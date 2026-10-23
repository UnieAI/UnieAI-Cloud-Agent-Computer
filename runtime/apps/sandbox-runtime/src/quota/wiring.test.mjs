/**
 * 接線釘住（行為在 quota.test.mjs；這裡確認門真的掛在每一條寫入路徑上）。
 * 檢查成對：宣告大小的串流上傳、沒宣告／必須 buffer 的上傳、寫入成功後的快取增量、狀態與上限兩條路由。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const upload = read("../files/user-workspace-upload.mjs");
const server = read("../server.mjs");

test("串流上傳：傳之前就用宣告的大小比對剩餘空間", () => {
  const at = upload.indexOf("return await streamUpload(");
  assert.ok(at > 0);
  assert.match(upload.slice(at - 400, at), /quotaService\.check\(\{ owner: ownerKey, relPath, incomingBytes: declared \}\)/);
});

test("buffer 上傳：宣告了就先比對；沒宣告讀完再比對；兩條成功路徑都把增量記進快取", () => {
  assert.match(upload, /if \(declared !== null\) await quotaService\.check\(/);
  assert.match(upload, /if \(declared === null\) await quotaService\.check\(\{ owner: ownerKey, relPath, incomingBytes: body\.length \}\)/);
  assert.equal((upload.match(/quotaService\.noteWrite\(/g) || []).length, 2);
});

test("刪除不經過閘（唯讀＋可刪）：DELETE 路由沒有 quotaService.check", () => {
  const at = server.indexOf('method: "DELETE",\n    pattern: /^\\/v1\\/users\\/(?<userId>[^/]+)\\/workspace\\/file');
  assert.ok(at > 0, "找不到 DELETE 路由");
  assert.doesNotMatch(server.slice(at, at + 3000), /quotaService\.check/);
});

test("狀態路由（GET …/workspace/quota）與上限推送路由（POST /v1/workspace-quota/limits）存在", () => {
  assert.match(server, /workspace\\\/quota\\\/\?\$\//);
  assert.match(server, /\\\/v1\\\/workspace-quota\\\/limits\\\/\?\$\//);
});
