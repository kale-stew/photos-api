#!/usr/bin/env npx tsx
/**
 * Bring every active photo in line with the Listed / Link-only / Private model.
 *
 * Visibility decides `exclude` and the managed collection (portfolio or editorial). The one
 * judgment call: a public photo with `exclude = 1` was hidden on purpose, so it becomes
 * Link-only rather than Listed. Feature collections such as `about` are never touched.
 *
 * Inactive photos only get the visibility and exclude fix; they cannot join collections.
 *
 * Dry run (default): writes a manifest of changes and prints its approval digest.
 * Apply: requires --apply and --approve=<manifest-sha256>. Every write is a compare-and-set on
 * the planned state (visibility, exclude, site, status), and collection changes run only when
 * the photo is in the target state, so an admin edit made during the run always wins.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { publicationFor, type Visibility } from "../../src/publication.js";

const DEFAULT_MANIFEST = join(tmpdir(), "photos-api", "normalize-publication.manifest.json");

export interface PublicationRow {
  id: string;
  title: string | null;
  visibility: Visibility;
  exclude: number;
  site: string | null;
  status: string;
  in_portfolio: number;
  in_editorial: number;
}

export interface PublicationSnapshot {
  visibility: Visibility;
  exclude: number;
  site: string | null;
  status: string;
  portfolio: boolean;
  editorial: boolean;
}

export interface NormalizationEntry {
  id: string;
  title: string | null;
  site: string | null;
  from: PublicationSnapshot;
  to: PublicationSnapshot;
  reason: string;
}

export interface NormalizationManifest {
  version: 1;
  entries: NormalizationEntry[];
  summary: Record<string, number>;
}

function snapshot(row: PublicationRow): PublicationSnapshot {
  return {
    visibility: row.visibility,
    exclude: row.exclude,
    site: row.site,
    status: row.status,
    portfolio: row.in_portfolio === 1,
    editorial: row.in_editorial === 1,
  };
}

/** Active photos whose stored state differs from what their visibility implies. */
export function planNormalization(rows: PublicationRow[]): NormalizationManifest {
  const entries: NormalizationEntry[] = [];
  for (const row of rows) {
    const from = snapshot(row);
    const hidden = row.visibility === "public" && row.exclude === 1;
    const visibility: Visibility = hidden ? "unlisted" : row.visibility;
    const publication = publicationFor(visibility, row.site, row.status);
    const active = row.status === "active";
    const to: PublicationSnapshot = {
      visibility,
      exclude: publication.exclude,
      site: row.site,
      status: row.status,
      // Inactive photos keep their memberships; reactivation recomputes them.
      portfolio: active ? publication.collection === "portfolio" : from.portfolio,
      editorial: active ? publication.collection === "kylies-photos-content" : from.editorial,
    };
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    const reason = hidden
      ? "public but hidden → Link-only"
      : from.visibility === "public" && !from.portfolio && to.portfolio
        ? "Listed but missing from the portfolio → join it"
        : from.portfolio && !to.portfolio
          ? `${from.visibility} in the portfolio → leave it`
          : "collections or exclude out of step with visibility";
    entries.push({ id: row.id, title: row.title, site: row.site, from, to, reason });
  }
  const summary: Record<string, number> = {};
  for (const entry of entries) summary[entry.reason] = (summary[entry.reason] ?? 0) + 1;
  return { version: 1, entries, summary };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlValue(value: string | number | null): string {
  if (value === null) return "NULL";
  return typeof value === "number" ? String(value) : sqlString(value);
}

/**
 * Statements for one photo, sent as one D1 batch. The UPDATE only matches the planned starting
 * state; collection changes only run once the photo is in the target state.
 */
export function normalizationSql(entry: NormalizationEntry): string {
  const id = sqlString(entry.id);
  const { from, to } = entry;
  const target = `EXISTS (SELECT 1 FROM photos WHERE id = ${id} AND visibility = ${sqlValue(to.visibility)} AND exclude = ${to.exclude} AND site IS ${sqlValue(to.site)} AND status = 'active')`;
  const statements = [
    `UPDATE photos SET visibility = ${sqlValue(to.visibility)}, exclude = ${to.exclude}, updated_at = datetime('now')
      WHERE id = ${id} AND visibility = ${sqlValue(from.visibility)} AND exclude = ${from.exclude} AND site IS ${sqlValue(from.site)} AND status = ${sqlValue(from.status)}
      RETURNING id`,
  ];
  if (to.status === "active") {
    statements.push(
      `DELETE FROM photo_collections WHERE photo_id = ${id} AND collection_slug IN ('portfolio', 'kylies-photos-content') AND ${target}`,
    );
    if (to.portfolio) statements.push(`INSERT OR IGNORE INTO photo_collections (photo_id, collection_slug) SELECT ${id}, 'portfolio' WHERE ${target}`);
    if (to.editorial) statements.push(`INSERT OR IGNORE INTO photo_collections (photo_id, collection_slug) SELECT ${id}, 'kylies-photos-content' WHERE ${target}`);
  }
  return statements.join(";\n");
}

const ROWS_SQL = `
  SELECT p.id, p.title, p.visibility, p.exclude, p.site,
    EXISTS(SELECT 1 FROM photo_collections pc WHERE pc.photo_id = p.id AND pc.collection_slug = 'portfolio') AS in_portfolio,
    EXISTS(SELECT 1 FROM photo_collections pc WHERE pc.photo_id = p.id AND pc.collection_slug = 'kylies-photos-content') AS in_editorial,
    p.status
  FROM photos p ORDER BY p.id`;

interface Options {
  manifest: string;
  apply: boolean;
  databaseId?: string;
  approve?: string;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Results of every statement in one D1 request. */
function queryAll(databaseId: string, sql: string): unknown[][] {
  const output = execFileSync("cf", ["d1", "query", databaseId, "--sql", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return (JSON.parse(output) as Array<{ results?: unknown[] }>).map((result) => result.results ?? []);
}

function query<T>(databaseId: string, sql: string): T[] {
  return (queryAll(databaseId, sql)[0] ?? []) as T[];
}

async function apply(options: Options, databaseId: string): Promise<void> {
  if (!options.approve) throw new Error("Apply requires --approve=<manifest-sha256>");
  const bytes = await readFile(options.manifest);
  if (sha256(bytes) !== options.approve) throw new Error("Manifest approval digest does not match");
  const manifest = JSON.parse(bytes.toString("utf8")) as NormalizationManifest;
  if (manifest.version !== 1) throw new Error("Unknown manifest version; plan again");

  const outcome = { applied: 0, skippedBecauseChanged: [] as string[], failed: [] as { id: string; error: string }[] };
  for (const entry of manifest.entries) {
    try {
      const [update] = queryAll(databaseId, normalizationSql(entry));
      if (update?.length === 1) outcome.applied++;
      else outcome.skippedBecauseChanged.push(entry.id);
    } catch (error) {
      outcome.failed.push({ id: entry.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const after = planNormalization(query<PublicationRow>(databaseId, ROWS_SQL));
  console.log(JSON.stringify({ ...outcome, remaining: after.entries.length }, null, 2));
  if (outcome.failed.length > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const options: Options = {
    manifest: resolve(argument("manifest") || DEFAULT_MANIFEST),
    apply: process.argv.includes("--apply"),
    databaseId: argument("database-id") || process.env.PHOTOS_DATABASE_ID,
    approve: argument("approve"),
  };
  if (!options.databaseId) throw new Error("Requires --database-id (read-only for the dry run)");
  if (options.apply) return apply(options, options.databaseId);

  const manifest = planNormalization(query<PublicationRow>(options.databaseId, ROWS_SQL));
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
