// Hand-written types for click-policy.mjs (plain ESM, no build step — see index.d.mts).
export interface ClickVerdict {
  tier: "routine" | "major";
  category: string | null;
  signals: string[];
}
export const PASSKEY_CATEGORIES: readonly string[];
export const AUTO_LIMITS: Readonly<{ maxAutoClicks: number; maxPerMinute: number; maxConsecutiveBlocked: number }>;
export function isSensitiveOrigin(host: string, extra?: readonly string[]): boolean;
export function classifyClick(resolution: any, opts?: { extraSensitiveHosts?: readonly string[] }): ClickVerdict;
export function stricter(a: ClickVerdict | null | undefined, b: ClickVerdict | null | undefined): ClickVerdict;
export function requiresFreshPasskey(verdict: ClickVerdict | null | undefined): boolean;
export function canAutoApprove(
  verdict: ClickVerdict,
  resolution: any,
  budget: { check(): { ok: boolean; reason?: string } },
  opts?: { extraSensitiveHosts?: readonly string[] },
): { ok: boolean; reason?: string };
export interface ClickBudget {
  check(): { ok: boolean; reason?: string };
  recordAuto(): void;
  recordHumanApproved(): void;
  recordBlocked(): void;
  snapshot(): { total: number; consecutiveBlocked: number; tripped: boolean };
}
export function createClickBudget(opts?: { now?: () => number; limits?: Readonly<{ maxAutoClicks: number; maxPerMinute: number; maxConsecutiveBlocked: number }> }): ClickBudget;
export function claimMatch(claim: string, hit: any): "match" | "mismatch" | "unverifiable";
export function isActivationKey(key: unknown): boolean;
