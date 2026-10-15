CREATE TABLE photo_exif (
  photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  make TEXT,
  model TEXT,
  lens_model TEXT,
  focal_length REAL,
  aperture REAL,
  exposure_time REAL,
  iso INTEGER,
  exposure_compensation REAL,
  date_taken TEXT,
  gps_latitude REAL,
  gps_longitude REAL,
  gps_altitude REAL,
  software TEXT,
  orientation INTEGER,
  color_space TEXT,
  image_description TEXT,
  artist TEXT,
  copyright TEXT,
  extracted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_photo_exif_camera ON photo_exif(make, model);
CREATE INDEX idx_photo_exif_date_taken ON photo_exif(date_taken);
