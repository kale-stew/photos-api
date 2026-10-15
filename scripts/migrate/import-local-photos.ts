#!/usr/bin/env npx tsx

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

type ImageFormat = "jpeg" | "png" | "webp";

interface BlogPhoto {
  id: string;
  title: string | null;
  caption: string | null;
  src: string;
  area: string | null;
  state: string | null;
  date: string | null;
  search_tags: string | null;
}

interface ImportPhoto {
  action: "create" | "reuse";
  id: string;
  sourceKind: "blog" | "desktop";
  sourceFiles: string[];
  sourceUrl: string | null;
  aliases: { alias: string; kind: string }[];
  r2Key: string;
  sha256: string;
  width: number;
  height: number;
  format: ImageFormat;
  sizeBytes: number;
  title: string | null;
  caption: string | null;
  location: string | null;
  date: string | null;
  tags: string[];
  collection: "kylies-photos-content" | "portfolio" | null;
}

interface ImportManifest {
  version: 1;
  inputs: {
    blogJsonSha256: string;
    desktopFiles: number;
  };
  photos: ImportPhoto[];
  duplicates: { sha256: string; files: string[] }[];
  summary: {
    create: number;
    reuse: number;
    blog: number;
    desktop: number;
    bytesToUpload: number;
  };
}

interface PlanOptions {
  blogJson: string;
  desktopDir: string;
  resolutions: string;
}

interface CliOptions extends PlanOptions {
  manifest: string;
  apply: boolean;
  accountId?: string;
  databaseId?: string;
  approve?: string;
}

const DEFAULTS = {
  blogJson: resolve("../climb-log/data/blog-photos.json"),
  desktopDir: resolve("../Desktop Pictures copy"),
  resolutions: resolve("data/imports/local-photos.resolutions.json"),
  manifest: resolve("data/imports/local-photos.manifest.json"),
};

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function publishedShortId(id: string): string {
  return sha256(id).slice(0, 8);
}

export function desktopPhotoId(imageSha256: string): string {
  return sha256(`desktop\0${imageSha256}`).slice(0, 12);
}

export function publicationFor(
  collection: ImportPhoto["collection"]
): { exclude: number; visibility: "public" | "unlisted" } {
  return collection === "portfolio"
    ? { exclude: 0, visibility: "public" }
    : { exclude: 1, visibility: "unlisted" };
}

function getArgument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

export function parseArgs(): CliOptions {
  return {
    blogJson: resolve(getArgument("blog-json") || DEFAULTS.blogJson),
    desktopDir: resolve(getArgument("desktop-dir") || DEFAULTS.desktopDir),
    resolutions: resolve(getArgument("resolutions") || DEFAULTS.resolutions),
    manifest: resolve(getArgument("manifest") || DEFAULTS.manifest),
    apply: process.argv.includes("--apply"),
    accountId: getArgument("account-id") || process.env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: getArgument("database-id") || process.env.PHOTOS_DATABASE_ID,
    approve: getArgument("approve"),
  };
}

async function inspectImage(buffer: Buffer): Promise<Pick<ImportPhoto, "sha256" | "width" | "height" | "format" | "sizeBytes">> {
  const metadata = await sharp(buffer, { failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height || !["jpeg", "png", "webp"].includes(metadata.format || "")) {
    throw new Error(`Unsupported image: ${metadata.format || "unknown"}`);
  }
  return {
    sha256: sha256(buffer),
    width: metadata.width,
    height: metadata.height,
    format: metadata.format as ImageFormat,
    sizeBytes: buffer.byteLength,
  };
}

function flickrId(url: string): string | null {
  return url.match(/\/(\d+)_/)?.[1] || null;
}

function desktopTitle(filename: string): string {
  return basename(filename, extname(filename))
    .replace(/^\d{4}-/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function listDesktopFiles(directory: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(directory);
  return names
    .filter((name) => /\.(?:jpe?g|png|webp)$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
}

async function fetchImage(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function buildManifest(options: PlanOptions): Promise<ImportManifest> {
  const blogJsonBuffer = await readFile(options.blogJson);
  const blogPhotos = JSON.parse(blogJsonBuffer.toString("utf8")) as BlogPhoto[];
  const resolutions = JSON.parse(await readFile(options.resolutions, "utf8")) as Record<string, string>;
  const photos: ImportPhoto[] = [];

  for (const blog of [...blogPhotos].sort((a, b) => a.id.localeCompare(b.id))) {
    const buffer = await fetchImage(blog.src);
    const inspected = await inspectImage(buffer);
    const reuseId = resolutions[blog.id];
    const canonicalId = reuseId || (blog.id.startsWith("blog-") ? blog.id : sha256(`legacy\0${blog.id}`).slice(0, 12));
    const aliases = [
      { alias: publishedShortId(blog.id), kind: "legacy-short-id" },
      ...(canonicalId === blog.id ? [] : [{ alias: blog.id, kind: "legacy-id" }]),
    ].sort((a, b) => a.alias.localeCompare(b.alias));

    photos.push({
      action: reuseId ? "reuse" : "create",
      id: canonicalId,
      sourceKind: "blog",
      sourceFiles: [],
      sourceUrl: blog.src,
      aliases,
      r2Key: `photos/${canonicalId}`,
      ...inspected,
      title: blog.title,
      caption: blog.caption,
      location: [blog.area, blog.state].filter(Boolean).join(", ") || null,
      date: blog.date,
      tags: blog.search_tags?.split(",").map((tag) => tag.trim()).filter(Boolean) || [],
      collection: "kylies-photos-content",
    });
  }

  const desktopNames = await listDesktopFiles(options.desktopDir);
  const desktopByHash = new Map<string, { names: string[]; buffer: Buffer; inspected: Awaited<ReturnType<typeof inspectImage>> }>();
  for (const name of desktopNames) {
    const buffer = await readFile(join(options.desktopDir, name));
    const inspected = await inspectImage(buffer);
    const existing = desktopByHash.get(inspected.sha256);
    if (existing) {
      existing.names.push(name);
    } else {
      desktopByHash.set(inspected.sha256, { names: [name], buffer, inspected });
    }
  }

  for (const [imageSha256, entry] of [...desktopByHash.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const id = desktopPhotoId(imageSha256);
    photos.push({
      action: "create",
      id,
      sourceKind: "desktop",
      sourceFiles: entry.names.sort((a, b) => a.localeCompare(b)),
      sourceUrl: null,
      aliases: [],
      r2Key: `photos/${id}`,
      ...entry.inspected,
      title: desktopTitle(entry.names[0]),
      caption: null,
      location: null,
      date: null,
      tags: [],
      collection: "portfolio",
    });
  }

  photos.sort((a, b) => `${a.sourceKind}:${a.id}`.localeCompare(`${b.sourceKind}:${b.id}`));
  const duplicates = [...desktopByHash.entries()]
    .filter(([, entry]) => entry.names.length > 1)
    .map(([hash, entry]) => ({ sha256: hash, files: [...entry.names].sort((a, b) => a.localeCompare(b)) }));

  const identifiers = new Map<string, string>();
  for (const photo of photos) {
    for (const identifier of [photo.id, photo.r2Key, ...photo.aliases.map(({ alias }) => alias)]) {
      const existing = identifiers.get(identifier);
      if (existing && existing !== photo.id) throw new Error(`Identifier collision: ${identifier} (${existing}, ${photo.id})`);
      identifiers.set(identifier, photo.id);
    }
  }

  return {
    version: 1,
    inputs: { blogJsonSha256: sha256(blogJsonBuffer), desktopFiles: desktopNames.length },
    photos,
    duplicates,
    summary: {
      create: photos.filter(({ action }) => action === "create").length,
      reuse: photos.filter(({ action }) => action === "reuse").length,
      blog: photos.filter(({ sourceKind }) => sourceKind === "blog").length,
      desktop: photos.filter(({ sourceKind }) => sourceKind === "desktop").length,
      bytesToUpload: photos.filter(({ action }) => action === "create").reduce((sum, photo) => sum + photo.sizeBytes, 0),
    },
  };
}

function sqlString(value: string | null): string {
  return value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`;
}

let cloudflareTarget: { accountId: string; databaseId: string } | undefined;

function cf(args: string[], options: { encoding?: "utf8" | "buffer" } = {}): string | Buffer {
  if (!cloudflareTarget) throw new Error("Cloudflare target is not configured");
  return execFileSync("cf", args, {
    encoding: options.encoding === "buffer" ? "buffer" : "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: cloudflareTarget.accountId },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function query(sql: string): Record<string, unknown>[] {
  if (!cloudflareTarget) throw new Error("Cloudflare target is not configured");
  const output = cf(["d1", "query", cloudflareTarget.databaseId, "--sql", sql], { encoding: "utf8" }) as string;
  return JSON.parse(output)[0]?.results || [];
}

async function sourceBuffer(photo: ImportPhoto, options: PlanOptions): Promise<Buffer> {
  if (photo.sourceUrl) return fetchImage(photo.sourceUrl);
  if (!photo.sourceFiles[0]) throw new Error(`No source for ${photo.id}`);
  return readFile(join(options.desktopDir, photo.sourceFiles[0]));
}

async function uploadAndVerify(photo: ImportPhoto, buffer: Buffer): Promise<void> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "photos-import-"));
  const sourcePath = join(tempDirectory, `original.${photo.format}`);
  const objectKey = `${photo.r2Key}/original.${photo.format}`;
  try {
    await writeFile(sourcePath, buffer);
    let current: Buffer | null = null;
    try {
      current = cf(["r2", "objects", "get", objectKey, "--bucket-name", "photos-bucket"], { encoding: "buffer" }) as Buffer;
    } catch {
      // Missing objects are uploaded below.
    }
    if (current) {
      if (sha256(current) !== photo.sha256) throw new Error(`R2 object differs for ${photo.id}`);
      return;
    }
    cf(["r2", "objects", "put", objectKey, "--bucket-name", "photos-bucket", `--file=${sourcePath}`, `--content-type=image/${photo.format}`]);
    const verified = cf(["r2", "objects", "get", objectKey, "--bucket-name", "photos-bucket"], { encoding: "buffer" }) as Buffer;
    if (sha256(verified) !== photo.sha256) throw new Error(`R2 verification failed for ${photo.id}`);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function commitPhoto(photo: ImportPhoto): Promise<void> {
  const existingPhoto = query(`SELECT id, r2_key, sha256 FROM photos WHERE id = ${sqlString(photo.id)}`)[0];
  if (existingPhoto && (existingPhoto.r2_key !== photo.r2Key || (existingPhoto.sha256 && existingPhoto.sha256 !== photo.sha256))) {
    throw new Error(`Canonical photo conflict for ${photo.id}`);
  }
  for (const { alias } of photo.aliases) {
    const existing = query(`SELECT photo_id FROM photo_aliases WHERE alias = ${sqlString(alias)}`)[0];
    if (existing && existing.photo_id !== photo.id) throw new Error(`Alias conflict for ${alias}`);
  }

  const { exclude, visibility } = publicationFor(photo.collection);
  const inserts = photo.action === "create" ? `
    INSERT OR IGNORE INTO photos (
      id, r2_key, title, caption, location, date, width, height, format, size_bytes,
      site, source, tags, exclude, status, visibility, sha256
    ) VALUES (
      ${sqlString(photo.id)}, ${sqlString(photo.r2Key)}, ${sqlString(photo.title)}, ${sqlString(photo.caption)},
      ${sqlString(photo.location)}, ${sqlString(photo.date)}, ${photo.width}, ${photo.height}, ${sqlString(photo.format)},
      ${photo.sizeBytes}, 'climb-log', ${sqlString(photo.sourceKind)}, ${sqlString(JSON.stringify(photo.tags))},
      ${exclude}, 'active', ${sqlString(visibility)}, ${sqlString(photo.sha256)}
    );` : "";
  const aliases = photo.aliases.map(({ alias, kind }) => `
    INSERT OR IGNORE INTO photo_aliases (alias, photo_id, kind)
    VALUES (${sqlString(alias)}, ${sqlString(photo.id)}, ${sqlString(kind)});`).join("");
  const collection = photo.collection ? `
    INSERT OR IGNORE INTO photo_collections (photo_id, collection_slug)
    VALUES (${sqlString(photo.id)}, ${sqlString(photo.collection)});` : "";
  query(`${inserts}${aliases}${collection}`);

  const verified = query(`SELECT id, r2_key FROM photos WHERE id = ${sqlString(photo.id)}`)[0];
  if (!verified || verified.r2_key !== photo.r2Key) throw new Error(`D1 verification failed for ${photo.id}`);
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function preflightManifest(manifest: ImportManifest): void {
  const expectedIds = new Map(manifest.photos.map((photo) => [photo.id, photo]));
  for (const ids of chunks([...expectedIds.keys()], 100)) {
    const rows = query(`SELECT id, r2_key, sha256 FROM photos WHERE id IN (${ids.map(sqlString).join(",")})`);
    for (const row of rows) {
      const expected = expectedIds.get(String(row.id));
      if (!expected) continue;
      if (expected.action === "create" && (row.r2_key !== expected.r2Key || (row.sha256 && row.sha256 !== expected.sha256))) {
        throw new Error(`Canonical photo conflict for ${expected.id}`);
      }
    }
  }

  const expectedAliases = new Map<string, string>();
  for (const photo of manifest.photos) {
    for (const { alias } of photo.aliases) expectedAliases.set(alias, photo.id);
  }
  for (const aliases of chunks([...expectedAliases.keys()], 100)) {
    const rows = query(`SELECT alias, photo_id FROM photo_aliases WHERE alias IN (${aliases.map(sqlString).join(",")})`);
    for (const row of rows) {
      const expectedPhotoId = expectedAliases.get(String(row.alias));
      if (row.photo_id !== expectedPhotoId) throw new Error(`Alias conflict for ${row.alias}`);
    }
  }

  for (const hashes of chunks(manifest.photos.filter(({ action }) => action === "create").map(({ sha256 }) => sha256), 100)) {
    const rows = query(`SELECT id, sha256 FROM photos WHERE sha256 IN (${hashes.map(sqlString).join(",")})`);
    for (const row of rows) {
      const expected = manifest.photos.find((photo) => photo.sha256 === row.sha256);
      if (expected && row.id !== expected.id) throw new Error(`Image hash conflict for ${expected.id}: ${row.id}`);
    }
  }

  for (const photo of manifest.photos.filter(({ action }) => action === "reuse")) {
    const existing = query(`SELECT id FROM photos WHERE id = ${sqlString(photo.id)}`)[0];
    if (!existing) throw new Error(`Reuse target is missing: ${photo.id}`);
  }
}

export async function applyManifest(manifest: ImportManifest, options: CliOptions): Promise<void> {
  if (!options.accountId || !options.databaseId || !options.approve) {
    throw new Error("Apply requires --account-id, --database-id, and --approve=<manifest-sha256>");
  }
  cloudflareTarget = { accountId: options.accountId, databaseId: options.databaseId };
  const manifestBytes = await readFile(options.manifest);
  if (sha256(manifestBytes) !== options.approve) throw new Error("Manifest approval digest does not match");
  const migrations = query("SELECT name FROM d1_migrations WHERE name = '0004_add_photo_sha256.sql'");
  if (migrations.length !== 1) throw new Error("Production migration 0004_add_photo_sha256.sql is not applied");
  preflightManifest(manifest);

  for (const [index, photo] of manifest.photos.entries()) {
    console.log(`[${index + 1}/${manifest.photos.length}] ${photo.action} ${photo.id}`);
    if (photo.action === "create") {
      const buffer = await sourceBuffer(photo, options);
      const inspected = await inspectImage(buffer);
      if (JSON.stringify(inspected) !== JSON.stringify({
        sha256: photo.sha256,
        width: photo.width,
        height: photo.height,
        format: photo.format,
        sizeBytes: photo.sizeBytes,
      })) throw new Error(`Source changed for ${photo.id}`);
      await uploadAndVerify(photo, buffer);
    }
    await commitPhoto(photo);
  }
}

async function main(): Promise<void> {
  const options = parseArgs();
  if (options.apply) {
    const manifest = JSON.parse(await readFile(options.manifest, "utf8")) as ImportManifest;
    await applyManifest(manifest, options);
    return;
  }

  const manifest = await buildManifest(options);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await mkdir(dirname(options.manifest), { recursive: true });
  await writeFile(options.manifest, serialized);
  console.log(JSON.stringify(manifest.summary, null, 2));
  console.log(`Duplicate groups: ${manifest.duplicates.length}`);
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
