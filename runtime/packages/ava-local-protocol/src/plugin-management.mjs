export const PLUGIN_MANAGER_SERVER = "dshplugins";
export const READ_ONLY_PLUGIN_ACTIONS = Object.freeze(["list", "inspect", "progress", "configuration"]);
const FIELDS = {
  list: [], inspect: ["spec", "registry"], progress: ["requestId"], configuration: ["id"],
  install: ["spec", "registry", "requestId", "enabled", "approvedBuilds"],
  cancel: ["requestId"], toggleBundle: ["name", "enabled"], togglePlugin: ["id", "enabled"],
  remove: ["name"], configure: ["id", "config"],
};
export function parsePluginManagementCall(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plugin management request");
  if (typeof value.action !== "string") throw new Error("Invalid plugin management action");
  const fields = Object.hasOwn(FIELDS, value.action) ? FIELDS[value.action] : undefined;
  if (!fields || Object.keys(value).some(key => key !== "action" && !fields.includes(key))) throw new Error("Unknown plugin management action or fields");
  if (new TextEncoder().encode(JSON.stringify(value)).length > 65536) throw new Error("Plugin configuration exceeds 64 KB");
  for (const field of ["spec", "name", "id", "requestId"]) {
    if (!fields.includes(field)) continue;
    if (typeof value[field] !== "string" || !value[field].trim() || value[field].length > 1024 || /[\u0000-\u001f]/.test(value[field])) throw new Error(`Invalid ${field}`);
  }
  if (fields.includes("enabled") && typeof value.enabled !== "boolean") throw new Error("Plugin enabled must be a boolean");
  if (value.registry !== undefined && !["https://registry.npmjs.org/", "https://registry.npmmirror.com/"].includes(value.registry)) throw new Error("Choose an offered package registry");
  if (value.approvedBuilds !== undefined && (!Array.isArray(value.approvedBuilds) || value.approvedBuilds.length > 64 || value.approvedBuilds.some(item => typeof item !== "string" || !item || item.length > 1024 || !/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9_][a-zA-Z0-9._-]*(?:@(?:[0-9][a-zA-Z0-9.+_-]*|(?:file|https?|git\+https?):[^\s*?\u0000-\u001f]+))?$/.test(item)))) throw new Error("Invalid individual build approvals");
  if (fields.includes("config") && (!value.config || typeof value.config !== "object" || Array.isArray(value.config))) throw new Error("Plugin configuration must be an object");
  return { ...value };
}
/** Management writes use the existing exact-argument, browser-signed MCP approval. */
export function pluginManagementApprovalArgs(call) {
  return { server: PLUGIN_MANAGER_SERVER, tool: call.action, arguments: call };
}
