# MCP Server Plan — photos-api

> Model Context Protocol server for AI-powered interaction with the photos API.
> Version: 1.0-draft | Last updated: 2026-05-25

## 1. Goals

Build a local MCP server that exposes the photos API as AI-native tools, enabling:
- **Natural language search** over photo metadata and AI-generated captions
- **Random photo discovery** with filtering
- **Metadata cleanup & deduplication** (AI-assisted quality control)
- **EXIF-based quality evaluation** (camera identification, technical scoring)
- **Future: deployed access** from kylies.photos (climb-log) for AI-powered prompts

## 2. Architecture

### Phase 1: Local MCP Server (Immediate)
```
┌─────────────────┐      stdio       ┌──────────────────────┐
│  Claude Desktop │ ◄──► │  photos-api MCP    │
│  / Cursor       │        │  (Node.js/TS)      │
└─────────────────┘        └──────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
        ┌──────────────────┐      ┌──────────────────────┐
        │  photos-api      │      │  Cloudflare D1       │
        │  (HTTP/REST)     │      │  (wrangler d1 exec)  │
        └──────────────────┘      └──────────────────────┘
                    │                           │
                    ▼                           ▼
        ┌──────────────────┐      ┌──────────────────────┐
        │  R2 / Images     │      │  Cloudflare          │
        │  (image storage) │      │  Workers AI          │
        └──────────────────┘      └──────────────────────┘
                                               │
                                               ▼
                                  ┌──────────────────────┐
                                  │  Kimi / fallback LLM │
                                  └──────────────────────┘
```

- **Transport**: `stdio` (standard for Claude Desktop / Cursor)
- **Location**: `mcp-server/` directory, separate from the worker
- **Runtime**: Node.js + TypeScript (not a Cloudflare Worker)
- **Dual data access**:
  - **HTTP API** for image transforms, uploads, admin routes, and read-only public data
  - **Direct D1 access** via Wrangler CLI (`wrangler d1 execute`) for search queries, batch updates, backfills, and anything that needs FTS or complex SQL
- **AI calls**: Cloudflare Workers AI REST API (primary), Kimi API (fallback for reasoning tasks)

### Phase 2: Deployed MCP Gateway (Future)
- A **second Cloudflare Worker** (`mcp-gateway`) exposing MCP over HTTP/SSE
- Reuses the same tool logic but runs at the edge
- Enables AI prompts from kylies.photos without local MCP installation
- Auth: Cloudflare Access JWT (same as admin API)

### Why Not a Single Worker?
- MCP over `stdio` requires a persistent local process (not a request/response worker)
- Even for SSE transport, MCP statefulness is awkward inside the existing monolithic worker
- Separating concerns keeps the photos-api worker lean and the MCP logic testable locally

## 3. Database Additions

To support AI features, we need new columns on the `photos` table and a new table for EXIF data.

### Migration 0003: AI Captions & Search (`migrations/0003_ai_captions.sql`)

```sql
-- AI-generated searchable content
ALTER TABLE photos ADD COLUMN ai_caption TEXT;          -- Vision model description
ALTER TABLE photos ADD COLUMN ai_keywords TEXT;         -- JSON array of extracted keywords
ALTER TABLE photos ADD COLUMN ai_quality_score REAL;    -- 0.0–1.0 composite score
ALTER TABLE photos ADD COLUMN ai_processed_at TEXT;     -- ISO timestamp of last AI analysis

CREATE INDEX idx_photos_ai_caption ON photos(ai_caption);
CREATE VIRTUAL TABLE photos_fts USING fts5(
  id UNINDEXED,
  title,
  caption,
  location,
  ai_caption,
  ai_keywords
);  -- Full-text search over metadata + AI content
```

**Note on `camera` column:** The `camera` field (denormalized make/model, e.g. `"Sony ILCE-7RM4"`) already exists in the deployed D1 for 337 older photos but was added outside of migrations. It is intentionally omitted from this migration. If applying to a fresh database, add it manually:
```sql
ALTER TABLE photos ADD COLUMN camera TEXT;
CREATE INDEX idx_photos_camera ON photos(camera);
```
For existing databases, preserve the 337 camera values and backfill the rest from EXIF data via the `extract_exif` tool/script.

**Note on FTS5:** D1 SQLite includes FTS5 (`sqlite_compileoption_used('ENABLE_FTS5')` returns `1` in local testing). However, FTS5 virtual tables cannot be created inside conditional blocks. If this migration fails on a D1 instance without FTS5, apply the fallback:
```sql
-- Fallback if FTS5 is unavailable:
ALTER TABLE photos ADD COLUMN search_text TEXT;
CREATE INDEX idx_photos_search_text ON photos(search_text);
-- Populate via: UPDATE photos SET search_text = COALESCE(title,'') || ' ' || COALESCE(caption,'') || ' ' || COALESCE(location,'');
```

**Note on `caption` column:** Like `camera`, `caption` exists in the deployed D1 but was not added via any migration file. This is pre-existing schema drift. The `0003` migration assumes `caption` already exists (it's referenced in the `photos_fts` trigger). If applying to a fresh database, ensure `caption` is present before running this migration:
```sql
ALTER TABLE photos ADD COLUMN caption TEXT;
```

### Migration 0004: EXIF Data (`migrations/0004_exif.sql`)

```sql
-- Extracted EXIF metadata (populated on upload or backfilled via script)
CREATE TABLE photo_exif (
  photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  make TEXT,                    -- e.g. "SONY", "Apple"
  model TEXT,                   -- e.g. "ILCE-7RM4", "iPhone15,2"
  lens_model TEXT,              -- e.g. "FE 24-70mm F2.8 GM"
  focal_length REAL,            -- mm
  aperture REAL,                -- f-number
  shutter_speed REAL,           -- denominator (e.g. 125 = 1/125s)
  iso INTEGER,
  exposure_compensation TEXT,
  date_taken TEXT,              -- EXIF DateTimeOriginal
  gps_latitude REAL,
  gps_longitude REAL,
  gps_altitude REAL,
  software TEXT,                -- Post-processing software
  orientation INTEGER,
  color_space TEXT,
  extracted_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_exif_make ON photo_exif(make);
CREATE INDEX idx_exif_model ON photo_exif(model);
CREATE INDEX idx_exif_iso ON photo_exif(iso);
```

**What to Persist vs. Compute On-Demand:**
| Data | Persist? | Rationale |
|------|----------|-----------|
| Make/Model | ✅ Yes | Fast filtering ("show me iPhone photos"). Static. Denormalized to `photos.camera`. |
| ISO/Aperture/Shutter | ✅ Yes | Enables quality scoring queries. Static. |
| GPS | ✅ Yes | Location clustering, map integration. Static. |
| Full EXIF blob | ❌ No | R2 original always available if needed. |
| AI Caption | ✅ Yes | Expensive to generate (~1-3s per photo). Reusable. |
| AI Keywords | ✅ Yes | Derived from caption, but pre-computed for search. |
| Quality Score | ✅ Yes | Composite metric, expensive to recompute. |

## 4. AI Strategy

### Primary: Cloudflare Workers AI

Use the [Workers AI REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/) from the local MCP server.

**Models:**
| Task | Model | Notes |
|------|-------|-------|
| Image Captioning | `@cf/llava-hf/llava-1.5-7b-hf` | Vision-language model. Input: image bytes + prompt "Describe this photo in detail." |
| Keyword Extraction | `@cf/meta/llama-3.1-8b-instruct` | Text model. Input: caption → output JSON keywords array. |
| Quality Scoring | `@cf/llava-hf/llava-1.5-7b-hf` | Prompt: "Rate this photo's technical quality (sharpness, exposure, composition) from 0-10." |
| Metadata Cleanup | `@cf/meta/llama-3.1-8b-instruct` | Prompt: "Suggest a better title and normalized tags for this photo." |

**API Pattern:**
```typescript
// workers-ai.ts
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

async function captionImage(imageBuffer: ArrayBuffer): Promise<string> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/llava-hf/llava-1.5-7b-hf`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: [
            { type: "text", text: "Describe this photo in detail. Include the subject, setting, lighting, mood, and any notable elements." },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${bufferToBase64(imageBuffer)}` } }
          ]}
        ]
      })
    }
  );
  const json = await res.json();
  return json.result.response; // text caption
}
```

### Fallback: Kimi (Moonshot AI)

For tasks requiring deeper reasoning (e.g., "Compare these two photos and suggest which to keep for deduplication"), use Kimi API (`kimi.moonshot.cn`).

```typescript
async function kimiChat(systemPrompt: string, userPrompt: string): Promise<string> {
  const res = await fetch("https://api.moonshot.cn/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.KIMI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "kimi-latest",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });
  // ... parse
}
```

### Cost & Caching Strategy

- **Caption generation**: ~$0.001–$0.005 per image on Workers AI. For 573 photos: ~$2–$3 one-time.
- **Cache**: Store `ai_caption`, `ai_keywords`, `ai_quality_score` in D1. Only regenerate on explicit request.
- **Batch processing**: Provide a script (`scripts/backfill-ai.ts`) to process all existing photos overnight.

## 5. REST API Enhancements (Also Available via HTTP)

Several MCP features are also exposed as public REST endpoints so external sites (kylies.photos, kylieis.online) can use them without an MCP server.

| Endpoint | Status | MCP Tool |
|----------|--------|----------|
| `GET /api/photos?q=&site=` | **New** | `search_photos` |
| `GET /api/photos/random?site=&tag=` | **New** | `get_random_photo` |
| `GET /api/photos/{id}?include=exif,ai` | **Enhanced** | `get_photo` |

**MCP-only features** (not exposed via public REST):
- `ai_caption` — AI generation is expensive (~1-3s per image, API cost). Admin-only.
- `cleanup_metadata` — Admin tool for bulk metadata rewriting.
- `deduplicate` — Admin/scaffolding tool.
- `evaluate_quality` — Backfill tool for scoring.
- `extract_exif` — Backfill script for populating `photo_exif`.

This split keeps the public REST API fast and cheap while the MCP server handles orchestration of expensive AI operations.

## 6. MCP Tool Definitions

### Core Tools (Wrap Existing API)

```typescript
// tools/search.ts
const searchPhotosSchema = z.object({
  query: z.string().describe("Natural language search query (e.g. 'sunset at the beach', 'iPhone photos from 2024')"),
  site: z.enum(["climb-log", "kylieis-online", "both"]).optional(),
  limit: z.number().max(50).default(20),
  offset: z.number().default(0),
});

async function searchPhotos({ query, site, limit, offset }) {
  // 1. If query looks like metadata search, query D1 FTS
  // 2. If query is vague, use AI to expand to keywords, then query D1
  // 3. Return photo metadata + thumbnail URLs
}
```

```typescript
// tools/random.ts
const randomPhotoSchema = z.object({
  site: z.enum(["climb-log", "kylieis-online", "both"]).optional(),
  tag: z.string().optional(),
  minQualityScore: z.number().min(0).max(1).optional(),
});

async function getRandomPhoto({ site, tag, minQualityScore }) {
  // SQL: SELECT * FROM photos WHERE exclude = 0 ... ORDER BY RANDOM() LIMIT 1
}
```

```typescript
// tools/get-photo.ts
const getPhotoSchema = z.object({
  id: z.string().describe("Photo ID"),
  includeExif: z.boolean().default(false),
  includeAiAnalysis: z.boolean().default(false),
});
```

```typescript
// tools/update-photo.ts
const updatePhotoSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  caption: z.string().optional(),
  location: z.string().optional(),
  date: z.string().optional(),
  tags: z.array(z.string()).optional(),
  site: z.enum(["climb-log", "kylieis-online", "both"]).optional(),
  exclude: z.boolean().optional(),
});
```

### AI-Powered Tools

```typescript
// tools/ai-caption.ts
const aiCaptionSchema = z.object({
  photoId: z.string(),
  regenerate: z.boolean().default(false), // Force regeneration even if cached
});

async function aiCaption({ photoId, regenerate }) {
  // 1. Check D1 for existing ai_caption (unless regenerate)
  // 2. Download original from R2 (via /img/{id} or direct R2 call)
  // 3. Call Workers AI vision model
  // 4. Store result in D1
  // 5. Return caption
}
```

```typescript
// tools/deduplicate.ts
const deduplicateSchema = z.object({
  threshold: z.enum(["strict", "loose", "ai"]).default("ai"),
  site: z.string().optional(),
  dryRun: z.boolean().default(true), // If true, return candidates without deleting
});

async function deduplicate({ threshold, site, dryRun }) {
  // "strict": Exact match on r2_key or flickr_id
  // "loose": Fuzzy match on title + date + location
  // "ai": Download candidate pairs, ask vision model "Are these the same photo?"
  // Return groups of duplicates with confidence scores
}
```

```typescript
// tools/cleanup-metadata.ts
const cleanupSchema = z.object({
  photoId: z.string().optional(),     // If omitted, scan all photos
  batchSize: z.number().default(50),
  dryRun: z.boolean().default(true),
});

async function cleanupMetadata({ photoId, batchSize, dryRun }) {
  // 1. Fetch photo(s) metadata
  // 2. For each, call LLM with prompt:
  //    "Here is a photo: title='{title}', tags={tags}, caption='{caption}'.
  //     Suggest: normalized title, cleaned tags, improved caption, corrected location."
  // 3. If not dryRun, PATCH /api/admin/photos/{id} with changes
  // 4. Return before/after diff
}
```

```typescript
// tools/evaluate-quality.ts
const evaluateQualitySchema = z.object({
  photoId: z.string().optional(),
  batchSize: z.number().default(50),
  criteria: z.array(z.enum(["technical", "composition", "camera"])).default(["technical", "composition"]),
});

async function evaluateQuality({ photoId, batchSize, criteria }) {
  // 1. Fetch EXIF data (camera, lens, ISO, aperture, shutter)
  // 2. Compute technical score:
  //    - High ISO (>3200) → penalty
  //    - Very slow shutter (<1/60) without tripod → penalty
  //    - Underexposed/overexposed → penalty
  // 3. If "composition" in criteria: download image, call vision model for aesthetic scoring
  // 4. If "camera" in criteria: just return make/model
  // 5. Store ai_quality_score in D1
  // 6. Return structured report
}
```

```typescript
// tools/exif-extract.ts
const extractExifSchema = z.object({
  photoId: z.string().optional(), // Omit to backfill all
  overwrite: z.boolean().default(false),
});

async function extractExif({ photoId, overwrite }) {
  // 1. Download original from R2
  // 2. Parse EXIF using `exifreader` or `sharp` (Node.js library in MCP server)
  // 3. Upsert into photo_exif table via API or direct D1 call
  // 4. Return extracted fields
}
```

## 6. MCP Resources

Expose read-only photo data as MCP Resources for direct context injection:

| URI Pattern | Description |
|-------------|-------------|
| `photo://{id}` | Single photo metadata (JSON) |
| `photo://{id}/image` | Image URL for the original |
| `photo://{id}/exif` | EXIF data if available |
| `photos://list?site=&limit=` | Paginated photo list |
| `search://{query}` | Search results as a resource |

## 7. Auth Strategy

### Local Development
```bash
# .env in mcp-server/
PHOTOS_API_URL=https://photos-api.kylieski.workers.dev
CF_ACCESS_TOKEN=<Cloudflare Access JWT from browser cookie>
CLOUDFLARE_ACCOUNT_ID=...
CF_API_TOKEN=...
KIMI_API_KEY=...  # Optional fallback
```

The MCP server passes `Cf-Access-Jwt-Assertion` header on all admin API calls.

### Future Deployed Mode
The `mcp-gateway` worker will:
- Validate Cloudflare Access JWT at the edge
- Run the same tool logic inside a Worker using the MCP SDK's HTTP transport
- This enables Claude Desktop or custom web clients to connect remotely

## 8. Project Structure

```
photos-api/
├── src/
│   └── index.tsx                 # Existing worker (unchanged for Phase 1)
├── mcp-server/
│   ├── src/
│   │   ├── index.ts              # MCP server entry (stdio transport)
│   │   ├── tools/
│   │   │   ├── search.ts
│   │   │   ├── random.ts
│   │   │   ├── get-photo.ts
│   │   │   ├── update-photo.ts
│   │   │   ├── ai-caption.ts
│   │   │   ├── deduplicate.ts
│   │   │   ├── cleanup-metadata.ts
│   │   │   ├── evaluate-quality.ts
│   │   │   └── extract-exif.ts
│   │   ├── ai/
│   │   │   ├── workers-ai.ts     # Cloudflare Workers AI client
│   │   │   └── kimi.ts           # Kimi fallback client
│   │   ├── api-client.ts         # HTTP client for photos-api
│   │   └── types.ts              # Shared TypeScript types
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
├── migrations/
│   ├── 0003_ai_captions.sql      # New: AI columns + FTS
│   └── 0004_exif.sql             # New: EXIF table
├── scripts/
│   └── backfill-ai.ts            # Batch process all photos for captions
├── mcp-gateway/                  # Phase 2: deployed worker
│   └── (to be planned)
└── MCP-PLAN.md                   # This file
```

## 9. Implementation Phases

### Phase 1: Foundation (Week 1)
1. **Scaffold `mcp-server/`**
   - `npm init`, install `@modelcontextprotocol/sdk`, `zod`, `typescript`
   - Set up `stdio` transport with a hello-world tool
2. **Add DB migrations**
   - Create `migrations/0003_ai_captions.sql`
   - Create `migrations/0004_exif.sql`
   - Apply locally and remotely
3. **Build core API wrapper tools**
   - `search_photos` (metadata search)
   - `get_random_photo`
   - `get_photo` (with optional EXIF/AI joins)
   - `update_photo`

### Phase 2: AI Features (Week 2)
4. **Workers AI integration**
   - Implement `captionImage()` helper
   - Implement `extractKeywords()` helper
   - Test on 5–10 photos locally
5. **Build `ai_caption` tool**
   - Fetch image → caption → store in D1 → return
6. **Build `evaluate_quality` tool**
   - EXIF read + vision model scoring
   - Store `ai_quality_score`

### Phase 3: Batch & Cleanup (Week 3)
7. **EXIF extraction script**
   - Node.js script using `exifreader`
   - Backfill all 573 photos
8. **AI backfill script**
   - Batch caption all photos via `scripts/backfill-ai.ts`
   - Rate-limited to avoid API quotas
9. **Build `cleanup_metadata` tool**
   - LLM-driven title/tag/caption improvement
   - Dry-run mode by default
10. **Build `deduplicate` tool**
    - SQL-based candidate finding + AI confirmation

### Phase 4: Polish & Deploy (Week 4+)
11. **Full-text search**
    - Populate `photos_fts` with existing + AI content
    - Update `search_photos` to use FTS when available
12. **MCP Resource exposure**
    - Photo metadata as `photo://{id}` resources
13. **Deployed gateway**
    - Scaffold `mcp-gateway/` worker
    - SSE transport over HTTP
    - Cloudflare Access auth
    - Integration with kylies.photos

## 10. Technology Choices

| Layer | Choice | Rationale |
|-------|--------|-----------|
| MCP SDK | `@modelcontextprotocol/sdk` (Node.js) | Official SDK, handles stdio/SSE transport |
| HTTP Client | Native `fetch` | Zero deps, works everywhere |
| Schema Validation | `zod` | Type-safe, great for MCP tool schemas |
| EXIF Parsing | `exifreader` (Node.js) | Pure JS, no native deps, comprehensive |
| Image Processing | `sharp` (scripts only) | Already in repo, good for thumbnails if needed |
| AI (Primary) | Cloudflare Workers AI REST API | Same infra, low latency, no egress cost |
| AI (Fallback) | Kimi (Moonshot) | Better reasoning, Chinese/English bilingual |
| FTS | SQLite FTS5 (D1) | Native to D1, no extra service |

## 11. Risk & Mitigation

| Risk | Mitigation |
|------|------------|
| Workers AI vision model is slow (3-5s) | Batch process offline; MCP tool reads cached D1 results |
| D1 FTS5 not supported | Fall back to `LIKE` queries on concatenated text column |
| Kimi API unavailable | Graceful degradation; skip reasoning-heavy features |
| EXIF missing from migrated photos | Many Flickr exports strip EXIF. Document coverage %; don't block on it. |
| MCP SDK changes | Pin version; wrap transport setup in abstraction |

## 12. Open Questions

1. **D1 FTS5 support**: Verify `wrangler d1` SQLite build includes FTS5. If not, use a `search_text` denormalized column with `LIKE '%term%'`.
2. **Workers AI image format**: Confirm `llava-1.5-7b-hf` accepts base64 JPEG/PNG/WebP.
3. **Kimi vision**: If Kimi supports image input, we can use it for captioning too (higher quality, higher cost).
4. **Rate limits**: Workers AI has per-account rate limits. Batch script needs exponential backoff.
5. **Cost ceiling**: Set a hard limit on AI processing (e.g., $20 for initial backfill).

---

*Next step: Scaffold `mcp-server/` and create the first tool (`get_random_photo`).*
