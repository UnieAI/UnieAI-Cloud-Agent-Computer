/**
 * routes.test.mjs — the relay over real HTTP: a throwaway server mounting the
 * five handlers, a fake daemon driven with fetch. Ports the three scenarios of
 * the old llm-runtime desktop-relay e2e test and adds streaming, status and
 * revoke. No sandbox, no docker, no DB.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { relayRoutes } from "./routes.mjs";
import { invoke, _resetForTest } from "./registry.mjs";
import { parseFrame } from "../../../../packages/ava-local-protocol/src/protocol.mjs";

function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    for (const route of relayRoutes) {
      const m = route.method === req.method && route.pattern.exec(url.pathname);
      if (!m) continue;
      try {
        await route.handler(req, res, { params: m.groups || {}, requestId: "t" });
      } catch (err) {
        res.writeHead(err?.status || 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: err?.code || "internal", message: err?.message } }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

/** A minimal daemon: opens the SSE stream and yields parsed frames. */
async function openStream(base, machineId, userId = "u1") {
  const res = await fetch(`${base}/v1/relay/connect`, { headers: { "x-machine-id": machineId, "x-machine-user-id": userId } });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const queue = [];
  const waiters = [];
  let ended = false;
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { ended = true; waiters.splice(0).forEach((w) => w(null)); break; }
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (block.startsWith(":")) continue;
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!data) continue;
        const parsed = parseFrame(data + "\n");
        const frame = parsed.ok ? parsed.frame : { type: "__invalid__", reason: parsed.reason, raw: data };
        const w = waiters.shift();
        if (w) w(frame); else queue.push(frame);
      }
    }
  })();
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : ended ? Promise.resolve(null) : new Promise((r) => waiters.push(r)));
  return { next, close: () => reader.cancel().catch(() => {}), isEnded: () => ended };
}

const post = (base, path, headers, body) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("connect → ready, hello registers, invoke round-trips through HTTP, status reports online", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  try {
    const daemon = await openStream(base, "m-a");
    const ready = await daemon.next();
    assert.equal(ready.type, "ready");

    const hello = await post(base, "/v1/relay/hello", { "x-machine-id": "m-a" }, {
      machine: { platform: "linux", arch: "x64", daemonVersion: "0.1.0", grantedRoot: "/w" }, ops: ["exec", "readFile"],
    });
    assert.equal(hello.status, 200);

    const status = await (await fetch(`${base}/v1/relay/machines/m-a/status`)).json();
    assert.equal(status.online, true);
    assert.equal(status.info.platform, "linux");

    const pending = invoke({ machineId: "m-a", op: "readFile", args: { path: "a.txt" }, timeoutMs: 2000 });
    const inv = await daemon.next();
    assert.equal(inv.type, "invoke");
    assert.equal(inv.op, "readFile");
    const result = await post(base, "/v1/relay/result", { "x-machine-id": "m-a" }, { id: inv.id, ok: true, output: { contentBase64: "aGk=" } });
    assert.equal(result.status, 200);
    const r = await pending;
    assert.equal(r.ok, true);
    assert.equal(r.output.contentBase64, "aGk=");
    daemon.close();
  } finally {
    server.close();
  }
});

test("a connection becomes online only after hello, including reconnect", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  const streams = [];
  const status = async () => (await fetch(`${base}/v1/relay/machines/m-ready/status`)).json();
  try {
    assert.equal((await status()).online, false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const daemon = await openStream(base, "m-ready"); streams.push(daemon);
      await daemon.next();
      const connecting = await status();
      assert.equal(connecting.online, false, "An open transport without capabilities is still connecting");
      assert.equal(connecting.info, null);
      const hello = await post(base, "/v1/relay/hello", { "x-machine-id": "m-ready" }, {
        machine: { platform: "linux", arch: "x64", daemonVersion: "fixture", grantedRoot: "/w" }, ops: ["sessionAuthorize"],
      });
      assert.equal(hello.status, 200);
      const ready = await status();
      assert.equal(ready.online, true);
      assert.deepEqual(ready.ops, ["sessionAuthorize"]);
    }
  } finally {
    await Promise.all(streams.map(stream => stream.close()));
    server.closeAllConnections(); server.close();
  }
});

test("exec streams partial results before the final exit", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  try {
    const daemon = await openStream(base, "m-b");
    await daemon.next();
    const events = [];
    const pending = invoke({ machineId: "m-b", op: "exec", args: { command: "ls" }, timeoutMs: 2000, onEvent: (e) => events.push(e) });
    const inv = await daemon.next();
    await post(base, "/v1/relay/result", { "x-machine-id": "m-b" }, { id: inv.id, ok: true, partial: true, output: { stream: "stdout", data: "a\n" } });
    await post(base, "/v1/relay/result", { "x-machine-id": "m-b" }, { id: inv.id, ok: true, output: { exit: { code: 0, signal: null } } });
    const r = await pending;
    assert.equal(r.ok, true);
    assert.equal(events.length, 1);
    assert.equal(r.output.exit.code, 0);
    daemon.close();
  } finally {
    server.close();
  }
});

test("hello before connect is 409; a result for an unknown id is 404; a missing machine id is 400", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  try {
    const h = await post(base, "/v1/relay/hello", { "x-machine-id": "m-c" }, { machine: { platform: "linux", arch: "x64", daemonVersion: "0", grantedRoot: "/" }, ops: [] });
    assert.equal(h.status, 409);
    const daemon = await openStream(base, "m-c");
    await daemon.next();
    const r = await post(base, "/v1/relay/result", { "x-machine-id": "m-c" }, { id: "nope", ok: true, output: {} });
    assert.equal(r.status, 404);
    const bad = await post(base, "/v1/relay/result", {}, { id: "x", ok: true });
    assert.equal(bad.status, 400);
    daemon.close();
  } finally {
    server.close();
  }
});

test("revoke pushes a revoke frame, ends the stream and the machine goes offline", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  try {
    const daemon = await openStream(base, "m-d");
    await daemon.next();
    const rv = await post(base, "/v1/relay/machines/m-d/revoke", {}, { reason: "user clicked remove" });
    // 撤銷回報三件事，不是一件：關掉的連線、放掉的 sandbox 登記列、忘掉的憑證
    // principal。這個測試沒開任何 sandbox，所以後兩個是 0 —— 但它們**必須在**，
    // 不然「撤銷了」這句話只涵蓋三分之一。有 sandbox 的那條在
    // pool/machine-revocation.e2e.test.mjs。
    assert.deepEqual(await rv.json(), { revoked: true, sandboxes_released: 0, cert_principals_forgotten: 0 });
    const frame = await daemon.next();
    assert.equal(frame.type, "revoke");
    assert.equal(frame.reason, "user clicked remove");
    const after = await daemon.next();
    assert.equal(after, null, "stream ended after revoke");
    const status = await (await fetch(`${base}/v1/relay/machines/m-d/status`)).json();
    assert.equal(status.online, false);
    const again = await (await post(base, "/v1/relay/machines/m-d/revoke", {}, {})).json();
    assert.equal(again.revoked, false);
  } finally {
    server.close();
  }
});

test("ad-hoc invoke serves reads for the folder browser and refuses anything else", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  try {
    const daemon = await openStream(base, "m-e");
    await daemon.next();
    const pending = post(base, "/v1/relay/machines/m-e/invoke", {}, { op: "listFiles", args: { path: "/" } });
    const inv = await daemon.next();
    assert.equal(inv.op, "listFiles");
    await post(base, "/v1/relay/result", { "x-machine-id": "m-e" }, { id: inv.id, ok: true, output: { entries: [{ name: "src", isDirectory: true }] } });
    const r = await (await pending).json();
    assert.equal(r.ok, true);
    assert.equal(r.output.entries[0].name, "src");
    const bad = await post(base, "/v1/relay/machines/m-e/invoke", {}, { op: "exec", args: { command: "ls" } });
    assert.equal(bad.status, 400);
    daemon.close();
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
/**
 * 地端外掛清單（pluginInventory）走這扇門 —— 唯讀、不需要票。
 *
 * 這扇門有自己的白名單，而那正是 `agentSession` 當年漏掉的形狀：daemon 實作了、
 * 協定清單有、app 呼叫了，**中間這一格少一個字串**，使用者看到的是 400。
 */
test("ad-hoc invoke carries pluginInventory (read-only, no approval) to the device", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  try {
    const daemon = await openStream(base, "m-pi");
    await daemon.next();
    const pending = post(base, "/v1/relay/machines/m-pi/invoke", {}, { op: "pluginInventory", args: { preset: "cordis" } });
    const inv = await daemon.next();
    assert.equal(inv.op, "pluginInventory");
    assert.equal(inv.args.preset, "cordis");
    await post(base, "/v1/relay/result", { "x-machine-id": "m-pi" }, { id: inv.id, ok: true, output: { entries: [{ id: "tool-cordis" }] } });
    const r = await (await pending).json();
    assert.equal(r.ok, true);
    assert.equal(r.output.entries[0].id, "tool-cordis");
    daemon.close();
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// The ad-hoc invoke door: reads free, writes only with an approval attached.
// Added 2026-09-02 when the file panel and upload button started using this
// door for the machine the composer is pointed at.
// ---------------------------------------------------------------------------

test("the ad-hoc door refuses an unknown op, and a write without an approval", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  try {
    const daemon = await openStream(base, "m-w");
    await daemon.next();

    // exec is not a file operation and never travels this way.
    const noExec = await post(base, "/v1/relay/machines/m-w/invoke", {}, { op: "exec", args: { command: "ls" } });
    assert.equal(noExec.status, 400);
    assert.match((await noExec.json()).error.message, /does not allow "exec"/);

    // A write with no token: refused before it can reach the machine.
    const bare = await post(base, "/v1/relay/machines/m-w/invoke", {}, { op: "writeFile", args: { path: "a.txt", contentBase64: "aGk=" } });
    assert.equal(bare.status, 400);
    assert.match((await bare.json()).error.message, /needs an approval token/);

    // An empty string is not a token either — the classic falsy-but-present bug.
    const empty = await post(base, "/v1/relay/machines/m-w/invoke", {}, { op: "writeFile", args: { path: "a.txt" }, approval: "" });
    assert.equal(empty.status, 400);

    daemon.close();
  } finally {
    server.close();
  }
});

test("the ad-hoc door carries a write WITH an approval, and the token reaches the device", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  try {
    const daemon = await openStream(base, "m-x");
    await daemon.next();
    const pending = post(base, "/v1/relay/machines/m-x/invoke", {}, {
      op: "writeFile",
      args: { path: "notes.md", contentBase64: "aGk=" },
      approval: "avl-approval-token",
    });
    const inv = await daemon.next();
    assert.equal(inv.op, "writeFile");
    // The token must arrive BESIDE args, where the daemon looks for it. Nested
    // inside args it is invisible to the device and the write is refused there
    // as unapproved — which reads as "the upload silently does nothing".
    assert.equal(inv.approval, "avl-approval-token");
    assert.equal(inv.args.path, "notes.md");
    await post(base, "/v1/relay/result", { "x-machine-id": "m-x" }, { id: inv.id, ok: true, output: { path: "notes.md", bytes: 2 } });
    const r = await (await pending).json();
    assert.equal(r.ok, true);
    assert.equal(r.output.bytes, 2);
    daemon.close();
  } finally {
    server.close();
  }
});

// 2026-09-26 UAT 軌道 C（P0）：檔案面板存的是 daemon 遮蔽後的內容，照寫回去會把電腦上
// 真正的祕密換成 `[redacted:…]`。這扇門必須在票之前、在碰到機器之前拒收。
test("a write carrying redaction markers is refused before it reaches the machine — even with a token", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  try {
    const daemon = await openStream(base, "m-r");
    await daemon.next();
    const body = Buffer.from("API_URL=https://x\nOPENAI_API_KEY=[redacted:openai-key]\n").toString("base64");
    const res = await post(base, "/v1/relay/machines/m-r/invoke", {}, { op: "writeFile", args: { path: ".env", contentBase64: body }, approval: "avl-approval-token" });
    assert.equal(res.status, 409);
    const j = await res.json();
    assert.equal(j.error.code, "redacted_content");
    assert.match(j.error.message, /\[redacted:openai-key\]/);
    daemon.close();
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// 大檔上傳（ava-local 0.2.19）：writeFileChunk 只進 daemon 自己的暫存資料夾，
// 不碰授權資料夾，所以這扇門不要票 —— 真正的把關是 commit（writeFile + stagedId）
// 在使用者機器上驗的那張票。遮蔽記號照樣在這裡先擋一次（便宜的早一點說不）。
// ---------------------------------------------------------------------------

test("the ad-hoc door carries writeFileChunk without a token, and the chunk reaches the device", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  try {
    const daemon = await openStream(base, "m-c");
    await daemon.next();
    const pending = post(base, "/v1/relay/machines/m-c/invoke", {}, {
      op: "writeFileChunk",
      args: { uploadId: "up-12345678", offset: 0, dataBase64: "aGk=" },
    });
    const inv = await daemon.next();
    assert.equal(inv.op, "writeFileChunk");
    assert.equal(inv.args.uploadId, "up-12345678");
    await post(base, "/v1/relay/result", { "x-machine-id": "m-c" }, { id: inv.id, ok: true, output: { uploadId: "up-12345678", received: 2 } });
    const r = await (await pending).json();
    assert.equal(r.ok, true);
    assert.equal(r.output.received, 2);
    daemon.close();
  } finally {
    server.close();
  }
});

// 位元組安全的讀取（0.2.27）：跟 readFile 同一類（讀，不要票），而且不是任何寫入類的後門。
test("the ad-hoc door carries readFileBytes without a token, as a read", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  try {
    const daemon = await openStream(base, "m-rb");
    await daemon.next();
    const pending = post(base, "/v1/relay/machines/m-rb/invoke", {}, { op: "readFileBytes", args: { path: "a.xlsx", offset: 0, length: 1024 } });
    const inv = await daemon.next();
    assert.equal(inv.op, "readFileBytes");
    assert.equal(inv.args.path, "a.xlsx");
    await post(base, "/v1/relay/result", { "x-machine-id": "m-rb" }, { id: inv.id, ok: true, output: { contentBase64: "AA==", size: 1, offset: 0, bytesRead: 1, eof: true, encoding: "binary" } });
    const r = await (await pending).json();
    assert.equal(r.ok, true);
    assert.equal(r.output.encoding, "binary");
    daemon.close();
  } finally {
    server.close();
  }
});

test("a chunk carrying a redaction marker is refused at the door", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  try {
    const daemon = await openStream(base, "m-cr");
    await daemon.next();
    const data = Buffer.from("KEY=[redacted:openai-key]\n").toString("base64");
    const res = await post(base, "/v1/relay/machines/m-cr/invoke", {}, { op: "writeFileChunk", args: { uploadId: "up-12345678", offset: 0, dataBase64: data } });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "redacted_content");
    daemon.close();
  } finally {
    server.close();
  }
});

test("a commit (writeFile with stagedId) still needs a token at the door", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  try {
    const daemon = await openStream(base, "m-cc");
    await daemon.next();
    const res = await post(base, "/v1/relay/machines/m-cc/invoke", {}, { op: "writeFile", args: { path: "big.bin", stagedId: "up-12345678" } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /needs an approval token/);
    daemon.close();
  } finally {
    server.close();
  }
});

// ── hello 對帳：daemon 報「我手上有哪些終端機」，伺服器答「哪些我不認得」──────────────
// 終端機的 id 就是 terminalOpen 那個 invoke 的 id；伺服器「認得」＝這條連線的 pending 表裡還有它。
// 連線一斷（sandbox-runtime 重啟、daemon 重連）所有 pending 都已結算，舊的終端機網頁不可能再接回，
// PTY 卻還留在使用者的電腦上 —— daemon 靠這個回應把它們收掉（ava-local/src/terminal.ts 的 reclaim）。
test("hello 帶 terminals：回 unknownTerminals＝不在這條連線 pending 裡的那些", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  try {
    const daemon = await openStream(base, "m-t");
    assert.equal((await daemon.next()).type, "ready");
    // 一個還開著的長壽 invoke（像 terminalOpen）：伺服器認得它的 id。
    const open = invoke({ machineId: "m-t", invokeId: "term-known", op: "terminalOpen", args: {}, timeoutMs: 5000 });
    const inv = await daemon.next();
    assert.equal(inv.id, "term-known");

    const hello = await post(base, "/v1/relay/hello", { "x-machine-id": "m-t" }, {
      machine: { platform: "linux" }, ops: ["terminalOpen"], terminals: ["term-known", "term-ghost", "term-ghost"],
    });
    assert.equal(hello.status, 200);
    const body = await hello.json();
    assert.deepEqual(body.unknownTerminals, ["term-ghost"]);       // 認得的不列；重複的只列一次

    daemon.close();
    void open.catch(() => {});
  } finally { server.close(); _resetForTest(); }
});

test("hello 沒帶 terminals（舊 daemon）：回應沒有 unknownTerminals 這個欄位", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  try {
    const daemon = await openStream(base, "m-old");
    assert.equal((await daemon.next()).type, "ready");
    const hello = await post(base, "/v1/relay/hello", { "x-machine-id": "m-old" }, { machine: { platform: "linux" }, ops: [] });
    assert.equal(hello.status, 200);
    assert.equal("unknownTerminals" in (await hello.json()), false);
    daemon.close();
  } finally { server.close(); }
});

test("hello 的 terminals 不是字串陣列、或含怪東西：只處理合法的字串，不丟錯", async () => {
  _resetForTest();
  const { server, base } = await startServer();
  try {
    const daemon = await openStream(base, "m-odd");
    assert.equal((await daemon.next()).type, "ready");
    const mk = (terminals) => post(base, "/v1/relay/hello", { "x-machine-id": "m-odd" }, { machine: { platform: "linux" }, ops: [], terminals });
    assert.equal((await (await mk("nope")).json()).unknownTerminals, undefined);          // 不是陣列 → 當作沒帶
    assert.deepEqual((await (await mk(["ok", 5, null, { a: 1 }, "x".repeat(500)])).json()).unknownTerminals, ["ok"]);
    const many = Array.from({ length: 1000 }, (_, i) => `t${i}`);
    assert.equal((await (await mk(many)).json()).unknownTerminals.length, 64);             // 上限 64 個
    daemon.close();
  } finally { server.close(); }
});

test("plugin management relays validated reads and approved changes with a bounded install deadline", async () => {
  _resetForTest();
  const {server,base}=await startServer();
  let daemon;
  try {
    daemon=await openStream(base,"m-plugin"); await daemon.next();
    const url="/v1/relay/machines/m-plugin/invoke";
    for (const call of [{action:"install",spec:"example@1.0.0",requestId:"probe",enabled:false},{action:"configure",id:"probe",config:{}}]) {
      const response=await post(base,url,{}, {op:"pluginManage",args:{call}}); assert.equal(response.status,400);
    }
    assert.equal((await post(base,url,{}, {op:"pluginManage",args:{call:{action:"exec",command:"arbitrary"}},approval:"ticket"})).status,400);
    for (const call of [{action:"list"},{action:"install",spec:"example@1.0.0",requestId:"probe",enabled:false,approvedBuilds:["one"]}]) {
      const pending=post(base,url,{}, {op:"pluginManage",args:{call},timeoutMs:3600000,...(call.action==="install"?{approval:"device-ticket"}:{})});
      const frame=await daemon.next(); assert.equal(frame.op,"pluginManage"); assert.deepEqual(frame.args.call,call);
      assert.equal(frame.deadlineMs,call.action==="install"?900000:60000);
      assert.equal(frame.approval,call.action==="install"?"device-ticket":undefined);
      await post(base,"/v1/relay/result",{"x-machine-id":"m-plugin"},{id:frame.id,ok:true,output:{value:{ready:true}}});
      assert.equal((await (await pending).json()).output.value.ready,true);
    }
  } finally {daemon?.close();server.close();}
});

test("browser preparation crosses the real relay route; changes require approval and bounded input", async () => {
  _resetForTest();
  const {server,base}=await startServer();
  const daemon=await openStream(base,'m-browser-setup');await daemon.next();
  try {
    const endpoint='/v1/relay/machines/m-browser-setup/invoke';
    const status=post(base,endpoint,{}, {op:'browserSetup',args:{call:{action:'status'}}});
    const frame=await daemon.next();assert.equal(frame.op,'browserSetup');assert.deepEqual(frame.args,{call:{action:'status'}});
    await post(base,'/v1/relay/result',{'x-machine-id':'m-browser-setup'},{id:frame.id,ok:true,output:{browsers:[]}});
    assert.equal((await status).status,200);
    const call={action:'setup',browser:'chrome',mode:'headless'};
    assert.equal((await post(base,endpoint,{}, {op:'browserSetup',args:{call}})).status,400);
    assert.equal((await post(base,endpoint,{}, {op:'browserSetup',approval:'signed',args:{call:{...call,command:'arbitrary'}}})).status,400);
    const setup=post(base,endpoint,{}, {op:'browserSetup',approval:'signed',args:{call}});
    const approved=await daemon.next();assert.equal(approved.approval,'signed');assert.deepEqual(approved.args,{call});
    await post(base,'/v1/relay/result',{'x-machine-id':'m-browser-setup'},{id:approved.id,ok:true,output:{ready:true}});
    assert.deepEqual(await (await setup).json(),{ok:true,output:{ready:true}});
  } finally {await daemon.close();server.closeAllConnections();server.close();}
});
