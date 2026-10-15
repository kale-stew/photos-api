#!/usr/bin/env npx tsx

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PhotoProfile } from "../../src/photo-metadata.js";

interface ExifUpdate {
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
  summary: Record<string, number>;
  updates: ExifUpdate[];
}

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

if (!apply) {
  console.log("Dry run only. Review the manifest before applying.");
  process.exit(0);
}
if (!accountId || !databaseId || approval !== digest) {
  throw new Error("Apply requires --account-id, --database-id, and the exact --approve digest");
}

const sqlString = (value: string | null): string => value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`;
const sqlNumber = (value: number | null): string => value === null ? "NULL" : String(value);

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

const chunks = <T>(values: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
};

for (const [chunkIndex, group] of chunks(manifest.updates, 25).entries()) {
  const statements = group.map(({ id, profile, updates }) => `
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
      extracted_at=datetime('now');
    UPDATE photos SET
      title=${sqlString(updates.title)}, caption=${sqlString(updates.caption)},
      location=${sqlString(updates.location)}, date=${sqlString(updates.date)},
      updated_at=datetime('now')
    WHERE id=${sqlString(id)};
  `).join("\n");
  query(statements);
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
