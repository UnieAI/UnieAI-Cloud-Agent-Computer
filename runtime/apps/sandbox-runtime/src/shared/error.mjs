export class SandboxError extends Error {
  constructor(code, message, status = 500, details = null) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.details = details || null;
  }
}

/** Connect-RPC transport / RPC-level error from the CubeAPI envd or control plane. */
export class ConnectError extends SandboxError {
  constructor(code, message, status = 502, details = null) {
    super(code, message, status, details);
    this.name = "ConnectError";
  }
}

export function toErrorPayload(err, requestId) {
  if (err instanceof SandboxError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        status: err.status,
        request_id: requestId || null,
        details: err.details || null
      }
    };
  }
  return {
    error: {
      code: "internal_error",
      message: err?.message || "Unexpected error",
      status: 500,
      request_id: requestId || null,
      details: null
    }
  };
}
