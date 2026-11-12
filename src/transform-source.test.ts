import assert from "node:assert/strict";
import test from "node:test";
import {
  exceedsImagesInputLimit,
  IMAGES_INPUT_LIMIT_BYTES,
  transformInputs,
  transformSourceKey,
} from "./transform-source.js";

test("treats the Images input limit as inclusive", () => {
  assert.equal(exceedsImagesInputLimit(IMAGES_INPUT_LIMIT_BYTES), false);
  assert.equal(exceedsImagesInputLimit(IMAGES_INPUT_LIMIT_BYTES + 1), true);
});

test("uses a 20.2 MB original's transform source, not the original", () => {
  assert.deepEqual(
    transformInputs({ originalSize: 20_219_048, hasTransformSource: true, hasSourceUrl: false }),
    ["transform-source"],
  );
});

test("prefers a small original over other inputs", () => {
  assert.deepEqual(
    transformInputs({ originalSize: 3_253_484, hasTransformSource: true, hasSourceUrl: true }),
    ["original", "transform-source", "source-url"],
  );
});

test("falls back to the source URL for oversized migrated originals", () => {
  assert.deepEqual(
    transformInputs({ originalSize: 30_942_887, hasTransformSource: false, hasSourceUrl: true }),
    ["source-url"],
  );
});

test("reports no input for an oversized original without repair inputs", () => {
  assert.deepEqual(
    transformInputs({ originalSize: 28_395_532, hasTransformSource: false, hasSourceUrl: false }),
    ["none"],
  );
});

test("stores the transform source under the photo prefix", () => {
  assert.equal(transformSourceKey("photos/cc4957db86c2"), "photos/cc4957db86c2/transform-source.webp");
  assert.ok(transformSourceKey("photos/cc4957db86c2").startsWith("photos/cc4957db86c2/"));
});
