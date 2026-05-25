-- Add AI-generated searchable content
-- Run with: wrangler d1 migrations apply photos-db --local/--remote
--
-- IMPORTANT PREREQUISITES:
--
-- 1. The `caption` column must exist on the `photos` table before this migration.
--    It exists in the deployed D1 (schema drift, not added via migration), but
--    may be missing on fresh databases. If missing, run first:
--      ALTER TABLE photos ADD COLUMN caption TEXT;
--
-- 2. The `camera` column is NOT included in this migration because it may already
--    exist in your deployed D1 (added manually or via script). If it does NOT
--    exist in your target environment, add it manually before applying:
--      ALTER TABLE photos ADD COLUMN camera TEXT;
--      CREATE INDEX idx_photos_camera ON photos(camera);
--
-- 3. FTS5: D1 SQLite includes FTS5 in local testing. If this migration fails
--    on a D1 instance without FTS5 support, use this fallback instead of the
--    CREATE VIRTUAL TABLE and trigger sections below:
--      ALTER TABLE photos ADD COLUMN search_text TEXT;
--      CREATE INDEX idx_photos_search_text ON photos(search_text);
--      -- Populate via: UPDATE photos SET search_text = COALESCE(title,'') || ' ' || COALESCE(caption,'') || ' ' || COALESCE(location,'');

-- AI captions from vision models (e.g. "a person standing on a mountain summit at sunset")
ALTER TABLE photos ADD COLUMN ai_caption TEXT;

-- Extracted keywords from AI caption, stored as JSON array string
ALTER TABLE photos ADD COLUMN ai_keywords TEXT;

-- Composite quality score (0.0–1.0) from EXIF + optional vision model evaluation
ALTER TABLE photos ADD COLUMN ai_quality_score REAL;

-- Timestamp of last AI analysis
ALTER TABLE photos ADD COLUMN ai_processed_at TEXT;

-- Indexes for AI lookups
CREATE INDEX idx_photos_ai_caption ON photos(ai_caption);
CREATE INDEX idx_photos_ai_quality ON photos(ai_quality_score);

-- Full-text search over metadata + AI-generated content
-- D1 supports FTS5. If unavailable, see fallback in header comments above.
CREATE VIRTUAL TABLE photos_fts USING fts5(
  id UNINDEXED,
  title,
  caption,
  location,
  ai_caption,
  ai_keywords
);

-- Trigger to keep FTS index in sync with photos table
CREATE TRIGGER photos_fts_insert AFTER INSERT ON photos BEGIN
  INSERT INTO photos_fts(id, title, caption, location, ai_caption, ai_keywords)
  VALUES (new.id, new.title, new.caption, new.location, new.ai_caption, new.ai_keywords);
END;

CREATE TRIGGER photos_fts_update AFTER UPDATE ON photos BEGIN
  UPDATE photos_fts SET
    title = new.title,
    caption = new.caption,
    location = new.location,
    ai_caption = new.ai_caption,
    ai_keywords = new.ai_keywords
  WHERE id = new.id;
END;

CREATE TRIGGER photos_fts_delete AFTER DELETE ON photos BEGIN
  DELETE FROM photos_fts WHERE id = old.id;
END;

-- Backfill FTS index with existing photos (triggers only fire on new inserts/updates)
INSERT INTO photos_fts(id, title, caption, location, ai_caption, ai_keywords)
SELECT id, title, caption, location, ai_caption, ai_keywords FROM photos;
