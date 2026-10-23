export const KEYCHAIN_FREE_FLAGS: readonly string[];
export function splitSimpleCommands(command: string): string[][];
export function chromeLaunchRefusal(command: string, depth?: number): { code: "chrome_launch_flags" | "chrome_open_app"; message: string; missing?: string[] } | null;
