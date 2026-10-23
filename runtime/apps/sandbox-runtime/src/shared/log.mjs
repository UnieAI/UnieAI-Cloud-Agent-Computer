const SANDBOX_LOG_LEVEL = String(process.env.SANDBOX_LOG_LEVEL || process.env.RUNTIME_LOG_LEVEL || "info").toLowerCase();

function shouldLog(level) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  return (order[level] || 20) >= (order[SANDBOX_LOG_LEVEL] || 20);
}

function log(level, event, payload = {}) {
  if (!shouldLog(level)) {
    return;
  }
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    service: "sandbox-runtime",
    level,
    event,
    ...payload
  });
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

export { shouldLog, log };
