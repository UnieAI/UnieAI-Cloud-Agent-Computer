/**
 * cube/filer-exposure.mjs — refuse to hand a tenant a sandbox that can reach an
 * unauthenticated filer.
 *
 * THE EXPOSURE, measured 2026-09-06 from the sandbox network itself:
 *
 *     :8888   filer HTTP   reachable · anonymous GET / → 200
 *     :18888  filer gRPC   reachable · no authorization configured
 *     :8333   S3           reachable · anonymous 403
 *     :9333   master       not reachable
 *
 * So a tenant's agent can `curl` every other tenant's workspace out of the
 * filer without any credential. The S3 door is the only one with a lock, and
 * `weed mount` cannot use it — it speaks the filer's gRPC, which has none.
 *
 * WHY THIS FILE IS A GUARD AND NOT A FIX. It fixes nothing. The route exists
 * because `SANDBOX_WORKSPACE_MOUNT` defaults to `in-guest`, where the guest
 * mounts `/workspace` itself and therefore MUST reach the filer. Removing the
 * route means host-side mounting (docs/ops/host-workspace-mount.md) and a
 * sandbox network that excludes the filer. Both are per-HOST work.
 *
 * And that is exactly why the guard is worth more than it looks. A security
 * property whose prerequisites live in host configuration fails silently, once
 * per machine: bring the service up somewhere new, forget one of them, and the
 * mode falls back to `in-guest`, the sandbox mounts, everything works, and
 * every tenant on that machine is readable. Nothing is red. Nobody is told.
 *
 * This turns that into a refusal with the reason attached. A new machine stops
 * serving CLOUD sandboxes until someone decides — and deciding to accept it is
 * one explicit variable, so the acceptance is visible, greppable, and dated by
 * the commit that set it, instead of being the default nobody chose.
 *
 * WHAT IT DELIBERATELY DOES NOT REFUSE: machine-bound sandboxes (Rabi Local and
 * SSH). Those are routing records for the user's own hardware — they mount no
 * workspace, hold no filer route, and are not exposed by any of the above.
 * Refusing them would take the local-machine product down to fix a hazard it
 * does not have.
 */

/** The env var a deployment sets to accept the exposure knowingly. */
export const ACK_ENV = "SANDBOX_ALLOW_ANONYMOUS_FILER";

/**
 * The filer address as the GUEST resolves it, derived exactly the way the
 * sandbox image derives it (docker/cm-agent-sandbox/entrypoint.sh): same host
 * as the S3 endpoint, port 8888.
 *
 * Derived rather than configured separately because a probe that checked a
 * DIFFERENT address than the guest uses would answer a question nobody asked —
 * and would answer it reassuringly, since the host cannot resolve `seaweedfs`
 * at all while the guest can.
 *
 * Returns null when there is nothing to derive from; the caller reads that as
 * "no S3 workspace is configured", not as "not exposed".
 */
export function guestFilerAddress(s3Endpoint) {
  const raw = String(s3Endpoint ?? "").trim();
  if (!raw) return null;
  let host;
  try {
    host = new URL(raw.includes("://") ? raw : `http://${raw}`).hostname;
  } catch {
    return null;
  }
  if (!host) return null;
  return { host, port: 8888 };
}

/**
 * The verdict, from facts only. No I/O, so every branch is testable and the
 * probe can be swapped for a different mechanism without touching the rule.
 *
 * `filerReachable` is a THREE-valued input on purpose: `true`, `false`, and
 * `null` for "the probe could not answer". Collapsing `null` into `false`
 * would turn every environment where the probe cannot run into a clean bill of
 * health, which is the failure this whole file exists to prevent.
 *
 * `probeDetail` is optional and only ever READ when `filerReachable === null`
 * — it says *why* the probe could not answer (2026-09-26/27: "the probe
 * container could not start: Unable to find image … locally", because
 * kubelet's image GC had removed `cm-agent-sandbox:weed-mount` — see
 * image-pin.mjs and probeFilerFromSandboxNetworkDetailed below). It changes
 * no branch and no boolean here; it is folded into the existing reason/note
 * text so a refused user and this file's own log line say the same thing.
 */
export function exposureVerdict({ filerReachable, acknowledged, mountMode, filerAddress, probeDetail = null }) {
  const where = filerAddress ? `${filerAddress.host}:${filerAddress.port}` : "the filer";
  // Only meaningful when filerReachable === null (probeFilerFromSandboxNetworkDetailed
  // is the only source of it) — see that function for what can populate it and
  // why: the exit code stays the only vote on filerReachable itself, this is
  // purely "why couldn't the probe answer", added to ONE reason string so the
  // log line and the refusal a user sees never carry two different stories.
  const why = probeDetail ? ` (${probeDetail})` : "";

  if (filerReachable === false) {
    return { ok: true, note: `sandboxes cannot reach ${where}` };
  }

  if (acknowledged) {
    // Accepted, not fixed — and said so every time, because an acknowledgement
    // that goes quiet is indistinguishable from the hazard being gone.
    return {
      ok: true,
      note:
        filerReachable === null
          ? `filer reachability UNKNOWN${why} and accepted via ${ACK_ENV}`
          : `sandboxes CAN reach ${where}, which is unauthenticated — accepted via ${ACK_ENV}`,
      accepted: true,
    };
  }

  if (filerReachable === null) {
    return {
      ok: false,
      code: "filer_exposure_unknown",
      reason:
        `could not determine whether a sandbox can reach ${where}${why}, so cloud sandboxes are refused. ` +
        `An unauthenticated filer hands every tenant's workspace to any caller that can reach it, and ` +
        `an unanswerable check is not an answer. Fix the probe, remove the route ` +
        `(SANDBOX_WORKSPACE_MOUNT=host plus a sandbox network without the filer), or accept it with ${ACK_ENV}=1.`,
    };
  }

  return {
    ok: false,
    code: "filer_exposure_refused",
    reason:
      `a sandbox on this host can reach ${where}, which requires no credential and serves every tenant's ` +
      `workspace, so cloud sandboxes are refused. ` +
      // Any host-side mode, not just the literal "host": `host-premounted`
      // reaches here too, and telling that deployment to "switch to host
      // mounting" is advice to do what it already did.
      (String(mountMode ?? "").startsWith("host")
        ? `The workspace is mounted host-side, so the guest no longer NEEDS that route — put sandboxes on a network that excludes the filer.`
        : `SANDBOX_WORKSPACE_MOUNT=${mountMode ?? "in-guest"} means the guest mounts /workspace itself and must reach the filer to do it; ` +
          `switch to host mounting (docs/ops/host-workspace-mount.md) before isolating the network.`) +
      ` To accept the exposure meanwhile, set ${ACK_ENV}=1 — deliberately, and where someone will see it.`,
  };
}

/**
 * Whether this allocation is subject to the guard.
 *
 * Machine-bound sandboxes are not: they are routing records for the user's own
 * computer, they mount nothing here and hold no filer route. See the header.
 */
export function guardAppliesTo({ machine }) {
  return !machine?.kind;
}

/**
 * Ask, from the SANDBOX's own vantage point, whether the filer is reachable.
 *
 * Runs one throwaway container on the network sandboxes get, using the image
 * they get, and opens a TCP connection. Two deliberate choices:
 *
 *   · The sandbox IMAGE, not a convenient one. `busybox` would need pulling on
 *     a machine that has never seen it, and a probe that fails because of a
 *     missing image reports "unknown" for a reason unrelated to the question.
 *     The sandbox image is present by definition — if it is not, no sandbox
 *     could start anyway.
 *   · A TCP connect, not an HTTP request. The exposure is the ROUTE. A filer
 *     that answered 401 on HTTP would still hand its gRPC port (:18888, no
 *     authorization at all) to anything that can open a socket to it.
 *
 * The connect is attempted with python3, then bash's /dev/tcp, then `nc`,
 * because none of them is guaranteed. That chain is not defensive
 * boilerplate — the first version of this used `nc` alone on the claim that
 * "every sandbox image here is built on busybox", which was written as if
 * measured and was wrong: `cm-agent-sandbox:weed-mount` is Debian-based, has
 * no `nc`, and the probe answered `null` for every run. It was the probe that
 * could not run, reported honestly, which is the only reason it was caught
 * rather than shipped as a clean bill of health.
 *
 * MEASURED in that image: python3, bash, curl, wget, weed, node, perl — no nc.
 *
 * Exit codes are the answer; no output is parsed, so a chatty image cannot
 * turn a refusal into a pass. 0 = reachable, 1 = not (a refused connection, an
 * unresolvable name, or no answer within the window — all of which mean a
 * caller in that sandbox cannot get to the filer), 127 = no tool to ask with,
 * which is UNKNOWN and never a pass.
 *
 * Returns `true`, `false`, or `null` for "could not answer" — never a guess.
 * `runner` is injectable so the decision logic can be tested without docker.
 *
 * KEPT AS A BARE true/false/null RETURN, unchanged, because that is the
 * contract `pool/manager.mjs` and every existing caller of THIS function
 * already have. `probeFilerFromSandboxNetworkDetailed` below is the same
 * probe — one `docker run`, not two — with the "why couldn't it answer"
 * attached; use that one where the answer reaches a log line or a user.
 */
export async function probeFilerFromSandboxNetwork(args, runner = defaultDockerRunner) {
  const { reachable } = await runProbe(args, runner);
  return reachable;
}

/**
 * THE SAME PROBE, plus WHY a `null` happened — added 2026-09-27 after an
 * incident where it mattered which "unknown" this was.
 *
 * This host runs k3s with `--docker` (`systemctl cat k3s`), so kubelet's own
 * image garbage collection manages DOCKER's image store, not just what
 * Kubernetes itself scheduled. At 20:21:48 UTC on 2026-09-26 disk usage
 * crossed kubelet's 85% high-threshold GC trigger and it logged "Removing
 * image to free bytes" for 49 images — including `cm-agent-sandbox:weed-mount`
 * (env `SANDBOX_DOCKER_IMAGE`), because to kubelet an image no *pod* is
 * currently running counts as unused, and nothing about a probe container
 * that runs for milliseconds between allocations changes that count.
 *
 * With the image gone, THIS probe's `docker run` exited 125 ("Unable to find
 * image … pull access denied") before the connect script ever ran. `null` was
 * still the correct tri-state answer — but it carried no explanation, so the
 * refusal it produced ("could not determine whether a sandbox can reach
 * seaweedfs:8888…") sent people looking at the FILER for hours while the
 * actual fault was a missing IMAGE (see image-pin.mjs for the fix to the
 * image side of this). This function is the honesty fix on the probe side:
 * it keeps the first line of docker's OWN stderr — captured only when the
 * container never got to run (exit 125, or the runner throwing before any
 * exit code exists at all) — so the eventual refusal can say so.
 *
 * Why exit 125 specifically, and not "any nonzero code": at 125 the FAILURE
 * IS DOCKER'S, emitted before the image's entrypoint runs, so the text is
 * trustworthy to show. At 127 (no tool in the image) or any other code the
 * CONTAINER DID RUN — that stderr would be the image's, not docker's, and
 * showing it would be one step from parsing untrusted output for meaning,
 * which is exactly the property `connectScript`'s doc-comment above protects.
 * `detail` therefore stays `null` for every other non-0/1 code, same as
 * before this change; nothing about reachability itself changed shape.
 */
export async function probeFilerFromSandboxNetworkDetailed(args, runner = defaultDockerRunner) {
  return runProbe(args, runner);
}

/** How much of docker's own stderr ever reaches a log line or a refusal. */
const PROBE_DETAIL_MAX_CHARS = 300;

/**
 * First non-blank line of `text`, bounded. Deliberately not smarter than
 * that — see probeFilerFromSandboxNetworkDetailed's doc-comment above for why
 * this text is never parsed for meaning, only ever displayed once it is
 * already known to be safe to display.
 */
function firstLine(text) {
  const line = String(text ?? "").split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.trim().slice(0, PROBE_DETAIL_MAX_CHARS);
}

/**
 * A `runner` may still resolve a bare exit code — every test and caller that
 * predates 2026-09-27 does exactly that — or the richer `{code, stderr}` the
 * default runner now returns. Normalising here means neither
 * `probeFilerFromSandboxNetwork` nor its detailed sibling has to know which
 * shape it got, and a runner that returns a bare number keeps working with
 * both, unchanged.
 */
function normalizeRunnerResult(result) {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { code: result.code, stderr: typeof result.stderr === "string" ? result.stderr : "" };
  }
  return { code: result, stderr: "" };
}

/** The one probe both exported functions above are thin views over. */
async function runProbe({ network, image, filerAddress, timeoutMs = 15000 }, runner) {
  if (!filerAddress) return { reachable: null, detail: null };
  if (!network || !image) return { reachable: null, detail: null };
  const { host, port } = filerAddress;
  try {
    const result = await runner({
      args: ["run", "--rm", "--network", network, "--entrypoint", "sh", image, "-c", connectScript(host, port)],
      timeoutMs,
    });
    const { code, stderr } = normalizeRunnerResult(result);
    if (code === 0) return { reachable: true, detail: null };
    if (code === 1) return { reachable: false, detail: null };
    if (code === 125 && stderr) {
      return { reachable: null, detail: `the probe container could not start: ${firstLine(stderr)}` };
    }
    // 127 (nothing to ask with), a signal, any other docker exit — none of
    // these is evidence about the filer, and none is docker's own stderr
    // about a container that never ran, so none gets a detail either.
    return { reachable: null, detail: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "");
    return { reachable: null, detail: message ? `the probe could not run: ${firstLine(message)}` : null };
  }
}

/**
 * The in-container script. Exits 0 reachable, 1 unreachable, 127 no tool.
 *
 * `host` and `port` are interpolated, so they are validated here rather than
 * trusted: the port is a number and the host is checked against the character
 * set a hostname or IP can use. They come from configuration rather than from
 * a tenant, but a config value reaching a shell unchecked is how that stops
 * being true later.
 */
export function connectScript(host, port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`filer-exposure: bad port ${port}`);
  if (!/^[A-Za-z0-9._-]{1,253}$/.test(String(host))) throw new Error(`filer-exposure: bad host ${host}`);
  return [
    `if command -v python3 >/dev/null 2>&1; then`,
    `  python3 -c "import socket,sys;s=socket.socket();s.settimeout(3);sys.exit(0 if s.connect_ex(('${host}',${p}))==0 else 1)"`,
    `  exit $?`,
    `fi`,
    `if command -v bash >/dev/null 2>&1; then`,
    `  bash -c 'exec 3<>/dev/tcp/${host}/${p}' >/dev/null 2>&1 && exit 0 || exit 1`,
    `fi`,
    `if command -v nc >/dev/null 2>&1; then`,
    `  nc -z -w 3 ${host} ${p} >/dev/null 2>&1 && exit 0 || exit 1`,
    `fi`,
    `exit 127`,
  ].join("\n");
}

/**
 * `docker run …` → `{code, stderr}`. Separated so the probe can be tested
 * without it.
 *
 * stderr is captured (bounded while accumulating) rather than discarded as it
 * was before 2026-09-27: at exit 125 this is docker's OWN diagnostic for a
 * container that never got to run the image's entrypoint (see
 * probeFilerFromSandboxNetworkDetailed above), so it is not attacker- or
 * even image-controlled — safe to keep. The cap here is defence in depth,
 * not the thing that makes it safe; `firstLine()` is what actually bounds
 * what a caller ever sees.
 */
async function defaultDockerRunner({ args, timeoutMs }) {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("probe timed out"));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/**
 * The same facts, shaped for a READER instead of for a refusal.
 *
 * WHY THIS EXISTS. The verdict above is only ever seen by whoever is holding a
 * 503 — and only the half of it that reaches a user's screen. Everything else
 * about this hazard (the address, whether the probe could answer, whether a
 * deployment has ACCEPTED it) lives in a log line on one machine. On
 * 2026-09-11 every cloud sandbox on `agent.dev` had been refused for long
 * enough that nobody remembered why, and the console said "capacity is full",
 * which was false in every particular.
 *
 * WHY IT IS READ-ONLY, AND STAYS READ-ONLY. This is a cross-tenant isolation
 * guard. A console toggle for it would be a button that quietly turns tenant
 * isolation off for everyone, held by anyone who ever gets admin — and the
 * setting would live in the same database the sandboxes can reach. The
 * acknowledgement stays where it is: one env var on the machine, so changing
 * it means touching the deployment and leaves a dated commit behind. The
 * console's job is to make the state IMPOSSIBLE TO MISS, not to change it.
 * See docs/ops/filer-exposure-visibility.md.
 *
 * `probed: false` is its own answer, not a reassuring one: it means the probe
 * has not come back yet, so nothing here is known. It is deliberately NOT
 * folded into `filerReachable: null` — "we have not asked yet" and "we asked
 * and could not get an answer" call for different words on the other end.
 *
 * snake_case because this crosses the wire to the app, like every other field
 * on `GET /v1/sandboxes`.
 */
export function exposureReport({
  probed,
  filerReachable,
  acknowledged,
  mountMode,
  filerAddress,
  probedAt = null,
  probeDetail = null,
}) {
  const base = {
    probe: probed ? "answered" : "pending",
    filer: filerAddress ? `${filerAddress.host}:${filerAddress.port}` : null,
    acknowledged: Boolean(acknowledged),
    ack_env: ACK_ENV,
    mount_mode: mountMode ?? null,
    probed_at: probedAt,
  };
  if (!probed) {
    return {
      ...base,
      filer_reachable: null,
      cloud_allocation_allowed: null,
      accepted: false,
      code: null,
      detail: null,
    };
  }
  // The verdict is computed HERE rather than restated on the app side on
  // purpose: the rule has exactly one implementation, and the console renders
  // its answer. An app that re-derived "is this deployment safe" from the raw
  // fields would be a second copy of the guard, free to drift into disagreeing
  // with the one that actually refuses allocations.
  const verdict = exposureVerdict({ filerReachable, acknowledged, mountMode, filerAddress, probeDetail });
  return {
    ...base,
    filer_reachable: filerReachable ?? null,
    cloud_allocation_allowed: verdict.ok,
    accepted: Boolean(verdict.accepted),
    code: verdict.code ?? null,
    detail: verdict.note ?? verdict.reason ?? null,
  };
}
