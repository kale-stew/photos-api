-- Photos taken out of a feature collection by hand. Automatic fills (the `kylie` tag rule
-- for `about`) skip these so an unchecked feature stays off.
CREATE TABLE collection_opt_outs (
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  collection_slug TEXT NOT NULL REFERENCES collections(slug) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (photo_id, collection_slug)
);
