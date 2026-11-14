import assert from "node:assert/strict";
import test from "node:test";
import { imageVersion, staleObjectKeys, versionedImagePath } from "./replace-image.js";

test("versions an image by its content hash", () => {
  assert.equal(imageVersion({ sha256: "a1b2c3d4e5f6a7b8c9d0", updated_at: "2026-11-13 10:00:00" }), "a1b2c3d4e5f6");
});

test("falls back to the update time for photos without a hash", () => {
  assert.equal(imageVersion({ sha256: null, updated_at: "2026-11-13 10:00:00" }), "20261113100000");
});

test("builds versioned image paths with and without a width", () => {
  assert.equal(versionedImagePath("abc", "v1"), "/img/abc?v=v1");
  assert.equal(versionedImagePath("abc", "v1", 800), "/img/abc?w=800&v=v1");
});

test("treats every object but the new original as stale", () => {
  const keys = [
    "photos/abc/original.jpeg",
    "photos/abc/original.heic",
    "photos/abc/w800.webp",
    "photos/abc/w200.jpg",
    "photos/abc/transform-source.webp",
  ];
  assert.deepEqual(staleObjectKeys(keys, "photos/abc", "photos/abc/original.heic"), [
    "photos/abc/original.jpeg",
    "photos/abc/w800.webp",
    "photos/abc/w200.jpg",
    "photos/abc/transform-source.webp",
  ]);
});

test("never touches another photo's objects", () => {
  assert.deepEqual(staleObjectKeys(["photos/abcd/w800.webp"], "photos/abc", "photos/abc/original.jpeg"), []);
});
