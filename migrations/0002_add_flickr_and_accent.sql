-- Add columns for Flickr source tracking and accent color
-- Run with: wrangler d1 migrations apply photos-db --local/--remote

-- Flickr photo ID for deduplication and original fetching
ALTER TABLE photos ADD COLUMN flickr_id TEXT;

-- Accent/dominant color from the image (hex format)
ALTER TABLE photos ADD COLUMN accent_color TEXT;

-- Original source URL (Flickr URL before migration)
ALTER TABLE photos ADD COLUMN source_url TEXT;

-- Create index for Flickr ID lookups
CREATE INDEX idx_photos_flickr_id ON photos(flickr_id);
