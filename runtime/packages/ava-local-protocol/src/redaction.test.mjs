import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { REDACTION_KINDS, redactedWriteRefusal, redactionMarkersIn } from "./redaction.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("the daemon's RedactionKind union is exactly this list (one list, not two)", () => {
  const src = readFileSync(path.join(HERE, "../../../apps/ava-local/src/redact.ts"), "utf8");
  const union = src.slice(src.indexOf("export type RedactionKind"), src.indexOf(";", src.indexOf("export type RedactionKind")));
  const kinds = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...kinds].sort(), [...REDACTION_KINDS].sort());
});

test("markers are found in order; ordinary text is not", () => {
  assert.deepEqual(redactionMarkersIn("a [redacted:jwt] b [redacted:aws-key] c [redacted:jwt]"), ["jwt", "aws-key", "jwt"]);
  assert.deepEqual(redactionMarkersIn("[redacted] or [redacted:unknown-kind] or redacted:jwt"), []);
});

test("a write with markers is refused with a message a person can act on", () => {
  const r = redactedWriteRefusal(Buffer.from("KEY=[redacted:openai-key]"));
  assert.equal(r?.code, "redacted_content");
  assert.match(r.message, /請在你的電腦上直接編輯/);
  assert.equal(redactedWriteRefusal("KEY=sk-real-but-not-a-marker"), null);
});
