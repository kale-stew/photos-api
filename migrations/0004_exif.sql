-- Extracted EXIF metadata for technical analysis and quality evaluation
-- Run with: wrangler d1 migrations apply photos-db --local/--remote

CREATE TABLE photo_exif (
  photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,

  -- Camera & lens
  make TEXT,                    -- e.g. "SONY", "Apple", "Canon"
  model TEXT,                   -- e.g. "ILCE-7RM4", "iPhone15,2"
  lens_model TEXT,              -- e.g. "FE 24-70mm F2.8 GM"

  -- Exposure
  focal_length REAL,            -- mm
  aperture REAL,                -- f-number, e.g. 2.8
  shutter_speed REAL,           -- denominator (e.g. 125 = 1/125s, 0.5 = 0.5s)
  iso INTEGER,
  exposure_compensation TEXT,   -- e.g. "+0.33", "-1.00"

  -- Timing & location
  date_taken TEXT,              -- EXIF DateTimeOriginal (YYYY:MM:DD HH:MM:SS)
  gps_latitude REAL,
  gps_longitude REAL,
  gps_altitude REAL,

  -- Processing
  software TEXT,                -- e.g. "Adobe Lightroom"
  orientation INTEGER,          -- EXIF orientation value (1-8)
  color_space TEXT,             -- e.g. "sRGB", "Adobe RGB"

  -- Backfill tracking
  extracted_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for common EXIF queries
CREATE INDEX idx_exif_make ON photo_exif(make);
CREATE INDEX idx_exif_model ON photo_exif(model);
CREATE INDEX idx_exif_date_taken ON photo_exif(date_taken);
CREATE INDEX idx_exif_iso ON photo_exif(iso);

-- Combined index for camera identification queries (phone vs. dedicated camera)
CREATE INDEX idx_exif_make_model ON photo_exif(make, model);
