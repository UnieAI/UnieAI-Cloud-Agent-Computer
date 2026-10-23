import { createPublicKey, verify } from "node:crypto";

export const LICENSE_FEATURES = {
  KB: "kb",
  ONPREM: "onprem",
  CUSTOM_MODEL: "custom_model"
};

export const LICENSE_FORMAT_VERSION = "unieai-license-v1";

export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA6JxZ01ATMeoJojN+J8WYHLSqPlLBz6FhFiOwStgmDzw=
-----END PUBLIC KEY-----`;

const KNOWN_FEATURES = Object.freeze(Object.values(LICENSE_FEATURES));
const DEFAULT_FEATURES = Object.freeze(
  Object.fromEntries(KNOWN_FEATURES.map((feature) => [feature, false]))
);

let resolvedLicenseCache = null;

function createLicenseError(code, message, details = {}, status = 403) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.status = status;
  return error;
}

function normalizeLicenseStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || "invalid";
}

function isExpired(expiresAt, now = Date.now()) {
  const timestamp = Date.parse(String(expiresAt || ""));
  return Number.isFinite(timestamp) && timestamp <= now;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function createInvalidLicense(reason, details = {}) {
  return Object.freeze({
    status: "invalid",
    reason,
    details: Object.freeze({ ...details }),
    licenseId: null,
    customer: null,
    issuedAt: null,
    expiresAt: null,
    features: DEFAULT_FEATURES
  });
}

function normalizeFeatures(value) {
  const input = isPlainObject(value) ? value : {};
  const features = { ...DEFAULT_FEATURES };

  for (const [key, enabled] of Object.entries(input)) {
    const feature = String(key || "").trim();
    if (feature && typeof enabled === "boolean") {
      features[feature] = enabled;
    }
  }

  return Object.freeze(features);
}

function normalizeIsoDate(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function decodeBase64UrlJson(value) {
  const raw = Buffer.from(String(value || ""), "base64url").toString("utf8");
  return JSON.parse(raw);
}

export function resolveLicenseText(licenseText, options = {}) {
  const text = String(licenseText || "").trim();
  if (!text) {
    return createInvalidLicense("missing_license");
  }

  const parts = text.split(".");
  if (parts.length !== 3 || parts[0] !== LICENSE_FORMAT_VERSION) {
    return createInvalidLicense("unsupported_license_format", {
      expectedFormat: LICENSE_FORMAT_VERSION
    });
  }

  const [version, payloadPart, signaturePart] = parts;
  const signingInput = `${version}.${payloadPart}`;

  let publicKey;
  let signature;
  try {
    publicKey = createPublicKey(String(options.publicKeyPem || LICENSE_PUBLIC_KEY_PEM));
    signature = Buffer.from(signaturePart, "base64url");
  } catch (error) {
    return createInvalidLicense("license_key_error", {
      message: error?.message || "Unable to prepare license verification key"
    });
  }

  const signatureValid = verify(null, Buffer.from(signingInput, "utf8"), publicKey, signature);
  if (!signatureValid) {
    return createInvalidLicense("license_signature_invalid");
  }

  let payload;
  try {
    payload = decodeBase64UrlJson(payloadPart);
  } catch (error) {
    return createInvalidLicense("license_payload_invalid", {
      message: error?.message || "Unable to parse license payload"
    });
  }

  if (!isPlainObject(payload)) {
    return createInvalidLicense("license_payload_invalid", {
      message: "License payload must be an object"
    });
  }

  const expiresAt = normalizeIsoDate(payload.expiresAt);
  if (!expiresAt) {
    return createInvalidLicense("license_expiration_invalid");
  }

  const issuedAt = normalizeIsoDate(payload.issuedAt);
  if (payload.issuedAt && !issuedAt) {
    return createInvalidLicense("license_issued_at_invalid");
  }

  const license = {
    status: "valid",
    reason: null,
    details: Object.freeze({}),
    licenseId: String(payload.licenseId || "").trim() || null,
    customer: String(payload.customer || "").trim() || null,
    issuedAt,
    expiresAt,
    features: normalizeFeatures(payload.features)
  };

  return Object.freeze(license);
}

export function resolveConfiguredLicense() {
  return Object.freeze({
    ...createInvalidLicense("missing_license"),
    source: "database"
  });
}

export function setResolvedLicense(license, source = "database") {
  const normalizedLicense = isPlainObject(license) ? license : createInvalidLicense("missing_license");
  resolvedLicenseCache = Object.freeze({
    ...normalizedLicense,
    source
  });
  return resolvedLicenseCache;
}

export function initializeLicense(license = null, source = "database") {
  return setResolvedLicense(license || createInvalidLicense("missing_license"), source);
}

export function getResolvedLicense() {
  if (!resolvedLicenseCache) {
    resolvedLicenseCache = resolveConfiguredLicense();
  }

  return resolvedLicenseCache;
}

export function isLicenseActive(license = getResolvedLicense()) {
  return normalizeLicenseStatus(license?.status) === "valid" && !isExpired(license?.expiresAt);
}

export function assertLicenseActive(context = {}) {
  const license = getResolvedLicense();
  const status = normalizeLicenseStatus(license?.status);

  if (status !== "valid") {
    throw createLicenseError(
      "license_invalid",
      "License is not valid.",
      {
        status,
        reason: license?.reason || null,
        operation: context?.operation || null
      },
      403
    );
  }

  if (isExpired(license?.expiresAt)) {
    throw createLicenseError(
      "license_expired",
      "License has expired.",
      {
        expiresAt: license?.expiresAt || null,
        operation: context?.operation || null
      },
      403
    );
  }

  return license;
}

export function isLicenseFeatureEnabled(feature) {
  const license = getResolvedLicense();
  return isLicenseActive(license) && license?.features?.[feature] === true;
}

export function assertLicenseFeature(feature, context = {}) {
  const license = assertLicenseActive(context);
  if (license?.features?.[feature] === true) {
    return license;
  }

  throw createLicenseError(
    "license_feature_unavailable",
    "This feature is not enabled by the current license.",
    {
      feature,
      operation: context?.operation || null
    },
    403
  );
}
