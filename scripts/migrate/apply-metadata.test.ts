import assert from "node:assert/strict";
import test from "node:test";
import { metadataSql, summarize, validateManifest } from "./apply-metadata.js";

const entry = {
  id: "blog-1",
  from: { title: "First light seen along the ridge. {768x264}", caption: null, date: null },
  to: { title: "Ridge first light", caption: "First light seen along the ridge.", date: "2021-01-31" },
};

test("updates only the listed fields, guarded on their current values", () => {
  assert.equal(
    metadataSql(entry),
    "UPDATE photos SET title = 'Ridge first light', caption = 'First light seen along the ridge.', date = '2021-01-31', updated_at = datetime('now') " +
      "WHERE id = 'blog-1' AND title IS 'First light seen along the ridge. {768x264}' AND caption IS NULL AND date IS NULL RETURNING id",
  );
});

test("quotes apostrophes", () => {
  assert.match(metadataSql({ id: "x", from: { caption: null }, to: { caption: "Maroon's summit" } }), /'Maroon''s summit'/);
});

test("rejects unknown fields, missing expectations, bad dates, and duplicates", () => {
  const errors = validateManifest({
    version: 1,
    entries: [
      { id: "a", from: {}, to: { caption: "x" } },
      { id: "b", from: { visibility: "public" } as never, to: { visibility: "private" } as never },
      { id: "c", from: { date: null }, to: { date: "July 2021" } },
      { id: "c", from: { date: null }, to: { date: "2021-07-01" } },
    ],
  });
  assert.deepEqual(errors, [
    "a: caption has no expected current value",
    "b: unknown field visibility",
    "c: date July 2021 is not YYYY-MM-DD",
    "c: listed twice",
  ]);
});

test("a valid manifest has no errors and a field summary", () => {
  const manifest = { version: 1 as const, entries: [entry] };
  assert.deepEqual(validateManifest(manifest), []);
  assert.deepEqual(summarize(manifest), { photos: 1, title: 1, caption: 1, date: 1 });
});
