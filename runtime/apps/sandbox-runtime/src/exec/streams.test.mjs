import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { registerExec } from "./streams.mjs";

test("registerExec drains an exit event buffered before listener registration", () => {
  const handle = new EventEmitter();
  handle.execId = "exec-buffered-exit-test";
  handle.drainBufferedEvents = () => {
    handle.emit("exit", { code: 0, signal: null, error: null });
  };

  const entry = registerExec({
    sandboxId: "sandbox-buffered-exit-test",
    handle,
    kind: "bash",
    command: "echo ok",
    timeoutMs: 1000,
  });

  assert.equal(entry.status, "exited");
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.ring.events.at(-1)?.type, "exit");
});
