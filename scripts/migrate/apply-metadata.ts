#!/usr/bin/env npx tsx
/**
 * Apply a reviewed manifest of photo metadata changes (title, caption, date, location).
 *
 * The manifest lists, per photo, the values it expects now (`from`) and the values to write
 * (`to`), for the changed fields only. Each photo is one compare-and-set UPDATE on exactly those
 * fields, so a photo edited in admin after the manifest was made is skipped, never overwritten.
 *
 * Check (default): validates the manifest and prints a summary and its approval digest.
 * Apply: requires --apply and --approve=<manifest-sha256>.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const METADATA_FIELDS = ["title", "caption", "date", "location"] as const;
export type MetadataField = (typeof METADATA_FIELDS)[number];
type Values = Partial<Record<MetadataField, string | null>>;

export interface MetadataEntry {
  id: string;
  from: Values;
  to: Values;
  why?: Partial<Record<MetadataField, string>>;
}

export interface MetadataManifest {
  version: 1;
  entries: MetadataEntry[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reject anything other than a plain change to known fields with matching from/to keys. */
export function validateManifest(manifest: MetadataManifest): string[] {
  const errors: string[] = [];
  if (manifest.version !== 1) errors.push("unknown manifest version");
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    if (seen.has(entry.id)) errors.push(`${entry.id}: listed twice`);
    seen.add(entry.id);
    const fields = Object.keys(entry.to);
    if (fields.length === 0) errors.push(`${entry.id}: no changes`);
    for (const field of fields) {
      if (!METADATA_FIELDS.includes(field as MetadataField)) errors.push(`${entry.id}: unknown field ${field}`);
      if (!(field in entry.from)) errors.push(`${entry.id}: ${field} has no expected current value`);
      const value = entry.to[field as MetadataField];
      if (field === "date" && value !== null && !DATE.test(String(value))) errors.push(`${entry.id}: date ${value} is not YYYY-MM-DD`);
      if (typeof value === "string" && value.length > 2000) errors.push(`${entry.id}: ${field} is too long`);
    }
  }
  return errors;
}

function sqlValue(value: string | null | undefined): string {
  return value === null || value === undefined ? "NULL" : `'${value.replace(/'/g, "''")}'`;
}

export function metadataSql(entry: MetadataEntry): string {
  const fields = Object.keys(entry.to) as MetadataField[];
  const set = fields.map((field) => `${field} = ${sqlValue(entry.to[field])}`).join(", ");
  const guard = fields.map((field) => `${field} IS ${sqlValue(entry.from[field])}`).join(" AND ");
  return `UPDATE photos SET ${set}, updated_at = datetime('now') WHERE id = ${sqlValue(entry.id)} AND ${guard} RETURNING id`;
}

export function summarize(manifest: MetadataManifest): Record<string, number> {
  const summary: Record<string, number> = { photos: manifest.entries.length };
  for (const entry of manifest.entries) for (const field of Object.keys(entry.to)) summary[field] = (summary[field] ?? 0) + 1;
  return summary;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const manifestPath = argument("manifest");
  const databaseId = argument("database-id") || process.env.PHOTOS_DATABASE_ID;
  if (!manifestPath) throw new Error("Requires --manifest=<path>");
  const bytes = await readFile(resolve(manifestPath));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const manifest = JSON.parse(bytes.toString("utf8")) as MetadataManifest;
  const errors = validateManifest(manifest);
  if (errors.length > 0) throw new Error(`Invalid manifest:\n${errors.join("\n")}`);

  if (!process.argv.includes("--apply")) {
    console.log(JSON.stringify(summarize(manifest), null, 2));
    console.log(`Approval digest: ${digest}`);
    console.log("Check only. Review the manifest before applying.");
    return;
  }
  if (!databaseId) throw new Error("Apply requires --database-id");
  if (argument("approve") !== digest) throw new Error("Apply requires --approve=<manifest-sha256> matching this manifest");

  const outcome = { applied: 0, skippedBecauseEditedSince: [] as string[], failed: [] as { id: string; error: string }[] };
  for (const entry of manifest.entries) {
    try {
      const output = execFileSync("cf", ["d1", "query", databaseId, "--sql", metadataSql(entry)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if ((JSON.parse(output)[0]?.results ?? []).length === 1) outcome.applied++;
      else outcome.skippedBecauseEditedSince.push(entry.id);
    } catch (error) {
      outcome.failed.push({ id: entry.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
