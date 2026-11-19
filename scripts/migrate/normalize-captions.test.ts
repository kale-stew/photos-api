import assert from "node:assert/strict";
import test from "node:test";
import { captionSql, planCaptions, stripSizeHint } from "./normalize-captions.js";

test("strips a trailing size hint only", () => {
  assert.equal(stripSizeHint("First light. {768x264}"), "First light.");
  assert.equal(stripSizeHint("Plain title"), "Plain title");
  assert.equal(stripSizeHint("{768x264}"), null);
  assert.equal(stripSizeHint(null), null);
});

test("blog photos without a caption get the title as caption; the title stays", () => {
  const [entry] = planCaptions([{ id: "b1", source: "blog", title: "Headwall of La Plata. {768x264}", caption: null }]).entries;
  assert.deepEqual(entry.to, { title: "Headwall of La Plata.", caption: "Headwall of La Plata." });
  assert.deepEqual(entry.reasons, ["size hint removed from title", "blog caption copied from title"]);
});

test("an existing caption is never replaced, only cleaned", () => {
  const [entry] = planCaptions([{ id: "b1", source: "blog", title: "Leftover anchors", caption: "Blue rope. {576x768}" }]).entries;
  assert.deepEqual(entry.to, { title: "Leftover anchors", caption: "Blue rope." });
});

test("non-blog photos without hints are left alone", () => {
  assert.deepEqual(planCaptions([{ id: "f1", source: "flickr", title: "Sunrise", caption: null }]).entries, []);
});

test("the update is a compare-and-set on the planned title and caption", () => {
  const [entry] = planCaptions([{ id: "b1", source: "blog", title: "It's here. {1x1}", caption: null }]).entries;
  const sql = captionSql(entry);
  assert.match(sql, /WHERE id = 'b1' AND title IS 'It''s here\. \{1x1\}' AND caption IS NULL/);
  assert.match(sql, /RETURNING id/);
});
