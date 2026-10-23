/**
 * relay.test.mjs — the Rabi Local cube backend, driven with a fake registry so
 * no daemon, socket or timer is needed. What it pins: the invoke frames the
 * daemon will see (op, args, approval passthrough), how streamed results turn
 * into the exec handle's stdout/stderr/exit events, how daemon errors become
 * SandboxErrors, and which contract methods are honestly unsupported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createRelayClient } from "./relay.mjs";
import { SandboxError } from "../shared/error.mjs";

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

const machine = { id: "m-1", kind: "local", root: "/home/alice/work" };

async function collect(handle) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    handle.on("stdout", (c) => { stdout += String(c); });
    handle.on("stderr", (c) => { stderr += String(c); });
    handle.on("exit", (evt) => resolve({ stdout, stderr, exit: evt }));
    handle.drainBufferedEvents?.();
  });
}

test("createSandbox registers a connection-backed sandbox and refuses non-local machines", async () => {
  const reg = fakeRegistry();
  const client = createRelayClient(reg);
  const s = await client.createSandbox({ userId: "u1", sessionId: "s1", machine });
  assert.match(s.sandboxId, /^local-/);
  assert.equal(s.workspaceDir, "/home/alice/work");
  await assert.rejects(() => client.createSandbox({ machine: { id: "x", kind: "ssh" } }), (e) => e instanceof SandboxError && e.code === "bad_request");
  const offline = createRelayClient({ ...reg, online: () => false });
  await assert.rejects(() => offline.createSandbox({ machine }), (e) => e.code === "machine_offline" && e.status === 503);
});

test("execProcess sends one exec invoke with the approval and streams the daemon's output", async () => {
  const reg = fakeRegistry({
    exec: ({ onEvent }) => {
      onEvent({ stream: "stdout", data: "hello\n" });
      onEvent({ stream: "stderr", data: "warn\n" });
      return { ok: true, output: { exit: { code: 3, signal: null } } };
    },
  });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ userId: "u1", sessionId: "s1", machine });
  const handle = await client.execProcess(sandboxId, {
    kind: "bash", command: "npm test", env: { CI: "1" }, cwd: "pkg", timeoutMs: 5000, approval: "tok.sig",
  });
  const out = await collect(handle);
  assert.equal(out.stdout, "hello\n");
  assert.equal(out.stderr, "warn\n");
  assert.equal(out.exit.code, 3);
  const call = reg.calls.find((c) => c.op === "exec");
  assert.equal(call.machineId, "m-1");
  assert.equal(call.approval, "tok.sig");
  // `sandbox` is the per-command container opt-in on the user's own machine.
  // It travels on every exec so the daemon never has to guess, and defaults to
  // false — commands run on the machine unless the agent asked otherwise.
  // `cwd` arrives workspace-relative and leaves resolved under the folder the
  // user picked — the daemon would otherwise resolve it against the folder they
  // GRANTED at pairing (see relay-workspace.test.mjs).
  assert.deepEqual(call.args, { kind: "bash", command: "npm test", env: { CI: "1" }, cwd: "/home/alice/work/pkg", stdin: null, sandbox: false });
  assert.equal(call.timeoutMs, 5000);
});

test("the agent can ask for the container per command, and it defaults to off", async () => {
  const reg = fakeRegistry({ exec: { ok: true, output: { exit: { code: 0, signal: null } } } });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ machine });

  await collect(await client.execProcess(sandboxId, { command: "ls" }));
  assert.equal(reg.calls.at(-1).args.sandbox, false, "working on the user's own files is the default");

  await collect(await client.execProcess(sandboxId, { command: "npm i", sandbox: true }));
  assert.equal(reg.calls.at(-1).args.sandbox, true, "an install can be asked to run in the container");
});

test("raw kind is quoted into one bash command so the approval subject covers the arguments", async () => {
  const reg = fakeRegistry({ exec: { ok: true, output: { exit: { code: 0, signal: null } } } });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ machine });
  await collect(await client.execProcess(sandboxId, { kind: "raw", command: "git", args: ["log", "-1", "a b"] }));
  assert.equal(reg.calls.at(-1).args.command, "git log -1 'a b'");
  assert.equal(reg.calls.at(-1).args.kind, "bash");
});

test("a daemon error settles the handle with an exit that names the error", async () => {
  const reg = fakeRegistry({
    exec: { ok: false, output: { error: { code: "approval_required", message: "no valid approval" } } },
  });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ machine });
  const out = await collect(await client.execProcess(sandboxId, { kind: "bash", command: "rm -rf build" }));
  assert.equal(out.exit.code, null);
  assert.equal(out.exit.errorCode, "approval_required");
  assert.match(out.exit.error, /no valid approval/);
});

test("file operations map onto invoke ops and decode the daemon's answers", async () => {
  const reg = fakeRegistry({
    readFile: { ok: true, output: { contentBase64: Buffer.from("hi").toString("base64") } },
    statFile: { ok: true, output: { stat: { path: "a", size: 2, mtimeMs: 5, isFile: true, isDirectory: false } } },
    listFiles: { ok: true, output: { entries: [{ name: "a", path: "/a", isFile: true, isDirectory: false, size: 2, mtimeMs: 5 }] } },
  });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ machine });
  assert.equal((await client.readFile(sandboxId, "a")).toString("utf8"), "hi");
  await client.writeFile(sandboxId, "b", "content", { approval: "tok" });
  const w = reg.calls.find((c) => c.op === "writeFile");
  assert.equal(w.args.contentBase64, Buffer.from("content").toString("base64"));
  assert.equal(w.approval, "tok");
  assert.equal((await client.statFile(sandboxId, "a")).size, 2);
  assert.equal((await client.listFiles(sandboxId, "/")).length, 1);
  await client.deleteFile(sandboxId, "b", { approval: "tok2" });
  assert.equal(reg.calls.at(-1).approval, "tok2");
  await client.ensureDir(sandboxId, "dir");
  assert.equal(reg.calls.at(-1).op, "ensureDir");
});

test("a missing file stats to null; a containment refusal becomes workspace_escape", async () => {
  const reg = fakeRegistry({
    statFile: { ok: true, output: { stat: null } },
    readFile: { ok: false, output: { error: { code: "outside_root", message: "nope" } } },
  });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ machine });
  assert.equal(await client.statFile(sandboxId, "missing"), null);
  // The daemon's refusal, not ours: `a` is a legal workspace path, so this
  // exercises the outside_root → workspace_escape mapping rather than the
  // local guard (which relay-workspace.test.mjs covers with `../`).
  await assert.rejects(() => client.readFile(sandboxId, "a"), (e) => e instanceof SandboxError && e.code === "workspace_escape" && e.status === 400);
});

test("offline and timeout errors keep their codes so the app can say what happened", async () => {
  const reg = fakeRegistry({
    readFile: { ok: false, output: { error: { code: "machine_offline", message: "gone" } } },
    listFiles: { ok: false, output: { error: { code: "machine_timeout", message: "slow", retryable: true } } },
  });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ machine });
  await assert.rejects(() => client.readFile(sandboxId, "a"), (e) => e.code === "machine_offline" && e.status === 503);
  await assert.rejects(() => client.listFiles(sandboxId, "/"), (e) => e.code === "machine_timeout" && e.status === 504);
});

// 背景執行以前也在這一排（「honestly unsupported」）。它離開這一排是 2026-09-06 的
// 改動：daemon 那端一直都做得到，缺的只有一個夠長的 deadline —— 見檔案下半部
// 「背景執行（長駐處理程序）」那一組。快照與埠轉發還是真的沒有。
test("snapshots and tunnels are honestly unsupported", async () => {
  const client = createRelayClient(fakeRegistry());
  const { sandboxId } = await client.createSandbox({ machine });
  await assert.rejects(() => client.snapshotSandbox(sandboxId), (e) => e.code === "not_supported");
  await assert.rejects(() => client.openTunnel(sandboxId, { remotePort: 3000 }), (e) => e.code === "not_supported");
});

test("cancel sends a cancel op for the running invoke; destroy forgets the sandbox", async () => {
  let release;
  const reg = fakeRegistry({ exec: () => new Promise((r) => { release = r; }) });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ machine });
  const handle = await client.execProcess(sandboxId, { kind: "bash", command: "sleep 60" });
  handle.cancel();
  const cancel = reg.calls.find((c) => c.op === "cancel");
  assert.ok(cancel, "a cancel op was sent");
  // WHICH id it carries is asserted by the test below — it used to be
  // `handle.execId`, and that was the bug rather than the contract.
  release({ ok: true, output: { exit: { code: null, signal: "SIGTERM" } } });
  const out = await collect(handle);
  assert.equal(out.exit.signal, "SIGTERM");
  await client.destroySandbox(sandboxId);
  await assert.rejects(() => client.readFile(sandboxId, "a"), (e) => e.code === "sandbox_not_found");
});

/**
 * Cancel has to name the invocation the DAEMON knows about.
 *
 * The daemon registers a running command under the invoke frame's `id`
 * (`running.set(frame.id, child)` in tool-host.ts) and `cancel` looks it up by
 * `args.id`. This backend was sending its own local handle id — a value the
 * daemon has never seen — so every cancel found nothing, answered
 * `{cancelled:false}`, and the command kept running on the user's computer
 * until its timeout. Meanwhile sandbox-runtime had already finalized the exec
 * as "cancelled", so the UI said stopped and the machine disagreed.
 *
 * That is a bad failure to have on someone else's hardware: Stop is the control
 * a person reaches for when a command is doing something they did not intend.
 */
test("cancel names the same invocation id the exec was sent under", async () => {
  let release;
  const reg = fakeRegistry({
    exec: () => new Promise((r) => { release = () => r({ ok: true, output: { exit: { code: 143, signal: "SIGTERM" } } }); }),
    cancel: () => ({ ok: true, output: { cancelled: true } }),
  });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ userId: "u1", sessionId: "s1", machine });
  const handle = await client.execProcess(sandboxId, { kind: "bash", command: "sleep 300", approval: "tok.sig" });

  handle.cancel();
  const exec = reg.calls.find((c) => c.op === "exec");
  const cancel = reg.calls.find((c) => c.op === "cancel");
  assert.ok(cancel, "cancel must reach the machine at all");
  assert.ok(exec.invokeId, "the exec must be sent under an id this process chose, or it cannot refer to it later");
  assert.equal(
    cancel.args.id,
    exec.invokeId,
    "the daemon keys running children by the invoke frame id; anything else silently cancels nothing",
  );
  release();
  const { exit } = await collect(handle);
  assert.equal(exit.signal, "SIGTERM");
});

test("every invocation gets its own id — two execs are separately cancellable", async () => {
  const reg = fakeRegistry({ exec: () => new Promise(() => {}), cancel: () => ({ ok: true, output: { cancelled: true } }) });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ userId: "u1", sessionId: "s1", machine });
  const a = await client.execProcess(sandboxId, { command: "sleep 100" });
  const b = await client.execProcess(sandboxId, { command: "sleep 200" });
  const [execA, execB] = reg.calls.filter((c) => c.op === "exec");
  assert.notEqual(execA.invokeId, execB.invokeId, "a shared id would let one Stop kill the other command");
  a.cancel();
  assert.equal(reg.calls.filter((c) => c.op === "cancel").at(-1).args.id, execA.invokeId);
  b.cancel();
  assert.equal(reg.calls.filter((c) => c.op === "cancel").at(-1).args.id, execB.invokeId);
});

/**
 * ── 背景執行（長駐處理程序）────────────────────────────────────────────────
 *
 * 「在我的電腦上把專案跑起來」最後一步幾乎都是留下來跑的：dev server、watch、
 * `tail -f`。2026-09-04 實測那一步一定斷 —— `git clone` 與 `pnpm install` 都成功，
 * `pnpm dev:web` 卻在第 120 秒被殺掉，因為 daemon 的預設截止時間就是兩分鐘，
 * 而模型看到的只有 `exit code -1`。
 *
 * 下面幾條釘的是那個修法的四個前提：deadline 要送得夠長、這一輪不能等它、
 * 分級要看得到真正的那一行指令、Stop 要真的送得到 daemon 的 cancel。
 */

/** 只給長駐用的假機器：exec 永遠不結束，但可以隨時吐輸出或喊結束。 */
function longLivedRegistry({ onExec = null, cancel = () => ({ ok: true, output: { cancelled: true } }) } = {}) {
  let emit = null;
  let finish = null;
  const reg = fakeRegistry({
    exec: ({ onEvent, args, approval }) => {
      emit = onEvent;
      onExec?.({ args, approval });
      return new Promise((r) => { finish = r; });
    },
    cancel,
  });
  return {
    ...reg,
    emit: (stream, data) => emit?.({ stream, data }),
    finish: (output) => finish?.({ ok: true, output }),
  };
}

test("背景執行送得出去，而且這一輪不等它結束", async () => {
  const reg = longLivedRegistry();
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ userId: "u1", sessionId: "s1", machine });

  // 第一段輸出就代表 spawn 成功了 —— 起動窗不必等滿。
  const started = client.spawnLongLivedProcess(sandboxId, { command: "bash", args: ["-lc", "pnpm dev"] });
  setTimeout(() => reg.emit("stdout", "listening on :3000\n"), 5);
  const handle = await started;

  // 沒有 exit 就回來了 = 這一輪沒有等它。這是整件事的重點：
  // 舊的行為是等到 daemon 兩分鐘後把它殺掉才回。
  assert.ok(handle, "handle 要立刻拿得到");
  const call = reg.calls.find((c) => c.op === "exec");
  assert.equal(
    call.timeoutMs,
    24 * 60 * 60 * 1000,
    "deadline 就是唯一的真兇：送 daemon 的預設值（兩分鐘）等於第 120 秒被 SIGKILL",
  );

  // 回來之後才產生的輸出照樣送得到 handle 上（processManager 靠這個做鏡像）。
  const later = new Promise((r) => handle.on("stdout", (c) => r(String(c))));
  handle.drainBufferedEvents();
  reg.emit("stdout", "compiled\n");
  assert.match(await later, /listening|compiled/);
});

test("背景執行的指令是拆開來送的 —— 分級看得到真正的那一行", async () => {
  const reg = longLivedRegistry();
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ userId: "u1", sessionId: "s1", machine });
  const started = client.spawnLongLivedProcess(sandboxId, { command: "bash", args: ["-lc", "tail -f app.log"] });
  setTimeout(() => reg.emit("stdout", "x"), 5);
  await started;
  const call = reg.calls.find((c) => c.op === "exec");
  // daemon 自己就是用 `bash -lc` 跑的。再包一層的話 classifyCommand 讀到的第一個字
  // 永遠是 `bash`，於是連唯讀的 `tail -f` 都要使用者按核准 —— 而卡片上寫的是「bash」。
  assert.equal(call.args.command, "tail -f app.log");
  assert.equal(call.args.kind, "bash");
});

test("背景執行的 Stop 送得到 daemon 的 cancel，而且是同一個 invoke id", async () => {
  const reg = longLivedRegistry();
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ userId: "u1", sessionId: "s1", machine });
  const started = client.spawnLongLivedProcess(sandboxId, { command: "bash", args: ["-lc", "sleep 300"] });
  setTimeout(() => reg.emit("stdout", "up\n"), 5);
  const handle = await started;

  handle.cancel();
  const exec = reg.calls.find((c) => c.op === "exec");
  const cancel = reg.calls.find((c) => c.op === "cancel");
  assert.ok(cancel, "job_kill 要真的送到機器上，不然行程留在使用者的電腦上跑");
  assert.equal(cancel.args.id, exec.invokeId, "daemon 用 invoke frame 的 id 找子行程，送別的等於什麼都沒殺");

  // daemon 殺掉之後才回的那個 exit 要走得到 handle 上，否則工作永遠停在 running。
  const exited = new Promise((r) => handle.on("exit", r));
  handle.drainBufferedEvents();
  reg.finish({ exit: { code: null, signal: "SIGTERM" } });
  assert.equal((await exited).signal, "SIGTERM");
});

test("核准票跟著背景執行一起送出去", async () => {
  const reg = longLivedRegistry();
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ userId: "u1", sessionId: "s1", machine });
  const started = client.spawnLongLivedProcess(sandboxId, {
    command: "bash", args: ["-lc", "pnpm dev"], approval: "tok.sig", cwd: "app",
  });
  setTimeout(() => reg.emit("stdout", "x"), 5);
  await started;
  const call = reg.calls.find((c) => c.op === "exec");
  assert.equal(call.approval, "tok.sig", "沒有票的話會改東西的指令一律被拒 —— 背景執行只剩唯讀能用");
  assert.equal(call.args.cwd, "/home/alice/work/app", "cwd 跟前景走同一條路徑規則");
});

test("起不來要長得像起不來 —— daemon 的拒絕變成錯誤，不是一個馬上死掉的工作", async () => {
  const reg = fakeRegistry({
    exec: () => ({ ok: false, output: { error: { code: "approval_required", message: "needs the user's approval" } } }),
  });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ userId: "u1", sessionId: "s1", machine });
  await assert.rejects(
    () => client.spawnLongLivedProcess(sandboxId, { command: "bash", args: ["-lc", "pnpm dev"] }),
    (e) => e instanceof SandboxError && e.code === "approval_required" && e.status === 403,
    "回 201 再讓它立刻死掉的話，呼叫端走不到「領票再試一次」，模型讀到的是一段錯誤字串",
  );
});

test("短命的背景工作照樣把 exit 交出來，不會卡在 running", async () => {
  const reg = fakeRegistry({
    exec: ({ onEvent }) => {
      onEvent({ stream: "stdout", data: "done\n" });
      return { ok: true, output: { exit: { code: 0, signal: null } } };
    },
  });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ userId: "u1", sessionId: "s1", machine });
  const handle = await client.spawnLongLivedProcess(sandboxId, { command: "bash", args: ["-lc", "echo done"] });
  const out = await collect(handle);
  assert.equal(out.stdout, "done\n");
  assert.equal(out.exit.code, 0);
});

test("沙盒收掉時，它開的長駐行程一起收掉", async () => {
  const reg = longLivedRegistry();
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ userId: "u1", sessionId: "s1", machine });
  const started = client.spawnLongLivedProcess(sandboxId, { command: "bash", args: ["-lc", "sleep 300"] });
  setTimeout(() => reg.emit("stdout", "up\n"), 5);
  await started;
  await client.destroySandbox(sandboxId);
  const exec = reg.calls.find((c) => c.op === "exec");
  assert.equal(
    reg.calls.filter((c) => c.op === "cancel").at(-1)?.args.id,
    exec.invokeId,
    "少了這個，使用者關掉分頁之後 dev server 還留在他的電腦上跑",
  );
});

/**
 * 引擎送的是**那台機器上的絕對路徑**（它必須：核准票綁的就是 daemon 會看到的
 * 那個字串，而 daemon 是拿授權根去解，不是拿使用者挑的資料夾）。而
 * `workspacePath` 把開頭的斜線當成「相對於工作區」，會把它疊在自己身上：
 *
 *   workspacePath("/home/alice/work", "/home/alice/work") → "/home/alice/work/home/alice/work"
 *
 * 那就是 2026-09-06 那個 bug 往下一層的形狀 —— 從「跑錯資料夾」變成
 * `payload_mismatch`。已經在工作區裡面的絕對路徑要原樣通過。
 */
test("已經在工作區裡面的絕對路徑原樣通過，不會被疊成兩層", async () => {
  const reg = fakeRegistry({});
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ machine });

  await collect(await client.execProcess(sandboxId, { command: "pwd", cwd: "/home/alice/work" }));
  assert.equal(reg.calls.at(-1).args.cwd, "/home/alice/work", "工作區根目錄本身被疊了一層");

  await collect(await client.execProcess(sandboxId, { command: "pwd", cwd: "/home/alice/work/api" }));
  assert.equal(reg.calls.at(-1).args.cwd, "/home/alice/work/api", "子目錄被疊了一層");

  // 工作區相對路徑照舊：那是 file 操作與舊呼叫端在用的形狀。
  await collect(await client.execProcess(sandboxId, { command: "pwd", cwd: "api" }));
  assert.equal(reg.calls.at(-1).args.cwd, "/home/alice/work/api");
});

test("工作區外面的絕對路徑不會因此變成通行證", async () => {
  const reg = fakeRegistry({});
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ machine });
  // 前綴像但不是同一層（`/home/alice/workshop`）也不算在裡面。
  await collect(await client.execProcess(sandboxId, { command: "pwd", cwd: "/home/alice/workshop" }));
  assert.equal(reg.calls.at(-1).args.cwd, "/home/alice/work/home/alice/workshop", "界外的路徑要照舊被收進工作區，由 daemon 再判一次");
});

// daemon 0.2.19：readFile 收 offset/length 一頁一頁回。整檔讀的呼叫端（下載、
// artifact 保存）照樣拿到整個檔案，只是分頁拿 —— 不再撞 4 MB 的拒絕。
test("readFile pages through a new daemon and joins the pages; an old daemon's single answer is the whole file", async () => {
  const file = Buffer.from("row,of,data\n".repeat(900_000)); // ~10.8 MB
  const reg = fakeRegistry({
    readFile: ({ args }) => {
      const offset = args.offset ?? 0;
      let slice = file.subarray(offset, offset + Math.min(args.length ?? 4 << 20, 4 << 20));
      const eof = offset + slice.length >= file.length;
      if (!eof) slice = slice.subarray(0, slice.lastIndexOf(0x0a) + 1);
      return { ok: true, output: { contentBase64: slice.toString("base64"), size: file.length, offset, bytesRead: slice.length, eof: offset + slice.length >= file.length } };
    },
  });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ machine });
  const got = await client.readFile(sandboxId, "data.csv");
  assert.equal(Buffer.compare(got, file), 0);
  const reads = reg.calls.filter((c) => c.op === "readFile");
  assert.ok(reads.length >= 3);
  assert.ok(reads.every((c) => typeof c.args.offset === "number"));
});

// 2026-10-02：daemon 的簽章政策拒絕（使用者自己開的 strict）。relay 不認得這個 code 時收成 machine_error，
// **但訊息（為什麼、怎麼辦）與原 code（details.machineCode）必須保留** —— app 靠它們在終端機、工具卡、檔案面板
// 說出原因，而不是「連不上」（lib/machines/policy-refusal.ts 與 daemon 的 requireApproval 是同一份契約）。
test("a signature-policy refusal keeps the daemon's words and its original code", async () => {
  const why = "device approval refused: approval_not_verified — 要關掉這個模式：ava-local devices strict off";
  const reg = fakeRegistry({
    readFile: { ok: false, output: { error: { code: "approval_policy_refused", message: why, reason: "approval_not_verified" } } },
  });
  const client = createRelayClient(reg);
  const { sandboxId } = await client.createSandbox({ machine });
  await assert.rejects(
    () => client.readFile(sandboxId, "a"),
    (e) => e instanceof SandboxError && e.message === why && e.details?.machineCode === "approval_policy_refused" && e.code !== "approval_rejected",
  );
});

// ── a flaky network must not fail a whole turn (Evan, 2026-10-22: DNS blip, machine back within ~1s) ──

/** A fake registry whose clock only moves when the client sleeps; `up` is a function of that clock. */
function flaky({ script, up = () => true, conn = () => "c1" }) {
  const calls = [];
  let now = 0;
  const invoke = async ({ op }) => { calls.push(op); return script(calls.filter((c) => c === op).length, op); };
  return { calls, invoke, online: () => up(now), connectionId: conn, sleep: async (ms) => { now += ms; }, reconnectWaitMs: 5_000, tick: () => now };
}
const err = (code) => ({ ok: false, output: { error: { code, message: code, retryable: true } } });
const ok = (output = {}) => ({ ok: true, output });

test("a read that dies with the connection is repeated once after the machine is back, and the caller gets the answer", async () => {
  const reg = flaky({ script: (n) => (n === 1 ? err("machine_disconnected") : ok({ entries: [{ name: "a", type: "file" }] })) });
  const client = createRelayClient(reg);
  const s = await client.createSandbox({ userId: "u1", sessionId: "s1", machine });
  await client.listFiles(s.sandboxId, "/");
  assert.deepEqual(reg.calls, ["listFiles", "listFiles"]);
});

test("a timeout on the SAME connection is not repeated (a half-dead link would just time out twice); on a NEW connection it is", async () => {
  const same = flaky({ script: () => err("machine_timeout") });
  const c1 = createRelayClient(same);
  const s1 = await c1.createSandbox({ userId: "u", sessionId: "s", machine });
  await assert.rejects(() => c1.statFile(s1.sandboxId, "a"), (e) => e.code === "machine_timeout");
  assert.equal(same.calls.length, 1);

  let id = "c1";
  const replaced = flaky({ script: (n) => { if (n === 1) { id = "c2"; return err("machine_timeout"); } return ok({ exists: true }); }, conn: () => id });
  const c2 = createRelayClient(replaced);
  const s2 = await c2.createSandbox({ userId: "u", sessionId: "s", machine });
  await c2.statFile(s2.sandboxId, "a");
  assert.equal(replaced.calls.length, 2);
});

test("writes and deletes are never repeated (the failed attempt may have taken effect)", async () => {
  const reg = flaky({ script: () => err("machine_disconnected") });
  const client = createRelayClient(reg);
  const s = await client.createSandbox({ userId: "u", sessionId: "s", machine });
  await assert.rejects(() => client.writeFile(s.sandboxId, "a.txt", Buffer.from("x")), (e) => e.code === "machine_offline");
  await assert.rejects(() => client.deleteFile(s.sandboxId, "a.txt"), (e) => e.code === "machine_offline");
  assert.deepEqual(reg.calls, ["writeFile", "deleteFile"]);
});

test("a machine that is offline right now is waited for BEFORE anything is sent — for any op — and then the call goes through", async () => {
  let phase = "up";
  const reg = flaky({ script: () => ok(), up: (t) => phase === "up" || t >= 1_000 });
  const client = createRelayClient(reg);
  const s = await client.createSandbox({ userId: "u", sessionId: "s", machine });
  phase = "down"; // offline until 1 s of waiting has passed
  await client.writeFile(s.sandboxId, "a.txt", Buffer.from("x"));
  assert.deepEqual(reg.calls, ["writeFile"], "sent exactly once, after the machine came back");
  assert.ok(reg.tick() >= 1_000 && reg.tick() < 5_000, `waited ${reg.tick()}ms`);
});

test("still offline after the wait: the old, honest error — and the wait is bounded", async () => {
  let up = true;
  const reg = flaky({ script: () => err("machine_offline"), up: () => up });
  const client = createRelayClient(reg);
  const s = await client.createSandbox({ userId: "u", sessionId: "s", machine });
  up = false;
  await assert.rejects(() => client.listFiles(s.sandboxId, "/"), (e) => e.code === "machine_offline");
  assert.ok(reg.tick() >= 5_000 && reg.tick() <= 5_250, `waited ${reg.tick()}ms (budget 5000)`);
});
