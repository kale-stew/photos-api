/**
 * Gear product images: Notion-sourced, normalized into a standard transparent
 * frame, stored under `gear/` in the photo bucket, and served by version.
 *
 * climb-log's nightly Notion sync drives ingestion through the `GearAssets`
 * RPC entrypoint, which is reachable only through a service binding. Gear
 * assets never touch the photo tables, aliases, collections, or slugs.
 */

import { convertIndexedToRgb, decode as decodePng, encode as encodePng } from "fast-png";
import {
  centerOnFrame,
  containSize,
  contentBox,
  cropRgba,
  contentCoverage,
  GEAR_ALPHA_THRESHOLD,
  GEAR_CONTENT_BOX,
  GEAR_FRAME,
  GEAR_MAX_SOURCE_BYTES,
  GEAR_PIPELINE_VERSION,
  GEAR_WIDTHS,
  GEAR_WORKING_SIZE,
  gearAssetVersion,
  gearPrefix,
  hasTransparency,
  isAllowedSourceUrl,
  isGearVersion,
  isNotionPageId,
  judgeSegmentation,
  sha256Hex,
  sourceKey,
  toRgba8,
} from "./gear-image";

export type GearImageStatus = "ready" | "needs_review" | "missing" | "unsupported" | "pending" | "failed";

// The RPC contract is mirrored in climb-log `src/lib/gear-images.ts`; keep them in step.
export interface GearImageItem {
  id: string;
  url: string | null;
}

export interface GearImageResult {
  id: string;
  status: GearImageStatus;
  version?: string;
  error?: string;
}

export interface GearImageSyncOptions {
  maxProcess?: number;
  dryRun?: boolean;
}

/** Seams for unit tests; production uses the defaults. */
export interface GearAssetDeps {
  fetch: typeof fetch;
  normalize: typeof normalizeGearImage;
}

interface GearAssetRow {
  notion_page_id: string;
  source_key: string;
  pipeline_version: number;
  version: string;
  r2_prefix: string;
  status: "ready" | "needs_review";
}

const DEFAULT_MAX_PROCESS = 20;
const MAX_ITEMS = 500;
const RETIRED_GRACE_DAYS = 7;
const MAX_CLEANUP_PER_CALL = 10;

const inFlightGearTransforms = new Map<string, Promise<R2ObjectBody | null>>();

async function currentAsset(db: D1Database, pageId: string): Promise<GearAssetRow | null> {
  return db
    .prepare(
      "SELECT notion_page_id, source_key, pipeline_version, version, r2_prefix, status FROM gear_assets WHERE notion_page_id = ?",
    )
    .bind(pageId)
    .first<GearAssetRow>();
}

async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new Error(`source is ${declared} bytes, over the ${limit} byte limit`);
  }
  if (!response.body) throw new Error("source has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`source exceeds the ${limit} byte limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes).body as ReadableStream<Uint8Array>;
}

async function toBytes(result: ImageTransformationResult): Promise<Uint8Array> {
  return new Uint8Array(await result.response().arrayBuffer());
}

interface NormalizedImage {
  master: Uint8Array;
  backgroundRemoved: boolean;
  needsReview: boolean;
  coverage: number;
}

/** Background-remove if needed, trim to content, and centre in the standard frame. */
export async function normalizeGearImage(images: ImagesBinding, source: Uint8Array): Promise<NormalizedImage> {
  const working = (segment: boolean) => {
    const transform: ImageTransform = { width: GEAR_WORKING_SIZE, height: GEAR_WORKING_SIZE, fit: "scale-down" };
    if (segment) transform.segment = "foreground";
    return images.input(streamOf(source)).transform(transform).output({ format: "image/png" }).then(toBytes);
  };
  let pixels = decodeToRgba(await working(false));
  let backgroundRemoved = false;
  let needsReview = false;

  if (!hasTransparency(pixels.rgba)) {
    try {
      const segmented = decodeToRgba(await working(true));
      if (judgeSegmentation(contentCoverage(segmented.rgba)) === "ok") {
        pixels = segmented;
        backgroundRemoved = true;
      } else {
        needsReview = true;
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "gear_segment_failed", error: errorMessage(error) }));
      needsReview = true;
    }
  }

  const box = contentBox(pixels.rgba, pixels.width, pixels.height, GEAR_ALPHA_THRESHOLD) ?? {
    left: 0,
    top: 0,
    width: pixels.width,
    height: pixels.height,
  };
  const cropped = encodePng({
    width: box.width,
    height: box.height,
    data: cropRgba(pixels.rgba, pixels.width, pixels.height, box),
    channels: 4,
    depth: 8,
  });
  const fitted = decodeToRgba(
    await toBytes(
      await images
        .input(streamOf(cropped))
        .transform({ width: GEAR_CONTENT_BOX, height: GEAR_CONTENT_BOX, fit: "contain" })
        .output({ format: "image/png" }),
    ),
  );
  const expected = containSize(box.width, box.height, GEAR_CONTENT_BOX);
  if (Math.abs(fitted.width - expected.width) > 2 || Math.abs(fitted.height - expected.height) > 2) {
    throw new Error(`fitted image is ${fitted.width}x${fitted.height}, expected about ${expected.width}x${expected.height}`);
  }
  const frame = centerOnFrame(fitted.rgba, fitted.width, fitted.height, GEAR_FRAME);
  const master = encodePng({ width: GEAR_FRAME, height: GEAR_FRAME, data: frame, channels: 4, depth: 8 });
  return { master, backgroundRemoved, needsReview, coverage: contentCoverage(frame) };
}

function decodeToRgba(png: Uint8Array): { rgba: Uint8Array; width: number; height: number } {
  const decoded = decodePng(png);
  if (decoded.palette) {
    const expanded = convertIndexedToRgb(decoded);
    const channels = expanded.length / (decoded.width * decoded.height);
    return { rgba: toRgba8({ width: decoded.width, height: decoded.height, data: expanded, depth: 8, channels }), width: decoded.width, height: decoded.height };
  }
  return { rgba: toRgba8(decoded), width: decoded.width, height: decoded.height };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch a Notion-hosted file. `file.notion.so` answers with a redirect to S3,
 * so follow at most one hop, and only to another allowlisted host.
 */
async function fetchSource(url: string, fetcher: typeof fetch): Promise<Response> {
  let target = url;
  for (let hop = 0; hop < 2; hop++) {
    const response = await fetcher(target, { redirect: "manual", headers: { Accept: "image/*" } });
    if (response.status === 200) return response;
    await response.body?.cancel();
    const location = response.headers.get("Location");
    if (hop === 0 && response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, target).toString();
      if (!isAllowedSourceUrl(next)) throw new Error("source redirected to a host that is not allowed");
      target = next;
      continue;
    }
    throw new Error(`source returned ${response.status}`);
  }
  throw new Error("source redirected more than once");
}

async function ingestOne(
  env: Env,
  item: { id: string; url: string },
  existing: GearAssetRow | null,
  deps: GearAssetDeps,
): Promise<GearImageResult> {
  const response = await fetchSource(item.url, deps.fetch);
  const source = await readCapped(response, GEAR_MAX_SOURCE_BYTES);
  const sourceSha256 = await sha256Hex(source);
  const version = await gearAssetVersion(sourceSha256);
  const prefix = gearPrefix(item.id, version);

  if (existing && existing.version === version && (await env.PHOTOS_BUCKET.head(`${prefix}/master.png`))) {
    // Same bytes re-uploaded under a new Notion file: just record the new key.
    await env.DB.prepare(
      "UPDATE gear_assets SET source_key = ?, pipeline_version = ?, updated_at = datetime('now') WHERE notion_page_id = ?",
    )
      .bind(sourceKey(item.url), GEAR_PIPELINE_VERSION, item.id)
      .run();
    return { id: item.id, status: existing.status, version };
  }

  const normalized = await deps.normalize(env.IMAGES, source);
  // Track the prefix before writing to it, so a failed D1 batch below leaves a
  // retired row that cleanup can find. The batch removes it on success.
  await env.DB.prepare("INSERT OR IGNORE INTO gear_asset_retired_prefixes (r2_prefix, notion_page_id) VALUES (?, ?)")
    .bind(prefix, item.id)
    .run();
  await env.PHOTOS_BUCKET.put(`${prefix}/master.png`, normalized.master, {
    httpMetadata: { contentType: "image/png" },
  });
  const status = normalized.needsReview ? "needs_review" : "ready";

  const statements = [
    env.DB.prepare(`
      INSERT INTO gear_assets (notion_page_id, source_key, source_sha256, pipeline_version, version, r2_prefix, status, background_removed, content_coverage, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(notion_page_id) DO UPDATE SET
        source_key = excluded.source_key,
        source_sha256 = excluded.source_sha256,
        pipeline_version = excluded.pipeline_version,
        version = excluded.version,
        r2_prefix = excluded.r2_prefix,
        status = excluded.status,
        background_removed = excluded.background_removed,
        content_coverage = excluded.content_coverage,
        updated_at = datetime('now')
    `).bind(
      item.id,
      sourceKey(item.url),
      sourceSha256,
      GEAR_PIPELINE_VERSION,
      version,
      prefix,
      status,
      normalized.backgroundRemoved ? 1 : 0,
      normalized.coverage,
    ),
  ];
  if (existing && existing.r2_prefix !== prefix) {
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO gear_asset_retired_prefixes (r2_prefix, notion_page_id) VALUES (?, ?)")
        .bind(existing.r2_prefix, item.id),
    );
  }
  // A prefix that was retired earlier and is now current again must not be cleaned up.
  statements.push(env.DB.prepare("DELETE FROM gear_asset_retired_prefixes WHERE r2_prefix = ?").bind(prefix));
  await env.DB.batch(statements);
  return { id: item.id, status, version };
}

/** Delete superseded prefixes after the grace period: R2 first, verified, then D1. */
export async function cleanupRetiredGearPrefixes(env: Env, limit = MAX_CLEANUP_PER_CALL): Promise<number> {
  const due = await env.DB.prepare(`
    SELECT r.r2_prefix FROM gear_asset_retired_prefixes r
    WHERE r.retired_at <= datetime('now', ?)
      AND NOT EXISTS (SELECT 1 FROM gear_assets a WHERE a.r2_prefix = r.r2_prefix)
    ORDER BY r.retired_at
    LIMIT ?
  `).bind(`-${RETIRED_GRACE_DAYS} days`, limit).all<{ r2_prefix: string }>();
  let cleaned = 0;
  const isCurrent = async (prefix: string) =>
    (await env.DB.prepare("SELECT 1 AS current FROM gear_assets WHERE r2_prefix = ?").bind(prefix).first()) !== null;
  for (const { r2_prefix } of due.results ?? []) {
    try {
      // A concurrent sync can re-adopt this prefix after it was selected.
      if (await isCurrent(r2_prefix)) {
        await env.DB.prepare("DELETE FROM gear_asset_retired_prefixes WHERE r2_prefix = ?").bind(r2_prefix).run();
        continue;
      }
      const listPrefix = `${r2_prefix}/`;
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await env.PHOTOS_BUCKET.list({ prefix: listPrefix, cursor });
        keys.push(...page.objects.map((object) => object.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      if (keys.length > 0) await env.PHOTOS_BUCKET.delete(keys);
      const remaining = await env.PHOTOS_BUCKET.list({ prefix: listPrefix, limit: 1 });
      if (remaining.objects.length > 0) throw new Error("objects remain after delete");
      if (await isCurrent(r2_prefix)) {
        // Re-adopted while deleting: force the next sync to rebuild it.
        await env.DB.prepare("UPDATE gear_assets SET pipeline_version = 0 WHERE r2_prefix = ?").bind(r2_prefix).run();
      }
      await env.DB.prepare("DELETE FROM gear_asset_retired_prefixes WHERE r2_prefix = ?").bind(r2_prefix).run();
      cleaned++;
    } catch (error) {
      console.error(JSON.stringify({ event: "gear_prefix_cleanup_failed", prefix: r2_prefix, error: errorMessage(error) }));
    }
  }
  return cleaned;
}

export async function syncGearImages(
  env: Env,
  items: GearImageItem[],
  options: GearImageSyncOptions = {},
  deps: GearAssetDeps = { fetch: (input, init) => fetch(input, init), normalize: normalizeGearImage },
): Promise<{ results: GearImageResult[]; cleaned: number }> {
  if (!Array.isArray(items) || items.length > MAX_ITEMS) throw new Error(`items must be an array of at most ${MAX_ITEMS}`);
  const maxProcess = Math.max(0, Math.min(options.maxProcess ?? DEFAULT_MAX_PROCESS, 50));
  const results: GearImageResult[] = [];
  let processed = 0;
  const rows = await env.DB.prepare(
    "SELECT notion_page_id, source_key, pipeline_version, version, r2_prefix, status FROM gear_assets",
  ).all<GearAssetRow>();
  const existingById = new Map((rows.results ?? []).map((row) => [row.notion_page_id, row]));

  for (const item of items) {
    const id = item?.id;
    if (!isNotionPageId(id)) {
      results.push({ id: String(id), status: "failed", error: "id is not a dashed Notion page id" });
      continue;
    }
    if (!item.url) {
      results.push({ id, status: "missing" });
      continue;
    }
    if (!isAllowedSourceUrl(item.url)) {
      results.push({ id, status: "unsupported", error: "image is not a Notion-hosted upload" });
      continue;
    }
    try {
      const existing = existingById.get(id) ?? null;
      if (existing && existing.source_key === sourceKey(item.url) && existing.pipeline_version === GEAR_PIPELINE_VERSION) {
        results.push({ id, status: existing.status, version: existing.version });
        continue;
      }
      if (options.dryRun || processed >= maxProcess) {
        results.push({ id, status: "pending" });
        continue;
      }
      processed++;
      results.push(await ingestOne(env, { id, url: item.url }, existing, deps));
    } catch (error) {
      console.error(JSON.stringify({ event: "gear_image_failed", id, error: errorMessage(error) }));
      results.push({ id, status: "failed", error: errorMessage(error).slice(0, 200) });
    }
  }

  const cleaned = options.dryRun ? 0 : await cleanupRetiredGearPrefixes(env);
  return { results, cleaned };
}

async function getOrCreateGearTransform(
  env: Env,
  asset: GearAssetRow,
  width: number,
): Promise<R2ObjectBody | null> {
  const targetKey = `${asset.r2_prefix}/w${width}.webp`;
  const existing = inFlightGearTransforms.get(targetKey);
  if (existing) return existing;

  const isCurrent = async () => (await currentAsset(env.DB, asset.notion_page_id))?.r2_prefix === asset.r2_prefix;

  const promise = (async (): Promise<R2ObjectBody | null> => {
    try {
      if (!(await isCurrent())) return null;
      const master = await env.PHOTOS_BUCKET.get(`${asset.r2_prefix}/master.png`);
      if (!master) return null;
      const output = await env.IMAGES.input(master.body)
        .transform({ width, fit: "scale-down" })
        .output({ format: "image/webp", quality: 90 });
      const buffer = await output.response().arrayBuffer();
      await env.PHOTOS_BUCKET.put(targetKey, buffer, { httpMetadata: { contentType: "image/webp" } });
      // The asset can be replaced while this runs; never leave output in a retired prefix.
      if (!(await isCurrent())) {
        await env.PHOTOS_BUCKET.delete(targetKey);
        return null;
      }
      return await env.PHOTOS_BUCKET.get(targetKey);
    } catch (error) {
      console.error(JSON.stringify({ event: "gear_transform_failed", key: targetKey, error: errorMessage(error) }));
      return null;
    } finally {
      inFlightGearTransforms.delete(targetKey);
    }
  })();
  inFlightGearTransforms.set(targetKey, promise);
  return promise;
}

/** GET /gear/{pageId}/{version}.{webp|png}[?w=200|400|800] */
export async function serveGearImage(
  env: Env,
  pageId: string,
  version: string,
  ext: string,
  widthParam: string | undefined,
): Promise<Response> {
  if (!isNotionPageId(pageId) || !isGearVersion(version) || (ext !== "webp" && ext !== "png")) {
    return new Response("Not found", { status: 404 });
  }
  let width: number | null = null;
  if (ext === "webp") {
    width = widthParam ? Number(widthParam) : 400;
    if (!GEAR_WIDTHS.has(width)) {
      return new Response(`Invalid width. Allowed: ${[...GEAR_WIDTHS].join(", ")}`, { status: 400 });
    }
  }

  const asset = await currentAsset(env.DB, pageId);
  if (!asset) return new Response("Gear image not found", { status: 404 });
  if (asset.version !== version) {
    const location = `/gear/${pageId}/${asset.version}.${ext}${width ? `?w=${width}` : ""}`;
    return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "public, max-age=300" } });
  }

  const object = width
    ? (await env.PHOTOS_BUCKET.get(`${asset.r2_prefix}/w${width}.webp`)) ?? (await getOrCreateGearTransform(env, asset, width))
    : await env.PHOTOS_BUCKET.get(`${asset.r2_prefix}/master.png`);
  if (!object) return new Response("Gear image unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });

  return new Response(object.body, {
    headers: {
      "Content-Type": width ? "image/webp" : "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: object.etag,
    },
  });
}
