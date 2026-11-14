import assert from "node:assert/strict";
import test from "node:test";
import { parseTags, parseTagSuggestions } from "./tag-suggestions.js";

test("reads stored JSON tags and tolerates comma lists", () => {
  assert.deepEqual(parseTags('["14er","snow"]'), ["14er", "snow"]);
  assert.deepEqual(parseTags("coast, fog"), ["coast", "fog"]);
  assert.deepEqual(parseTags(null), []);
});

test("normalizes model output into short lowercase tags", () => {
  assert.deepEqual(parseTagSuggestions("Snow, #Ridge, Alpine Lake.", [], []), ["snow", "ridge", "alpine lake"]);
});

test("strips list markers and drops sentences", () => {
  assert.deepEqual(
    parseTagSuggestions("1. desert\n- sunset\nthis is a photo of a very long ridge line", [], []),
    ["desert", "sunset"],
  );
});

test("excludes tags the photo already has and duplicates", () => {
  assert.deepEqual(parseTagSuggestions("snow, Snow, 14er, ridge", [], ["14er"]), ["snow", "ridge"]);
});

test("adopts the library's plural form", () => {
  assert.deepEqual(parseTagSuggestions("wildflower, lakes, cliffs", ["wildflowers", "lake"], []), ["wildflowers", "lake", "cliffs"]);
  assert.deepEqual(parseTagSuggestions("wildflower", ["wildflowers"], ["wildflowers"]), []);
});

test("keeps short tags that end in s intact", () => {
  assert.deepEqual(parseTagSuggestions("moss, pass", ["mos"], []), ["moss", "pass"]);
});

test("puts library vocabulary first and caps the count", () => {
  assert.deepEqual(
    parseTagSuggestions("granite, snow, clouds, 14er, ridge, summit, wildflowers", ["14er", "snow"], []),
    ["snow", "14er", "granite", "clouds", "ridge", "summit"],
  );
});
