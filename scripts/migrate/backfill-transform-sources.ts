#!/usr/bin/env npx tsx
/**
 * Create transform sources for originals the Images binding cannot read.
 *
 * Dry run (default): inventories active photos and R2, then writes a manifest.
 * Apply: requires --apply, --account-id, --database-id, and --approve=<manifest-sha256>.
 * Apply only adds `photos/{id}/transform-source.webp`; it never modifies originals
 * and deletes only a source it just created for a photo that became inactive.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  exceedsImagesInputLimit,
  IMAGES_INPUT_LIMIT_BYTES,
  originalKey,
  TRANSFORM_SOURCE_LONG_EDGE,
  transformSourceKey,
} from "../../src/transform-source.js";
import { createTransformSource } from "./transform-source.js";

const BUCKET = "photos-bucket";
const DEFAULT_MANIFEST = resolve("data/imports/transform-sources.manifest.json");

interface Options {
  manifest: string;
  apply: boolean;
  accountId?: string;
  databaseId?: string;
  approve?: string;
}

interface R2Entry {
  key: string;
  size: number;
  etag: string;
}

export interface PlannedSource {
  id: string;
  r2Key: string;
  originalKey: string;
  originalBytes: number;
  originalEtag: string;
  targetKey: string;
}

export interface TransformSourceManifest {
  version: 1;
  limitBytes: number;
  longEdge: number;
  photos: PlannedSource[];
  summary: {
    activePhotos: number;
    oversizedOriginals: number;
    alreadyHaveSource: number;
    toCreate: number;
    missingOriginals: string[];
  };
}

interface PhotoRow {
  id: string;
  r2_key: string;
  format: string;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function parseArgs(): Options {
  return {
    manifest: resolve(argument("manifest") || DEFAULT_MANIFEST),
    apply: process.argv.includes("--apply"),
    accountId: argument("account-id") || process.env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: argument("database-id") || process.env.PHOTOS_DATABASE_ID,
    approve: argument("approve"),
  };
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

let target: { accountId: string; databaseId: string } | undefined;

function cf(args: string[], encoding: "utf8" | "buffer" = "utf8"): string | Buffer {
  if (!target) throw new Error("Cloudflare target is not configured");
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return execFileSync("cf", args, {
        encoding,
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: target.accountId },
        maxBuffer: 350 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error
        ? `${error.message} ${"stderr" in error ? String(error.stderr) : ""}`
        : String(error);
      const transient = /fetch failed|unsettled top-level await|429|5\d\d|timeout|ECONNRESET|ETIMEDOUT/i.test(message);
      if (!transient || attempt === 5) throw error;
      console.warn(`Transient cf failure; retrying (${attempt}/5)`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

function query<T>(sql: string): T[] {
  if (!target) throw new Error("Cloudflare target is not configured");
  const output = cf(["d1", "query", target.databaseId, "--sql", sql]) as string;
  return (JSON.parse(output)[0]?.results || []) as T[];
}

function listObjects(prefix: string): Map<string, R2Entry> {
  const objects = new Map<string, R2Entry>();
  let startAfter: string | undefined;
  for (;;) {
    const args = ["r2", "objects", "list", "--bucket-name", BUCKET, "--prefix", prefix, "--per-page", "1000"];
    if (startAfter) args.push("--start-after", startAfter);
    const page = JSON.parse(cf(args) as string) as R2Entry[];
    for (const object of page) objects.set(object.key, { key: object.key, size: object.size, etag: object.etag });
    if (page.length < 1000) return objects;
    startAfter = page[page.length - 1].key;
  }
}

function getObject(key: string): Buffer | null {
  try {
    return cf(["r2", "objects", "get", key, "--bucket-name", BUCKET], "buffer") as Buffer;
  } catch {
    return null;
  }
}

/** Pure planning step so the selection rules are testable without Cloudflare. */
export function planTransformSources(photos: PhotoRow[], objects: Map<string, R2Entry>): TransformSourceManifest {
  const planned: PlannedSource[] = [];
  const missingOriginals: string[] = [];
  let oversized = 0;
  let alreadyHaveSource = 0;

  for (const photo of [...photos].sort((a, b) => a.id.localeCompare(b.id))) {
    const original = objects.get(originalKey(photo.r2_key, photo.format));
    if (!original) {
      missingOriginals.push(photo.id);
      continue;
    }
    if (!exceedsImagesInputLimit(original.size)) continue;
    oversized++;
    const targetKey = transformSourceKey(photo.r2_key);
    if (objects.has(targetKey)) {
      alreadyHaveSource++;
      continue;
    }
    planned.push({
      id: photo.id,
      r2Key: photo.r2_key,
      originalKey: original.key,
      originalBytes: original.size,
      originalEtag: original.etag,
      targetKey,
    });
  }

  return {
    version: 1,
    limitBytes: IMAGES_INPUT_LIMIT_BYTES,
    longEdge: TRANSFORM_SOURCE_LONG_EDGE,
    photos: planned,
    summary: {
      activePhotos: photos.length,
      oversizedOriginals: oversized,
      alreadyHaveSource,
      toCreate: planned.length,
      missingOriginals,
    },
  };
}

interface ActivePhoto extends PhotoRow {
  sha256: string | null;
}

function activePhoto(id: string): ActivePhoto | null {
  return query<ActivePhoto>(
    `SELECT id, r2_key, format, sha256 FROM photos WHERE id = ${sqlString(id)} AND status = 'active'`,
  )[0] ?? null;
}

/** Reject manifest entries whose keys do not match the canonical layout for the photo. */
export function assertCanonicalKeys(entry: PlannedSource, photo: PhotoRow): void {
  if (photo.r2_key !== entry.r2Key) throw new Error(`r2_key changed since planning for ${entry.id}`);
  if (entry.originalKey !== originalKey(photo.r2_key, photo.format)) {
    throw new Error(`Unexpected original key for ${entry.id}: ${entry.originalKey}`);
  }
  if (entry.targetKey !== transformSourceKey(photo.r2_key)) {
    throw new Error(`Unexpected target key for ${entry.id}: ${entry.targetKey}`);
  }
}

type Outcome = "created" | "skipped" | "inactive";

async function createAndVerify(entry: PlannedSource): Promise<Outcome> {
  const photo = activePhoto(entry.id);
  if (!photo) {
    if (listObjects(`${entry.r2Key}/`).has(entry.targetKey)) {
      console.warn(`  ${entry.id} is inactive but holds ${entry.targetKey}; review before deletion`);
    }
    return "inactive";
  }
  assertCanonicalKeys(entry, photo);

  const current = listObjects(`${entry.r2Key}/`);
  if (current.has(entry.targetKey)) return "skipped";

  const original = current.get(entry.originalKey);
  if (!original || original.size !== entry.originalBytes || original.etag !== entry.originalEtag) {
    throw new Error(`Original changed since planning for ${entry.id}`);
  }

  const bytes = getObject(entry.originalKey);
  if (!bytes || bytes.byteLength !== entry.originalBytes) throw new Error(`Original download failed for ${entry.id}`);
  if (photo.sha256 && sha256(bytes) !== photo.sha256) throw new Error(`Original hash mismatch for ${entry.id}`);

  const source = await createTransformSource(bytes);
  const directory = await mkdtemp(join(tmpdir(), "photos-transform-source-"));
  try {
    const path = join(directory, "transform-source.webp");
    await writeFile(path, source.buffer);
    cf(["r2", "objects", "put", entry.targetKey, "--bucket-name", BUCKET, `--file=${path}`, "--content-type=image/webp"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const verified = getObject(entry.targetKey);
  if (!verified || sha256(verified) !== sha256(source.buffer)) {
    throw new Error(`R2 verification failed for ${entry.targetKey}`);
  }

  if (!activePhoto(entry.id)) {
    cf(["r2", "objects", "delete", entry.targetKey, "--bucket-name", BUCKET]);
    return "inactive";
  }
  console.log(`  ${entry.targetKey}: ${source.width}x${source.height}, ${source.buffer.byteLength} bytes`);
  return "created";
}

async function apply(options: Options): Promise<void> {
  if (!options.approve) throw new Error("Apply requires --approve=<manifest-sha256>");
  const bytes = await readFile(options.manifest);
  if (sha256(bytes) !== options.approve) throw new Error("Manifest approval digest does not match");
  const manifest = JSON.parse(bytes.toString("utf8")) as TransformSourceManifest;
  if (manifest.version !== 1 || manifest.limitBytes !== IMAGES_INPUT_LIMIT_BYTES) {
    throw new Error("Manifest was planned with different limits; plan again");
  }

  const results: Record<Outcome, number> = { created: 0, skipped: 0, inactive: 0 };
  const failed: { id: string; error: string }[] = [];
  for (const [index, entry] of manifest.photos.entries()) {
    console.log(`[${index + 1}/${manifest.photos.length}] ${entry.id}`);
    try {
      results[await createAndVerify(entry)]++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  failed: ${message}`);
      failed.push({ id: entry.id, error: message });
    }
  }
  console.log(JSON.stringify({ ...results, failed }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const options = parseArgs();
  if (!options.accountId || !options.databaseId) {
    throw new Error("Requires --account-id and --database-id (read-only for the dry run)");
  }
  target = { accountId: options.accountId, databaseId: options.databaseId };

  if (options.apply) {
    await apply(options);
    return;
  }

  const photos = query<PhotoRow>("SELECT id, r2_key, format FROM photos WHERE status = 'active'");
  const manifest = planTransformSources(photos, listObjects("photos/"));
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await mkdir(dirname(options.manifest), { recursive: true });
  await writeFile(options.manifest, serialized);
  console.log(JSON.stringify(manifest.summary, null, 2));
  console.log(`Manifest: ${options.manifest}`);
  console.log(`Approval digest: ${sha256(serialized)}`);
  console.log("Dry run only. Review the manifest before applying.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
