export const PLUGIN_MANAGER_SERVER: "dshplugins";
export const READ_ONLY_PLUGIN_ACTIONS: readonly string[];
export type PluginManagementCall = Record<string, unknown> & { action: string };
export function parsePluginManagementCall(value: unknown): PluginManagementCall;
export function pluginManagementApprovalArgs(call: PluginManagementCall): { server: string; tool: string; arguments: PluginManagementCall };
