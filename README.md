# photos-api

Shared photo storage for [kylies.photos](https://kylies.photos) and [kylieis.online](https://kylieis.online).

**Live API**: https://photos-api.kylieski.workers.dev

## Stack

- **Cloudflare Workers** - API + image transforms
- **D1** - Photo metadata (SQLite)
- **R2** - Image storage (originals + cached transforms)
- **Images binding** - On-demand resize/format conversion

## API Endpoints

### Images

```
GET /img/{id}           # Original image (JPEG)
GET /img/{id}?w=800     # Resized to 800px wide (WebP)
```

**Allowed widths**: `200`, `400`, `800`, `1600`, or omit for original

Resized images are:
- Converted to WebP for smaller file sizes
- Cached in R2 after first request
- Served with 1-year immutable cache headers

### Metadata

```
GET /api/photos              # List photos
GET /api/photos?site=climb-log&limit=50&offset=0
GET /api/photos/{id}         # Single photo
GET /docs                    # Interactive API documentation (Swagger UI)
```

### Photo Object

```json
{
  "id": "517c0f03a93c",
  "title": "Paintbrush on Spencer Peak",
  "location": "Caribou-Targhee NF, Idaho",
  "date": "2024-08-04",
  "width": 768,
  "height": 1024,
  "blurhash": "L:E|G2f+Wot7t:WDjZbIx^oJo0kC",
  "format": "jpeg",
  "site": "climb-log",
  "source": "flickr"
}
```

## local dev

```bash
npm install
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

## deploy

```bash
npm run db:migrate:remote
npm run deploy
```

## migration scripts

```bash
# migrate from notion (downloads from flickr, uploads to r2)
npm run migrate:notion

# backfill climb links after main migration
npm run migrate:climb-links

# generate blurhashes for all photos
npm run generate:blurhash
```

## env

```
NOTION_API_KEY=xxx
NOTION_DATABASE_ID=xxx
FLICKR_API_KEY=xxx
```

## schema

```sql
photos (**`id`**, **`notion_id`**, **`r2_key`**, **`title`**, **`location`**, **`date`**, **`width`**, **`height`**, **`blurhash`**, **`format`**, **`size_bytes`**, **`site`**, **`source`**, **`tags`**, **`exclude`**, **`created_at`**, **`updated_at`**)
photo_climb_links (**`photo_id`**, **`climb_id`**)
```

---

see `TODO.md` for post-migration checklist.
