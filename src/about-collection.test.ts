import assert from "node:assert/strict";
import test from "node:test";
import { isAboutPhoto, missingAboutPhotos } from "./about-collection.js";

test("matches the kylie tag exactly, in any case", () => {
  assert.equal(isAboutPhoto('["summit","Kylie"]'), true);
  assert.equal(isAboutPhoto('["kylies-photos"]'), false);
  assert.equal(isAboutPhoto("kylie, summit"), true);
  assert.equal(isAboutPhoto(null), false);
});

test("returns only tagged photos that are not members yet, in order", () => {
  const candidates = [
    { id: "a", tags: '["kylie"]' },
    { id: "b", tags: '["kylie"]' },
    { id: "c", tags: '["ridge"]' },
    { id: "d", tags: '["kylie","ridge"]' },
  ];
  assert.deepEqual(missingAboutPhotos(candidates, new Set(["b"])), ["a", "d"]);
});
