import assert from "node:assert/strict";
import test from "node:test";
import { distanceKm, isHumanLocation, matchExistingLocation } from "./location-matcher.js";

test("recognizes human labels and excludes coordinate placeholders", () => {
  assert.equal(isHumanLocation("Point Reyes, California"), true);
  assert.equal(isHumanLocation("37.99650, -122.99970"), false);
});

test("calculates useful geographic distances", () => {
  assert.ok(distanceKm(37.7749, -122.4194, 37.8044, -122.2712) > 10);
});

test("matches a nearby existing label and ignores distant anchors", () => {
  const match = matchExistingLocation(37.997, -123.001, [
    { location: "Point Reyes, California", latitude: 37.9965, longitude: -122.9997 },
    { location: "Yosemite, California", latitude: 37.7459, longitude: -119.5332 },
  ]);
  assert.equal(match?.location, "Point Reyes, California");
  assert.ok((match?.distanceKm || Infinity) < 1);
});
