-- Seed test data for local development
-- Run with: wrangler d1 execute photos-db --local --file=scripts/seed-test-data.sql

INSERT INTO photos (id, r2_key, title, caption, location, date, width, height, format, site, source)
VALUES 
  ('test-photo-1', 'photos/test-1', 'Test Photo 1', 'A test photo for development', 'Yosemite', '2024-06-15', 4000, 3000, 'jpeg', 'climb-log', 'upload'),
  ('test-photo-2', 'photos/test-2', 'Test Photo 2', 'Another test photo', 'Joshua Tree', '2024-07-20', 3000, 4000, 'jpeg', 'kylieis.online', 'upload'),
  ('test-photo-3', 'photos/test-3', 'Shared Photo', 'Visible on both sites', 'Red Rocks', '2024-08-10', 5000, 3333, 'jpeg', 'both', 'upload')
ON CONFLICT (id) DO NOTHING;
