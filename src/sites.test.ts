import assert from "node:assert/strict";
import test from "node:test";
import { parseSite, siteLabel, sitesForValue } from "./sites.js";

test("expands a stored value into selected sites", () => {
  assert.deepEqual(sitesForValue("both"), ["climb-log", "kylieis-online"]);
  assert.deepEqual(sitesForValue("climb-log"), ["climb-log"]);
  assert.deepEqual(sitesForValue(null), []);
  assert.deepEqual(sitesForValue("unknown"), []);
});

test("collapses selected sites into the stored value", () => {
  assert.equal(parseSite(["climb-log", "kylieis-online"]), "both");
  assert.equal(parseSite(["kylieis-online"]), "kylieis-online");
  assert.equal(parseSite(["climb-log", "climb-log"]), "climb-log");
});

test("accepts stored values directly for older clients", () => {
  assert.equal(parseSite("both"), "both");
  assert.equal(parseSite("climb-log"), "climb-log");
  assert.equal(parseSite(["both"]), "both");
});

test("rejects empty and unknown selections", () => {
  assert.equal(parseSite([]), null);
  assert.equal(parseSite(""), null);
  assert.equal(parseSite(["climb-log", "flickr"]), null);
  assert.equal(parseSite(null), null);
});

test("labels sites by their public domain", () => {
  assert.equal(siteLabel("climb-log"), "kylies.photos");
  assert.equal(siteLabel("both"), "both sites");
});
