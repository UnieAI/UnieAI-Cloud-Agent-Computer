/**
 * cube/host-filer-exposure.mjs — the HOST-side half of the filer exposure.
 *
 * `cube/filer-exposure.mjs` asks whether a SANDBOX can reach the filer. On this
 * deployment the answer is now no: `SANDBOX_WORKSPACE_MOUNT=host-premounted`
 * plus an `ava_sandbox` docker network that excludes the filer. That guard is
 * green, and it is measuring a real thing.
 *
 * It is also measuring the smaller half. The filer requires no credential from
 * ANY caller, and the HOST must be able to reach it — the root `weed mount`
 * units are what put every tenant's workspace on this machine in the first
 * place. So the route the sandbox lost is still open to every process on the
 * box, and "every process" is not a hypothetical population here: this host
 * runs another product's containers, a k3s node, and several services that are
 * not ours.
 *
 * MEASURED 2026-09-07 from an ordinary unprivileged shell on this host (uid
 * 1000, no credential, no sudo):
 *
 *     GET :8888/buckets/                                        → 200 + listing
 *     GET :8888/buckets/cm-agent-artifacts/users/?limit=3        → 200 + every tenant uuid
 *     GET :8888/buckets/.../users/<uuid>/workspace/test.txt      → 200, 23 bytes of content
 *     TCP :18888 (filer gRPC)                                    → open
 *     GET :8333/  (S3 gateway)                                   → 403   ← the only door with a lock
 *
 * ── The second door, which is easy to miss ────────────────────────────────
 *
 * Closing the filer port is not sufficient, and believing it is would be the
 * expensive mistake. The root mount units publish the same bytes at
 * `/mnt/ava/<bucket>`, and the permission bits there come from filer metadata:
 *
 *     /mnt/ava/<bucket>/users            0771 root:root   ← `--x` for other:
 *                                                           no listing, but a
 *                                                           KNOWN name traverses
 *     /mnt/ava/<bucket>/users/<uuid>/workspace    0777     ← read AND write
 *     /mnt/ava/<bucket>/users/<uuid>/.snapshots   0777
 *
 * Measured: 14 of 24 probed tenant subtrees are readable and writable by uid
 * 1000. The `0771` on `users/` only withholds ENUMERATION — and enumeration is
 * exactly what the filer's HTTP port hands out for free. The two doors compose,
 * and tenant uuids are ordinary user ids that also appear in app URLs, logs and
 * Postgres. So a check that only watched the port would go green while the
 * filesystem still handed a compromised unprivileged service full read/write
 * over other tenants' work.
 *
 * Per-tenant buckets (since 2026-09-07) have no `users/` parent at all:
 *
 *     /mnt/ava/ws-<kind>-<id>             0777 root:root  ← the tenant's ROOT
 *     /mnt/ava/ws-<kind>-<id>/workspace   0777
 *
 * This check did not look there until 2026-09-26 — see `tenantBucketRoots`.
 *
 * ── Why this is a check and not a fix ─────────────────────────────────────
 *
 * Same reason as its sibling, and one more. The filer belongs to another
 * product: container `uac2-seaweedfs`, compose project `eve`, config file
 * `/home/ubuntu/EVE/docker-compose.uac2.yml`. We do not get to restart it or
 * change its flags.
 *
 * And the app-level change everyone reaches for first does not work. Filer JWT
 * (`jwt.filer_signing[.read]`) is SAFE to apply — it breaks neither the mounts
 * nor the S3 gateway — and that is precisely the trap, because it also closes
 * none of this. Read in the 4.41 source: the mount takes all metadata over
 * gRPC :18888, which has no authentication of any kind and no interceptor to
 * add one; bulk chunk read AND write go through `/?proxyChunkId=`, which is
 * handled BEFORE the JWT gate; and `GET /` is explicitly exempt from the read
 * key. Anyone who can open a socket to the filer can still run their own
 * `weed mount` against it. `[guard] white_list` is a documented no-op on the
 * filer (upstream issue 7094). docs/ops/filer-auth.md carries the file and line
 * for each of those. The lever that exists here is the network, not the app.
 *
 * The fix is host-local (a uid-scoped reject on the filer's ports, plus one
 * chmod on the three tenant-parent directories) and is written up as a runbook
 * rather than executed here. This file is what tells us it has been done, and
 * keeps telling us on every machine that comes later.
 *
 * ── Vantage point ─────────────────────────────────────────────────────────
 *
 * This check is only meaningful when run FROM the host, AS an unprivileged
 * user. The intended fix deliberately leaves root's access intact — root
 * already reads every workspace through the mount it owns, so denying root the
 * port would cost the mounts everything and gain nothing. That means running
 * this as root would measure the one uid that is supposed to still get through
 * and report a clean bill of health for the wrong reason. It refuses instead.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import * as fsSync from "node:fs";

import { isTenantBucketName } from "../workspace/tenant-store.mjs";

/** The env var a deployment sets to accept the host-side exposure knowingly. */
export const HOST_ACK_ENV = "HOST_ALLOW_ANONYMOUS_FILER";

/** Filer ports. HTTP serves content anonymously; gRPC has no auth at all. */
export const FILER_HTTP_PORT = 8888;
export const FILER_GRPC_PORT = 18888;

/**
 * The filer address as the HOST actually reaches it, read from the live mount
 * table rather than from configuration.
 *
 * /proc/mounts lines for these mounts look like:
 *   172.20.0.4:8888:/buckets/cm-agent-artifacts /mnt/ava/cm-agent-artifacts fuse.seaweedfs rw,...
 *
 * Configuration would be the wrong source. `SANDBOX_HOST_MOUNT_FILER` is unset
 * on this deployment (the systemd unit carries the address), and `.env` says
 * `WEED_FILER_URL=http://localhost:8888`, where nothing listens on the host —
 * a probe pointed there would find nothing and call it safe. The mount table is
 * the only place that records the address the running mount is really using.
 *
 * Returns `[]` when no such mount exists, which the caller reads as "this host
 * mounts no workspace tree", not as "not exposed".
 */
export function parseSeaweedMounts(procMounts, mountRoot = "/mnt/ava") {
  const out = [];
  const prefix = path.resolve(mountRoot) + path.sep;
  for (const line of String(procMounts ?? "").split("\n")) {
    const parts = line.split(/\s+/);
    const [source, mountPoint, fsType] = parts;
    if (!source || !mountPoint) continue;
    if (fsType !== "fuse.seaweedfs") continue;
    const resolved = path.resolve(mountPoint);
    if (resolved !== path.resolve(mountRoot) && !(resolved + path.sep).startsWith(prefix)) continue;
    // `host:port:/buckets/<bucket>` — split from the LEFT twice only, because
    // the remote path itself contains no colon but an IPv6 host would.
    const m = /^(.+):(\d+):(\/.*)$/.exec(source);
    if (!m) continue;
    out.push({ host: m[1], port: Number(m[2]), remotePath: m[3], mountPoint: resolved });
  }
  return out;
}

/**
 * The verdict, from facts only. No I/O, so every branch is testable.
 *
 * Each input is THREE-valued — `true`, `false`, `null` for "could not answer" —
 * for the reason its sibling documents: collapsing `null` into `false` turns
 * every environment where a probe cannot run into a clean bill of health, which
 * is the failure this file exists to prevent.
 *
 * `applicable: false` is different from all three: it means this host mounts no
 * workspace tree, so there is no exposure to have. CI and a developer laptop
 * land there, and they should be green without pretending to have measured
 * anything.
 */
/**
 * Where to look for the `users|orgs|groups` parents, under either topology.
 *
 * PER-BUCKET mount (`-filer.path=/buckets/<bucket>` → `/mnt/ava/<bucket>`): the
 * mount point holds them directly. ROOT mount (`-filer.path=/buckets` →
 * `/mnt/ava`): every bucket is a subdirectory, so they are one level deeper.
 * The distinction is readable from `remotePath`, which `parseSeaweedMounts`
 * already returns — a root mount's is exactly `/buckets`.
 *
 * The topology changed on 2026-09-07 (one mount now serves every per-tenant
 * bucket, because a bucket per tenant cannot mean a unit per tenant), and this
 * probe went red reporting `tenant tree=unknown` while the property it guards
 * was still holding. That is the worst failure mode available to a security
 * check: it is red for a reason that has nothing to do with the hazard, so the
 * next person makes it green by deleting it.
 */
export function tenantParentRoots(mounts, readdir) {
  const out = new Set();
  for (const m of mounts ?? []) {
    const remote = String(m?.remotePath ?? "").replace(/\/+$/, "");
    const isRoot = remote === "/buckets" || remote === "";
    if (!isRoot) {
      out.add(m.mountPoint);
      continue;
    }
    let buckets = [];
    try {
      buckets = readdir(m.mountPoint) ?? [];
    } catch {
      // Denied or unreadable. NOT an empty answer: [] would make the caller
      // report "nothing to check", which reads as safe. Scan the mount point
      // itself so the per-parent ENOENT/EACCES logic gets to answer.
      out.add(m.mountPoint);
      continue;
    }
    if (buckets.length === 0) out.add(m.mountPoint);
    for (const b of buckets) out.add(path.join(m.mountPoint, b));
  }
  return [...out];
}

export function hostExposureVerdict({
  applicable,
  privileged,
  filerAnonymousRead,
  tenantTreeAccessible,
  acknowledged,
  filerAddress,
}) {
  if (applicable === false) {
    return { ok: true, applicable: false, note: "this host mounts no SeaweedFS workspace tree" };
  }

  // Measured from the one uid the fix deliberately still allows. Whatever this
  // says, it is not an answer about the population the fix is protecting from.
  if (privileged) {
    return {
      ok: false,
      code: "host_exposure_wrong_vantage_point",
      reason:
        "this check was run as root, and the intended fix leaves root's access to the filer and the mount " +
        "intact on purpose (root already reads every workspace through the mount it owns). Run it as the " +
        "unprivileged user the runtime runs as — measuring root measures the exception, not the rule.",
    };
  }

  const where = filerAddress ? `${filerAddress.host}:${filerAddress.port}` : "the filer";
  const unknown = filerAnonymousRead === null || tenantTreeAccessible === null;
  const exposed = filerAnonymousRead === true || tenantTreeAccessible === true;

  if (!unknown && !exposed) {
    return { ok: true, note: `unprivileged host processes can reach neither ${where} nor another tenant's tree` };
  }

  if (acknowledged) {
    // Accepted, not fixed — and said so every time, because an acknowledgement
    // that goes quiet is indistinguishable from the hazard being gone.
    return {
      ok: true,
      accepted: true,
      note: unknown
        ? `host-side filer exposure UNKNOWN and accepted via ${HOST_ACK_ENV}`
        : `unprivileged host processes CAN reach tenant data — accepted via ${HOST_ACK_ENV}`,
    };
  }

  if (unknown) {
    return {
      ok: false,
      code: "host_exposure_unknown",
      reason:
        `could not determine whether an unprivileged host process can read tenant data ` +
        `(filer=${describe(filerAnonymousRead)}, tenant tree=${describe(tenantTreeAccessible)}), so this is ` +
        `not a pass. An unanswerable check is not an answer. Fix the probe, apply ` +
        `docs/ops/filer-auth.md, or accept it with ${HOST_ACK_ENV}=1.`,
    };
  }

  const doors = [];
  if (filerAnonymousRead === true) {
    doors.push(
      `the filer at ${where} answers an anonymous GET with another tenant's file content ` +
        `(and its gRPC port ${FILER_GRPC_PORT} has no authentication at all)`,
    );
  }
  if (tenantTreeAccessible === true) {
    doors.push(
      `the workspace tree under the host mount is readable and writable by this uid, so a known tenant uuid ` +
        `is enough — closing the filer port alone would not shut this`,
    );
  }

  return {
    ok: false,
    code: "host_exposure_refused",
    reason:
      `an unprivileged process on this host can read and write every tenant's workspace: ${doors.join("; and ")}. ` +
      `Apply docs/ops/filer-auth.md (a uid-scoped reject on the filer's ports, and 0770 on the tenant-parent ` +
      `directories) and docs/ops/ava-workspace-group-access.md (0:0 0770 on every per-tenant bucket root, ` +
      `/mnt/ava/ws-*), or accept it deliberately with ${HOST_ACK_ENV}=1 where someone will see it.`,
    doors: doors.length,
  };
}

const describe = (v) => (v === null ? "unknown" : v === true ? "reachable" : "closed");

/**
 * Can THIS process, at its own uid, read a tenant's bytes out of the filer's
 * HTTP port with no credential?
 *
 * A content GET, not a TCP connect and not a listing. The sibling guard probes
 * the ROUTE, because for a sandbox the route is the exposure. Here the route is
 * required — root's mount rides it — so the question is narrower and has to be
 * asked precisely: can an unprivileged caller get *data*. A filer that answered
 * 403 to this while still accepting root's mount is exactly the success state.
 *
 * Returns true / false / null, never a guess.
 */
export async function probeAnonymousFilerRead({ filerAddress, timeoutMs = 6000 }, fetchImpl = fetch) {
  if (!filerAddress) return null;
  const { host, port } = filerAddress;
  const url = `http://${host}:${port}/buckets/`;
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal, headers: { Accept: "application/json" } });
  } catch (err) {
    // Connection refused / rejected / DNS / timeout — all of them mean an
    // unprivileged caller does not get through, which is the state we want.
    // Distinguishing them would be reporting on HOW it is closed, not whether.
    if (isNetworkClosed(err)) return false;
    return null;
  }
  if (res.status === 401 || res.status === 403) return false;
  if (!res.ok) return null;
  // 200 alone is not yet proof it served US anything: confirm the body is a
  // filer response. `Path` rather than `Entries` alone, because an EMPTY
  // directory comes back as `{"Path":"/buckets","Entries":null}` — the filer
  // answering an anonymous caller in full, which an `Array.isArray(Entries)`
  // test would have scored as "closed". A body that is neither is an
  // unexpected shape: unknown, never a pass.
  try {
    const body = await res.json();
    if (Array.isArray(body?.Entries) || typeof body?.Path === "string") return true;
    return null;
  } catch {
    return null;
  }
}

function isNetworkClosed(err) {
  const name = err?.name;
  if (name === "TimeoutError" || name === "AbortError") return true;
  const code = err?.cause?.code ?? err?.code;
  return ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "ETIMEDOUT", "EACCES", "ENOTFOUND"].includes(
    code,
  );
}

/**
 * Can THIS process, at its own uid, get into another tenant's workspace through
 * the host mount?
 *
 * Deliberately does NOT rely on being able to list `users/` — that directory is
 * `0771`, so an unprivileged caller cannot enumerate it, and a probe that gave
 * up there would report "closed" for the half of the exposure that is open. The
 * names come from the filer's HTTP listing when it is still answering, and
 * otherwise from whatever this uid can see; if neither yields a name, the answer
 * is `null` (unknown), not `false`.
 *
 * Read-only: `opendir` and `access(W_OK)`. Nothing is written.
 */
export async function probeTenantTreeAccessible(
  { mountPoints, tenantNames = [], parents = ["users", "orgs", "groups"], tenantRoots = [], unlistedRoots = [] },
  deps = {},
) {
  const opendir = deps.opendir ?? ((p) => fsp.opendir(p));
  const access = deps.access ?? ((p, m) => fsp.access(p, m));
  const legacy = Array.isArray(mountPoints) ? mountPoints : [];
  if (legacy.length === 0 && tenantRoots.length === 0 && unlistedRoots.length === 0) return null;

  // Per-tenant buckets first: there the bucket root IS the tenant's root, and
  // the `users|orgs|groups` scan below finds nothing under them. See
  // tenantBucketRoots for how that kept this check green over 22 open roots.
  const buckets = await probeTenantBucketRoots({ tenantRoots, unlistedRoots }, { opendir, access });
  if (buckets.open) return true;
  if (buckets.error) return null;

  let asked = buckets.asked;
  for (const mp of legacy) {
    for (const parent of parents) {
      const parentPath = path.join(mp, parent);

      // First try the cheap, decisive question: can this uid LIST the parent?
      // If it can, the tree is wide open and no tenant name is needed.
      try {
        const dir = await opendir(parentPath);
        await dir.close();
        return true;
      } catch (err) {
        if (err?.code !== "EACCES" && err?.code !== "ENOENT") return null;
        if (err?.code === "ENOENT") continue;
      }

      // EACCES on the parent means no ENUMERATION — which on `0771` is not the
      // same as no ACCESS: `--x` still lets a known name walk straight through,
      // which is why a closed port was an insufficient conclusion and why the
      // loop below exists.
      //
      // But `0770` denies traversal too, and THAT is decisive without any
      // tenant name: if this uid cannot execute the parent, no name it could
      // have guessed would have helped. Asking costs one syscall and turns the
      // whole check from "unknown, because the port that leaks names is shut"
      // into a positive statement — which matters because the fence being
      // effective is exactly what makes the name-discovery route blind. A probe
      // that cannot recognise its own success reports a false red forever, and
      // the next person makes it green the easy way.
      let traversable = true;
      try {
        await access(parentPath, fsConstantsX());
      } catch (err) {
        if (err?.code === "EACCES") traversable = false;
      }
      if (!traversable) {
        // Answered, and answered "shut". Counted so the verdict below is
        // `false` rather than `null`.
        asked += 1;
        continue;
      }

      for (const name of tenantNames) {
        for (const leaf of ["workspace", ".snapshots"]) {
          const p = path.join(parentPath, name, leaf);
          asked += 1;
          try {
            const dir = await opendir(p);
            await dir.close();
            return true;
          } catch (err) {
            if (err?.code === "ENOENT") continue;
            if (err?.code !== "EACCES") return null;
          }
          try {
            await access(p, fsConstantsW());
            return true;
          } catch {
            /* not writable either — this one is genuinely shut */
          }
        }
      }
    }
  }

  // A walkable mount root whose buckets could not be listed: not a "closed".
  if (buckets.unknown) return null;
  // Nothing was reachable. That is only a "closed" if we actually asked about
  // something; with no tenant names and no listable parent we asked nothing.
  return asked > 0 ? false : null;
}

function fsConstantsX() {
  return 0o1; // fs.constants.X_OK — traversal, which is what a known name needs
}

function fsConstantsW() {
  // Imported lazily so the module stays trivially loadable in environments
  // where node:fs constants are stubbed by a test.
  return 0o2; // fs.constants.W_OK
}

/**
 * Tenant names, obtained the way an attacker on this host would: from the
 * filer's own anonymous listing. Returns `[]` when that door is already shut —
 * which is correct, and is why `probeTenantTreeAccessible` reports `null`
 * rather than `false` when it has no names to try. Once the port is closed, the
 * honest statement about the filesystem is "not measured by this route", and
 * the runbook's own verification step covers it with a name taken from root.
 */
export async function discoverTenantNames({ filerAddress, mountPoints, limit = 5, timeoutMs = 6000 }, fetchImpl = fetch) {
  if (!filerAddress || !Array.isArray(mountPoints) || mountPoints.length === 0) return [];
  const bucket = path.basename(mountPoints[0]);
  const url = `http://${filerAddress.host}:${filerAddress.port}/buckets/${bucket}/users/?limit=${limit}`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const body = await res.json();
    return (body?.Entries ?? []).map((e) => path.basename(String(e?.FullPath ?? ""))).filter(Boolean);
  } catch {
    return [];
  }
}

/** Read the live mount table. Separated so the parse can be tested without it. */
export async function readProcMounts() {
  return await fsp.readFile("/proc/mounts", "utf8");
}

/**
 * Every per-tenant bucket root under the mounts: `{ roots, unlisted }`.
 *
 * WHY THIS EXISTS (2026-09-26, F-GRP). Since 09-07/09-09 a migrated tenant has
 * its own bucket, `ws-<kind>-<id>`, and there the BUCKET ROOT is the tenant's
 * root — there is no `users/` parent to fence. `tenantParentRoots` handed these
 * buckets to the `users|orgs|groups` scan, which found ENOENT under every one
 * and moved on; the check stayed green on the strength of the fenced
 * `cm-agent-artifacts/users` while all 22 `ws-*` roots were `drwxrwxrwx` (two
 * owned by uid 1000), and a process running as the login account walked into
 * every isolated tenant's workspace. The fix is the fence on each root
 * (docs/ops/ava-workspace-group-access.md); this is what tells us it holds.
 *
 * ROOT mount: the listing, filtered to names `tenantBucketName` could have made
 * (the rule lives in workspace/tenant-store.mjs). A listing that FAILS is
 * reported in `unlisted` — never folded into an empty answer, which would read
 * as "no tenants, nothing to check". PER-BUCKET mount of a tenant bucket: the
 * mount point is the tenant's root.
 */
export function tenantBucketRoots(mounts, readdir) {
  const roots = new Set();
  const unlisted = [];
  for (const m of mounts ?? []) {
    const remote = String(m?.remotePath ?? "").replace(/\/+$/, "");
    const isRoot = remote === "/buckets" || remote === "";
    if (!isRoot) {
      if (isTenantBucketName(path.basename(remote))) roots.add(m.mountPoint);
      continue;
    }
    let names;
    try {
      names = readdir(m.mountPoint) ?? [];
    } catch {
      unlisted.push(m.mountPoint);
      continue;
    }
    for (const name of names) if (isTenantBucketName(name)) roots.add(path.join(m.mountPoint, name));
  }
  return { roots: [...roots], unlisted };
}

/**
 * The per-tenant bucket half of `probeTenantTreeAccessible`: `{ open }`,
 * `{ error }`, or `{ asked, unknown }`.
 *
 * A root this uid cannot traverse is shut, and that is decisive: nothing below
 * it is reachable, whatever the modes inside say. A root it CAN traverse is open
 * if it is writable — `workspace` can then be renamed away and replaced with a
 * directory this uid owns, into which the tenant's next sandbox writes — or if
 * either fixed child (`workspace`, `.snapshots`; the names are not secrets) can
 * be listed or written. A root mount whose buckets could not be listed but can
 * be walked is `unknown`: tenant ids appear in URLs and logs, so the roots are
 * reachable by name even when this uid cannot enumerate them.
 */
async function probeTenantBucketRoots({ tenantRoots = [], unlistedRoots = [] }, { opendir, access }) {
  let asked = 0;
  const canDo = async (p, mode) => {
    try {
      await access(p, mode);
      return true;
    } catch (err) {
      if (err?.code === "EACCES") return false;
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  };
  try {
    for (const root of tenantRoots) {
      const walk = await canDo(root, fsConstantsX());
      if (walk === null) continue; // gone between the listing and now
      asked += 1;
      if (walk === false) continue; // fenced: decisive for everything below
      if (await canDo(root, fsConstantsW())) return { open: true };
      for (const leaf of ["workspace", ".snapshots"]) {
        const p = path.join(root, leaf);
        asked += 1;
        try {
          const dir = await opendir(p);
          await dir.close();
          return { open: true };
        } catch (err) {
          if (err?.code === "ENOENT") continue;
          if (err?.code !== "EACCES") return { error: true };
        }
        if (await canDo(p, fsConstantsW())) return { open: true };
      }
    }
    let unknown = false;
    for (const mp of unlistedRoots) {
      const walk = await canDo(mp, fsConstantsX());
      if (walk === false) asked += 1;
      else if (walk === true) unknown = true;
    }
    return { asked, unknown };
  } catch {
    return { error: true };
  }
}

/**
 * The whole check, end to end, from this process's own uid. Returns a verdict.
 *
 * `deps` (readProcMounts, readdir, opendir, access, fetch) exist so the whole
 * composition can be run against a fake tree in tests — the live test at the end
 * of host-filer-exposure.test.mjs is the only caller that measures this host.
 */
export async function checkHostFilerExposure({ env = process.env, mountRoot, uid, deps = {} } = {}) {
  const root = mountRoot ?? String(env?.SANDBOX_HOST_MOUNT_ROOT ?? "/mnt/ava").trim() ?? "/mnt/ava";
  const readMounts = deps.readProcMounts ?? readProcMounts;
  const readdir = deps.readdir ?? ((dir) => fsSync.readdirSync(dir));
  const fetchImpl = deps.fetch ?? fetch;
  let mounts = [];
  try {
    mounts = parseSeaweedMounts(await readMounts(), root);
  } catch {
    return hostExposureVerdict({ applicable: null, filerAnonymousRead: null, tenantTreeAccessible: null });
  }
  if (mounts.length === 0) return hostExposureVerdict({ applicable: false });

  const effectiveUid = uid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  const filerAddress = { host: mounts[0].host, port: mounts[0].port };
  const acknowledged = String(env?.[HOST_ACK_ENV] ?? "").trim() === "1";

  if (effectiveUid === 0) {
    return hostExposureVerdict({ applicable: true, privileged: true, filerAddress, acknowledged: false });
  }

  // NOT `mounts.map(m => m.mountPoint)`: under a ROOT mount the tenant parents
  // are a level below the mount point, one per bucket. See tenantParentRoots.
  const mountPoints = tenantParentRoots(mounts, readdir);
  // …and every per-tenant bucket root, which that scan cannot see.
  const buckets = tenantBucketRoots(mounts, readdir);
  const filerAnonymousRead = await probeAnonymousFilerRead({ filerAddress }, fetchImpl);
  const tenantNames = await discoverTenantNames({ filerAddress, mountPoints }, fetchImpl);
  const tenantTreeAccessible = await probeTenantTreeAccessible(
    { mountPoints, tenantNames, tenantRoots: buckets.roots, unlistedRoots: buckets.unlisted },
    { opendir: deps.opendir, access: deps.access },
  );

  return hostExposureVerdict({
    applicable: true,
    privileged: false,
    filerAnonymousRead,
    tenantTreeAccessible,
    acknowledged,
    filerAddress,
  });
}
