import crypto from "node:crypto";

export const JOB_TYPES = {
  KB_INGEST: "kb_ingest",
  GUARDRAIL_JUDGE: "guardrail_judge",
  DATA_FOUNDRY: "data_foundry",
  REQUEST_LOG_EVAL: "request_log_eval",
  EVAL_JOB: "eval_job",
  BENCHMARK_RUN: "benchmark_run",
  ONPREM_PREFLIGHT: "onprem_preflight",
  ONPREM_CLUSTER_SETUP: "onprem_cluster_setup",
  ONPREM_CLUSTER_DELETION: "onprem_cluster_deletion",
  ONPREM_HELM_CHART_INSPECTION: "onprem_helm_chart_inspection",
  ONPREM_HELM_DEPLOYMENT: "onprem_helm_deployment"
};

export const KB_SUBMISSION_STATUSES = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  WITHDRAWN: "withdrawn",
  SUPERSEDED: "superseded"
};


export const JOB_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed"
};

export const PLATFORM_ROLES = {
  SUPER_ADMIN: "super_admin",
  ADMIN: "admin",
  PRO: "pro",
  USER: "user",
  PENDING: "pending"
};

export const GROUP_MEMBER_ROLES = {
  CREATOR: "creator",
  COLLABORATOR: "collaborator",
  USER: "user"
};

export const KNOWLEDGE_BASE_ACCESS_LEVELS = {
  PRIVATE: "private",
  PUBLIC: "public",
  GROUP: "group"
};

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function createRequestId() {
  return createId("req");
}

export function nowIso() {
  return new Date().toISOString();
}

export function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

export function createApiSecret() {
  return `sk-${crypto.randomBytes(24).toString("hex")}`;
}

export function createApiSecretPreview(secret) {
  const normalized = String(secret || "").trim();

  if (!normalized) {
    return "sk-*****...***";
  }

  const prefix = normalized.startsWith("sk-") ? "sk-" : "";
  const body = prefix ? normalized.slice(3) : normalized;

  if (body.length <= 8) {
    return `${prefix}${body}`;
  }

  return `${prefix}${body.slice(0, 5)}...${body.slice(-3)}`;
}

export function createApiSecretPrefix(secret) {
  const normalized = String(secret || "").trim();
  if (!normalized) {
    return "sk-";
  }

  return normalized.slice(0, Math.min(normalized.length, 15));
}

function getSecretEncryptionKeyMaterial() {
  const raw =
    process.env.USER_API_KEY_ENCRYPTION_KEY ||
    process.env.API_KEY_ENCRYPTION_KEY ||
    process.env.NEXTAUTH_SECRET ||
    process.env.AUTH_SECRET ||
    "";

  if (!raw) {
    throw createError(
      "server_misconfigured",
      "API key encryption key is not configured",
      {
        env: [
          "USER_API_KEY_ENCRYPTION_KEY",
          "API_KEY_ENCRYPTION_KEY",
          "NEXTAUTH_SECRET",
          "AUTH_SECRET"
        ]
      },
      500
    );
  }

  return crypto.createHash("sha256").update(raw).digest();
}

export function encryptSecret(secret) {
  const normalized = String(secret || "");
  const key = getSecretEncryptionKeyMaterial();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptSecret(payload) {
  const normalized = String(payload || "").trim();
  if (!normalized) {
    return "";
  }

  const [ivBase64, tagBase64, ciphertextBase64] = normalized.split(".");
  if (!ivBase64 || !tagBase64 || !ciphertextBase64) {
    throw createError("invalid_secret_payload", "Encrypted secret payload is malformed", {}, 500);
  }

  const key = getSecretEncryptionKeyMaterial();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivBase64, "base64"));
  decipher.setAuthTag(Buffer.from(tagBase64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextBase64, "base64")),
    decipher.final()
  ]);

  return plaintext.toString("utf8");
}

export function createOpaqueToken(prefix = "tok") {
  return `${prefix}_${crypto.randomBytes(32).toString("hex")}`;
}

export function createError(code, message, details = {}, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.status = status;
  return error;
}

export function assertRequired(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    throw createError("invalid_request", `${fieldName} is required`, { field: fieldName }, 400);
  }
}

export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const body = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(body);
  } catch {
    throw createError("invalid_json", "Request body must be valid JSON", {}, 400);
  }
}

export function writeJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...headers
  });
  res.end(JSON.stringify(payload, null, 2));
}

export function writeError(res, error, requestId) {
  writeJson(res, error.status || 500, {
    error: {
      code: error.code || "internal_error",
      message: error.message || "Unexpected error",
      request_id: requestId,
      details: error.details || {}
    }
  });
}

export function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length).trim();
}

export function tokenizeText(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .filter(Boolean);
}

export function countTokens(text) {
  return tokenizeText(text).length;
}

export function textPreview(text, maxLength = 180) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}

export function simpleEmbedding(input, dimensions = 8) {
  const tokens = tokenizeText(Array.isArray(input) ? input.join(" ") : input);
  const vector = Array.from({ length: dimensions }, () => 0);

  for (const token of tokens) {
    const digest = crypto.createHash("md5").update(token).digest();
    for (let index = 0; index < dimensions; index += 1) {
      vector[index] += digest[index] / 255;
    }
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

export function overlapScore(query, text) {
  const queryTokens = new Set(tokenizeText(query));
  const textTokens = tokenizeText(text);
  let score = 0;

  for (const token of textTokens) {
    if (queryTokens.has(token)) {
      score += 1;
    }
  }

  return score;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const digest = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${digest}`;
}

export function verifyPassword(password, passwordHash) {
  const [salt, storedDigest] = String(passwordHash || "").split(":");
  if (!salt || !storedDigest) {
    return false;
  }

  const digest = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(storedDigest, "hex"));
}
