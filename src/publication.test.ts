import assert from "node:assert/strict";
import test from "node:test";
import { PUBLICATIONS, publicCollection, publicationForVisibility } from "./publication.js";

test("hidden public photos stay out of the portfolio", () => {
  assert.equal(publicCollection("climb-log", 0), "portfolio");
  assert.equal(publicCollection("both", 1), null);
  assert.equal(publicCollection("kylieis-online", 0), null);
  assert.equal(publicCollection("climb-log", 0, "quarantined"), null);
});

test("making a photo public lists it in the portfolio", () => {
  assert.deepEqual(publicationForVisibility("public", "both"), PUBLICATIONS.portfolio);
  assert.deepEqual(publicationForVisibility("public", "climb-log"), PUBLICATIONS.portfolio);
});

test("public kylieis.online photos stay out of the kylies.photos portfolio", () => {
  assert.deepEqual(publicationForVisibility("public", "kylieis-online"), { visibility: "public", exclude: 0, collection: null });
});

test("unlisted and private match the editorial and private bulk actions", () => {
  assert.deepEqual(publicationForVisibility("unlisted", "both"), PUBLICATIONS.editorial);
  assert.deepEqual(publicationForVisibility("private", "both"), PUBLICATIONS.private);
});
