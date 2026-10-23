/**
 * terminal/stream-headers.test.mjs —— `GET /terminals/:id/stream` 的標頭在連上的那一刻就要送出。
 *
 * 跟 ava-engine/test/terminal-sse.test.mjs 同一個缺陷、同一個形狀：`attachTerminal` 只 `res.writeHead`，
 * 開場重播環是空的（shell 還沒印任何東西）時沒有任何一次 write，標頭要等 20 秒的 `: beat`。
 * 引擎是在背景接這條串流（不擋 open），但「標頭等第一個位元組」是同一個錯，而且任何直接讀這條串流的人都會中。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";

const { openTerminal, attachTerminal, closeTerminal, _resetTerminals } = await import("./registry.mjs");

function fakeBackend() {
  return {
    async openTerminal() {
      const h = new EventEmitter();
      h.write = async () => true;
      h.close = async () => {};
      h.resize = async () => true;
      return h;
    },
  };
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ac = new AbortController();
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, ac.signal);
  } finally {
    ac.abort();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

test("開場重播環是空的：標頭 1 秒內就到（修之前是 20 秒）", async () => {
  _resetTerminals();
  const { terminalId } = await openTerminal({ sandboxId: "sb1", backend: fakeBackend(), spec: {}, attachDeadlineMs: 0 });
  await withServer((req, res) => attachTerminal("sb1", terminalId, res), async (base, signal) => {
    const t0 = Date.now();
    const res = await fetch(`${base}/`, { signal });
    const ms = Date.now() - t0;
    assert.equal(res.status, 200);
    assert.ok(ms < 1000, `標頭花了 ${ms} ms`);
  });
  await closeTerminal("sb1", terminalId);
});

test("有開場輸出時：先是 `: ready`，接著補發的那一段（資料沒有被標頭那一行吃掉）", async () => {
  _resetTerminals();
  const backend = fakeBackend();
  let handle;
  const orig = backend.openTerminal;
  backend.openTerminal = async (...a) => { handle = await orig(...a); return handle; };
  const { terminalId } = await openTerminal({ sandboxId: "sb2", backend, spec: {}, attachDeadlineMs: 0 });
  handle.emit("data", Buffer.from("prompt$ "));
  await withServer((req, res) => attachTerminal("sb2", terminalId, res), async (base, signal) => {
    const res = await fetch(`${base}/`, { signal });
    const reader = res.body.getReader();
    let text = "";
    while (!text.includes("event: data")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString();
    }
    assert.ok(text.startsWith(": ready\n\n"), text);
    assert.match(text, /event: data\ndata: \{"data":"cHJvbXB0JCA="\}/);
  });
  await closeTerminal("sb2", terminalId);
});
