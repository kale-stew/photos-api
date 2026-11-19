#!/usr/bin/env npx tsx
/**
 * Give blog photos real captions and drop leftover `{WxH}` size hints.
 *
 * Blog imports stored the post's caption sentence as the photo title. For an active blog photo
 * with no caption, the title is copied into the caption (the title is kept, so nothing is lost;
 * shorten it in admin). Size hints are stripped from titles and captions on every photo.
 * A caption that already exists is never replaced.
 *
 * Dry run (default): writes a manifest and prints its approval digest.
 * Apply: requires --apply and --approve=<manifest-sha256>. Every write is a compare-and-set on
 * the planned title and caption, so a photo edited in admin since the plan is skipped.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MANIFEST = join(tmpdir(), "photos-api", "normalize-captions.manifest.json");
const SIZE_HINT = /\s*\{\d+x\d+\}\s*$/;

export interface CaptionRow {
  id: string;
  source: string | null;
  title: string | null;
  caption: string | null;
}

export interface CaptionEntry {
  id: string;
  from: { title: string | null; caption: string | null };
  to: { title: string | null; caption: string | null };
  reasons: string[];
}

export interface CaptionManifest {
  version: 1;
  entries: CaptionEntry[];
  summary: Record<string, number>;
}

export function stripSizeHint(value: string | null): string | null {
  if (value === null) return null;
  const stripped = value.replace(SIZE_HINT, "").trim();
  return stripped || null;
}

export function planCaptions(rows: CaptionRow[]): CaptionManifest {
  const entries: CaptionEntry[] = [];
  for (const row of rows) {
    const reasons: string[] = [];
    const title = stripSizeHint(row.title);
    let caption = stripSizeHint(row.caption?.trim() ? row.caption : null);
    if (title !== row.title) reasons.push("size hint removed from title");
    if (caption !== (row.caption?.trim() ? row.caption : null)) reasons.push("size hint removed from caption");
    if (row.source === "blog" && !caption && title) {
      caption = title;
      reasons.push("blog caption copied from title");
    }
    if (reasons.length === 0) continue;
    entries.push({ id: row.id, from: { title: row.title, caption: row.caption }, to: { title, caption }, reasons });
  }
  const summary: Record<string, number> = {};
  for (const entry of entries) for (const reason of entry.reasons) summary[reason] = (summary[reason] ?? 0) + 1;
  return { version: 1, entries, summary };
}

function sqlValue(value: string | null): string {
  return value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`;
}

/** One compare-and-set update: it changes nothing if the title or caption moved since the plan. */
export function captionSql(entry: CaptionEntry): string {
  return `UPDATE photos SET title = ${sqlValue(entry.to.title)}, caption = ${sqlValue(entry.to.caption)}, updated_at = datetime('now')
    WHERE id = ${sqlValue(entry.id)} AND title IS ${sqlValue(entry.from.title)} AND caption IS ${sqlValue(entry.from.caption)}
    RETURNING id`;
}

const ROWS_SQL = "SELECT id, source, title, caption FROM photos WHERE status = 'active' ORDER BY id";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function query<T>(databaseId: string, sql: string): T[] {
  const output = execFileSync("cf", ["d1", "query", databaseId, "--sql", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return (JSON.parse(output)[0]?.results || []) as T[];
}

async function main(): Promise<void> {
  const manifestPath = resolve(argument("manifest") || DEFAULT_MANIFEST);
  const databaseId = argument("database-id") || process.env.PHOTOS_DATABASE_ID;
  if (!databaseId) throw new Error("Requires --database-id (read-only for the dry run)");

  if (process.argv.includes("--apply")) {
    const approve = argument("approve");
    if (!approve) throw new Error("Apply requires --approve=<manifest-sha256>");
    const bytes = await readFile(manifestPath);
    if (sha256(bytes) !== approve) throw new Error("Manifest approval digest does not match");
    const manifest = JSON.parse(bytes.toString("utf8")) as CaptionManifest;
    if (manifest.version !== 1) throw new Error("Unknown manifest version; plan again");
    const skipped: string[] = [];
    let applied = 0;
    for (const entry of manifest.entries) {
      if (query(databaseId, captionSql(entry)).length === 1) applied++;
      else skipped.push(entry.id);
    }
    console.log(JSON.stringify({ applied, skippedBecauseEditedSincePlan: skipped }, null, 2));
    return;
  }

  const manifest = planCaptions(query<CaptionRow>(databaseId, ROWS_SQL));
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, serialized);
  console.log(JSON.stringify({ photos: manifest.entries.length, ...manifest.summary }, null, 2));
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Approval digest: ${sha256(serialized)}`);
  console.log("Dry run only. Review the manifest before applying.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
