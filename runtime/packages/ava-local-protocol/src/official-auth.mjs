/** Fixed-purpose authentication terminals. The signed env is the intent;
 * callers cannot choose arbitrary executables, flags or shell expressions. */
export function officialAuthIntent(env = {}) {
  const value = env.AVA_OFFICIAL_AUTH;
  if (value === undefined) return null;
  const match = /^(claude|codex)\.(connect|account)$/.exec(value);
  if (!match) throw new Error('invalid_official_auth_intent');
  return { provider: match[1], action: match[2] };
}
