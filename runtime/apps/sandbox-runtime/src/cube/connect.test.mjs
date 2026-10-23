import { test } from "node:test";
import assert from "node:assert/strict";

import { connectUnary, connectServerStream } from "./connect.mjs";

// Build a Connect envelope (5-byte header + payload).
function envelope(flags, payloadStr) {
  const payload = Buffer.from(payloadStr, "utf-8");
  const hdr = Buffer.alloc(5);
  hdr[0] = flags;
  hdr.writeUInt32BE(payload.length, 1);
  return Buffer.concat([hdr, payload]);
}

function streamFrom(buffers) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < buffers.length) {
        controller.enqueue(buffers[i++]);
      } else {
        controller.close();
      }
    }
  });
}

function mockResponse({ ok = true, status = 200, json: jsonBody, stream }) {
  return {
    ok,
    status,
    headers: new Headers({ "content-type": "application/connect+json" }),
    body: stream || null,
    async json() { return jsonBody; }
  };
}

test("unary call POSTs to {base}/{service}/{method} with correct headers", async () => {
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts };
    return mockResponse({ json: { ok: 1 } });
  };
  const result = await connectUnary({
    baseUrl: "https://e.example/",
    service: "filesystem.Filesystem",
    method: "ListDir",
    body: { path: "/", depth: 1 },
    auth: { "x-access-token": "tok123" },
    fetchImpl: fakeFetch
  });
  assert.deepEqual(result, { ok: 1 });
  assert.equal(captured.url, "https://e.example/filesystem.Filesystem/ListDir");
  assert.equal(captured.opts.method, "POST");
  assert.equal(captured.opts.headers["content-type"], "application/json");
  assert.equal(captured.opts.headers["connect-protocol-version"], "1");
  assert.equal(captured.opts.headers["x-access-token"], "tok123");
  assert.deepEqual(JSON.parse(captured.opts.body), { path: "/", depth: 1 });
});

test("unary call surfaces non-200 as ConnectError with code/message from body", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 403,
    async json() { return { code: "permission_denied", message: "nope" }; }
  });
  await assert.rejects(
    () => connectUnary({ baseUrl: "https://x", service: "S", method: "M", fetchImpl: fakeFetch }),
    (err) => err.code === "permission_denied" && /nope/.test(err.message) && err.status === 403
  );
});

test("server-streaming yields each envelope as a JSON message", async () => {
  const buffers = [
    envelope(0x00, JSON.stringify({ event: { start: { pid: 42 } } })),
    envelope(0x00, JSON.stringify({ event: { data: { stdout: "aGVsbG8=" } } })),
    envelope(0x00, JSON.stringify({ event: { end: { exitCode: 0, exited: true } } })),
    envelope(0x01, JSON.stringify({})) // trailer
  ];
  const fakeFetch = async () => mockResponse({ stream: streamFrom(buffers) });
  const gen = connectServerStream({
    baseUrl: "https://e",
    service: "process.Process",
    method: "Start",
    body: {},
    fetchImpl: fakeFetch
  });
  const messages = [];
  for await (const m of gen) messages.push(m);
  assert.equal(messages.length, 4);
  assert.equal(messages[0].event.start.pid, 42);
  assert.equal(messages[1].event.data.stdout, "aGVsbG8=");
  assert.equal(messages[2].event.end.exitCode, 0);
  assert.equal(messages[3].__trailer, true);
});

test("server-streaming reassembles envelopes split across chunks", async () => {
  const full = envelope(0x00, JSON.stringify({ event: { start: { pid: 7 } } }));
  const trailer = envelope(0x01, JSON.stringify({}));
  // Split: 3 bytes of header, then 2 bytes + first half of payload, then rest
  const buffers = [
    full.slice(0, 3),
    full.slice(3, 7),
    full.slice(7),
    trailer
  ];
  const fakeFetch = async () => mockResponse({ stream: streamFrom(buffers) });
  const gen = connectServerStream({ baseUrl: "https://e", service: "S", method: "M", fetchImpl: fakeFetch });
  const messages = [];
  for await (const m of gen) messages.push(m);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].event.start.pid, 7);
  assert.equal(messages[1].__trailer, true);
});

test("server-streaming trailer with error throws ConnectError", async () => {
  const buffers = [
    envelope(0x00, JSON.stringify({ event: { start: { pid: 1 } } })),
    envelope(0x01, JSON.stringify({ error: { code: "internal", message: "boom" } }))
  ];
  const fakeFetch = async () => mockResponse({ stream: streamFrom(buffers) });
  const gen = connectServerStream({ baseUrl: "https://e", service: "S", method: "M", fetchImpl: fakeFetch });
  await assert.rejects(
    async () => { for await (const _ of gen) { /* drain */ } },
    (err) => err.code === "internal" && /boom/.test(err.message)
  );
});

test("server-streaming pre-stream non-200 throws ConnectError synchronously", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 502,
    async json() { return { code: "bad_gateway", message: "upstream down" }; }
  });
  await assert.rejects(async () => {
    const gen = connectServerStream({ baseUrl: "https://e", service: "S", method: "M", fetchImpl: fakeFetch });
    for await (const _ of gen) { /* should not reach */ }
  }, (err) => err.code === "bad_gateway");
});

test("server-streaming handles empty envelope payload (length=0)", async () => {
  const buffers = [envelope(0x00, ""), envelope(0x01, "")];
  const fakeFetch = async () => mockResponse({ stream: streamFrom(buffers) });
  const gen = connectServerStream({ baseUrl: "https://e", service: "S", method: "M", fetchImpl: fakeFetch });
  const out = [];
  for await (const m of gen) out.push(m);
  // First (empty payload) parses to {}, second is trailer
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {});
  assert.equal(out[1].__trailer, true);
});
