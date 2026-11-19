import assert from "node:assert/strict";
import test from "node:test";
import { captionSql, planCaptions, stripSizeHint } from "./normalize-captions.js";

test("strips a trailing size hint only", () => {
  assert.equal(stripSizeHint("First light. {768x264}"), "First light.");
  assert.equal(stripSizeHint("Plain title"), "Plain title");
  assert.equal(stripSizeHint("{768x264}"), null);
  assert.equal(stripSizeHint(null), null);
});

test("size hints are removed from titles and captions", () => {
  const [entry] = planCaptions([{ id: "b1", title: "Headwall. {768x264}", caption: "Blue rope. {576x768}" }]).entries;
  assert.deepEqual(entry.to, { title: "Headwall.", caption: "Blue rope." });
  assert.deepEqual(entry.reasons, ["size hint removed from title", "size hint removed from caption"]);
});

test("whitespace-only changes are labeled as such", () => {
  const [entry] = planCaptions([{ id: "b1", title: "Sunrise", caption: "  " }]).entries;
  assert.deepEqual(entry.to.caption, null);
  assert.deepEqual(entry.reasons, ["whitespace trimmed from caption"]);
});

test("clean photos are left alone", () => {
  assert.deepEqual(planCaptions([{ id: "f1", title: "Sunrise", caption: null }]).entries, []);
});

test("the update is a compare-and-set on the planned title and caption", () => {
  const [entry] = planCaptions([{ id: "b1", title: "It's here. {1x1}", caption: null }]).entries;
  const sql = captionSql(entry);
  assert.match(sql, /WHERE id = 'b1' AND title IS 'It''s here\. \{1x1\}' AND caption IS NULL/);
  assert.match(sql, /RETURNING id/);
});
