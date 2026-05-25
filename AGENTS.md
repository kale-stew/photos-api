# photos-api — Agent Context

> Last updated: 2026-05-25
>
> This file is for coding agents. Human docs live in README.md.

## Overview

Shared photo storage and delivery service powering **kylies.photos** and **kylieis.online**. Stores photo metadata in Cloudflare D1 (SQLite) and serves original + on-demand resized images from Cloudflare R2, with transforms via the Cloudflare Images binding.

## Architecture

- **Single-file worker**: `src/index.tsx` (~1,170 lines) contains *everything* — routes, handlers, JSX components for the admin UI, SQL queries, OpenAPI spec, and image-transform helpers.
- **Runtime**: Cloudflare Workers (`wrangler dev` / `wrangler deploy`)
- **Framework**: Hono v4 (routing, middleware, JSX SSR)
- **Database**: Cloudflare D1 (`photos-db`, binding `DB`)
- **Object Storage**: Cloudflare R2 (`photos-bucket`, binding `PHOTOS_BUCKET`)
- **Image Transforms**: Cloudflare Images binding (`IMAGES`)
- **Compatibility**: `2025-05-24` with `nodejs_compat_v2`

## Critical Conventions

### Single-File Architecture
The entire worker application is in `src/index.tsx`. Any change to:
- API routes or handlers
- Database queries or schema
- Admin UI components
- OpenAPI spec generation
- Image transform logic

...must happen in that file. There are no separate controller/service directories.

### R2 Key Structure
Originals and transforms are stored under a per-photo prefix:
- `photos/{id}/original.{format}` — original upload
- `photos/{id}/w{width}.webp` — on-demand resized WebP

When deleting a photo, delete the entire `photos/{id}/` prefix from R2, not just the original.

### Image Transform Concurrency
Duplicate concurrent requests for the same on-demand resize are coalesced via an in-memory `Map<string, Promise>` called `inFlightTransforms`. If modifying the `/img/{photoId}` flow or transform helpers, preserve this deduplication to avoid redundant CPU/R2 work.

### Admin Authentication
Admin API routes (`/api/admin/*`) enforce a `Cf-Access-Jwt-Assertion` header check. Cloudflare Access validates the JWT signature at the edge; the worker only checks for its presence as defense-in-depth.

There is **no** API-key, cookie-session, or role-based authorization inside the worker code.

### Database Migrations
All schema changes go through `wrangler d1 migrations`:
```bash
# Local
npm run db:migrate:local

# Production
npm run db:migrate:remote
```

Migration files live in `migrations/`. They are applied in filename order.

### Local Scripts
The `scripts/` directory contains one-off backfill and migration scripts that run **locally** against remote resources (D1, R2, Notion API, Flickr API). They:
- Require `.env` vars (see `.env.example`)
- Use `tsx` and Node.js libraries like `sharp` and `blurhash`
- Are **not** bundled into the worker

Do not move script dependencies into the main `package.json` devDeps unless they are also needed by the worker.

## API Endpoints

### Public
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/img/{photoId}?w={width}` | Serve original or resized image. Widths: `200`, `400`, `800`, `1600`, or omit for original. Resized are WebP, cached in R2 with immutable headers. |
| `GET` | `/api/photos?site=&limit=&offset=` | List photo metadata. Filter by `site`. |
| `GET` | `/api/photos?q=&site=` | **New.** Search photos by text query. Uses FTS5 when available, falls back to `LIKE` on `title`, `caption`, `location`, `tags`, `ai_caption`, `ai_keywords`. |
| `GET` | `/api/photos/random?site=&tag=` | **New.** Return a single random photo. Optional `site` and `tag` filters. |
| `GET` | `/api/photos/{id}?include=exif,ai` | Get single photo metadata. Optional `include` param to embed `exif` and/or `ai` sub-objects. |
| `GET` | `/docs` | Swagger UI |
| `GET` | `/openapi.json` | OpenAPI 3.0 spec |

### Admin
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin` | Server-rendered photo grid (paginated). |
| `GET` | `/admin/photos/{id}` | Server-rendered detail page with metadata + size previews. |
| `PATCH` | `/api/admin/photos/{id}` | Edit metadata. Allowed fields: `title`, `location`, `date`, `tags`, `site`, `exclude`, `caption`. |
| `DELETE` | `/api/admin/photos/{id}` | Delete photo from D1 + all R2 objects under prefix. |
| `POST` | `/api/admin/resize` | Custom resize (width `1–2048`). |
| `POST` | `/api/admin/upload` | Upload new photo (JPEG/PNG/WebP, max 20 MB). |

## Data Model

### `photos` table
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `notion_id` | TEXT UNIQUE | Legacy Notion page ID |
| `r2_key` | TEXT NOT NULL | e.g. `photos/abc123` |
| `title` | TEXT | |
| `caption` | TEXT | **Schema drift**: exists in DB but not added via any migration. Likely added manually or via script. |
| `location` | TEXT | |
| `date` | TEXT | `YYYY-MM-DD` |
| `width` | INTEGER | |
| `height` | INTEGER | |
| `blurhash` | TEXT | |
| `format` | TEXT | `jpeg`, `png`, `webp` |
| `size_bytes` | INTEGER | |
| `site` | TEXT | `climb-log`, `kylieis-online`, `both` |
| `source` | TEXT | `flickr`, `cf_images`, `upload` |
| `tags` | TEXT | JSON array string |
| `exclude` | INTEGER | `0` or `1` |
| `flickr_id` | TEXT | Added in migration 0002 |
| `accent_color` | TEXT | Hex color |
| `source_url` | TEXT | Original source URL |
| `camera` | TEXT | Added in migration 0003. Denormalized make/model for quick filtering (e.g. "Sony ILCE-7RM4", "Apple iPhone 15 Pro") |
| `ai_caption` | TEXT | Added in migration 0003. AI-generated image description |
| `ai_keywords` | TEXT | Added in migration 0003. JSON array of extracted keywords |
| `ai_quality_score` | REAL | Added in migration 0003. 0.0–1.0 composite quality score |
| `ai_processed_at` | TEXT | Added in migration 0003. Timestamp of last AI analysis |
| `created_at` | TEXT | |
| `updated_at` | TEXT | |

### `photo_climb_links` table
Join table for photos → climbs (used by kylies.photos / climb-log).

### `photo_exif` table
Added in migration 0004. Stores extracted EXIF metadata for technical analysis.
| Column | Type | Notes |
|--------|------|-------|
| `photo_id` | TEXT PK | References `photos(id)` |
| `make` | TEXT | Camera manufacturer (e.g. "SONY", "Apple") |
| `model` | TEXT | Camera model (e.g. "ILCE-7RM4", "iPhone15,2") |
| `lens_model` | TEXT | Lens used |
| `focal_length` | REAL | mm |
| `aperture` | REAL | f-number |
| `shutter_speed` | REAL | Denominator (e.g. 125 = 1/125s) |
| `iso` | INTEGER | |
| `exposure_compensation` | TEXT | |
| `date_taken` | TEXT | EXIF DateTimeOriginal |
| `gps_latitude` | REAL | |
| `gps_longitude` | REAL | |
| `gps_altitude` | REAL | |
| `software` | TEXT | Post-processing software |
| `orientation` | INTEGER | EXIF orientation value |
| `color_space` | TEXT | |
| `extracted_at` | TEXT | |

### `photos_fts` virtual table
Added in migration 0003. SQLite FTS5 index for full-text search over `title`, `caption`, `location`, `ai_caption`, and `ai_keywords`. Kept in sync with `photos` via triggers.

## Environment Variables

Required for local scripts (in `.env`, gitignored):
- `NOTION_API_KEY` / `NOTION_DATABASE_ID`
- `FLICKR_API_KEY`
- `CLOUDFLARE_ACCOUNT_ID` / `CF_API_TOKEN`

Worker env vars (in `wrangler.jsonc`):
- `ALLOWED_WIDTHS = "200,400,800,1600"`

## Common Commands

```bash
# Dev
npm install
npm run db:migrate:local
npm run db:seed:local
npm run dev                # localhost:8787

# Test
npm test                   # integration tests
npm run test:local         # explicit localhost target

# Deploy
npm run db:migrate:remote
npm run deploy
```

## MCP Server Notes

The repo includes a Model Context Protocol (MCP) server for AI-powered interaction with the photos API.

- **Location**: `mcp-server/` directory (local-first, Node.js/TypeScript)
- **Transport**: `stdio` for Claude Desktop / Cursor; eventually SSE for web clients
- **Auth**: For local dev, reads `PHOTOS_API_URL` and optional `CF_ACCESS_TOKEN` from env. For deployed mode, will use Cloudflare Access JWT.
- **AI Backends**: Cloudflare Workers AI (primary), Kimi / other LLM APIs (fallback for complex reasoning)

### MCP Commands
```bash
cd mcp-server
npm install                  # one-time
npm run dev                  # start stdio server via tsx
```

### Claude Desktop Config
Add to `~/Library/Application\ Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "photos-api": {
      "command": "npx",
      "args": ["tsx", "/Users/kski/Developer/photos-api/mcp-server/src/index.ts"],
      "env": {
        "PHOTOS_API_URL": "https://photos-api.kylieski.workers.dev",
        "CF_ACCESS_TOKEN": "<your-jwt>"
      }
    }
  }
}
```

### Implemented Tools
- `search_photos` — full-text search over metadata + AI captions
- `list_photos` — paginated photo list
- `get_random_photo` — random photo with optional filters
- `get_photo` — single photo metadata (optional EXIF/AI)
- `update_photo` — admin metadata edits

See `MCP-PLAN.md` for full architecture and planned tools.
