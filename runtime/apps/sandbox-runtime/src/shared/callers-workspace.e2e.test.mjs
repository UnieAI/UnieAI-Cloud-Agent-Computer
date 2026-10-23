/**
 * shared/callers-workspace.e2e.test.mjs — the bytes, not just the sandboxes (CAC P1).
 *
 * callers.e2e.test.mjs proves two callers get separate sandboxes. This one
 * proves the thing that actually matters to a tenant: a file one caller writes
 * for its user `u1` is not what another caller's `u1` reads. Real server, real
 * workspace store, on the local-disk backend (STORAGE_LOCAL_FS) so the bytes
 * land somewhere this test can look at directly.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const STUDIO_KEY = "studio-ws-key";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cac-ws-"));

process.env.SANDBOX_MODE = "cube";
process.env.SANDBOX_PORT = "0";
process.env.SANDBOX_INTERNAL_TOKEN = "legacy-ws-token";
process.env.SANDBOX_ENFORCE_OWNERSHIP = "";
process.env.STORAGE_LOCAL_FS = "1";
process.env.STORAGE_LOCAL_FS_ROOT = root;
process.env.STORAGE_LOCAL_FS_BUCKET = "cac-ws";
process.env.AGENT_WORKSPACE_S3 = "1";
process.env.CAC_CALLERS = JSON.stringify([{ id: "studio", namespace: "studio", key_sha256: sha(STUDIO_KEY) }]);

import test, { after } from "node:test";
import assert from "node:assert/strict";

const { server, matchRoute } = await import("../server.mjs");
const { readFile } = await import("../workspace/userStore.mjs");
server.listen(0, "127.0.0.1");
const base = await new Promise((resolve) => {
  if (server.listening) return resolve(`http://127.0.0.1:${server.address().port}`);
  server.once("listening", () => resolve(`http://127.0.0.1:${server.address().port}`));
});
after(async () => {
  server.close();
  await fs.rm(root, { recursive: true, force: true });
});

const LEGACY = process.env.SANDBOX_INTERNAL_TOKEN;
const as = (key, user, extra = {}) => ({ authorization: `Bearer ${key}`, "x-sandbox-user-id": user, ...extra });

async function put(key, user, rel, text, extra) {
  assert.ok(matchRoute("POST", `/v1/users/${user}/workspace/file`));
  const r = await fetch(`${base}/v1/users/${user}/workspace/file?path=${encodeURIComponent(rel)}`, {
    method: "POST", headers: { ...as(key, user, extra), "content-type": "text/plain" }, body: text,
  });
  return { status: r.status, text: await r.text() };
}
async function get(key, user, rel, extra) {
  assert.ok(matchRoute("GET", `/v1/users/${user}/workspace/file`));
  const r = await fetch(`${base}/v1/users/${user}/workspace/file?path=${encodeURIComponent(rel)}`, { headers: as(key, user, extra) });
  return { status: r.status, text: await r.text() };
}

test("two callers' u1 write the same path and each reads back its own bytes", async () => {
  const s = await put(STUDIO_KEY, "u1", "notes.txt", "studio-bytes");
  const c = await put(LEGACY, "u1", "notes.txt", "copilot-bytes");
  assert.equal(s.status, 200, s.text);
  assert.equal(c.status, 200, c.text);
  assert.equal((await get(STUDIO_KEY, "u1", "notes.txt")).text, "studio-bytes");
  assert.equal((await get(LEGACY, "u1", "notes.txt")).text, "copilot-bytes");
});

test("on disk, the namespaced caller's bytes live under its own owner", async () => {
  assert.equal(String(await readFile("studio--u1", "notes.txt")), "studio-bytes");
  assert.equal(String(await readFile("u1", "notes.txt")), "copilot-bytes");
});

test("a shared (group) workspace is namespaced too", async () => {
  const w = await put(STUDIO_KEY, "u1", "plan.md", "studio-group", { "x-workspace-owner": "group:g1" });
  assert.equal(w.status, 200, w.text);
  assert.equal((await get(STUDIO_KEY, "u1", "plan.md", { "x-workspace-owner": "group:g1" })).text, "studio-group");
  const crossed = await get(LEGACY, "u1", "plan.md", { "x-workspace-owner": "group:g1" });
  assert.equal(crossed.status, 404, `copilot-v2's group:g1 is a different group: ${crossed.text}`);
  assert.equal(String(await readFile("group:studio--g1", "plan.md")), "studio-group");
});

test("the shared token cannot reach into the namespace by spelling it out", async () => {
  const r = await get(LEGACY, "studio--u1", "notes.txt");
  assert.equal(r.status, 403, r.text);
  const g = await get(LEGACY, "u1", "plan.md", { "x-workspace-owner": "group:studio--g1" });
  assert.equal(g.status, 403, g.text);
});
