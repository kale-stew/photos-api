-- Gear product images synced from Notion by climb-log's nightly sync.
-- Kept apart from photos: no aliases, collections, visibility, or slugs.
CREATE TABLE gear_assets (
  notion_page_id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  pipeline_version INTEGER NOT NULL,
  version TEXT NOT NULL,
  r2_prefix TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ready', 'needs_review')),
  background_removed INTEGER NOT NULL DEFAULT 0,
  content_coverage REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Superseded versions awaiting cleanup. Rows are removed only after every
-- object under the prefix is deleted and verified, so failures can be retried.
CREATE TABLE gear_asset_retired_prefixes (
  r2_prefix TEXT PRIMARY KEY,
  notion_page_id TEXT NOT NULL,
  retired_at TEXT NOT NULL DEFAULT (datetime('now'))
);
