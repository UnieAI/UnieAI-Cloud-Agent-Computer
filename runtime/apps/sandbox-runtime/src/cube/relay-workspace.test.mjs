/**
 * relay-workspace.test.mjs — the folder the user picked has to reach the daemon.
 *
 * WHAT THE USER SAW (2026-09-04). The composer's machine chip read「evan」on
 * `ip-172-31-6-187`. Asked 「這個資料夾呢」 the agent answered about
 * /home/ubuntu — the machine's HOME — and listed `service/`, `perplexica-src/`,
 * `worktrees/`, `.config/`, `.dsh/`. The MACHINE was right (those are that
 * computer's files); the FOLDER was not. The row was fine too: that machine has
 * `allowed_roots = ["/home/ubuntu"]` and `last_workspace` pointing at a
 * subdirectory. What went wrong is here — `machine.root` arrives in the
 * allocate payload, is stored on the sandbox entry, and is then used for
 * nothing but the `workspaceDir` field. Every path and every command went to
 * the daemon workspace-relative, and the daemon resolves those against the
 * folder GRANTED at pairing, so the agent read, wrote and ran commands one or
 * more directories above the project the person was pointing at — and the only
 * clue was recognising the file names.
 *
 * The cost: an answer that describes the wrong directory reads as a correct
 * answer. Nothing errors. `ls` succeeds, `read` succeeds, a `write` lands — in
 * the wrong place, next to the user's other projects.
 *
 * The sibling backend already does this: ssh.mjs joins every path against
 * `target.root` and spawns in it (`joinRoot`, cube/ssh.mjs). This file pins the
 * same behaviour for the Rabi Local backend, plus the two boundaries that must
 * NOT move: a machine with no folder chosen behaves exactly as it did, and the
 * granted root is still the daemon's to enforce.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createRelayClient } from "./relay.mjs";

function fakeRegistry(script = {}) {
  const calls = [];
  const invoke = async ({ machineId, op, args, approval, timeoutMs, onEvent, invokeId }) => {
    calls.push({ machineId, op, args, approval, timeoutMs, invokeId });
    const step = script[op];
    if (typeof step === "function") return step({ args, approval, onEvent });
    return step ?? { ok: true, output: {} };
  };
  return { calls, invoke, online: () => true };
}

/** Granted at pairing: /home/ubuntu. Picked in the composer: /home/ubuntu/evan. */
const picked = { id: "m-1", kind: "local", root: "/home/ubuntu/evan" };

const okExit = { ok: true, output: { exit: { code: 0, signal: null } } };

async function drain(handle) {
  return new Promise((resolve) => {
    handle.on("exit", resolve);
    handle.drainBufferedEvents?.();
  });
}

test("a command with no cwd runs in the folder the user picked, not the folder they granted", async () => {
  const reg = fakeRegistry({ exec: okExit });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ userId: "u1", sessionId: "s1", machine: picked });

  await drain(await client.execProcess(sandboxId, { command: "ls" }));

  const call = reg.calls.find((c) => c.op === "exec");
  // This is the frame the daemon spawns in. Sending no cwd means "the granted
  // root", which is how `ls` came back with the user's whole home directory.
  assert.equal(call.args.cwd, "/home/ubuntu/evan");
});

test("a relative cwd is resolved under the picked folder", async () => {
  const reg = fakeRegistry({ exec: okExit });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ machine: picked });

  await drain(await client.execProcess(sandboxId, { command: "npm test", cwd: "pkg" }));

  assert.equal(reg.calls.find((c) => c.op === "exec").args.cwd, "/home/ubuntu/evan/pkg");
});

test("every file op names a path inside the picked folder", async () => {
  const reg = fakeRegistry({
    readFile: { ok: true, output: { contentBase64: "" } },
    statFile: { ok: true, output: { stat: null } },
    listFiles: { ok: true, output: { entries: [] } },
  });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ machine: picked });

  await client.readFile(sandboxId, "README.md");
  await client.writeFile(sandboxId, "notes/todo.md", "x");
  await client.statFile(sandboxId, "README.md");
  await client.listFiles(sandboxId, "src");
  await client.deleteFile(sandboxId, "tmp.log");
  await client.ensureDir(sandboxId, "build");

  const pathOf = (op) => reg.calls.find((c) => c.op === op).args.path;
  assert.equal(pathOf("readFile"), "/home/ubuntu/evan/README.md");
  assert.equal(pathOf("writeFile"), "/home/ubuntu/evan/notes/todo.md");
  assert.equal(pathOf("statFile"), "/home/ubuntu/evan/README.md");
  assert.equal(pathOf("listFiles"), "/home/ubuntu/evan/src");
  assert.equal(pathOf("deleteFile"), "/home/ubuntu/evan/tmp.log");
  assert.equal(pathOf("ensureDir"), "/home/ubuntu/evan/build");
});

test("listing the workspace root lists the picked folder", async () => {
  const reg = fakeRegistry({ listFiles: { ok: true, output: { entries: [] } } });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ machine: picked });

  // files/download.mjs passes "/" for "the workspace root" (`relPath || "/"`).
  await client.listFiles(sandboxId, "/");
  await client.listFiles(sandboxId, "");

  for (const c of reg.calls) assert.equal(c.args.path, "/home/ubuntu/evan");
});

test("a path that climbs out of the picked folder is refused before it reaches the machine", async () => {
  const reg = fakeRegistry();
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ machine: picked });

  await assert.rejects(
    () => client.readFile(sandboxId, "../secrets.env"),
    (e) => e.code === "workspace_escape" && e.status === 400,
  );
  assert.equal(reg.calls.length, 0, "nothing should have been sent to the machine");
});

test("NEAR MISS: a machine with no folder chosen behaves exactly as it did", async () => {
  // No `root` in the allocate payload — resolveCurrentMachine falls back to the
  // cloud when there is no folder at all, so this is the shape that reaches the
  // relay from anything that allocates without one. Paths must stay
  // workspace-relative: joining them under "/" would make them absolute, and
  // the daemon resolves an absolute path AS GIVEN (path.resolve discards the
  // root when the tail is absolute), so every one of them would come back
  // `outside_root`. Fixing the folder must not break the machines that never
  // picked one.
  const reg = fakeRegistry({ exec: okExit, readFile: { ok: true, output: { contentBase64: "" } } });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ machine: { id: "m-2", kind: "local" } });

  await client.readFile(sandboxId, "README.md");
  await drain(await client.execProcess(sandboxId, { command: "ls" }));

  assert.equal(reg.calls.find((c) => c.op === "readFile").args.path, "README.md");
  assert.equal(reg.calls.find((c) => c.op === "exec").args.cwd, undefined);
});
