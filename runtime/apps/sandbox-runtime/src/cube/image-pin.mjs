/**
 * cube/image-pin.mjs — keep the sandbox's own Docker image from being garbage
 * collected out from under it, and say so loudly when it is already gone.
 *
 * THE INCIDENT, 2026-09-26/27, production. This host runs k3s with `--docker`
 * (`systemctl cat k3s`), so kubelet's image garbage collection manages
 * DOCKER'S OWN image store — not just what Kubernetes itself scheduled. At
 * 20:21:48 UTC disk usage crossed kubelet's 85% high-threshold GC trigger
 * (it sat at 84%, 991 GB, when this was written); kubelet logged "Removing
 * image to free bytes" for 49 images. To kubelet, every image no *pod* is
 * currently running counts as unused, and that includes
 * `cm-agent-sandbox:weed-mount` (env `SANDBOX_DOCKER_IMAGE`): sandboxes are
 * created and destroyed per allocation (cube/docker.mjs), and the
 * filer-exposure probe (cube/filer-exposure.mjs `probeFilerFromSandboxNetwork`)
 * runs one throwaway container between allocations — nothing about that
 * image is EVER a long-lived pod kubelet can see as "in use".
 *
 * With the image gone, the probe's `docker run` exited 125 ("Unable to find
 * image … pull access denied"). The probe returned `null`, and the pool
 * (pool/manager.mjs `runFilerProbe`, 15-minute cache) refused every CLOUD
 * sandbox with `filer_exposure_unknown` — a message that sent people looking
 * at the FILER, when the actual fault was a missing IMAGE. Cloud sandboxes
 * were down for every user for hours while the image was rebuilt by hand.
 *
 * THE FIX. Docker refuses a non-forced `rmi` of an image any container still
 * references — running OR STOPPED — and kubelet's GC does not force it
 * (it is deleting images, not asking Docker to break a reference it holds).
 * So: keep exactly one throwaway, NEVER-STARTED container bound to the
 * image's current id. That single fact — a container exists — is the whole
 * protection; nothing here has to watch disk usage or race kubelet's GC loop.
 *
 * WHY NOT THE SANDBOXES' OWN LABEL. Real sandboxes carry `unieai.sandbox=1`
 * so `reapOrphanContainers` (docker.mjs) can find and `rm -f` every one of
 * them left over from a previous sandbox-runtime process, unconditionally, at
 * every boot. A pin container carrying that same label would be swept up by
 * its own protector on the very next restart. So the pin lives in a
 * different namespace entirely (`PIN_LABEL_KEY` below) — verified in
 * image-pin.test.mjs by calling the REAL `reapOrphanContainers`, not by
 * eyeballing that two string constants differ.
 *
 * WHY A FIXED NAME AND "REPLACE", NOT "ONE PER IMAGE ID". Docker container
 * names are unique, so keeping the same name (`PIN_CONTAINER_NAME`) across a
 * rebuild means the OLD pin must be removed before the NEW one can be
 * created — a brief window where neither id is protected, accepted rather
 * than engineered around (e.g. by keeping every historical pin forever, which
 * would just accumulate one stopped container per rebuild indefinitely, and
 * still not close the same window without depending on the rename itself
 * being atomic, which it is not either). kubelet's GC is disk-pressure
 * triggered, not continuous, so a reconcile-interval-scale window here is not
 * the same shape of risk as leaving the image unprotected between deploys.
 */

import { log } from "../shared/log.mjs";

/** Matches `cube/docker.mjs`'s own default — kept independent (not imported)
 * so this file has no dependency on docker.mjs beyond the shared convention
 * of the env var name; the two are cross-checked by image-pin.test.mjs. */
const DEFAULT_IMAGE = "cm-agent-sandbox:weed-mount";

/** One pin, process-wide — not one per image tag, see header. */
export const PIN_CONTAINER_NAME = "ava-sandbox-image-pin";

/**
 * The identifying label. Deliberately NOT `unieai.sandbox` (any value) — see
 * header. `ava.` is this product's own namespace, distinct from the
 * `unieai.*` labels docker.mjs puts on real sandboxes, so a future filter
 * written as "every unieai.* container" (none exists today — checked
 * 2026-09-27 across src/) still would not catch this one either.
 */
export const PIN_LABEL_KEY = "ava.image-pin";
export const PIN_LABEL_VALUE = "1";

/** How much of a failed docker invocation's stderr ever reaches a log line. */
const DETAIL_MAX_CHARS = 300;

function firstLine(text) {
  const line = String(text ?? "").split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.trim().slice(0, DETAIL_MAX_CHARS);
}

/**
 * The rebuild command an operator needs, named directly in the ERROR event
 * below rather than left for someone to rediscover mid-incident — matches
 * docker/cm-agent-sandbox/README.md's own "Local sanity check" build line.
 */
export function rebuildCommand(image) {
  return `docker build -t ${image} ./docker/cm-agent-sandbox/`;
}

/**
 * `docker <args>` → `{code, stdout, stderr}`. Never throws and never
 * rejects — every failure mode this module cares about (docker missing, a
 * timeout, a non-zero exit) collapses to the same action ("could not confirm
 * this step; the next reconcile tick tries again"), so there is no reason to
 * report them through two different channels.
 *
 * Injectable (the pattern cube/filer-exposure.mjs uses for its own docker
 * runner) so every reconcile branch below is unit-testable without a daemon.
 */
async function defaultDockerRunner({ args, timeoutMs = 10_000 }) {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: String(err?.message ?? err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || String(err?.message ?? err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** The image tag's CURRENT id, or `null` if the tag does not resolve at all. */
async function inspectImageId(image, runner) {
  const { code, stdout } = await runner({ args: ["image", "inspect", "--format", "{{.Id}}", image] });
  if (code !== 0) return null;
  return stdout.trim() || null;
}

/** The id the EXISTING pin container is bound to, or `null` if there is none. */
async function inspectPinnedImageId(name, runner) {
  const { code, stdout } = await runner({ args: ["inspect", "--format", "{{.Image}}", name] });
  if (code !== 0) return null;
  return stdout.trim() || null;
}

async function removePin(name, runner) {
  // Best-effort: if this fails, `create` below fails too (name conflict) and
  // that failure is reported and retried on the next tick — see ensureImagePin.
  await runner({ args: ["rm", "-f", name] });
}

/**
 * `docker create` from the image's CURRENT ID (not the tag) — see header for
 * why a fixed name forces remove-then-create on a rebuild. The command is
 * overridden to one that never does anything: this container is never
 * started by this module, but an operator poking at `docker ps -a` and
 * running one by hand must not trigger the REAL entrypoint (entrypoint.sh
 * weed-mounts a workspace and hard-requires WORKSPACE_BUCKET / WORKSPACE_PATH
 * / S3_ENDPOINT — see docker/cm-agent-sandbox/README.md — none of which this
 * container has).
 */
async function createPin({ name, image, imageId, runner }) {
  return runner({
    args: [
      "create",
      "--name", name,
      "--label", `${PIN_LABEL_KEY}=${PIN_LABEL_VALUE}`,
      "--label", `ava.image-pin.for=${image}`,
      "--entrypoint", "/bin/true",
      imageId,
    ],
  });
}

/**
 * Reconcile the pin against the image's CURRENT id. Safe to call at boot and
 * on every interval tick — every branch is idempotent, and nothing here ever
 * throws (docker failures are logged and left for the next tick).
 *
 * Returns `{ ok, action, image, imageId? }` — used by the tests; boot and the
 * interval both treat this as fire-and-forget.
 */
export async function ensureImagePin({
  image = process.env.SANDBOX_DOCKER_IMAGE || DEFAULT_IMAGE,
  name = PIN_CONTAINER_NAME,
  runner = defaultDockerRunner,
} = {}) {
  const currentId = await inspectImageId(image, runner);
  if (!currentId) {
    // THE EXACT FAILURE THIS FILE EXISTS TO CATCH. 2026-09-26/27: this state
    // was reachable only through `filer_exposure_unknown`, which named the
    // filer, not the image. Say the actual fact, and the fix, directly.
    log("error", "sandbox.image_missing", { image, rebuildCommand: rebuildCommand(image) });
    return { ok: false, action: "image_missing", image };
  }

  const pinnedId = await inspectPinnedImageId(name, runner);
  if (pinnedId === currentId) {
    return { ok: true, action: "kept", image, imageId: currentId };
  }

  if (pinnedId) {
    // The tag moved since we last pinned (someone rebuilt it) — drop the
    // stale pin first; see header for why this is remove-then-create rather
    // than accumulating one stopped container per rebuild.
    await removePin(name, runner);
  }

  const { code, stderr } = await createPin({ name, image, imageId: currentId, runner });
  if (code !== 0) {
    log("warn", "sandbox.image_pin_failed", { image, imageId: currentId, detail: firstLine(stderr) });
    return { ok: false, action: "create_failed", image, imageId: currentId };
  }

  log("info", pinnedId ? "sandbox.image_pin_replaced" : "sandbox.image_pinned", {
    image,
    imageId: currentId,
    previousImageId: pinnedId ?? null,
  });
  return { ok: true, action: pinnedId ? "replaced" : "created", image, imageId: currentId };
}

let pinTimer = null;

/**
 * Boot + hourly — mirrors pool/manager.mjs's startReaper/stopReaper shape.
 * Hourly rather than on the kubelet GC's own cadence because there is no way
 * to know that cadence from here; the reconcile is cheap (two `docker
 * inspect` calls on the common "nothing changed" path) and idempotent, so an
 * hour is "often enough to catch a rebuild same-day", not a tuned constant.
 */
export function startImagePinReconciler({ intervalMs = 60 * 60 * 1000 } = {}) {
  if (pinTimer) return;
  pinTimer = setInterval(() => {
    ensureImagePin().catch((err) => {
      log("warn", "sandbox.image_pin_reconcile_failed", { error: err?.message ?? String(err) });
    });
  }, intervalMs);
  pinTimer.unref?.();
}

export function stopImagePinReconciler() {
  if (pinTimer) {
    clearInterval(pinTimer);
    pinTimer = null;
  }
}
