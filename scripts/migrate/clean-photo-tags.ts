#!/usr/bin/env npx tsx
/**
 * Plan a cleanup of `photos.tags`.
 *
 * The Flickr import split tags on spaces (`from-flickr.ts`), so phrases entered
 * with commas became separate words in order: "class 3" -> ["class", "3"]. A few
 * admin uploads stored raw comma text instead of a JSON array. This rejoins
 * known phrases, normalizes spelling and case, and removes a person's name tag
 * only when the name already appears in the photo's title.
 *
 * Usage: npx tsx scripts/migrate/clean-photo-tags.ts --snapshot <rows.json> --out <dir>
 *
 * The snapshot is a JSON array of { id, title, tags } read from production.
 * The plan writes manifest.json (with a sha256 over the changes), apply.sql, and
 * rollback.sql. Each UPDATE matches the snapshot's exact tags value, so a photo
 * edited after the snapshot is skipped rather than overwritten; rerunning the
 * same SQL is a no-op. *
 * Applied 2026-11-14 through the Cloudflare D1 API (138 rows, manifest
 * 6dfcbcb3...1e3d). The manifest and rollback SQL are in data/migrations/; the
 * D1 Time Travel bookmark taken just before the write was
 * 000014e6-00000000-00005123-20d0a2cae20f5c3db17e59234fde1180.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Adjacent words the space split separated, joined back in order. */
const PHRASES: ReadonlyArray<readonly string[]> = [
  ["angel's", "landing"],
  ["alpine", "lake"],
  ["black", "bear"],
  ["capitol", "reef"],
  ["front", "range"],
  ["lake", "como"],
  ["little", "bear"],
  ["mallory", "cave"],
  ["manitou", "springs"],
  ["maroon", "bells"],
  ["maroon", "peak"],
  ["mayflower", "gulch"],
  ["national", "park"],
  ["north", "maroon"],
  ["palm", "trees"],
  ["pillar", "point"],
  ["red", "rocks"],
  ["san", "francisco"],
  ["slot", "canyon"],
  ["tenmile", "range"],
  ["wildlife", "conservancy"],
];

/** Spelling, abbreviation, and plural variants mapped to one form. */
const RENAMES: Readonly<Record<string, string>> = {
  "13ers": "13er",
  "1434": "14er",
  "14ers": "14er",
  animals: "animal",
  bells: "maroon bells",
  centennials: "centennial",
  flower: "flowers",
  lakes: "lake",
  scamble: "scramble",
  wildflower: "wildflowers",
};

/** Adjacent words that collapse to one tag. */
const COLLAPSE: ReadonlyArray<{ parts: readonly string[]; tag: string }> = [
  { parts: ["fall", "colors"], tag: "fall" },
];

/** Tags with no clear meaning, removed. */
const REMOVE: ReadonlySet<string> = new Set(["np"]);

/** Tags that name a person. Kept unless the title already names them. */
export const PERSON_TAGS: ReadonlySet<string> = new Set([
  "ally", "connor", "daniel", "hannah", "holly", "kyle", "kylie", "laura",
  "leah", "luis", "nikki", "otis", "sara",
]);

export interface TagRow {
  id: string;
  title: string | null;
  tags: string | null;
}

export interface TagChange {
  id: string;
  title: string | null;
  before: string | null;
  after: string;
  notes: string[];
}

export function readTags(raw: string | null): { tags: string[]; wasJson: boolean } {
  if (raw === null || raw.trim() === "") return { tags: [], wasJson: true };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { tags: parsed.map(String), wasJson: true };
  } catch {
    // Raw comma-separated text from an older admin upload.
  }
  return { tags: raw.split(","), wasJson: false };
}

function normalize(tag: string): string {
  return tag.normalize("NFKC").replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

export function cleanTags(tags: string[], title: string | null): { tags: string[]; notes: string[] } {
  const notes: string[] = [];
  const words = tags.map(normalize).filter(Boolean);

  const joined: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const next = words[index + 1];
    if (words[index] === "class" && next && /^[1-5]$/.test(next)) {
      joined.push(`c${next}`);
      notes.push(`joined "class ${next}" as "c${next}"`);
      index++;
      continue;
    }
    const collapse = COLLAPSE.find(({ parts }) => parts.every((part, offset) => words[index + offset] === part));
    if (collapse) {
      joined.push(collapse.tag);
      notes.push(`collapsed "${collapse.parts.join(" ")}" to "${collapse.tag}"`);
      index += collapse.parts.length - 1;
      continue;
    }
    const phrase = PHRASES.find((parts) => parts.every((part, offset) => words[index + offset] === part));
    if (phrase) {
      joined.push(phrase.join(" "));
      notes.push(`joined "${phrase.join(" ")}"`);
      index += phrase.length - 1;
      continue;
    }
    joined.push(words[index]);
  }

  const titleWords = new Set(normalize(title ?? "").split(/[^a-z0-9']+/).filter(Boolean));
  const result: string[] = [];
  for (const word of joined) {
    const tag = RENAMES[word] ?? word;
    if (tag !== word) notes.push(`renamed "${word}" -> "${tag}"`);
    if (REMOVE.has(tag)) {
      notes.push(`removed "${tag}"`);
      continue;
    }
    if (PERSON_TAGS.has(tag) && titleWords.has(tag)) {
      notes.push(`removed "${tag}" (in title)`);
      continue;
    }
    if (result.includes(tag)) {
      notes.push(`removed duplicate "${tag}"`);
      continue;
    }
    result.push(tag);
  }
  return { tags: result, notes };
}

export function planTagCleanup(rows: TagRow[]): TagChange[] {
  const changes: TagChange[] = [];
  for (const row of rows) {
    const { tags, wasJson } = readTags(row.tags);
    const cleaned = cleanTags(tags, row.title);
    const after = JSON.stringify(cleaned.tags);
    if (after === row.tags) continue;
    const notes = [...(wasJson ? [] : ["converted comma text to a JSON array"]), ...cleaned.notes];
    if (notes.length === 0 && tags.some((tag) => tag !== tag.toLowerCase())) notes.push("lowercased");
    if (notes.length === 0) notes.push("normalized whitespace or encoding");
    if (row.tags === null && cleaned.tags.length === 0) continue;
    changes.push({ id: row.id, title: row.title, before: row.tags, after, notes });
  }
  return changes;
}

const sqlString = (value: string | null) => (value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`);
const guard = (value: string | null) => (value === null ? "tags IS NULL" : `tags = ${sqlString(value)}`);

export function applySql(changes: TagChange[]): string {
  return changes
    .map((change) => `UPDATE photos SET tags = ${sqlString(change.after)}, updated_at = datetime('now') WHERE id = ${sqlString(change.id)} AND ${guard(change.before)};`)
    .join("\n");
}

export function rollbackSql(changes: TagChange[]): string {
  return changes
    .map((change) => `UPDATE photos SET tags = ${sqlString(change.before)}, updated_at = datetime('now') WHERE id = ${sqlString(change.id)} AND ${guard(change.after)};`)
    .join("\n");
}

export function manifestDigest(changes: TagChange[]): string {
  return createHash("sha256").update(JSON.stringify(changes.map(({ id, before, after }) => [id, before, after]))).digest("hex");
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const snapshotPath = arg("snapshot");
  const out = arg("out");
  if (!snapshotPath || !out) throw new Error("Usage: --snapshot <rows.json> --out <dir>");
  const rows = JSON.parse(await readFile(resolve(snapshotPath), "utf8")) as TagRow[];
  const changes = planTagCleanup(rows);
  const digest = manifestDigest(changes);

  const tally = new Map<string, number>();
  for (const change of changes) {
    for (const note of change.notes) tally.set(note, (tally.get(note) ?? 0) + 1);
  }
  const vocabulary = new Map<string, number>();
  for (const row of rows) {
    const after = changes.find((change) => change.id === row.id)?.after ?? row.tags;
    for (const tag of readTags(after).tags) vocabulary.set(tag, (vocabulary.get(tag) ?? 0) + 1);
  }
  const unreviewed = [...vocabulary].filter(([tag]) => /^\d+$/.test(tag) || tag.length <= 2).map(([tag]) => tag);

  await mkdir(resolve(out), { recursive: true });
  await writeFile(join(out, "manifest.json"), `${JSON.stringify({
    sha256: digest,
    rowsRead: rows.length,
    rowsChanged: changes.length,
    notes: Object.fromEntries([...tally].sort((a, b) => b[1] - a[1])),
    leftAsIs: unreviewed,
    changes,
  }, null, 2)}\n`);
  await writeFile(join(out, "apply.sql"), `${applySql(changes)}\n`);
  await writeFile(join(out, "rollback.sql"), `${rollbackSql(changes)}\n`);
  console.log(JSON.stringify({ sha256: digest, rowsRead: rows.length, rowsChanged: changes.length, leftAsIs: unreviewed }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
