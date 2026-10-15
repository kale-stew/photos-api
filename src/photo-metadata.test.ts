import assert from "node:assert/strict";
import test from "node:test";
import { dateInputValue, profilePhoto, UPLOAD_TYPES } from "./photo-metadata.js";

test("accepts HEIC and HEIF uploads as canonical HEIC originals", () => {
  assert.equal(UPLOAD_TYPES["image/heic"], "heic");
  assert.equal(UPLOAD_TYPES["image/heif"], "heic");
});

test("returns null for invalid image metadata without blocking upload", async () => {
  assert.equal(await profilePhoto(new TextEncoder().encode("not an image").buffer as ArrayBuffer), null);
});

test("formats an EXIF capture timestamp for a date input", () => {
  assert.equal(dateInputValue("2026-10-14T17:30:00.000Z"), "2026-10-14");
  assert.equal(dateInputValue(null), null);
});
