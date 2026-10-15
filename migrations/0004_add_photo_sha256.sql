ALTER TABLE photos ADD COLUMN sha256 TEXT
  CHECK (sha256 IS NULL OR length(sha256) = 64);

CREATE UNIQUE INDEX idx_photos_sha256
  ON photos(sha256)
  WHERE sha256 IS NOT NULL;
