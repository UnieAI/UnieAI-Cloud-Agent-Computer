/**
 * cube/client.test.mjs — Backend contract checks for the real CubeSandbox
 * client. Uses a stubbed `fetch` so we don't need a live cluster, but
 * exercises the full createSandbox → execProcess → fileops → destroy path.
 *
 * Also covers the workspace_not_known guard: if exec is called against a
 * sandbox the client never created (e.g. sandbox-runtime restarted and
 * lost its envd cache), we must throw the right error code.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createCubeClient, deriveWorkspaceEnv } from "./client.mjs";

function fixedFakeFetch(routes) {
  const calls = [];
  const fakeFetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const match = routes.find(([pattern]) =>
      pattern instanceof RegExp ? pattern.test(url) : url.endsWith(pattern)
    );
    if (!match) {
      return {
        ok: false, status: 404, async json() { return { code: "no_route", message: `Unrouted: ${url}` }; }
      };
    }
    return match[1]({ url, opts });
  };
  return { fakeFetch, calls };
}

function jsonOk(json) {
  return { ok: true, status: 200, async json() { return json; }, async arrayBuffer() { return new ArrayBuffer(0); } };
}

function connectStreamOf(events) {
  // Build a single chunk Connect stream of `events` then trailer.
  // Each event is wrapped in a `{event: {...}}` envelope per envd schema.
  const enc = new TextEncoder();
  const buffers = [];
  for (const evt of events) {
    const payload = enc.encode(JSON.stringify({ event: evt }));
    const hdr = new Uint8Array(5);
    hdr[0] = 0;
    const len = payload.length;
    hdr[1] = (len >>> 24) & 0xff;
    hdr[2] = (len >>> 16) & 0xff;
    hdr[3] = (len >>> 8) & 0xff;
    hdr[4] = len & 0xff;
    buffers.push(hdr, payload);
  }
  // Trailer: flags=1, empty payload
  buffers.push(new Uint8Array([1, 0, 0, 0, 2]), enc.encode("{}"));

  const merged = (() => {
    let total = 0;
    for (const b of buffers) total += b.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const b of buffers) { out.set(b, offset); offset += b.length; }
    return out;
  })();

  return new ReadableStream({
    start(controller) {
      controller.enqueue(merged);
      controller.close();
    }
  });
}

test("createSandbox requires a configured template id", async () => {
  const { fakeFetch } = fixedFakeFetch([]);
  // No CUBE_TEMPLATE_ID_BASH/PYTHON env set in test — client should reject.
  // We have to construct without going through config.mjs default for this.
  process.env.CUBE_TEMPLATE_ID_BASH = "";
  process.env.CUBE_TEMPLATE_ID_PYTHON = "";
  const client = createCubeClient({ cubeApiUrl: "https://cube.example.com", cubeApiKey: "k" });
  // Inject our fetch into control.mjs via override path: we can't easily —
  // so we instead test it indirectly by configuring CUBE_API_URL but no
  // template. The first call should throw "invalid_config".
  // (skipping fakeFetch usage here since createSandbox throws before fetch.)
  await assert.rejects(
    client.createSandbox({ userId: "u1", sessionId: "s1" }),
    /CUBE_TEMPLATE_ID_BASH/
  );
});

test("createSandbox: posts to /sandboxes, caches envd, returns contract-shaped fields", async () => {
  // config.mjs reads env at import-time so we can't influence the cached
  // template via process.env here; pass `image:` explicitly which bypasses
  // pickTemplate's default-config lookup. Real callers (pool/manager.mjs)
  // do the same thing when the caller specifies an image override.
  process.env.CUBE_ENVD_URL_TEMPLATE = "https://envd.test/{sandboxID}";

  const sandboxRow = {
    sandboxID: "sbx-1",
    templateID: "tpl-bash-1",
    clientID: "c1",
    domain: "fake.cube",
    envdAccessToken: "envd-token-1"
  };

  const { fakeFetch, calls } = fixedFakeFetch([
    [/\/sandboxes$/, () => jsonOk(sandboxRow)]
  ]);

  // We need to override fetchImpl inside createControlClient — the cube/client
  // doesn't expose that. So we use globalThis.fetch override for this test.
  const origFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const client = createCubeClient({ cubeApiUrl: "https://cube.example.com", cubeApiKey: "k" });
    const out = await client.createSandbox({ userId: "u1", sessionId: "s1", ttlSec: 600, image: "tpl-bash-1" });
    assert.equal(out.sandboxId, "sbx-1");
    assert.equal(out.workspaceId, "sbx-1");
    assert.ok(calls[0].url.endsWith("/sandboxes"));
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.templateID, "tpl-bash-1");
    assert.equal(body.timeout, 600);
    assert.equal(body.metadata.user_id, "u1");
    assert.equal(body.metadata.session_id, "s1");
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.CUBE_ENVD_URL_TEMPLATE;
  }
});

test("Workaround #4: deriveWorkspaceEnv extracts bucket + path from /mnt/<bucket>/<rest>", () => {
  // NEUTRALISE the deployment's own credential policy. `scripts/test-preload.cjs`
  // loads `.env`, so once production set SANDBOX_S3_CREDENTIALS=omit this test
  // inherited it and asserted an injected key that the policy strips. The test
  // below at "SANDBOX_S3_CREDENTIALS=omit keeps the admin key out" already did
  // this; these two did not. A test whose verdict depends on the current value
  // of a deployment's configuration is not testing anything.
  const prevMode = process.env.SANDBOX_S3_CREDENTIALS;
  delete process.env.SANDBOX_S3_CREDENTIALS;
  const origEndpoint = process.env.WEED_S3_ENDPOINT;
  const origAccess = process.env.WEED_S3_ACCESS_KEY;
  const origSecret = process.env.WEED_S3_SECRET_KEY;
  const origFiler = process.env.WEED_FILER_URL;
  process.env.WEED_S3_ENDPOINT = "http://seaweed.test:8333";
  process.env.WEED_S3_ACCESS_KEY = "AKIATEST";
  process.env.WEED_S3_SECRET_KEY = "secret/value";
  process.env.WEED_FILER_URL = "http://filer.test:8888";
  try {
    const env = deriveWorkspaceEnv("/mnt/agent-fs/u-alice/p-myproject");
    assert.equal(env.WORKSPACE_BUCKET, "agent-fs");
    assert.equal(env.WORKSPACE_PATH, "u-alice/p-myproject");
    assert.equal(env.S3_ENDPOINT, "http://seaweed.test:8333");
    assert.equal(env.S3_ACCESS_KEY, "AKIATEST");
    assert.equal(env.S3_SECRET_KEY, "secret/value");
    assert.equal(env.WEED_FILER_URL, "http://filer.test:8888");
  } finally {
    if (origEndpoint === undefined) delete process.env.WEED_S3_ENDPOINT; else process.env.WEED_S3_ENDPOINT = origEndpoint;
    if (origAccess === undefined) delete process.env.WEED_S3_ACCESS_KEY; else process.env.WEED_S3_ACCESS_KEY = origAccess;
    if (origSecret === undefined) delete process.env.WEED_S3_SECRET_KEY; else process.env.WEED_S3_SECRET_KEY = origSecret;
    if (origFiler === undefined) delete process.env.WEED_FILER_URL; else process.env.WEED_FILER_URL = origFiler;
  }
});

test("Workaround #4: deriveWorkspaceEnv returns {} on missing or empty mountPath", () => {
  assert.deepEqual(deriveWorkspaceEnv(undefined), {});
  assert.deepEqual(deriveWorkspaceEnv(null), {});
  assert.deepEqual(deriveWorkspaceEnv(""), {});
});

test("Workaround #4: deriveWorkspaceEnv returns {} on unrecognised path shape", () => {
  // Anything that isn't /mnt/<bucket>/<rest> falls through — guarded
  // against silently mounting the wrong subtree.
  assert.deepEqual(deriveWorkspaceEnv("/tmp/workspace"), {});
  assert.deepEqual(deriveWorkspaceEnv("/mnt/agent-fs"), {}); // no rest segment
  assert.deepEqual(deriveWorkspaceEnv("agent-fs/u/p"), {});  // not absolute
});

test("Workaround #4: deriveWorkspaceEnv omits WEED_FILER_URL when not set in env", () => {
  const origFiler = process.env.WEED_FILER_URL;
  delete process.env.WEED_FILER_URL;
  try {
    const env = deriveWorkspaceEnv("/mnt/agent-fs/u/p");
    assert.equal(env.WORKSPACE_BUCKET, "agent-fs");
    assert.equal("WEED_FILER_URL" in env, false,
      "filer URL only injected when explicitly configured");
  } finally {
    if (origFiler !== undefined) process.env.WEED_FILER_URL = origFiler;
  }
});

test("Workaround #4: createSandbox posts derived workspace envVars to /sandboxes", async () => {  // NEUTRALISE the deployment's own credential policy. `scripts/test-preload.cjs`
  // loads `.env`, so once production set SANDBOX_S3_CREDENTIALS=omit this test
  // inherited it and asserted an injected key that the policy strips. The test
  // below at "SANDBOX_S3_CREDENTIALS=omit keeps the admin key out" already did
  // this; these two did not. A test whose verdict depends on the current value
  // of a deployment's configuration is not testing anything.
  const prevMode = process.env.SANDBOX_S3_CREDENTIALS;
  delete process.env.SANDBOX_S3_CREDENTIALS;

  process.env.CUBE_ENVD_URL_TEMPLATE = "https://envd.test/{sandboxID}";
  process.env.WEED_S3_ENDPOINT = "http://seaweed.test:8333";
  process.env.WEED_S3_ACCESS_KEY = "AKIAFROMENV";
  process.env.WEED_S3_SECRET_KEY = "secret-from-env";

  const sandboxRow = {
    sandboxID: "sbx-envd-1", templateID: "tpl-bash-1", clientID: "c1",
    domain: "fake.cube", envdAccessToken: "envd-token-1"
  };
  const { fakeFetch, calls } = fixedFakeFetch([
    [/\/sandboxes$/, () => jsonOk(sandboxRow)]
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const client = createCubeClient({ cubeApiUrl: "https://cube.example.com", cubeApiKey: "k" });
    await client.createSandbox({
      userId: "u-X", sessionId: "s-Y", image: "tpl-bash-1", ttlSec: 600,
      workspaceMountPath: "/mnt/agent-fs/u-X/p-Y",
    });
    const body = JSON.parse(calls[0].opts.body);
    assert.ok(body.envVars, "envVars present on POST body");
    assert.equal(body.envVars.WORKSPACE_BUCKET, "agent-fs");
    assert.equal(body.envVars.WORKSPACE_PATH, "u-X/p-Y");
    assert.equal(body.envVars.S3_ENDPOINT, "http://seaweed.test:8333");
    assert.equal(body.envVars.S3_ACCESS_KEY, "AKIAFROMENV");
    assert.equal(body.envVars.S3_SECRET_KEY, "secret-from-env");
    // Phase 4.2 metadata breadcrumb retained (back-compat with operator
    // dashboards that grep by workspace_mount_path).
    assert.equal(body.metadata.workspace_mount_path, "/mnt/agent-fs/u-X/p-Y");
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.CUBE_ENVD_URL_TEMPLATE;
    delete process.env.WEED_S3_ENDPOINT;
    delete process.env.WEED_S3_ACCESS_KEY;
    delete process.env.WEED_S3_SECRET_KEY;
  }
});

test("Workaround #4: createSandbox without workspaceMountPath omits WORKSPACE_* envVars", async () => {
  process.env.CUBE_ENVD_URL_TEMPLATE = "https://envd.test/{sandboxID}";
  const sandboxRow = {
    sandboxID: "sbx-no-mount", templateID: "tpl-bash-1", clientID: "c1",
    domain: "fake.cube", envdAccessToken: "t"
  };
  const { fakeFetch, calls } = fixedFakeFetch([
    [/\/sandboxes$/, () => jsonOk(sandboxRow)]
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const client = createCubeClient({ cubeApiUrl: "https://cube.example.com", cubeApiKey: "k" });
    await client.createSandbox({ userId: "u", sessionId: "s", image: "tpl-bash-1" });
    const body = JSON.parse(calls[0].opts.body);
    if (body.envVars) {
      assert.equal("WORKSPACE_BUCKET" in body.envVars, false);
      assert.equal("WORKSPACE_PATH" in body.envVars, false);
    } else {
      // Either no envVars key at all, or no WORKSPACE_* in it — both acceptable.
      assert.equal(body.envVars, undefined);
    }
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.CUBE_ENVD_URL_TEMPLATE;
  }
});

test("Workaround #4: caller-supplied envVars override derived workspace envVars", async () => {
  process.env.CUBE_ENVD_URL_TEMPLATE = "https://envd.test/{sandboxID}";
  process.env.WEED_S3_ENDPOINT = "http://default-seaweed:8333";
  const sandboxRow = {
    sandboxID: "sbx-override", templateID: "tpl-bash-1", clientID: "c1",
    domain: "fake.cube", envdAccessToken: "t"
  };
  const { fakeFetch, calls } = fixedFakeFetch([
    [/\/sandboxes$/, () => jsonOk(sandboxRow)]
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const client = createCubeClient({ cubeApiUrl: "https://cube.example.com", cubeApiKey: "k" });
    await client.createSandbox({
      userId: "u", sessionId: "s", image: "tpl-bash-1",
      workspaceMountPath: "/mnt/agent-fs/u/p",
      envVars: {
        // Explicit override of an S3 field — operator wins.
        S3_ENDPOINT: "http://caller-override:8333",
        // Caller can also inject arbitrary extras alongside workspace envs.
        CUSTOM_FLAG: "yes",
      }
    });
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.envVars.S3_ENDPOINT, "http://caller-override:8333",
      "caller envVars take precedence over WEED_S3_ENDPOINT env-derived default");
    assert.equal(body.envVars.WORKSPACE_BUCKET, "agent-fs",
      "non-overridden workspace fields still flow through");
    assert.equal(body.envVars.CUSTOM_FLAG, "yes",
      "caller arbitrary envVars passed through");
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.CUBE_ENVD_URL_TEMPLATE;
    delete process.env.WEED_S3_ENDPOINT;
  }
});

test("execProcess against unknown sandbox throws sandbox_not_known (cache miss)", async () => {
  const client = createCubeClient({ cubeApiUrl: "https://cube.example.com", cubeApiKey: "k" });
  await assert.rejects(
    client.execProcess("never-created", { kind: "bash", command: "echo hi" }),
    (err) => err.code === "sandbox_not_known" && err.status === 404
  );
});

test("destroySandbox is idempotent — second call on already-destroyed sandbox does not throw", async () => {
  process.env.CUBE_ENVD_URL_TEMPLATE = "https://envd.test/{sandboxID}";

  let createReturned = false;
  let destroyCalls = 0;
  const fakeFetch = async (url, opts = {}) => {
    if (url.endsWith("/sandboxes") && opts.method === "POST") {
      createReturned = true;
      return jsonOk({
        sandboxID: "sbx-X",
        templateID: "tpl-bash-1",
        clientID: "c1",
        domain: "fake.cube",
        envdAccessToken: "t"
      });
    }
    if (url.includes("/sandboxes/sbx-X") && opts.method === "DELETE") {
      destroyCalls++;
      // First delete succeeds, second returns 404.
      if (destroyCalls === 1) return jsonOk({});
      return { ok: false, status: 404, async json() { return {}; } };
    }
    return { ok: false, status: 404, async json() { return { code: "no_route" }; } };
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const client = createCubeClient({ cubeApiUrl: "https://cube.example.com", cubeApiKey: "k" });
    await client.createSandbox({ userId: "u1", sessionId: "s1", image: "tpl-bash-1" });
    assert.ok(createReturned);
    await client.destroySandbox("sbx-X");
    await client.destroySandbox("sbx-X"); // must not throw
    assert.equal(destroyCalls, 2);
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.CUBE_ENVD_URL_TEMPLATE;
  }
});

// ---- S3 credential policy (CubeMaster backend) ----
//
// Same defect as the docker backend, same fix. The seaweedfs identity behind
// WEED_S3_ACCESS_KEY / WEED_S3_SECRET_KEY is the only one in the store, with
// actions ["Admin","Read","Write","List","Tagging"] and no bucket or prefix
// restriction, and it was shipped in the create-sandbox request body as
// S3_ACCESS_KEY / S3_SECRET_KEY for EVERY tenant's sandbox. Proven exploitable
// on the docker path: a process inside a real cm-agent-sandbox container, given
// only those two vars, signed a SigV4 ListBuckets and got every bucket back
// while anonymous from the same container got 403. The CubeMaster path ships
// the SAME image (#61) and mounts /workspace the SAME way — the image
// entrypoint runs `weed mount -filer=...`, which authenticates to the filer
// over gRPC and never uses the S3 credential — so withholding it costs the
// mount nothing here either. See cube/s3-credentials.mjs for the full rule.

test("deriveWorkspaceEnv: DEFAULT is today's behaviour — credentials are injected", () => {
  // Deliberate: this is a live data path and the default must not be "tidied"
  // to the safe value. Flipping it is an operator decision.
  const env = deriveWorkspaceEnv("/mnt/agent-fs/u-1/p-1", {
    s3CredentialMode: "inject",
    s3Endpoint: "http://seaweed.test:8333",
    s3AccessKey: "AKIAFAKE",
    s3SecretKey: "shh",
  });
  assert.equal(env.S3_ACCESS_KEY, "AKIAFAKE");
  assert.equal(env.S3_SECRET_KEY, "shh");
});

test("deriveWorkspaceEnv: omit mode removes S3 credentials entirely", () => {
  const env = deriveWorkspaceEnv("/mnt/agent-fs/u-1/p-1", {
    s3CredentialMode: "omit",
    s3Endpoint: "http://seaweed.test:8333",
    s3AccessKey: "AKIAFAKE",
    s3SecretKey: "shh",
  });
  assert.ok(!("S3_ACCESS_KEY" in env), "S3_ACCESS_KEY must not be present at all");
  assert.ok(!("S3_SECRET_KEY" in env), "S3_SECRET_KEY must not be present at all");
});

test("deriveWorkspaceEnv: omit mode still delivers the workspace coordinates + endpoint", () => {
  // The in-guest mount must keep working — `weed mount` reaches the filer over
  // gRPC and needs only WEED_FILER_URL / the coordinates, not S3 auth.
  const origFiler = process.env.WEED_FILER_URL;
  process.env.WEED_FILER_URL = "http://filer.test:8888";
  try {
    const env = deriveWorkspaceEnv("/mnt/agent-fs/u-1/p-1", {
      s3CredentialMode: "omit",
      s3Endpoint: "http://seaweed.test:8333",
      s3AccessKey: "AKIAFAKE",
      s3SecretKey: "shh",
    });
    assert.equal(env.WORKSPACE_BUCKET, "agent-fs");
    assert.equal(env.WORKSPACE_PATH, "u-1/p-1");
    assert.equal(env.S3_ENDPOINT, "http://seaweed.test:8333");
    assert.equal(env.WEED_FILER_URL, "http://filer.test:8888");
  } finally {
    if (origFiler === undefined) delete process.env.WEED_FILER_URL; else process.env.WEED_FILER_URL = origFiler;
  }
});

test("deriveWorkspaceEnv: unknown mode fails closed to inject (no silent lockout)", () => {
  // A typo must not strip credentials fleet-wide. The reversible direction is
  // the one we default to.
  const env = deriveWorkspaceEnv("/mnt/agent-fs/u-1/p-1", {
    s3CredentialMode: "wat",
    s3AccessKey: "AKIAFAKE",
    s3SecretKey: "shh",
  });
  assert.equal(env.S3_ACCESS_KEY, "AKIAFAKE");
});

test("createSandbox: injects S3 credentials by DEFAULT (unchanged live behaviour)", async () => {
  const prevMode = process.env.SANDBOX_S3_CREDENTIALS;
  delete process.env.SANDBOX_S3_CREDENTIALS;
  process.env.CUBE_ENVD_URL_TEMPLATE = "https://envd.test/{sandboxID}";
  process.env.WEED_S3_ACCESS_KEY = "AKIAFAKE";
  process.env.WEED_S3_SECRET_KEY = "shh";
  const { fakeFetch, calls } = fixedFakeFetch([
    [/\/sandboxes$/, () => jsonOk({ sandboxID: "sbx-inject", templateID: "tpl-bash-1", clientID: "c1", domain: "fake.cube", envdAccessToken: "t" })]
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const client = createCubeClient({ cubeApiUrl: "https://cube.example.com", cubeApiKey: "k" });
    await client.createSandbox({ userId: "u", sessionId: "s", image: "tpl-bash-1", workspaceMountPath: "/mnt/agent-fs/u/p" });
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.envVars.S3_ACCESS_KEY, "AKIAFAKE");
    assert.equal(body.envVars.S3_SECRET_KEY, "shh");
  } finally {
    globalThis.fetch = origFetch;
    if (prevMode === undefined) delete process.env.SANDBOX_S3_CREDENTIALS; else process.env.SANDBOX_S3_CREDENTIALS = prevMode;
    delete process.env.CUBE_ENVD_URL_TEMPLATE;
    delete process.env.WEED_S3_ACCESS_KEY;
    delete process.env.WEED_S3_SECRET_KEY;
  }
});

test("createSandbox: SANDBOX_S3_CREDENTIALS=omit keeps the admin key out of the request body", async () => {
  const prevMode = process.env.SANDBOX_S3_CREDENTIALS;
  process.env.SANDBOX_S3_CREDENTIALS = "omit";
  process.env.CUBE_ENVD_URL_TEMPLATE = "https://envd.test/{sandboxID}";
  process.env.WEED_S3_ACCESS_KEY = "AKIAFAKE";
  process.env.WEED_S3_SECRET_KEY = "shh";
  const { fakeFetch, calls } = fixedFakeFetch([
    [/\/sandboxes$/, () => jsonOk({ sandboxID: "sbx-omit", templateID: "tpl-bash-1", clientID: "c1", domain: "fake.cube", envdAccessToken: "t" })]
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const client = createCubeClient({ cubeApiUrl: "https://cube.example.com", cubeApiKey: "k" });
    await client.createSandbox({ userId: "u", sessionId: "s", image: "tpl-bash-1", workspaceMountPath: "/mnt/agent-fs/u/p" });
    const body = JSON.parse(calls[0].opts.body);
    assert.ok(!("S3_ACCESS_KEY" in body.envVars), "no S3_ACCESS_KEY reaches CubeMaster");
    assert.ok(!("S3_SECRET_KEY" in body.envVars), "no S3_SECRET_KEY reaches CubeMaster");
    assert.equal(body.envVars.WORKSPACE_BUCKET, "agent-fs", "workspace coords still delivered");
  } finally {
    globalThis.fetch = origFetch;
    if (prevMode === undefined) delete process.env.SANDBOX_S3_CREDENTIALS; else process.env.SANDBOX_S3_CREDENTIALS = prevMode;
    delete process.env.CUBE_ENVD_URL_TEMPLATE;
    delete process.env.WEED_S3_ACCESS_KEY;
    delete process.env.WEED_S3_SECRET_KEY;
  }
});

test("createSandbox: omit mode strips credentials smuggled in via caller envVars", async () => {
  // callerEnvVars are merged LAST on this backend (caller wins by design), so
  // without an explicit post-merge strip a caller — or a compromised upstream —
  // could reintroduce the very credential the operator withheld. "omit" means
  // omit: it outranks caller precedence for these four keys only.
  const prevMode = process.env.SANDBOX_S3_CREDENTIALS;
  process.env.SANDBOX_S3_CREDENTIALS = "omit";
  process.env.CUBE_ENVD_URL_TEMPLATE = "https://envd.test/{sandboxID}";
  const { fakeFetch, calls } = fixedFakeFetch([
    [/\/sandboxes$/, () => jsonOk({ sandboxID: "sbx-smuggle", templateID: "tpl-bash-1", clientID: "c1", domain: "fake.cube", envdAccessToken: "t" })]
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const client = createCubeClient({ cubeApiUrl: "https://cube.example.com", cubeApiKey: "k" });
    await client.createSandbox({
      userId: "u", sessionId: "s", image: "tpl-bash-1",
      workspaceMountPath: "/mnt/agent-fs/u/p",
      envVars: {
        S3_ACCESS_KEY: "sneaky", S3_SECRET_KEY: "sneaky",
        AWS_ACCESS_KEY_ID: "sneaky", AWS_SECRET_ACCESS_KEY: "sneaky",
        CUSTOM_FLAG: "yes",
      },
    });
    const body = JSON.parse(calls[0].opts.body);
    for (const k of ["S3_ACCESS_KEY", "S3_SECRET_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
      assert.ok(!(k in body.envVars), `${k} must be stripped in omit mode`);
    }
    assert.equal(body.envVars.CUSTOM_FLAG, "yes", "non-credential caller envVars still pass through");
  } finally {
    globalThis.fetch = origFetch;
    if (prevMode === undefined) delete process.env.SANDBOX_S3_CREDENTIALS; else process.env.SANDBOX_S3_CREDENTIALS = prevMode;
    delete process.env.CUBE_ENVD_URL_TEMPLATE;
  }
});

test("createSandbox: omit mode strips smuggled credentials even with no workspace mount path", async () => {
  // With no mount path deriveWorkspaceEnv returns {} and never sees the caller
  // env at all — the strip has to live on the merge, not only in the deriver.
  const prevMode = process.env.SANDBOX_S3_CREDENTIALS;
  process.env.SANDBOX_S3_CREDENTIALS = "omit";
  process.env.CUBE_ENVD_URL_TEMPLATE = "https://envd.test/{sandboxID}";
  const { fakeFetch, calls } = fixedFakeFetch([
    [/\/sandboxes$/, () => jsonOk({ sandboxID: "sbx-nomount", templateID: "tpl-bash-1", clientID: "c1", domain: "fake.cube", envdAccessToken: "t" })]
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const client = createCubeClient({ cubeApiUrl: "https://cube.example.com", cubeApiKey: "k" });
    await client.createSandbox({
      userId: "u", sessionId: "s", image: "tpl-bash-1",
      envVars: { S3_ACCESS_KEY: "sneaky", KEEP: "1" },
    });
    const body = JSON.parse(calls[0].opts.body);
    assert.ok(!("S3_ACCESS_KEY" in body.envVars), "S3_ACCESS_KEY must be stripped");
    assert.equal(body.envVars.KEEP, "1");
  } finally {
    globalThis.fetch = origFetch;
    if (prevMode === undefined) delete process.env.SANDBOX_S3_CREDENTIALS; else process.env.SANDBOX_S3_CREDENTIALS = prevMode;
    delete process.env.CUBE_ENVD_URL_TEMPLATE;
  }
});
