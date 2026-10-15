import assert from "node:assert/strict";
import test from "node:test";
import { distanceKm, isHumanLocation, matchExistingLocation, matchExistingLocationText } from "./location-matcher.js";

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

test("matches distinctive filename terms against existing labels", () => {
  const match = matchExistingLocationText("2025-yosemite2.jpg", [
    { location: "Yosemite National Park, CA", count: 3 },
    { location: "Inyo NF, California", count: 11 },
  ]);
  assert.deepEqual(match, { location: "Yosemite National Park, CA", matchedTerms: ["yosemite"] });
});

test("does not infer a place from only a state name", () => {
  assert.equal(matchExistingLocationText("2022-alaska5.jpg", [
    { location: "Lake Clark NP, Alaska", count: 10 },
    { location: "Girdwood, Alaska", count: 3 },
  ]), null);
});

test("does not match generic or conflicting terrain names", () => {
  assert.equal(matchExistingLocationText("2022-chicago_basin.jpg", [
    { location: "Chicago, IL", count: 2 },
  ]), null);
  assert.equal(matchExistingLocationText("2025-bishop_pass.jpeg", [
    { location: "Loveland Pass, Colorado", count: 3 },
  ]), null);
  assert.equal(matchExistingLocationText("2026-alamere_falls.jpeg", [
    { location: "Silver Falls SP, Oregon", count: 10 },
  ]), null);
});
