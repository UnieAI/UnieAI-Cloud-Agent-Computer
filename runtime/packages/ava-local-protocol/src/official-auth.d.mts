export function officialAuthIntent(env?: Record<string, string>): {provider: "claude" | "codex"; action: "connect" | "account"} | null;
