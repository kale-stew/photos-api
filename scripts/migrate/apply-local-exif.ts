#!/usr/bin/env npx tsx
/**
 * Apply a local EXIF manifest from plan-local-exif.ts.
 *
 * photo_exif is derived from the original file, so each row is replaced. The
 * photos title, caption, location, and date are only filled where they are
 * empty, so edits made after the import manifest are never overwritten.
 * Rerunning the same manifest is a no-op for photos.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PROFILE_VERSION, type PhotoProfile } from "../../src/photo-metadata.js";

export interface ExifUpdate {
  id: string;
  profile: PhotoProfile;
  updates: {
    title: string | null;
    caption: string | null;
    location: string | null;
    date: string | null;
  };
}

interface ExifManifest {
  profileVersion?: number;
  summary: Record<string, number>;
  updates: ExifUpdate[];
}

/** A manifest profiled by older code would overwrite photo_exif with stale values. */
export function staleManifestError(manifest: { profileVersion?: number }): string | null {
  if (manifest.profileVersion === PROFILE_VERSION) return null;
  return `Manifest profile version ${manifest.profileVersion ?? "missing"} does not match ${PROFILE_VERSION}; rerun npm run exif:local:plan`;
}

const sqlString = (value: string | null): string => value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`;
const sqlNumber = (value: number | null): string => value === null ? "NULL" : String(value);

export function exifSql({ id, profile }: ExifUpdate): string {
  return `
    INSERT INTO photo_exif (
      photo_id, make, model, lens_model, focal_length, aperture, exposure_time,
      iso, exposure_compensation, date_taken, gps_latitude, gps_longitude,
      gps_altitude, software, orientation, color_space, image_description,
      artist, copyright, extracted_at
    ) VALUES (
      ${sqlString(id)}, ${sqlString(profile.make)}, ${sqlString(profile.model)},
      ${sqlString(profile.lensModel)}, ${sqlNumber(profile.focalLength)}, ${sqlNumber(profile.aperture)},
      ${sqlNumber(profile.exposureTime)}, ${sqlNumber(profile.iso)}, ${sqlNumber(profile.exposureCompensation)},
      ${sqlString(profile.dateTaken)}, ${sqlNumber(profile.latitude)}, ${sqlNumber(profile.longitude)},
      ${sqlNumber(profile.altitude)}, ${sqlString(profile.software)}, ${sqlNumber(profile.orientation)},
      ${sqlString(profile.colorSpace)}, ${sqlString(profile.imageDescription)}, ${sqlString(profile.artist)},
      ${sqlString(profile.copyright)}, datetime('now')
    ) ON CONFLICT(photo_id) DO UPDATE SET
      make=excluded.make, model=excluded.model, lens_model=excluded.lens_model,
      focal_length=excluded.focal_length, aperture=excluded.aperture,
      exposure_time=excluded.exposure_time, iso=excluded.iso,
      exposure_compensation=excluded.exposure_compensation,
      date_taken=excluded.date_taken, gps_latitude=excluded.gps_latitude,
      gps_longitude=excluded.gps_longitude, gps_altitude=excluded.gps_altitude,
      software=excluded.software, orientation=excluded.orientation,
      color_space=excluded.color_space, image_description=excluded.image_description,
      artist=excluded.artist, copyright=excluded.copyright,
      extracted_at=datetime('now');`;
}

/** Fills only empty photo fields; returns "" when the manifest has nothing to fill. */
export function photoFillSql({ id, updates }: ExifUpdate): string {
  const fields = (["title", "caption", "location", "date"] as const)
    .filter((field) => updates[field]?.trim())
    .map((field) => ({ column: field, value: sqlString(updates[field]) }));
  if (fields.length === 0) return "";
  const empty = (column: string) => `NULLIF(TRIM(${column}), '') IS NULL`;
  return `
    UPDATE photos SET
      ${fields.map(({ column, value }) => `${column}=CASE WHEN ${empty(column)} THEN ${value} ELSE ${column} END`).join(",\n      ")},
      updated_at=datetime('now')
    WHERE id=${sqlString(id)} AND (${fields.map(({ column }) => empty(column)).join(" OR ")});`;
}

export function applySql(update: ExifUpdate): string {
  return `${exifSql(update)}\n${photoFillSql(update)}`;
}

const chunks = <T>(values: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
};

async function main() {
  const getArgument = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  };

  const manifestPath = resolve(getArgument("manifest") || "data/imports/local-exif.manifest.json");
  const apply = process.argv.includes("--apply");
  const accountId = getArgument("account-id") || process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = getArgument("database-id") || process.env.PHOTOS_DATABASE_ID;
  const approval = getArgument("approve");
  const bytes = await readFile(manifestPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const manifest = JSON.parse(bytes.toString("utf8")) as ExifManifest;

  console.log(JSON.stringify(manifest.summary, null, 2));
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Approval digest: ${digest}`);

  const stale = staleManifestError(manifest);
  if (stale) throw new Error(stale);
  if (!apply) {
    console.log("Dry run only. Review the manifest before applying.");
    return;
  }
  if (!accountId || !databaseId || approval !== digest) {
    throw new Error("Apply requires --account-id, --database-id, and the exact --approve digest");
  }

  const query = (sql: string): Record<string, unknown>[] => {
    const output = execFileSync("cf", ["d1", "query", databaseId, "--sql", sql], {
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(output)[0]?.results || [];
  };

  const migration = query("SELECT name FROM d1_migrations WHERE name = '0005_photo_exif.sql'");
  if (migration.length !== 1) throw new Error("Migration 0005_photo_exif.sql is not applied");

  for (const [chunkIndex, group] of chunks(manifest.updates, 25).entries()) {
    query(group.map(applySql).join("\n"));
    console.log(`Applied ${Math.min((chunkIndex + 1) * 25, manifest.updates.length)}/${manifest.updates.length}`);
  }

  const ids = manifest.updates.map(({ id }) => sqlString(id));
  let verified = 0;
  for (const group of chunks(ids, 100)) {
    const rows = query(`SELECT COUNT(*) AS count FROM photo_exif WHERE photo_id IN (${group.join(",")})`);
    verified += Number(rows[0]?.count || 0);
  }
  if (verified !== manifest.updates.length) throw new Error(`EXIF verification failed: ${verified}/${manifest.updates.length}`);
  console.log(`Verified ${verified} EXIF profiles.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
