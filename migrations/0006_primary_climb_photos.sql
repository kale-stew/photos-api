ALTER TABLE photo_climb_links ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0
  CHECK (is_primary IN (0, 1));

-- A photo depicts at most one hike. A hike may retain several related photos,
-- but only one can be the explicit preview selected in admin.
CREATE UNIQUE INDEX idx_photo_climb_links_unique_photo
  ON photo_climb_links(photo_id);

CREATE UNIQUE INDEX idx_photo_climb_links_primary
  ON photo_climb_links(climb_id)
  WHERE is_primary = 1;
