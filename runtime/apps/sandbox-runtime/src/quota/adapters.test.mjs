import test from "node:test";
import assert from "node:assert/strict";

import { createWeedShellControl } from "./filer-control.mjs";
import { createTenantLister } from "./tenants.mjs";

const P = (id) => `/buckets/ws-user-${id}/workspace/`;

test("filer 控制：current 解析 fs.configure 印出的 JSON（前後有雜訊也行），只回 readOnly 的前綴", async () => {
  const out = `some banner\n{\n  "version": 1,\n  "locations": [\n    {"locationPrefix": "${P("a")}", "readOnly": true},\n    {"locationPrefix": "/buckets/x/", "readOnly": false},\n    {"locationPrefix": "/etc/y/", "readOnly": true}\n  ]\n}\n> `;
  const c = createWeedShellControl({ exec: async () => out });
  assert.deepEqual([...(await c.current())].sort(), [P("a"), "/etc/y/"].sort(), "別人的唯讀規則也要讀進來（計畫會忽略它們，但不能假裝不存在）");
});

test("filer 控制：讀不到／不是 JSON → 丟錯（強制器因此什麼都不寫）", async () => {
  await assert.rejects(createWeedShellControl({ exec: async () => "error: filer: connection refused" }).current());
  await assert.rejects(createWeedShellControl({ exec: async () => "{ not json" }).current());
  await assert.rejects(createWeedShellControl({ exec: async () => { throw new Error("docker exec failed"); } }).current());
});

test("filer 控制：apply 只組出白名單前綴的指令；不合的前綴整批拒絕（不可能被注入 shell 指令）", async () => {
  const calls = [];
  const c = createWeedShellControl({ exec: async (lines) => { calls.push(lines); return "ok"; } });
  await c.apply({ add: [P("a")], remove: [P("b")] });
  assert.deepEqual(calls[0], [
    `fs.configure -locationPrefix=${P("a")} -readOnly=true -apply`,
    `fs.configure -locationPrefix=${P("b")} -delete -apply`,
  ]);
  for (const bad of ["/buckets/ws-user-a/", "/buckets/ws-user-a/workspace/ -delete", "/buckets/ws-user-a/workspace/\nfs.rm -r /", "/etc/", "/buckets/ws-user-a/workspace/;x/"]) {
    await assert.rejects(c.apply({ add: [bad], remove: [] }), /not a managed prefix/, JSON.stringify(bad));
  }
  assert.equal(calls.length, 1, "壞前綴一個指令都不能送出去");
});

test("filer 控制：shell 輸出裡有 error 行 → apply 丟錯", async () => {
  const c = createWeedShellControl({ exec: async () => "error: filer: rpc error" });
  await assert.rejects(c.apply({ add: [P("a")], remove: [] }), /fs\.configure failed/);
});

test("租戶列舉：白名單內的隔離租戶用自己的 bucket 前綴；舊共用 bucket 的租戶用 users/groups/orgs；被隔離的不重複列", async () => {
  const lister = createTenantLister({
    env: { SANDBOX_ISOLATED_TENANTS: "user:iso1,org:o1", S3_BUCKET: "shared" },
    listCommonPrefixes: async ({ at }) => ({ "users/": ["users/iso1/", "users/leg1/"], "groups/": ["groups/g1/"], "orgs/": ["orgs/o1/"] })[at.key] ?? [],
  });
  const got = (await lister()).map((t) => [t.owner, t.prefix]).sort((a, b) => a[1].localeCompare(b[1]));
  assert.deepEqual(got, [
    ["group:g1", "/buckets/shared/groups/g1/workspace/"],
    ["org:o1", "/buckets/ws-org-o1/workspace/"],
    ["user:iso1", "/buckets/ws-user-iso1/workspace/"],
    ["user:leg1", "/buckets/shared/users/leg1/workspace/"],
  ].sort((a, b) => a[1].localeCompare(b[1])));
});

test("租戶列舉：WEED_S3_BUCKET 不影響列舉 —— 沙盒掛載讀的就是 S3_BUCKET（自 2026-09-07 起），列別的 bucket 會把唯讀鎖上在沒人寫的地方", async () => {
  const lister = createTenantLister({
    env: { S3_BUCKET: "store", WEED_S3_BUCKET: "agent-fs" },     // .env 長這樣；ava-sandbox.service 的 env 根本沒有 WEED_S3_BUCKET
    listCommonPrefixes: async ({ at }) => (at.key === "users/" ? ["users/u1/"] : []),
  });
  const prefixes = (await lister()).map((t) => t.prefix).sort();
  assert.deepEqual(prefixes, ["/buckets/store/users/u1/workspace/"]);
});

// 「同一條規則兩份實作」：quota 列的 bucket，必須就是沙盒真的掛載的那個。直接拿真的掛載解析器對照。
test("租戶列舉與沙盒掛載解析器對同一個舊租戶給同一個 bucket（不管 WEED_S3_BUCKET 設什麼）", async () => {
  const { resolveWorkspaceLocation } = await import("../cube/docker.mjs");
  const saved = { S3_BUCKET: process.env.S3_BUCKET, WEED_S3_BUCKET: process.env.WEED_S3_BUCKET, SANDBOX_ISOLATED_TENANTS: process.env.SANDBOX_ISOLATED_TENANTS };
  try {
    for (const weed of [undefined, "agent-fs", "store"]) {
      process.env.S3_BUCKET = "store";
      delete process.env.SANDBOX_ISOLATED_TENANTS;
      if (weed === undefined) delete process.env.WEED_S3_BUCKET; else process.env.WEED_S3_BUCKET = weed;
      const mounted = resolveWorkspaceLocation({ workspaceMode: "user", workspaceOwner: "user:u1" });
      const lister = createTenantLister({
        env: { S3_BUCKET: "store", ...(weed === undefined ? {} : { WEED_S3_BUCKET: weed }) },
        listCommonPrefixes: async ({ at }) => (at.key === "users/" ? ["users/u1/"] : []),
      });
      const listed = (await lister()).map((t) => t.prefix);
      assert.deepEqual(listed, [`/buckets/${mounted.bucket}/${mounted.subpath}/`], `WEED_S3_BUCKET=${weed}`);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("租戶列舉：沒有 SANDBOX_ISOLATED_TENANTS、全部在共用 bucket 也行；列表失敗就丟（強制器整輪放棄）", async () => {
  const ok = createTenantLister({ env: { S3_BUCKET: "shared" }, listCommonPrefixes: async ({ at }) => (at.key === "users/" ? ["users/u1/"] : []) });
  assert.equal((await ok()).length, 1);
  const bad = createTenantLister({ env: { S3_BUCKET: "shared" }, listCommonPrefixes: async () => { throw new Error("s3 down"); } });
  await assert.rejects(bad(), /s3 down/);
});

test("租戶列舉：SANDBOX_ISOLATED_TENANTS=all 時，每個 ws-<kind>-<id> bucket 都是隔離租戶，舊 bucket 裡同名的那份不再列", async () => {
  const lister = createTenantLister({
    env: { SANDBOX_ISOLATED_TENANTS: "all", S3_BUCKET: "shared" },
    listIsolatedBuckets: async () => ["ws-user-a", "ws-org-o1", "cm-agent-artifacts", "agent-fs"],
    listCommonPrefixes: async ({ at }) => (at.key === "users/" ? ["users/a/", "users/legacyonly/"] : []),
  });
  const got = (await lister()).map((t) => t.prefix).sort();
  assert.deepEqual(got, ["/buckets/shared/users/legacyonly/workspace/", "/buckets/ws-org-o1/workspace/", "/buckets/ws-user-a/workspace/"]);
});

test("filer 控制：listBuckets 只回合法的 bucket 名稱", async () => {
  const c = createWeedShellControl({ exec: async () => "ws-user-a\nws-org-o1\nagent-fs\n> \nBad_Name\n" });
  assert.deepEqual(await c.listBuckets(), ["ws-user-a", "ws-org-o1", "agent-fs"]);
});
