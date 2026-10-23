/**
 * cube/s3-credentials.test.mjs — the ONE object-store credential rule, tested
 * once. Both backends (docker.mjs, client.mjs) call these helpers; this file
 * pins the rule itself, while each backend's own test file pins that the rule
 * is actually reached on its create path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  S3_CREDENTIAL_ENV_VARS,
  applyS3CredentialPolicy,
  isS3CredentialOmitMode,
  stripS3Credentials,
} from "./s3-credentials.mjs";

test("isS3CredentialOmitMode: only an exact (case/space-insensitive) 'omit' omits", () => {
  assert.equal(isS3CredentialOmitMode("omit"), true);
  assert.equal(isS3CredentialOmitMode("  OMIT "), true);
  // Everything else — unset, empty, a typo — is today's behaviour.
  assert.equal(isS3CredentialOmitMode(undefined), false);
  assert.equal(isS3CredentialOmitMode(""), false);
  assert.equal(isS3CredentialOmitMode("inject"), false);
  assert.equal(isS3CredentialOmitMode("ommit"), false);
  assert.equal(isS3CredentialOmitMode("omit "), true);
  assert.equal(isS3CredentialOmitMode(null), false);
});

// `mode: undefined` 讓預設值從 `process.env.SANDBOX_DEFAULT…` 讀 —— 也就是
// **繼承環境**。這個 repo 的測試前置會載入 `.env`，而正式環境刻意設
// `SANDBOX_S3_CREDENTIALS=omit`，所以這一條在任何載 .env 的跑法下都是紅的，
// 紅在一個已經被刻意改掉的行為上。（它因此躺在 test-coverage 基線裡 ——
// 「沒有人跑」把這個紅藏了起來。）
//
// 要測的性質是「非 omit 的模式會注入」，跟環境無關，所以明著給 mode。
test("applyS3CredentialPolicy: 非 omit 的模式會注入憑證（注入 mode，不繼承環境）", () => {
  const env = applyS3CredentialPolicy({ WORKSPACE_BUCKET: "b" }, {
    mode: "inject", accessKey: "AKIAFAKE", secretKey: "shh",
  });
  assert.equal(env.S3_ACCESS_KEY, "AKIAFAKE");
  assert.equal(env.S3_SECRET_KEY, "shh");
  assert.equal(env.WORKSPACE_BUCKET, "b");
});

test("applyS3CredentialPolicy: omit strips every alias, including smuggled ones", () => {
  const env = applyS3CredentialPolicy(
    { WORKSPACE_BUCKET: "b", S3_ACCESS_KEY: "sneaky", AWS_SECRET_ACCESS_KEY: "sneaky" },
    { mode: "omit", accessKey: "AKIAFAKE", secretKey: "shh" },
  );
  for (const key of S3_CREDENTIAL_ENV_VARS) {
    assert.ok(!(key in env), `${key} must be absent, not blank`);
  }
  assert.equal(env.WORKSPACE_BUCKET, "b");
});

test("applyS3CredentialPolicy does not mutate the env it is given", () => {
  const input = { S3_ACCESS_KEY: "sneaky" };
  applyS3CredentialPolicy(input, { mode: "omit" });
  assert.equal(input.S3_ACCESS_KEY, "sneaky", "caller's object is left alone");
});

test("stripS3Credentials removes the aliases regardless of mode", () => {
  const env = stripS3Credentials({ S3_SECRET_KEY: "x", KEEP: "1" });
  assert.ok(!("S3_SECRET_KEY" in env));
  assert.equal(env.KEEP, "1");
});
