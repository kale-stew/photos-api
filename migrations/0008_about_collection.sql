-- Photos for the kylies.photos about-page rotation. Membership is independent of the
-- portfolio, so a public photo hidden from listings can still rotate on /about.
INSERT INTO collections (slug, title, description, is_public) VALUES
  ('about', 'About', 'Photos of Kylie for the kylies.photos about page', 1);

-- Seed with today's tagged photos; climb-log's nightly sync adds new ones through
-- the PhotoCollections RPC entrypoint using the same rule (src/about-collection.ts).
INSERT OR IGNORE INTO photo_collections (photo_id, collection_slug)
SELECT p.id, 'about'
FROM photos p
WHERE p.status = 'active'
  AND p.visibility = 'public'
  AND (p.site = 'climb-log' OR p.site = 'both')
  AND EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(p.tags) THEN p.tags ELSE '[]' END) tag
    WHERE lower(tag.value) = 'kylie'
  );
