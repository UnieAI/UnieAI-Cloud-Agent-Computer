export type BrowserSetupCall = { action: "status" } | { action: "setup"; mode: "headless" | "attach"; browser: "chrome" | "chromium" | "edge" | "brave" };
export function parseBrowserSetup(value: unknown): BrowserSetupCall;
export function browserSetupApprovalArgs(call: BrowserSetupCall): { server: string; tool: string; arguments: BrowserSetupCall };
