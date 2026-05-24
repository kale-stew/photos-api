# Photos API - Post-Migration TODO

## After Migration Completes (573 photos)

### 1. Backfill Climb Links
```bash
cd /Users/kski/Developer/photos-api
npm run migrate:climb-links -- --dry-run  # preview
npm run migrate:climb-links               # execute
```

### 2. Generate Blurhashes
```bash
npm run generate:blurhash
```

### 3. Verify Migration
```bash
# Check counts
wrangler d1 execute photos-db --remote --command="SELECT COUNT(*) FROM photos"
wrangler d1 execute photos-db --remote --command="SELECT COUNT(*) FROM photo_climb_links"

# Check R2 bucket size
wrangler r2 object list photos-bucket --remote | wc -l
```

### 4. Test Image Transforms
```bash
# Test resize endpoint
curl -I "https://photos-api.kylieski.workers.dev/img/$(wrangler d1 execute photos-db --remote --command='SELECT id FROM photos LIMIT 1' --json | jq -r '.[0].results[0].id')?w=800"
```

### 5. Validate with kylieis.online
Create a branch in kylieis.online to test photos-api integration before going live.

```bash
cd /Users/kski/Developer/kylieis.online
git checkout -b feat/photos-api-integration

# Update image sources to use photos-api
# Test locally with wrangler dev
# Verify images load correctly at various sizes
# Check fallback behavior if API is down
```

**What to test:**
- [ ] Images render correctly on blog posts
- [ ] Responsive image sizing works (w=200, 400, 800, 1600)
- [ ] Fallback/error handling if photo not found
- [ ] Performance comparison vs old Flickr setup
- [ ] OG images still generate correctly

---

## Pending PRs (kylieis.online)

### Draft Preview Pipeline
- **Branch**: `feat/draft-preview-pipeline`
- **Status**: Committed, ready to push
- **Changes**: 
  - `.github/workflows/deploy-draft.yml`
  - `AGENTS.md` updated with draft workflow docs

```bash
cd /Users/kski/Developer/kylieis.online
git checkout feat/draft-preview-pipeline
git push -u origin feat/draft-preview-pipeline
```

### Photos API Blog Post
- **Branch**: `blog/photos-api-post`
- **Status**: Staged, needs commit
- **File**: `content/from-flickr-to-r2.md`

```bash
cd /Users/kski/Developer/kylieis.online
git checkout blog/photos-api-post
git commit -m "add photos-api blog post draft"
git push -u origin blog/photos-api-post
```

> Note: Push the pipeline PR first so the blog branch gets a preview deployment!

---

---

## Future: Peak List Feature

The old Next.js site had a `/peak-list` page showing Centennial peaks as cards with cover photos.

**Data source**: Notion database `d2c6ac15-7eb2-4fc4-99a4-691b6c853a0e` (Centennial Checklist)
- Properties: `peak_name`, `elevation`, `rank`, `range`, `first_completed_on`, `img_url`
- `img_url` contains Flickr `_b.jpg` URLs

**Integration path**:
1. Run `npm run migrate:map-peaks` to see current mapping status
2. After main migration completes, re-run to get full mapping
3. Update Centennial Checklist to store `photo_id` instead of (or alongside) `img_url`
4. Add `/peak-list` route to kylieis.online or climb-log
5. Fetch peak data from Notion, images from photos-api

**Script**: `scripts/migrate/map-centennial-photos.ts`
```bash
npm run migrate:map-peaks           # show mapping table
npm run migrate:map-peaks -- --json # output as JSON
```

**Current status** (as of migration ~70%):
- 114 peaks total
- 51 have Flickr URLs
- 11 already mapped to photos-api
- 40 will map once migration completes
- 63 have no photo yet

**Or**: Add `photo_peak_links` table to photos-api schema and sync from Notion.

---

## Migration Stats
- **Started**: May 24, 2026
- **Total photos**: 573
- **Source**: Notion → Flickr API → R2 + D1
- **Log**: `/tmp/photos-migration.log`
- **PID**: 72789
