import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PROFILE_VERSION, type PhotoProfile } from "../../src/photo-metadata.js";
import { applySql, type ExifUpdate, photoFillSql, staleManifestError } from "./apply-local-exif.js";

const migrations = new URL("../../migrations/", import.meta.url);

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  return db;
}

const profile: PhotoProfile = {
  make: "Canon", model: "EOS R6", lensModel: null, focalLength: 50, aperture: 2.8, exposureTime: 0.004,
  iso: 400, exposureCompensation: null, dateTaken: "2025-12-24T18:03:25-10:00", latitude: 39.64,
  longitude: -105.82, altitude: 4000, software: null, orientation: 6, colorSpace: "sRGB",
  imageDescription: null, userComment: null, artist: null, copyright: null,
};

function update(id: string, updates: Partial<ExifUpdate["updates"]> = {}): ExifUpdate {
  return { id, profile, updates: { title: null, caption: null, location: null, date: null, ...updates } };
}

function insertPhoto(db: DatabaseSync, id: string, fields: Record<string, string | null>) {
  db.prepare(`INSERT INTO photos (id, r2_key, title, caption, location, date, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '2026-01-01 00:00:00')`)
    .run(id, `photos/${id}`, fields.title ?? null, fields.caption ?? null, fields.location ?? null, fields.date ?? null);
}

const photo = (db: DatabaseSync, id: string) =>
  ({ ...db.prepare("SELECT title, caption, location, date, updated_at FROM photos WHERE id = ?").get(id) }) as Record<string, string | null>;

test("keeps photo fields edited after the manifest", () => {
  const db = database();
  insertPhoto(db, "edited", { title: "Edited title", caption: "Edited caption", location: "Longs Peak", date: "2025-12-24" });
  db.exec(applySql(update("edited", { title: "Old title", caption: "Old caption", location: "Old place", date: "2025-12-25" })));

  assert.deepEqual(photo(db, "edited"), {
    title: "Edited title", caption: "Edited caption", location: "Longs Peak", date: "2025-12-24",
    updated_at: "2026-01-01 00:00:00",
  });
});

test("fills only empty or blank photo fields", () => {
  const db = database();
  insertPhoto(db, "partial", { title: "Kept", caption: "  ", location: null, date: null });
  db.exec(applySql(update("partial", { title: "Old title", caption: "From EXIF", location: null, date: "2025-12-24" })));

  const row = photo(db, "partial");
  assert.deepEqual([row.title, row.caption, row.location, row.date], ["Kept", "From EXIF", null, "2025-12-24"]);
  assert.notEqual(row.updated_at, "2026-01-01 00:00:00");
});

test("replaces the EXIF profile and is safe to rerun", () => {
  const db = database();
  insertPhoto(db, "rerun", { title: null });
  db.exec(`INSERT INTO photo_exif (photo_id, date_taken, orientation, extracted_at)
    VALUES ('rerun', '2025-12-25T04:03:25.000Z', NULL, '2026-01-01 00:00:00')`);
  const sql = applySql(update("rerun", { title: "It's a title" }));
  db.exec(sql);
  const first = photo(db, "rerun");
  db.exec(`UPDATE photos SET updated_at = '2026-01-02 00:00:00' WHERE id = 'rerun'`);
  db.exec(sql);

  const exif = db.prepare("SELECT date_taken, orientation, make FROM photo_exif WHERE photo_id = 'rerun'").get();
  assert.deepEqual({ ...exif }, { date_taken: "2025-12-24T18:03:25-10:00", orientation: 6, make: "Canon" });
  assert.equal(first.title, "It's a title");
  assert.equal(photo(db, "rerun").updated_at, "2026-01-02 00:00:00");
});

test("skips the photos update when the manifest has nothing to fill", () => {
  assert.equal(photoFillSql(update("none", { title: "   " })), "");
});

test("refuses manifests profiled by older EXIF code", () => {
  assert.match(staleManifestError({}) ?? "", /profile version missing/);
  assert.match(staleManifestError({ profileVersion: PROFILE_VERSION - 1 }) ?? "", /rerun npm run exif:local:plan/);
  assert.equal(staleManifestError({ profileVersion: PROFILE_VERSION }), null);
});
