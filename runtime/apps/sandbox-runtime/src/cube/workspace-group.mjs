/**
 * cube/workspace-group.mjs — the one group that may read what the S3 API wrote.
 *
 * ── The defect (2026-09-26, UAT week 1, track B1, D1, P0) ─────────────────
 *
 * Uploads and the agent's write/edit tools go through the S3 API, and the S3
 * gateway stores every object as uid 0 / gid 0, mode 0660
 * (weed/s3api/s3api_object_handlers_put.go:678-687 at de34a1a87, the commit the
 * running 4.41 binary reports), with the directories it creates on the way as
 * 0771 (weed/filer/filer.go:335). The sandbox runs as uid 1000 behind a mount
 * that has `default_permissions`, so its own bash got `Permission denied` on a
 * CSV the user had just uploaded, and "upload a CSV and ask the AI to analyse
 * it" failed.
 *
 * ── The fix that was tried, and why it is forbidden ───────────────────────
 *
 * `-map.uid=1000:0 -map.gid=1000:0` on the host-wide mount. uid 1000 on this
 * host is ALSO the login account `ubuntu`, which runs ava-app and ava-sandbox.
 * The map made that account the OWNER of every tenant's files; owner bits beat
 * the 0770 tenant-parent fence, and the live isolation check
 * (host-filer-exposure.test.mjs) blocked the next deploy. Reverted in a142cae6.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 *
 * Map only the GROUP. Filer gid 0 is shown on the host as a dedicated gid that
 * no host account is in, and every sandbox container joins it with
 * `--group-add`. S3-written files then read as `root:<gid> 0660`: the sandbox
 * reads and writes them through its group bits, while a host account is
 * "other" and gets nothing. No uid is mapped anywhere, so no host account ever
 * owns a tenant's file because of this.
 *
 * Why not gid 0 (`--group-add 0`): cloud-sandbox-policy.md §4a measured 1,789
 * `root:root` group-writable paths inside the image, /bin among them.
 *
 * Why it depends on `default_permissions` (the mount's default, now also passed
 * explicitly): with it the KERNEL checks access, using the caller's real
 * credentials — a container's supplementary groups included. Without it weed
 * 4.41 checks access itself (weedfs_file_mkrm.go:339, weedfs_filehandle.go:52)
 * and resolves the caller's groups with `user.LookupId(uid)` against the HOST's
 * group database, which has never heard of a container's `--group-add`: every
 * write into a group-owned directory would be refused.
 *
 * The same number has to reach three places — the root mount script
 * (AVA_WORKSPACE_GID), sandbox-runtime (SANDBOX_WORKSPACE_GID) and
 * verify-storage — so all three default to DEFAULT_WORKSPACE_GID, and
 * workspace-group.test.mjs runs the real mount script to prove its default
 * agrees with this file.
 */

import { log } from "../shared/log.mjs";

/**
 * The dedicated gid. Chosen because `getent group 2468` answered nothing on the
 * production host (2026-09-26) and it is far above the range `useradd` hands
 * out for user-private groups. The runbook reserves it with a memberless group
 * (docs/ops/ava-workspace-group-access.md) so nothing later picks it by chance.
 */
export const DEFAULT_WORKSPACE_GID = 2468;

/**
 * env → the gid sandbox containers join, or `null` for "join nothing".
 *
 * Unset means the default, so no deploy has to remember a value. `off` / `none`
 * disables it on purpose. Anything else that is not a positive integer is a
 * configuration error and also yields `null` — with a warning — rather than a
 * guess: gid 0 is `root` (see the header), and a typo silently replaced by the
 * default could put the containers in a group the mount does not map.
 */
export function resolveWorkspaceGid(env = process.env) {
  const raw = String(env?.SANDBOX_WORKSPACE_GID ?? "").trim().toLowerCase();
  if (raw === "") return DEFAULT_WORKSPACE_GID;
  if (raw === "off" || raw === "none") return null;
  if (/^[1-9][0-9]*$/.test(raw)) {
    const n = Number(raw);
    if (n < 2 ** 31) return n;
  }
  log("warn", "workspace_group.invalid_gid", {
    value: raw,
    note: "SANDBOX_WORKSPACE_GID must be a positive integer (or off); sandboxes will join no workspace group, so files written through S3 stay unreadable to their shell",
  });
  return null;
}

/** The one weed flag: filer gid 0 (what the S3 API writes) shown locally as `gid`. */
export function workspaceGidMapFlag(gid) {
  return `-map.gid=${gid}:0`;
}

/**
 * Every value given to flag `name` in a weed argv, in either form Go's flag
 * package accepts: `-name=v` / `--name=v`, or `-name v` / `--name v`.
 */
function flagValues(argv, name) {
  const out = [];
  const list = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < list.length; i += 1) {
    const bare = list[i].replace(/^--?/, "");
    if (bare === name) {
      out.push(list[i + 1] ?? "");
      i += 1;
    } else if (bare.startsWith(`${name}=`)) {
      out.push(bare.slice(name.length + 1));
    }
  }
  return out;
}

/**
 * `getent group <gid>` + `getent passwd` → who is in the group on this host.
 * Pure, so the verdict below is testable without a host.
 */
export function parseGroupFacts({ gid, groupLine, passwdText }) {
  const fields = String(groupLine ?? "").trim().split(":");
  const members = fields.length >= 4 ? fields[3].split(",").map((s) => s.trim()).filter(Boolean) : [];
  const primaryOf = String(passwdText ?? "")
    .split("\n")
    .map((line) => line.split(":"))
    .filter((f) => f.length >= 4 && f[3] === String(gid))
    .map((f) => f[0]);
  return { members, primaryOf };
}

/**
 * The properties the host-wide workspace mount must have, from facts only.
 *
 *   argv         the running (or scripted) `weed mount` argv
 *   mountOptions the options field of its /proc/mounts line, or null if unknown
 *   expectedGid  the gid sandbox containers join
 *   groupFacts   `parseGroupFacts` for expectedGid on this host, or null
 *
 * Returns one `{ id, name, ok, detail }` per property. Unknown is never ok.
 */
export function workspaceMountIdentityChecks({ argv, mountOptions, expectedGid, groupFacts }) {
  const uidMaps = flagValues(argv, "map.uid");
  const gidMaps = flagValues(argv, "map.gid");
  const want = expectedGid ? `${expectedGid}:0` : null;
  const options = mountOptions == null ? null : String(mountOptions).split(",");
  const permFlags = flagValues(argv, "defaultPermissions");
  const members = groupFacts ? [...(groupFacts.members ?? []), ...(groupFacts.primaryOf ?? [])] : null;

  return [
    {
      id: "no-uid-map",
      name: "host mount does not make a host account the owner of tenant files (no -map.uid)",
      ok: uidMaps.length === 0,
      detail: uidMaps.length === 0
        ? "the mount maps no uid"
        : `the mount carries -map.uid=${uidMaps.join(",")} — a mapped local uid owns every tenant's files, and when it ` +
          "is a host account (uid 1000 is `ubuntu` here) every process running as it can read and write all of them",
    },
    {
      id: "gid-map",
      name: `host mount shows S3-written files to the workspace group (-map.gid=${want ?? "<gid>:0"})`,
      ok: Boolean(want) && gidMaps.length === 1 && gidMaps[0] === want,
      detail: !want
        ? "no workspace gid is configured, so nothing can be checked against — set AVA_WORKSPACE_GID / SANDBOX_WORKSPACE_GID"
        : gidMaps.length === 1 && gidMaps[0] === want
          ? `filer gid 0 is shown as ${expectedGid}; sandboxes join it with --group-add`
          : gidMaps.length === 0
            ? `no -map.gid — files written through S3 (uploads, the agent's write/edit) are root:root 0660 and the ` +
              `sandbox's shell cannot read them (UAT B1-D1). Install deploy/systemd/ava-workspace-mount.sh and restart the mount`
            : `-map.gid=${gidMaps.join(" / ")} is not exactly ${want}: any other pair gives some other gid access to what S3 wrote`,
    },
    {
      id: "default-permissions",
      name: "the kernel enforces the mount's permissions (default_permissions)",
      ok: options !== null && options.includes("default_permissions") && !permFlags.includes("false"),
      detail: options === null
        ? "the mount's options could not be read, so this is not a pass"
        : options.includes("default_permissions") && !permFlags.includes("false")
          ? "default_permissions is on"
          : "default_permissions is off — weed then checks access against the HOST's group database, which cannot see " +
            "a container's --group-add, so the sandbox loses write access to every group-owned directory",
    },
    {
      id: "group-has-no-host-members",
      name: `no host account is in the workspace group (${expectedGid ?? "<gid>"})`,
      ok: members !== null && members.length === 0,
      detail: members === null
        ? "group membership could not be determined, so this is not a pass"
        : members.length === 0
          ? "no member and no account whose primary group it is"
          : `${members.join(", ")} ${members.length === 1 ? "is" : "are"} in it — every S3-written file of every tenant is ` +
            "then readable and writable by that account. Remove the membership (and check nothing else relies on it)",
    },
  ];
}
