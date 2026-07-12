-- Seed test data for local development
-- Run with: wrangler d1 execute photos-db --local --file=scripts/seed-test-data.sql

INSERT INTO photos (id, notion_id, r2_key, title, caption, location, date, width, height, format, site, source, status, visibility)
VALUES 
  ('test-photo-1', 'legacy-test-photo-1', 'photos/test-1', 'Test Photo 1', 'A test photo for development', 'Yosemite', '2024-06-15', 4000, 3000, 'jpeg', 'climb-log', 'upload', 'active', 'public'),
  ('test-photo-2', NULL, 'photos/test-2', 'Test Photo 2', 'Another test photo', 'Joshua Tree', '2024-07-20', 3000, 4000, 'jpeg', 'kylieis.online', 'upload', 'active', 'public'),
  ('test-photo-3', NULL, 'photos/test-3', 'Shared Photo', 'Visible on both sites', 'Red Rocks', '2024-08-10', 5000, 3333, 'jpeg', 'both', 'upload', 'active', 'public'),
  ('test-unlisted-photo', NULL, 'photos/test-unlisted', 'Unlisted Photo', 'Addressable but not listed', NULL, NULL, 1200, 800, 'jpeg', 'kylieis.online', 'upload', 'active', 'unlisted'),
  ('test-private-photo', NULL, 'photos/test-private', 'Private Photo', 'Not publicly addressable', NULL, NULL, 1200, 800, 'jpeg', 'kylieis.online', 'upload', 'active', 'private'),
  ('test-quarantined-photo', NULL, 'photos/test-quarantined', 'Quarantined Photo', 'Not publicly addressable', NULL, NULL, 1200, 800, 'jpeg', 'kylieis.online', 'upload', 'quarantined', 'unlisted')
ON CONFLICT (id) DO NOTHING;

INSERT INTO photo_aliases (alias, photo_id, kind)
VALUES ('legacy-test-photo-1', 'test-photo-1', 'test')
ON CONFLICT (alias) DO NOTHING;

INSERT INTO photo_collections (photo_id, collection_slug, position)
VALUES ('test-photo-1', 'portfolio', 1)
ON CONFLICT (photo_id, collection_slug) DO NOTHING;

INSERT INTO people (slug, display_name, is_public)
VALUES ('test-person', 'Test Person', 1)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO photo_people (photo_id, person_slug, position)
VALUES ('test-photo-1', 'test-person', 1)
ON CONFLICT (photo_id, person_slug) DO NOTHING;
