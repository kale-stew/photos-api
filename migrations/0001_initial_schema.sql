-- Initial schema for photos-db
-- Unified photo storage for kylies.photos and kylieis.online

CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  notion_id TEXT UNIQUE,
  r2_key TEXT NOT NULL,              -- e.g., "photos/abc123"

  -- Display metadata
  title TEXT,
  caption TEXT,
  location TEXT,
  date TEXT,                         -- YYYY-MM-DD

  -- Technical metadata
  width INTEGER,
  height INTEGER,
  blurhash TEXT,
  format TEXT DEFAULT 'jpeg',
  size_bytes INTEGER,

  -- Categorization
  site TEXT DEFAULT 'climb-log',     -- 'climb-log' | 'kylieis.online' | 'both'
  source TEXT,                       -- 'flickr' | 'cf_images' | 'upload'
  tags TEXT,                         -- JSON array

  -- Flags
  exclude INTEGER DEFAULT 0,

  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_photos_site ON photos(site);
CREATE INDEX idx_photos_date ON photos(date DESC);
CREATE INDEX idx_photos_notion_id ON photos(notion_id);

-- Join table for photos associated with climbs
CREATE TABLE photo_climb_links (
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  climb_id TEXT NOT NULL,
  PRIMARY KEY (photo_id, climb_id)
);

CREATE INDEX idx_photo_climb_links_climb_id ON photo_climb_links(climb_id);
