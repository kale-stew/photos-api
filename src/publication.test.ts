import assert from "node:assert/strict";
import test from "node:test";
import { excludeFor, planPublication, PUBLICATIONS, publicationFor, VISIBILITIES, VISIBILITY_LABELS } from "./publication.js";

test("Listed photos join the portfolio", () => {
  assert.deepEqual(publicationFor("public", "both"), PUBLICATIONS.portfolio);
  assert.deepEqual(publicationFor("public", "climb-log"), PUBLICATIONS.portfolio);
});

test("Listed kylieis.online-only photos stay out of the kylies.photos portfolio", () => {
  assert.deepEqual(publicationFor("public", "kylieis-online"), { visibility: "public", exclude: 0, collection: null });
});

test("Link-only and Private match the bulk actions", () => {
  assert.deepEqual(publicationFor("unlisted", "both"), PUBLICATIONS.editorial);
  assert.deepEqual(publicationFor("private", "both"), PUBLICATIONS.private);
});

test("inactive photos join no managed collection", () => {
  assert.equal(publicationFor("public", "climb-log", "quarantined").collection, null);
  assert.equal(publicationFor("unlisted", "climb-log", "quarantined").collection, null);
});

test("exclude is derived from visibility alone", () => {
  assert.equal(excludeFor("public"), 0);
  assert.equal(excludeFor("unlisted"), 1);
  assert.equal(excludeFor("private"), 1);
  for (const visibility of VISIBILITIES) assert.equal(publicationFor(visibility, "both").exclude, excludeFor(visibility));
});

test("every visibility has a label", () => {
  assert.deepEqual(VISIBILITIES.map((value) => VISIBILITY_LABELS[value].label), ["Listed", "Link-only", "Private"]);
});

const listed = { visibility: "public", site: "climb-log", status: "active" } as const;
const linkOnly = { ...listed, visibility: "unlisted" } as const;

test("a plain metadata edit changes no membership", () => {
  assert.deepEqual(planPublication(listed, listed, new Set(["portfolio"]), undefined), { publication: null, features: [] });
});

test("Listed to Link-only leaves the portfolio and keeps features", () => {
  const plan = planPublication(listed, linkOnly, new Set(["portfolio", "about"]), { about: true });
  assert.deepEqual(plan.publication, PUBLICATIONS.editorial);
  assert.deepEqual(plan.features, []);
});

test("unchecking a feature records it once; an unchanged box writes nothing", () => {
  assert.deepEqual(planPublication(linkOnly, linkOnly, new Set(["about"]), { about: false }).features, [{ slug: "about", on: false }]);
  assert.deepEqual(planPublication(linkOnly, linkOnly, new Set(), { about: false }).features, []);
});

test("featuring a Link-only photo adds it without listing it", () => {
  const plan = planPublication(linkOnly, linkOnly, new Set(["kylies-photos-content"]), { about: true });
  assert.equal(plan.publication, null);
  assert.deepEqual(plan.features, [{ slug: "about", on: true }]);
});

test("quarantine alone keeps membership; reactivation recomputes it", () => {
  const quarantined = { ...listed, status: "quarantined" };
  assert.equal(planPublication(listed, quarantined, new Set(["portfolio"]), undefined).publication, null);
  assert.deepEqual(planPublication(quarantined, listed, new Set(), undefined).publication, PUBLICATIONS.portfolio);
});

test("an inactive photo cannot be featured", () => {
  const quarantined = { ...linkOnly, status: "quarantined" };
  assert.match(planPublication(quarantined, quarantined, new Set(), { about: true }).error ?? "", /Activate/);
});

test("moving a Listed photo to kylieis.online only leaves the portfolio", () => {
  assert.equal(planPublication(listed, { ...listed, site: "kylieis-online" }, new Set(["portfolio"]), undefined).publication?.collection, null);
});

test("a private photo cannot be featured", () => {
  const priv = { ...listed, visibility: "private" } as const;
  assert.match(planPublication(priv, priv, new Set(), { about: true }).error ?? "", /Private/);
});
