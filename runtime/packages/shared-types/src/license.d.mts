export const LICENSE_FEATURES: {
  readonly KB: "kb";
  readonly ONPREM: "onprem";
  readonly CUSTOM_MODEL: "custom_model";
};

export type LicenseFeature = typeof LICENSE_FEATURES[keyof typeof LICENSE_FEATURES];

export type ResolvedLicense = {
  status: string;
  reason?: string | null;
  details?: Record<string, unknown>;
  source?: string;
  licenseId?: string | null;
  customer?: string | null;
  issuedAt?: string | null;
  expiresAt: string | null;
  features: Record<string, boolean>;
};

export const LICENSE_FORMAT_VERSION: "unieai-license-v1";
export const LICENSE_PUBLIC_KEY_PEM: string;
export function resolveLicenseText(
  licenseText: string,
  options?: { publicKeyPem?: string }
): ResolvedLicense;
export function resolveConfiguredLicense(): ResolvedLicense;
export function setResolvedLicense(license: ResolvedLicense, source?: string): ResolvedLicense;
export function initializeLicense(license?: ResolvedLicense | null, source?: string): ResolvedLicense;
export function getResolvedLicense(): ResolvedLicense;
export function isLicenseActive(license?: ResolvedLicense): boolean;
export function assertLicenseActive(context?: { operation?: string | null }): ResolvedLicense;
export function isLicenseFeatureEnabled(feature: LicenseFeature | string): boolean;
export function assertLicenseFeature(feature: LicenseFeature | string, context?: { operation?: string | null }): ResolvedLicense;
