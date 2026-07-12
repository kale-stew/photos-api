#!/usr/bin/env npx tsx

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const TARGET = process.argv.includes("--local") ? "--local" : "--remote";
const persistArgument = process.argv.find((argument) => argument.startsWith("--persist-to="));
const manifestArgument = process.argv.find((argument) => argument.startsWith("--manifest="));
const manifestPath = manifestArgument?.slice("--manifest=".length);

interface PhotoIdentity {
  id: string;
  notion_id: string | null;
  status: string;
}

interface ExistingAlias {
  alias: string;
  photo_id: string;
}

interface AliasCandidate extends ExistingAlias {
  kind: "canonical-short-id" | "legacy-short-id";
}

function query<T>(sql: string): T[] {
  const args = ["wrangler", "d1", "execute", "photos-db", TARGET];
  if (persistArgument) args.push(persistArgument);
  args.push(`--command=${sql}`, "--json");
  const output = execFileSync(
    "npx",
    args,
    { encoding: "utf8" }
  );
  const jsonStart = output.indexOf("[");
  if (jsonStart === -1) throw new Error(`Wrangler returned no JSON: ${output}`);
  return JSON.parse(output.slice(jsonStart))[0]?.results || [];
}

function shortId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const photos = query<PhotoIdentity>("SELECT id, notion_id, status FROM photos ORDER BY id");
const existingAliases = query<ExistingAlias>(
  "SELECT alias, photo_id FROM photo_aliases ORDER BY alias"
);
const aliases = new Map(existingAliases.map((row) => [row.alias, row.photo_id]));
const canonicalIds = new Set(photos.map((photo) => photo.id));
const candidates = new Map<string, AliasCandidate>();

function addCandidate(candidate: AliasCandidate): void {
  if (canonicalIds.has(candidate.alias) && candidate.alias !== candidate.photo_id) {
    throw new Error(
      `Alias ${candidate.alias} for ${candidate.photo_id} conflicts with a canonical photo ID`
    );
  }
  const existingPhotoId = aliases.get(candidate.alias) || candidates.get(candidate.alias)?.photo_id;
  if (existingPhotoId && existingPhotoId !== candidate.photo_id) {
    throw new Error(
      `Alias collision for ${candidate.alias}: ${existingPhotoId} and ${candidate.photo_id}`
    );
  }
  candidates.set(candidate.alias, candidate);
}

for (const photo of photos) {
  if (photo.status !== "active") continue;

  addCandidate({
    alias: shortId(photo.id),
    photo_id: photo.id,
    kind: "canonical-short-id",
  });

  if (photo.notion_id) {
    addCandidate({
      alias: shortId(photo.notion_id),
      photo_id: photo.id,
      kind: "legacy-short-id",
    });
  }
}

console.log(`Photos inspected: ${photos.length}`);
console.log(`Inactive photos skipped: ${photos.filter((photo) => photo.status !== "active").length}`);
console.log(`Existing aliases: ${existingAliases.length}`);
console.log(`Desired short aliases: ${candidates.size}`);

const rowsToInsert = Array.from(candidates.values()).filter((row) => !aliases.has(row.alias));
console.log(`Aliases to add: ${rowsToInsert.length}`);

const manifest = JSON.stringify(Array.from(candidates.values()), null, 2) + "\n";

if (!APPLY) {
  if (manifestPath) {
    writeFileSync(manifestPath, manifest);
    console.log(`Manifest written to ${manifestPath}`);
  } else {
    console.log("Pass --manifest=<path> to write the reviewable alias manifest.");
  }
  console.log("Dry run complete. Re-run with --apply and the reviewed manifest.");
  process.exit(0);
}

if (!manifestPath) {
  throw new Error("--apply requires --manifest=<path> from a prior dry run");
}
if (readFileSync(manifestPath, "utf8") !== manifest) {
  throw new Error("Alias candidates no longer match the reviewed manifest; run a new dry run");
}

const rows = rowsToInsert;
for (let index = 0; index < rows.length; index += 100) {
  const statements = rows.slice(index, index + 100).map((row) => `
    INSERT INTO photo_aliases (alias, photo_id, kind)
    VALUES (${sqlString(row.alias)}, ${sqlString(row.photo_id)}, ${sqlString(row.kind)});`
  );
  query(statements.join("\n"));
}

console.log(`Inserted ${rows.length} aliases.`);
