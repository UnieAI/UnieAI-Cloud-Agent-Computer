/**
 * workspace.mjs — the folder the user picked, turned into a path the daemon
 * will act on.
 *
 * WHAT THE USER SAW (2026-09-04). The composer's machine chip read「evan」on
 * `ip-172-31-6-187`. Asked 「這個資料夾呢」 the agent answered about
 * /home/ubuntu — the machine's HOME — and listed `service/`, `perplexica-src/`,
 * `worktrees/`, `.config/`, `.dsh/`. The machine was resolved correctly; the
 * folder was not. What it cost: nothing failed. `ls` succeeded, `read`
 * succeeded, a `write` would have landed — one or more directories above the
 * project the person was pointing at, beside their other work, and the only way
 * to notice was to recognise the file names.
 *
 * TWO ROOTS, AND THEY ARE NOT THE SAME THING.
 *   · The GRANTED root (`allowed_roots[0]`; the daemon's `grantedRoot`) is the
 *     security boundary. It is chosen once, on the machine itself, at pairing.
 *     Nothing here can widen it: the daemon re-checks every path against it
 *     with `containPath`, symlinks resolved, and refuses `outside_root`.
 *   · The PICKED folder (`last_workspace`; `machine.root`) is where the work
 *     happens. It is normally a subdirectory of the granted root and the user
 *     changes it from the composer whenever they switch projects.
 * Only the second one is this function's business. A path it produces is still
 * offered to the device for judgement, and a picked folder that sits outside
 * the grant is refused there exactly as it was before.
 *
 * WHY IT LIVES IN THE PROTOCOL PACKAGE, next to the approval rules rather than
 * inside whichever component happened to need it first. The value it returns is
 * part of the approval SUBJECT the daemon hashes: sandbox-runtime puts it on
 * the invoke frame, and the app hashes it into the token the daemon verifies
 * against that frame. Those two have to agree character for character. A second
 * copy of this rule that differs by a trailing slash is not a wrong path — it
 * is `approval_rejected: payload_mismatch` on someone's own laptop, which reads
 * as "my computer rejected Ava" and has no obvious cause.
 *
 * The join deliberately mirrors `joinRoot` in sandbox-runtime's ssh backend
 * (cube/ssh.mjs), the sibling implementation of the same cube contract: a
 * leading slash means "relative to the workspace", not "absolute", so a path
 * can only ever be contained further, never escape sideways.
 */

/** Windows roots arrive with backslashes and an optional drive letter. */
const DRIVE = /^[A-Za-z]:/;

/** Normalise `a/./b`, `a//b` and a trailing slash away, without touching `..`. */
function tidySegments(segments) {
  const out = [];
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    out.push(seg);
  }
  return out;
}

/**
 * The picked folder, normalised — or "" when there is no folder to join to.
 *
 * "" and "/" both mean "no project chosen". That is not a quibble: joining
 * under "/" would turn `README.md` into `/README.md`, and the daemon resolves
 * an absolute path AS GIVEN (`path.resolve` discards the root when the tail is
 * absolute), so every such path would land outside the granted root and be
 * refused. Doing nothing is the only correct answer here.
 */
function normalizeRoot(root) {
  const raw = String(root ?? "").replace(/\\/g, "/").trim();
  if (!raw || raw === "/") return "";
  const drive = DRIVE.test(raw) ? raw.slice(0, 2) : "";
  const body = drive ? raw.slice(2) : raw;
  if (!drive && !body.startsWith("/")) return ""; // not an absolute folder — nothing to anchor to
  const joined = tidySegments(body.split("/")).join("/");
  return `${drive}/${joined}`.replace(/\/+$/, "") || (drive ? `${drive}/` : "/");
}

/**
 * Join a workspace-relative path onto the folder the user picked.
 *
 * @param {string|null|undefined} root      the picked folder (`machine.root` / `last_workspace`)
 * @param {string|null|undefined} requested a path relative to that folder; "", "." and "/" mean the folder itself
 * @returns {string|null} the path to send the daemon, `requested` unchanged when
 *   there is no picked folder, or `null` when the path climbs out of it — the
 *   caller refuses that rather than guessing (sandbox-runtime raises
 *   `workspace_escape`; the app throws).
 */
export function workspacePath(root, requested) {
  const base = normalizeRoot(root);
  const raw = String(requested ?? "").replace(/\\/g, "/").trim();
  // No project chosen: leave the path exactly as it arrived. Every machine
  // paired before a folder was ever picked depends on this.
  if (!base) return raw;

  const rel = raw.replace(/^\/+/, "");
  const segments = tidySegments(rel.split("/"));
  if (!segments.length) return base;

  const out = [];
  for (const seg of segments) {
    if (seg !== "..") {
      out.push(seg);
      continue;
    }
    // `..` may cancel a segment we just added; it may never climb past the
    // picked folder. The daemon would refuse that anyway — refusing it here
    // means the attempt never reaches the user's machine at all.
    if (!out.length) return null;
    out.pop();
  }
  return out.length ? `${base}/${out.join("/")}` : base;
}
