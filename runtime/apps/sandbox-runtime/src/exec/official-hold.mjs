import {SandboxError} from '../shared/error.mjs';

/** Keep a sandbox alive by observing an admitted turn, never by replaying it. */
export function officialHarnessHold(payload) {
  if (!payload || typeof payload !== 'object' ||
      Object.keys(payload).some(key => !['sessionId', 'provider', 'cwd'].includes(key)) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(payload.sessionId ?? '') ||
      !['claude', 'codex'].includes(payload.provider) || payload.cwd !== '/workspace') {
    throw new SandboxError('bad_request', 'Invalid official harness observer', 400);
  }
  return {
    timeoutMs: 65 * 60_000,
    payload: {
      command: 'node /opt/ava-browser/harness-client.mjs',
      stdin: JSON.stringify({hold: true, call: {action: 'read', ...payload}}),
    },
  };
}
