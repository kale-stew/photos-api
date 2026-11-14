import assert from "node:assert/strict";
import test from "node:test";
import { applySql, cleanTags, planTagCleanup, readTags, rollbackSql } from "./clean-photo-tags.js";

test("rejoins phrases the space split separated, in order", () => {
  assert.deepEqual(cleanTags(["14er", "class", "3"], null).tags, ["14er", "c3"]);
  assert.deepEqual(cleanTags(["13er", "front", "range", "scramble"], null).tags, ["13er", "front range", "scramble"]);
  assert.deepEqual(cleanTags(["Mallory", "Cave"], null).tags, ["mallory cave"]);
});

test("does not join words that are not adjacent", () => {
  assert.deepEqual(cleanTags(["ocean", "arctic"], null).tags, ["ocean", "arctic"]);
  assert.deepEqual(cleanTags(["class", "solo"], null).tags, ["class", "solo"]);
});

test("handles overlapping peak names", () => {
  assert.deepEqual(
    cleanTags(["class", "4", "14ers", "maroon", "peak", "north", "maroon"], null).tags,
    ["c4", "14er", "maroon peak", "north maroon"],
  );
  assert.deepEqual(
    cleanTags(["14er", "class", "4", "Luis", "bells", "north", "maroon"], null).tags,
    ["14er", "c4", "luis", "maroon bells", "north maroon"],
  );
});

test("keeps both sf and san francisco, and existing c-grades", () => {
  assert.deepEqual(cleanTags(["sf", "san", "francisco", "city"], null).tags, ["sf", "san francisco", "city"]);
  assert.deepEqual(cleanTags(["14er", "c4", "ally"], null).tags, ["14er", "c4", "ally"]);
});

test("collapses fall colors to fall and merges the duplicates it creates", () => {
  assert.deepEqual(cleanTags(["fall", "colors", "pano"], null).tags, ["fall", "pano"]);
  assert.deepEqual(cleanTags(["fall", "fall", "colors"], null).tags, ["fall"]);
  assert.deepEqual(cleanTags(["14er", "Kylie", "snowflake", "14er"], null).tags, ["14er", "kylie", "snowflake"]);
});

test("fixes the 1434 typo and removes np", () => {
  assert.deepEqual(cleanTags(["1434", "c4"], null).tags, ["14er", "c4"]);
  assert.deepEqual(cleanTags(["np", "desert"], null).tags, ["desert"]);
});

test("normalizes curly apostrophes before joining", () => {
  assert.deepEqual(cleanTags(["angel\u2019s", "landing"], null).tags, ["angel's landing"]);
});

test("keeps a person's name unless the title already names them", () => {
  assert.deepEqual(cleanTags(["luis"], "Luis on Missouri Ridge").tags, []);
  assert.deepEqual(cleanTags(["luis", "connor", "kyle"], "Descending Teton Ridge").tags, ["luis", "connor", "kyle"]);
  assert.deepEqual(cleanTags(["kyle"], "Kyleen's Lake").tags, ["kyle"]);
});

test("reads raw comma text from older uploads", () => {
  assert.deepEqual(readTags("rock climbing, kylie"), { tags: ["rock climbing", " kylie"], wasJson: false });
  assert.deepEqual(cleanTags(readTags("city, sunset, flowers").tags, null).tags, ["city", "sunset", "flowers"]);
});

test("plans only rows that change and records why", () => {
  const changes = planTagCleanup([
    { id: "a", title: null, tags: '["14er","class","3"]' },
    { id: "b", title: null, tags: '["desert"]' },
    { id: "c", title: null, tags: "trapani" },
    { id: "d", title: null, tags: null },
    { id: "e", title: null, tags: "[]" },
  ]);
  assert.deepEqual(changes.map(({ id, after }) => [id, after]), [["a", '["14er","c3"]'], ["c", '["trapani"]']]);
  assert.deepEqual(changes[1].notes, ["converted comma text to a JSON array"]);
});

test("guards every update on the snapshot value, both directions", () => {
  const changes = planTagCleanup([{ id: "x'1", title: null, tags: "angel's landing" }]);
  assert.equal(
    applySql(changes),
    `UPDATE photos SET tags = '["angel''s landing"]', updated_at = datetime('now') WHERE id = 'x''1' AND tags = 'angel''s landing';`,
  );
  assert.equal(
    rollbackSql(changes),
    `UPDATE photos SET tags = 'angel''s landing', updated_at = datetime('now') WHERE id = 'x''1' AND tags = '["angel''s landing"]';`,
  );
});
