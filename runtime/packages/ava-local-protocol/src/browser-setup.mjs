/** One fixed setup capability; the caller cannot supply a command, path or package. */
export function parseBrowserSetup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_browser_setup');
  if (Object.keys(value).some(k => !['action', 'mode', 'browser'].includes(k))) throw new Error('invalid_browser_setup');
  if (value.action === 'status' && Object.keys(value).length === 1) return { action: 'status' };
  if (value.action !== 'setup' || !['headless', 'attach'].includes(value.mode) || !['chrome', 'chromium', 'edge', 'brave'].includes(value.browser)) throw new Error('invalid_browser_setup');
  if (value.mode === 'attach' && value.browser !== 'chrome') throw new Error('attach_requires_chrome');
  return { action: 'setup', mode: value.mode, browser: value.browser };
}
export function browserSetupApprovalArgs(call) { return { server: 'ava-browser-setup', tool: 'setup', arguments: parseBrowserSetup(call) }; }
