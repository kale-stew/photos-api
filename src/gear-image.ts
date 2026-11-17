/**
 * Pure helpers for normalizing gear product images into a standard frame.
 * Everything here works on raw RGBA buffers so it can be unit tested without
 * the Images binding.
 */

export const GEAR_PIPELINE_VERSION = 1;
export const GEAR_FRAME = 800;
export const GEAR_PADDING = 0.06;
export const GEAR_CONTENT_BOX = Math.round(GEAR_FRAME * (1 - 2 * GEAR_PADDING));
export const GEAR_WORKING_SIZE = 1024;
export const GEAR_ALPHA_THRESHOLD = 16;
export const GEAR_MAX_SOURCE_BYTES = 15 * 1024 * 1024;
export const GEAR_WIDTHS = new Set([200, 400, 800]);

const NOTION_PAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[0-9a-f]{12}$/;
const ALLOWED_SOURCE_HOSTS = [
  /^prod-files-secure\.s3\.[a-z0-9-]+\.amazonaws\.com$/,
  /^file\.notion\.so$/,
  /^[a-z0-9-]+\.notionusercontent\.com$/,
];

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function isNotionPageId(id: unknown): id is string {
  return typeof id === "string" && NOTION_PAGE_ID.test(id);
}

export function isGearVersion(version: unknown): version is string {
  return typeof version === "string" && VERSION.test(version);
}

/** Only Notion-hosted uploads are fetched; anything else is reported, not fetched. */
export function isAllowedSourceUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
  return ALLOWED_SOURCE_HOSTS.some((pattern) => pattern.test(url.hostname));
}

/** Signed Notion URLs change every query; host + path identifies the uploaded file. */
export function sourceKey(raw: string): string {
  const url = new URL(raw);
  return `${url.hostname}${url.pathname}`;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function gearAssetVersion(sourceSha256: string, pipelineVersion = GEAR_PIPELINE_VERSION): Promise<string> {
  return (await sha256Hex(`${sourceSha256}:${pipelineVersion}`)).slice(0, 12);
}

export function gearPrefix(pageId: string, version: string): string {
  return `gear/${pageId}/${version}`;
}

/** Share of pixels that are at least partly transparent. */
export function transparentShare(rgba: Uint8Array, opaqueAlpha = 250): number {
  const pixels = rgba.length / 4;
  if (pixels === 0) return 0;
  let transparent = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < opaqueAlpha) transparent++;
  return transparent / pixels;
}

/** True when the image already has a cut-out background worth trimming. */
export function hasTransparency(rgba: Uint8Array): boolean {
  return transparentShare(rgba) >= 0.01;
}

/** Share of pixels that count as content. */
export function contentCoverage(rgba: Uint8Array, alphaThreshold = GEAR_ALPHA_THRESHOLD): number {
  const pixels = rgba.length / 4;
  if (pixels === 0) return 0;
  let covered = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > alphaThreshold) covered++;
  return covered / pixels;
}

/** Tight bounding box of pixels above the alpha threshold, or null when empty. */
export function contentBox(
  rgba: Uint8Array,
  width: number,
  height: number,
  alphaThreshold = GEAR_ALPHA_THRESHOLD,
): Box | null {
  if (rgba.length !== width * height * 4) throw new Error("RGBA buffer does not match dimensions");
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (rgba[row + x * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Copy a box out of an RGBA image. */
export function cropRgba(rgba: Uint8Array, width: number, height: number, box: Box): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error("RGBA buffer does not match dimensions");
  if (box.left < 0 || box.top < 0 || box.left + box.width > width || box.top + box.height > height) {
    throw new Error("Crop box is outside the image");
  }
  const out = new Uint8Array(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++) {
    const src = ((box.top + y) * width + box.left) * 4;
    out.set(rgba.subarray(src, src + box.width * 4), y * box.width * 4);
  }
  return out;
}

/** Dimensions of a `contain` fit, used to check the binding's output. */
export function containSize(width: number, height: number, box: number): { width: number; height: number } {
  const scale = box / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Centre an RGBA image on a transparent square frame. */
export function centerOnFrame(rgba: Uint8Array, width: number, height: number, frame = GEAR_FRAME): Uint8Array {
  if (width > frame || height > frame) throw new Error("Content is larger than the frame");
  if (rgba.length !== width * height * 4) throw new Error("RGBA buffer does not match dimensions");
  const out = new Uint8Array(frame * frame * 4);
  const left = Math.floor((frame - width) / 2);
  const top = Math.floor((frame - height) / 2);
  for (let y = 0; y < height; y++) {
    const src = y * width * 4;
    out.set(rgba.subarray(src, src + width * 4), ((top + y) * frame + left) * 4);
  }
  return out;
}

export type SegmentationVerdict = "ok" | "empty" | "everything";

/** Reject segmentation output that removed everything or nothing. */
export function judgeSegmentation(coverage: number): SegmentationVerdict {
  if (coverage < 0.02) return "empty";
  if (coverage > 0.98) return "everything";
  return "ok";
}

export interface DecodedPixels {
  width: number;
  height: number;
  data: ArrayLike<number>;
  depth: number;
  channels: number;
  transparency?: ArrayLike<number>;
}

/**
 * Normalize decoded PNG pixels (gray, gray+alpha, RGB, RGBA; 8 or 16 bit) to
 * 8-bit RGBA. Indexed images must be expanded with `convertIndexedToRgb` first.
 */
export function toRgba8(pixels: DecodedPixels): Uint8Array {
  const { width, height, data, depth, channels } = pixels;
  if (depth !== 8 && depth !== 16) throw new Error(`unsupported PNG bit depth ${depth}`);
  if (channels < 1 || channels > 4) throw new Error(`unsupported PNG channel count ${channels}`);
  const count = width * height;
  if (data.length < count * channels) throw new Error("PNG data is shorter than its dimensions");
  const scale = (value: number) => (depth === 16 ? value >> 8 : value);
  // tRNS on gray/RGB images names one fully transparent colour.
  const key = pixels.transparency && (channels === 1 || channels === 3) ? Array.from(pixels.transparency) : null;
  const out = new Uint8Array(count * 4);
  for (let p = 0; p < count; p++) {
    const i = p * channels;
    const o = p * 4;
    if (channels <= 2) {
      const gray = scale(data[i]);
      out[o] = out[o + 1] = out[o + 2] = gray;
      out[o + 3] = channels === 2 ? scale(data[i + 1]) : key && data[i] === key[0] ? 0 : 255;
    } else {
      out[o] = scale(data[i]);
      out[o + 1] = scale(data[i + 1]);
      out[o + 2] = scale(data[i + 2]);
      out[o + 3] =
        channels === 4
          ? scale(data[i + 3])
          : key && data[i] === key[0] && data[i + 1] === key[1] && data[i + 2] === key[2]
            ? 0
            : 255;
    }
  }
  return out;
}
