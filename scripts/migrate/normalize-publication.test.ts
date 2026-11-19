import assert from "node:assert/strict";
import test from "node:test";
import { normalizationSql, planNormalization, type PublicationRow } from "./normalize-publication.js";

const row = (overrides: Partial<PublicationRow>): PublicationRow => ({
  id: "p1",
  title: "Photo",
  visibility: "public",
  exclude: 0,
  site: "climb-log",
  in_portfolio: 1,
  in_editorial: 0,
  ...overrides,
});

test("consistent photos produce no changes", () => {
  const rows = [
    row({}),
    row({ id: "p2", visibility: "unlisted", exclude: 1, in_portfolio: 0, in_editorial: 1 }),
    row({ id: "p3", visibility: "private", exclude: 1, in_portfolio: 0 }),
    row({ id: "p4", site: "kylieis-online", in_portfolio: 0 }),
  ];
  assert.deepEqual(planNormalization(rows).entries, []);
});

test("public but hidden becomes Link-only", () => {
  const [entry] = planNormalization([row({ exclude: 1, in_portfolio: 0 })]).entries;
  assert.deepEqual(entry.to, { visibility: "unlisted", exclude: 1, portfolio: false, editorial: true });
  assert.equal(entry.reason, "public but hidden → Link-only");
});

test("a Listed photo outside the portfolio joins it and leaves editorial", () => {
  const [entry] = planNormalization([row({ in_portfolio: 0, in_editorial: 1 })]).entries;
  assert.deepEqual(entry.to, { visibility: "public", exclude: 0, portfolio: true, editorial: false });
});

test("Link-only photos leave the portfolio and get exclude = 1", () => {
  const [entry] = planNormalization([row({ visibility: "unlisted", exclude: 0, in_portfolio: 1 })]).entries;
  assert.deepEqual(entry.to, { visibility: "unlisted", exclude: 1, portfolio: false, editorial: true });
});

test("SQL touches only managed collections and quotes ids", () => {
  const [entry] = planNormalization([row({ id: "o'brien", exclude: 1, in_portfolio: 0 })]).entries;
  const sql = normalizationSql(entry);
  assert.match(sql, /WHERE id = 'o''brien'/);
  assert.match(sql, /collection_slug IN \('portfolio', 'kylies-photos-content'\)/);
  assert.doesNotMatch(sql, /'about'/);
});
