import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  LICENSE_FEATURES,
  LICENSE_FORMAT_VERSION,
  isLicenseActive,
  resolveLicenseText
} from "./license.mjs";

function createTestKeys() {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

function createSignedLicense(payload, privateKeyPem) {
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signingInput = `${LICENSE_FORMAT_VERSION}.${payloadPart}`;
  const signaturePart = sign(null, Buffer.from(signingInput, "utf8"), privateKeyPem).toString("base64url");
  return `${signingInput}.${signaturePart}`;
}

function createPayload(overrides = {}) {
  return {
    licenseId: "lic_test",
    customer: "Test Customer",
    issuedAt: "2026-05-02T00:00:00.000Z",
    expiresAt: "2099-12-31T23:59:59.000Z",
    features: {
      [LICENSE_FEATURES.KB]: true,
      [LICENSE_FEATURES.ONPREM]: true,
      [LICENSE_FEATURES.CUSTOM_MODEL]: true
    },
    ...overrides
  };
}

test("resolves a valid signed license", () => {
  const { publicKey, privateKey } = createTestKeys();
  const signedLicense = createSignedLicense(createPayload(), privateKey);
  const license = resolveLicenseText(signedLicense, { publicKeyPem: publicKey });

  assert.equal(license.status, "valid");
  assert.equal(license.licenseId, "lic_test");
  assert.equal(license.features[LICENSE_FEATURES.KB], true);
  assert.equal(license.features[LICENSE_FEATURES.ONPREM], true);
  assert.equal(license.features[LICENSE_FEATURES.CUSTOM_MODEL], true);
  assert.equal(isLicenseActive(license), true);
});

test("fails closed when license text is missing", () => {
  const license = resolveLicenseText("");

  assert.equal(license.status, "invalid");
  assert.equal(license.reason, "missing_license");
  assert.equal(license.features[LICENSE_FEATURES.KB], false);
});

test("rejects a tampered payload", () => {
  const { publicKey, privateKey } = createTestKeys();
  const signedLicense = createSignedLicense(createPayload(), privateKey);
  const parts = signedLicense.split(".");
  const tamperedPayload = createPayload({
    features: {
      [LICENSE_FEATURES.KB]: true,
      [LICENSE_FEATURES.ONPREM]: false,
      [LICENSE_FEATURES.CUSTOM_MODEL]: true
    }
  });
  parts[1] = Buffer.from(JSON.stringify(tamperedPayload), "utf8").toString("base64url");

  const license = resolveLicenseText(parts.join("."), { publicKeyPem: publicKey });

  assert.equal(license.status, "invalid");
  assert.equal(license.reason, "license_signature_invalid");
  assert.equal(license.features[LICENSE_FEATURES.ONPREM], false);
});

test("rejects a tampered signature", () => {
  const { publicKey, privateKey } = createTestKeys();
  const signedLicense = createSignedLicense(createPayload(), privateKey);
  const parts = signedLicense.split(".");
  parts[2] = `${parts[2].slice(0, -1)}${parts[2].endsWith("A") ? "B" : "A"}`;

  const license = resolveLicenseText(parts.join("."), { publicKeyPem: publicKey });

  assert.equal(license.status, "invalid");
  assert.equal(license.reason, "license_signature_invalid");
});

test("keeps expired signed licenses inactive", () => {
  const { publicKey, privateKey } = createTestKeys();
  const signedLicense = createSignedLicense(createPayload({ expiresAt: "2000-01-01T00:00:00.000Z" }), privateKey);
  const license = resolveLicenseText(signedLicense, { publicKeyPem: publicKey });

  assert.equal(license.status, "valid");
  assert.equal(isLicenseActive(license), false);
});

test("normalizes omitted features to disabled", () => {
  const { publicKey, privateKey } = createTestKeys();
  const signedLicense = createSignedLicense(
    createPayload({
      features: {
        [LICENSE_FEATURES.KB]: true
      }
    }),
    privateKey
  );
  const license = resolveLicenseText(signedLicense, { publicKeyPem: publicKey });

  assert.equal(license.status, "valid");
  assert.equal(license.features[LICENSE_FEATURES.KB], true);
  assert.equal(license.features[LICENSE_FEATURES.ONPREM], false);
  assert.equal(license.features[LICENSE_FEATURES.CUSTOM_MODEL], false);
});
