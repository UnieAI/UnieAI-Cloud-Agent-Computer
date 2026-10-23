/**
 * Make a tenant's `/workspace` usable by the sandbox before the sandbox starts.
 *
 * Pure rules plus one command plan; the caller runs it. See
 * `workspace-dir.test.mjs` for the production measurement this exists for —
 * short version: docker creates a missing bind source as `root:root 0755`, the
 * image runs as uid 1000, and the first thing a new tenant's agent does with
 * bash is fail with `Permission denied`.
 *
 * WHY A CONTAINER AND NOT A `mkdir` HERE. sandbox-runtime is uid 1000 and the
 * tenant parents are `root:root 0770` (the host-side fence: an unprivileged
 * process on this box must not be able to walk into another tenant's files).
 * So this process cannot create the directory, by design. Docker already runs
 * as root and already creates this exact directory as a side effect of the
 * bind; the only change here is that it now creates it in a state the sandbox
 * can use.
 */

/**
 * Does this directory need fixing?
 *
 * `false` for anything already usable, because this runs on the allocation
 * path: a fixup that fired every time would put a container start in front of
 * every sandbox, and a safety step with a cost proportional to traffic is one
 * that eventually gets switched off.
 *
 * A directory owned by someone else but world-writable is left ALONE. It is
 * usable, and rewriting its metadata would touch a store another product reads.
 */
export function needsWorkspaceFixup({ exists, uid, mode } = {}) {
  if (!exists) return true;
  const m = Number(mode ?? 0);
  if ((m & 0o002) !== 0) return false; // world-writable: usable whoever owns it
  return uid !== SANDBOX_UID;
}

/** The uid the sandbox image runs as (`USER user`). */
export const SANDBOX_UID = 1000;

/**
 * The one-shot that creates and hands over the directory.
 *
 * Binds the WORKSPACE PATH ITSELF, never the tenant parent: the parent holds
 * every sibling tenant, and a container given it could read all of them. The
 * bound path is the whole grant. No network — it has nothing to talk to, and
 * saying so costs nothing and removes a question.
 */
export function workspaceFixupPlan({ hostPath, image, uid = SANDBOX_UID, gid = SANDBOX_UID }) {
  if (!hostPath || !image) throw new Error("workspaceFixupPlan: hostPath and image are required");
  // `/w` is the bind target, so nothing here can walk outside what docker
  // granted. chmod after chown: the order matters if the image's sh is strict
  // about a failed first command.
  return rootOneShot({ hostPath, image, target: "/w", script: `chown ${uid}:${gid} /w && chmod 0770 /w` });
}

/**
 * The one-shot that FENCES a per-tenant bucket root (2026-09-26, F-GRP).
 *
 * On a per-tenant bucket the bucket root is the tenant's root, and
 * `s3.bucket.create` makes it 0777 (weed/shell/command_s3_bucket_create.go:92 in
 * the running 4.41; `weed shell` has no chmod, so it cannot be CREATED fenced).
 * An open root lets any host account walk into the workspace — whose files the
 * sandbox creates as uid 1000, which on this host is also the login account —
 * and, being writable, rename `workspace` away and plant its own.
 *
 * `chown 0:0` BEFORE `chmod`: two production roots were `ubuntu:ubuntu 0777`,
 * and a bare chmod 0770 leaves their owner with rwx. Group 0 is filer gid 0,
 * which the host mount shows as the workspace group (workspace-group.mjs) —
 * nobody on the host is in it. The sandbox does not need the root: it is given
 * `workspace` and `.snapshots` as binds, and dockerd resolves those as root.
 *
 * Binds the tenant's OWN root — one tenant's tree, the same grant the workspace
 * fixup already takes — and touches the root only, never recursively.
 */
export function tenantRootFencePlan({ hostPath, image }) {
  if (!hostPath || !image) throw new Error("tenantRootFencePlan: hostPath and image are required");
  return rootOneShot({ hostPath, image, target: "/b", script: "chown 0:0 /b && chmod 0770 /b" });
}

/**
 * Is this tenant root fenced? `true` / `false`, or `null` when this process
 * could not ask whether it can get in.
 *
 * Fenced means: owned by root, nothing at all for "other", the group is root or
 * the workspace group (nobody on the host is in either), AND this process
 * cannot traverse it. The last one is the kernel's own answer and catches the
 * case the mode bits cannot: this process being in the group after all.
 */
export function tenantRootFenced({ uid, gid, mode, traversable, workspaceGid = null } = {}) {
  if (traversable === true) return false;
  if (uid !== 0) return false;
  if ((Number(mode) & 0o007) !== 0) return false;
  if (gid !== 0 && (workspaceGid == null || gid !== workspaceGid)) return false;
  if (traversable === false) return true;
  return null;
}

/** `docker run` a fixed root script against ONE bound path, with no network. */
function rootOneShot({ hostPath, image, target, script }) {
  return {
    args: [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      // The image's own entrypoint mounts a workspace and demands
      // WORKSPACE_BUCKET; without this the `sh -c` below arrives as its
      // ARGUMENTS and the run fails with that script's error instead.
      "sh",
      "--user",
      "0:0",
      "-v",
      `${hostPath}:${target}`,
      image,
      "-c",
      script,
    ],
  };
}
