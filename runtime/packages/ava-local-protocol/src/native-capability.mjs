/** 0.2.11 is the first daemon with provider configuration and the native bridge.
 * Older daemons already advertised agentSession, but ignored runtime settings. */
export function supportsNativeAgent(ops, version) {
  if (!Array.isArray(ops) || !ops.includes("agentSession")) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? ""));
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 0 || minor > 2 || (minor === 2 && patch >= 11);
}
