// Hand-written types for click-resolve.mjs (plain ESM, no build step — see index.d.mts).
export const SHOT_MAX_WIDTH: number;
export function buildResolveScript(p: { x: number; y: number }): string;
export function buildResolveElementScript(): string;
export function buildResolveActiveScript(): string;
export function parseResolution(raw: unknown): { ok: true; value: any } | { ok: false; reason: string };
export function clickFingerprint(resolution: any): Promise<string>;
export function shotToCssPoint(p: { x: number; y: number }, vp: { w: number; h: number; dpr: number }, shot: { w: number; h: number }): { x: number; y: number };
export function checkViewportAgainstShot(vp: { w: number; h: number; dpr: number }, shot: { w: number; h: number } | null): boolean;
export function jpegSize(bytes: Uint8Array | null | undefined): { w: number; h: number } | null;
export function pngSize(bytes: Uint8Array | null | undefined): { w: number; h: number } | null;
export function imageSize(bytes: Uint8Array | null | undefined): { w: number; h: number } | null;
