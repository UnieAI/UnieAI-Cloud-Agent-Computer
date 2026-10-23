export type HarnessCall = { action: "status" | "read" | "models" | "configure" | "send" | "stop" | "approve" | "reconcile"; sessionId?: string; provider?: "claude" | "codex"; cwd?: string; requestId?: string; text?: string; rabi?: boolean; model?: string | null; approvalId?: string; decision?: "accept" | "decline" };
export type HarnessModel = { id: string; label: string; description?: string; isDefault?: boolean };
export type HarnessModels = { signedIn: boolean; models: HarnessModel[] };
export const HARNESS_READ_ACTIONS: readonly string[];
export function parseHarnessCall(value: unknown): HarnessCall;
export function harnessApprovalArgs(call: HarnessCall): { server: string; tool: string; arguments: HarnessCall };

export type HarnessView = { sessionId: string; provider: "claude" | "codex"; cwd: string; state: "idle" | "running" | "approval" | "uncertain";
  revision: number; messages: { id: string; role: "user" | "assistant" | "tool"; text: string }[];
  approvals: { id: string; title: string; detail: string }[]; model?: string | null; error?: string; requestId?: string; nativeTurnId?: string };
