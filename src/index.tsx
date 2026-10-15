/**
 * photos-api - Shared photo storage for kylies.photos and kylieis.online
 *
 * Public Endpoints:
 *   GET /img/{photo-id}?w={width}  - Serve photo with optional resize
 *   GET /api/photos                - List photos (with filters)
 *   GET /api/photos/{id}           - Get single photo metadata
 *   GET /docs                      - Swagger UI
 *   GET /openapi.json              - OpenAPI spec
 *
 * Admin Endpoints:
 *   GET /admin                     - Photo grid
 *   GET /admin/photos/{id}         - Photo detail view
 *   PATCH /api/admin/photos/{id}   - Edit photo metadata
 *   DELETE /api/admin/photos/{id}  - Validate deletion eligibility; never deletes directly
 *   POST /api/admin/resize         - Custom resize
 *   POST /api/admin/upload         - Upload new photo
 */

import { Hono, type Context, type Next } from "hono";
import type { FC } from "hono/jsx";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { dateInputValue, profilePhoto, type PhotoProfile, UPLOAD_TYPES } from "./photo-metadata";
import { matchExistingLocation } from "./location-matcher";

// Supported widths for public image transforms
const ALLOWED_WIDTHS = new Set([200, 400, 800, 1600]);
const MAX_CUSTOM_WIDTH = 2048;

// In-flight transform tracking to prevent duplicate work
const inFlightTransforms = new Map<string, Promise<R2ObjectBody | null>>();

interface Photo {
  id: string;
  notion_id: string | null;
  r2_key: string;
  title: string | null;
  caption: string | null;
  location: string | null;
  date: string | null;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  format: string;
  size_bytes: number | null;
  site: string;
  source: string | null;
  tags: string | null;
  exclude: number;
  status: "active" | "quarantined";
  visibility: "public" | "unlisted" | "private";
  flickr_id: string | null;
  accent_color: string | null;
  source_url: string | null;
  sha256: string | null;
  created_at: string;
  updated_at: string;
}

function tagsForInput(tags: string | null): string {
  if (!tags) return "";
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.join(", ") : tags;
  } catch {
    return tags;
  }
}

async function locationFromExistingPhotos(db: D1Database, profile: PhotoProfile | null): Promise<string | null> {
  if (profile?.latitude == null || profile.longitude == null) return null;
  const result = await db.prepare(`
    SELECT p.location, e.gps_latitude, e.gps_longitude
    FROM photo_exif e
    JOIN photos p ON p.id = e.photo_id
    WHERE p.location IS NOT NULL
      AND e.gps_latitude IS NOT NULL
      AND e.gps_longitude IS NOT NULL
    LIMIT 2000
  `).all<{ location: string; gps_latitude: number; gps_longitude: number }>();
  return matchExistingLocation(
    profile.latitude,
    profile.longitude,
    result.results.map((row) => ({
      location: row.location,
      latitude: row.gps_latitude,
      longitude: row.gps_longitude,
    }))
  )?.location || null;
}

// ============ ADMIN LAYOUT & COMPONENTS ============

const AdminLayout: FC<{ title: string; children: any }> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>{title} | photos-api admin</title>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet" />
      <style dangerouslySetInnerHTML={{ __html: `
        *, *::before, *::after { box-sizing: border-box; }
        
        :root {
          --color-bg: #fafafa;
          --color-bg-card: #ffffff;
          --color-text: #1a1a1a;
          --color-text-muted: #666666;
          --color-accent: #e23500;
          --color-accent-light: rgba(226, 53, 0, 0.1);
          --color-orange: #ffbc2d;
          --gradient: linear-gradient(135deg, var(--color-accent) 0%, var(--color-orange) 100%);
          --space-xs: 0.25rem;
          --space-sm: 0.5rem;
          --space-md: 1rem;
          --space-lg: 1.5rem;
          --space-xl: 2rem;
          --space-2xl: 3rem;
          --radius-sm: 0.375rem;
          --radius-md: 0.5rem;
          --radius-lg: 0.75rem;
          --radius-xl: 1rem;
          --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
          --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.07);
          --shadow-lg: 0 10px 25px rgba(0, 0, 0, 0.1);
          --font-body: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          --font-mono: 'Fira Code', monospace;
          --max-width: 1400px;
        }
        
        body {
          margin: 0;
          padding: 0;
          font-family: var(--font-body);
          background: var(--color-bg);
          color: var(--color-text);
          line-height: 1.6;
          min-height: 100vh;
        }
        
        /* Header */
        .admin-header {
          background: var(--gradient);
          padding: var(--space-md) var(--space-xl);
          position: sticky;
          top: 0;
          z-index: 100;
          box-shadow: var(--shadow-md);
        }
        .admin-header-inner {
          max-width: var(--max-width);
          margin: 0 auto;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .admin-header a {
          color: white;
          text-decoration: none;
          font-weight: 600;
          font-size: 1.1rem;
        }
        .admin-header nav {
          display: flex;
          gap: var(--space-lg);
        }
        .admin-header nav a {
          font-weight: 500;
          font-size: 0.9rem;
          opacity: 0.9;
          transition: opacity 0.2s;
        }
        .admin-header nav a:hover { opacity: 1; }
        
        /* Main content */
        .admin-main {
          max-width: var(--max-width);
          margin: 0 auto;
          padding: var(--space-xl);
        }
        
        /* Page title */
        .page-title {
          margin-bottom: var(--space-xl);
        }
        .page-title h1 {
          font-size: 1.75rem;
          font-weight: 700;
          margin: 0 0 var(--space-sm);
        }
        .page-title p {
          color: var(--color-text-muted);
          margin: 0;
          font-size: 0.95rem;
        }
        
        /* Photo grid */
        .photo-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: var(--space-lg);
        }
        
        .photo-card {
          background: var(--color-bg-card);
          border-radius: var(--radius-lg);
          overflow: hidden;
          box-shadow: var(--shadow-sm);
          transition: box-shadow 0.2s, transform 0.2s;
          border-left: 3px solid transparent;
          cursor: pointer;
          text-decoration: none;
          color: inherit;
          display: block;
        }
        .photo-card:hover {
          box-shadow: var(--shadow-lg);
          transform: translateY(-2px);
          border-left-color: var(--color-accent);
        }
        .photo-card img {
          width: 100%;
          height: 160px;
          object-fit: cover;
          display: block;
        }
        .photo-card-info {
          padding: var(--space-sm) var(--space-md);
        }
        .photo-card-title {
          font-weight: 600;
          font-size: 0.9rem;
          margin: 0 0 var(--space-xs);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .photo-card-meta {
          font-size: 0.75rem;
          color: var(--color-text-muted);
          font-family: var(--font-mono);
        }
        .photo-card-tags {
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-xs);
          margin-top: var(--space-sm);
        }
        .photo-card-actions {
          display: flex;
          gap: var(--space-sm);
          padding: 0 var(--space-md) var(--space-md);
        }
        .photo-card-actions a, .photo-card-actions button {
          flex: 1;
          min-height: 36px;
          border-radius: var(--radius-sm);
          border: 1px solid #ddd;
          background: white;
          color: var(--color-text);
          font: inherit;
          font-size: 0.75rem;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          text-decoration: none;
        }
        .photo-card-actions button { color: #b91c1c; border-color: #fecaca; }
        .tag {
          display: inline-block;
          background: var(--color-accent-light);
          color: var(--color-accent);
          padding: 0.125em 0.5em;
          border-radius: var(--radius-sm);
          font-size: 0.7rem;
          font-weight: 500;
          font-family: var(--font-mono);
        }
        
        /* Pagination */
        .pagination {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: var(--space-lg);
          margin-top: var(--space-2xl);
          padding: var(--space-lg) 0;
        }
        .pagination a, .pagination span {
          padding: var(--space-sm) var(--space-md);
          border-radius: var(--radius-md);
          text-decoration: none;
          font-size: 0.9rem;
        }
        .pagination a {
          background: var(--color-bg-card);
          color: var(--color-accent);
          box-shadow: var(--shadow-sm);
          border: 1px solid var(--color-accent-light);
        }
        .pagination a:hover {
          background: var(--color-accent-light);
        }
        .pagination span {
          color: var(--color-text-muted);
        }
        
        /* Detail view */
        .detail-layout {
          display: grid;
          grid-template-columns: 1fr 380px;
          gap: var(--space-2xl);
          align-items: start;
        }
        @media (max-width: 900px) {
          .detail-layout { grid-template-columns: 1fr; }
        }
        
        .detail-image {
          background: var(--color-bg-card);
          border-radius: var(--radius-lg);
          overflow: hidden;
          box-shadow: var(--shadow-md);
        }
        .detail-image img {
          width: 100%;
          display: block;
        }
        
        .detail-sidebar {
          position: sticky;
          top: 80px;
        }
        .detail-panel {
          background: var(--color-bg-card);
          border-radius: var(--radius-lg);
          padding: var(--space-lg);
          box-shadow: var(--shadow-sm);
          margin-bottom: var(--space-lg);
        }
        .detail-panel h2 {
          font-size: 1.1rem;
          margin: 0 0 var(--space-md);
          font-weight: 600;
        }
        
        .meta-table {
          width: 100%;
          border-collapse: collapse;
        }
        .meta-table td {
          padding: var(--space-sm) 0;
          border-bottom: 1px solid rgba(0,0,0,0.05);
          font-size: 0.85rem;
        }
        .meta-table td:first-child {
          color: var(--color-text-muted);
          font-family: var(--font-mono);
          width: 120px;
        }
        .meta-table td:last-child {
          text-align: right;
          word-break: break-all;
        }
        .meta-table tr:last-child td { border-bottom: none; }
        
        /* Sizes section */
        .sizes-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: var(--space-md);
        }
        .size-item {
          text-align: center;
        }
        .size-item img {
          width: 100%;
          border-radius: var(--radius-sm);
          margin-bottom: var(--space-sm);
        }
        .size-item code {
          font-family: var(--font-mono);
          font-size: 0.75rem;
          background: var(--color-accent-light);
          color: var(--color-accent);
          padding: 0.2em 0.5em;
          border-radius: var(--radius-sm);
        }
        .size-item button {
          margin-top: var(--space-xs);
          background: transparent;
          border: 1px solid var(--color-accent-light);
          color: var(--color-accent);
          padding: var(--space-xs) var(--space-sm);
          border-radius: var(--radius-sm);
          font-size: 0.75rem;
          cursor: pointer;
          font-family: var(--font-body);
        }
        .size-item button:hover {
          background: var(--color-accent-light);
        }
        
        /* Footer */
        .admin-footer {
          background: var(--gradient);
          padding: var(--space-lg) var(--space-xl);
          margin-top: auto;
          text-align: center;
        }
        .admin-footer a {
          color: white;
          text-decoration: none;
          font-weight: 500;
          font-size: 0.85rem;
          opacity: 0.9;
        }
        
        /* Utility */
        .back-link {
          display: inline-flex;
          align-items: center;
          gap: var(--space-sm);
          color: var(--color-accent);
          text-decoration: none;
          font-weight: 500;
          margin-bottom: var(--space-lg);
          font-size: 0.9rem;
        }
        .back-link:hover { text-decoration: underline; }
        
        .empty-state {
          text-align: center;
          padding: var(--space-3xl) var(--space-xl);
          color: var(--color-text-muted);
        }
        .empty-state h2 {
          margin: 0 0 var(--space-sm);
          color: var(--color-text);
        }

        .upload-panel {
          max-width: 720px;
          background: var(--color-bg-card);
          border-radius: var(--radius-xl);
          padding: var(--space-xl);
          box-shadow: var(--shadow-sm);
        }
        .upload-field { margin-bottom: var(--space-lg); }
        .upload-field label {
          display: block;
          margin-bottom: var(--space-xs);
          font-weight: 600;
          font-size: 0.85rem;
        }
        .upload-field input, .upload-field select {
          width: 100%;
          min-height: 46px;
          padding: 0.75rem;
          border: 1px solid #ddd;
          border-radius: var(--radius-md);
          background: white;
          font: inherit;
        }
        .upload-field input[type="file"] {
          min-height: 120px;
          padding: var(--space-lg);
          border: 2px dashed #ccc;
          background: #fafafa;
        }
        .upload-help { color: var(--color-text-muted); font-size: 0.8rem; margin-top: var(--space-xs); }
        .upload-submit {
          width: 100%;
          min-height: 50px;
          border: 0;
          border-radius: var(--radius-md);
          background: var(--gradient);
          color: white;
          font: inherit;
          font-weight: 700;
          cursor: pointer;
        }
        .upload-submit:disabled { opacity: 0.55; cursor: wait; }
        .upload-queue { margin-top: var(--space-lg); display: grid; gap: var(--space-sm); }
        .upload-item {
          padding: 0.75rem;
          border-radius: var(--radius-md);
          background: var(--color-bg);
          font-size: 0.85rem;
        }
        .upload-item.success { border-left: 3px solid #16a34a; }
        .upload-item.error { border-left: 3px solid #dc2626; }
        .edit-form { display: grid; gap: var(--space-md); }
        .edit-form label { display: grid; gap: var(--space-xs); font-size: 0.75rem; font-weight: 600; color: var(--color-text-muted); }
        .edit-form input, .edit-form select, .edit-form textarea {
          width: 100%;
          padding: 0.65rem;
          border: 1px solid #ddd;
          border-radius: var(--radius-md);
          background: white;
          color: var(--color-text);
          font: inherit;
        }
        .edit-form textarea { min-height: 84px; resize: vertical; }
        .edit-row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-sm); }
        .edit-checkbox { display: flex !important; grid-template-columns: auto 1fr; align-items: center; }
        .edit-checkbox input { width: auto; }
        .edit-submit { border: 0; border-radius: var(--radius-md); padding: 0.75rem; background: var(--gradient); color: white; font-weight: 700; cursor: pointer; }
        .edit-status { min-height: 1.25rem; font-size: 0.8rem; color: var(--color-text-muted); }
        .exif-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-sm); font-size: 0.8rem; }
        .exif-grid div { padding: var(--space-sm); background: var(--color-bg); border-radius: var(--radius-sm); }
        .exif-grid strong { display: block; color: var(--color-text-muted); font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em; }
        @media (max-width: 600px) {
          .admin-main { padding: var(--space-md); }
          .upload-panel { padding: var(--space-lg); }
          .admin-header { padding: 0.75rem var(--space-md); }
          .admin-header nav { gap: var(--space-md); }
          .edit-row, .exif-grid { grid-template-columns: 1fr; }
        }
      `}} />
    </head>
    <body>
      <header class="admin-header">
        <div class="admin-header-inner">
          <a href="/admin">photos-api admin</a>
          <nav>
            <a href="/admin">grid</a>
            <a href="/admin/upload">upload</a>
            <a href="/docs">api docs</a>
          </nav>
        </div>
      </header>
      <main class="admin-main">
        {children}
      </main>
      <footer class="admin-footer">
        <a href="https://kylieis.online" target="_blank">kylieis.online</a>
      </footer>
    </body>
  </html>
);

// ============ JWT VALIDATION ============

type AppEnv = Env & {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
};

const accessJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function verifyAccessJWT(request: Request, env: AppEnv): Promise<boolean> {
  const cookieJwt = request.headers.get("Cookie")
    ?.split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith("CF_Authorization="))
    ?.slice("CF_Authorization=".length);
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion") || cookieJwt;
  if (!jwt || !env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) return false;

  try {
    const configuredDomain = env.CF_ACCESS_TEAM_DOMAIN.replace(/\/$/, "");
    const issuer = configuredDomain.startsWith("https://")
      ? new URL(configuredDomain).origin
      : `https://${configuredDomain}`;
    let jwks = accessJwks.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      accessJwks.set(issuer, jwks);
    }
    await jwtVerify(jwt, jwks, { issuer, audience: env.CF_ACCESS_AUD });
    return true;
  } catch {
    return false;
  }
}

// ============ APP SETUP ============

const app = new Hono<{ Bindings: AppEnv }>();

async function resolvePhoto(
  db: D1Database,
  identifier: string
): Promise<Photo | null> {
  const canonical = await db.prepare(`
    SELECT * FROM photos
    WHERE id = ? AND status = 'active' AND visibility IN ('public', 'unlisted')
  `).bind(identifier).first<Photo>();
  if (canonical) return canonical;

  return db.prepare(`
    SELECT p.* FROM photos p
    JOIN photo_aliases a ON a.photo_id = p.id
    WHERE a.alias = ? AND p.status = 'active' AND p.visibility IN ('public', 'unlisted')
    LIMIT 1
  `).bind(identifier).first<Photo>();
}

async function isPhotoActive(db: D1Database, photoId: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT 1 AS active FROM photos WHERE id = ? AND status = 'active'"
  ).bind(photoId).first<{ active: number }>();
  return row?.active === 1;
}

// CORS for public API routes (excludes admin)
app.use("/api/*", async (c, next) => {
  // Skip wildcard CORS for admin routes - they get restricted CORS below
  if (c.req.path.startsWith("/api/admin")) {
    return next();
  }
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  if (c.req.method === "OPTIONS") return c.body(null);
  await next();
});

const requireAccess = async (c: Context<{ Bindings: AppEnv }>, next: Next) => {
  if (!(await verifyAccessJWT(c.req.raw, c.env))) {
    return c.json({ error: "Unauthorized" }, 403);
  }
  await next();
};

// Access protects /admin/* but not the exact /admin path. Enter through the
// protected trailing-slash route so first-time visitors receive a login flow.
app.get("/admin", (c) => c.redirect("/admin/", 302));
app.use("/admin", requireAccess);
app.use("/admin/*", requireAccess);

// Admin API routes require JWT validation with restricted CORS
app.use("/api/admin/*", async (c, next) => {
  // Restricted CORS for admin API - no cross-origin access
  c.header("Access-Control-Allow-Origin", "null");
  c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Cf-Access-Jwt-Assertion");
  if (c.req.method === "OPTIONS") return c.body(null);

  const origin = c.req.header("Origin");
  if (origin && origin !== new URL(c.req.url).origin) {
    return c.json({ error: "Cross-origin admin request denied" }, 403);
  }

  return requireAccess(c, next);
});

// ============ PUBLIC API ROUTES (existing) ============

// GET /docs - Swagger UI
app.get("/docs", (c) => {
  const url = new URL(c.req.url);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>photos-api | Documentation</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <style>body { margin: 0; padding: 0; } .swagger-ui .topbar { display: none; } .swagger-ui .info { margin: 20px 0; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({
        url: '${url.origin}/openapi.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
        layout: 'BaseLayout',
        defaultModelsExpandDepth: 1,
        docExpansion: 'list',
      });
    };
  </script>
</body>
</html>`;
  return c.html(html);
});

// GET /openapi.json - OpenAPI spec
app.get("/openapi.json", (c) => {
  const url = new URL(c.req.url);
  return c.json(getOpenApiSpec(url.origin));
});

// GET /img/{photo-id}
app.get("/img/:photoId", async (c) => {
  const photoId = c.req.param("photoId");
  const requestedWidth = c.req.query("w");
  const env = c.env;
  const ctx = c.executionCtx;

  if (!photoId) return c.text("Missing photo ID", 400);

  const photo = await resolvePhoto(env.DB, photoId);

  if (!photo) return c.text("Photo not found", 404);

  let r2Key: string;
  let width: number | null = null;

  if (requestedWidth && requestedWidth !== "original") {
    width = parseInt(requestedWidth, 10);
    if (!ALLOWED_WIDTHS.has(width)) {
      return c.text(
        `Invalid width. Allowed: ${Array.from(ALLOWED_WIDTHS).join(", ")}, original`,
        400
      );
    }
    r2Key = `${photo.r2_key}/w${width}.webp`;
  } else {
    r2Key = `${photo.r2_key}/original.${photo.format}`;
  }

  let object = await env.PHOTOS_BUCKET.get(r2Key);

  if (!object && width) {
    object = await getOrCreateTransform(env, ctx, photo, width, r2Key);
  }

  if (!object) {
    const originalKey = `${photo.r2_key}/original.${photo.format}`;
    object = await env.PHOTOS_BUCKET.get(originalKey);

    if (!object) return c.text("Photo file not found", 404);

    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType || `image/${photo.format}`,
        "Cache-Control": "public, max-age=3600",
        "X-Transform-Failed": "true",
      },
    });
  }

  const contentType = width
    ? "image/webp"
    : object.httpMetadata?.contentType || `image/${photo.format}`;

  return new Response(object.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "ETag": object.etag,
    },
  });
});

// GET /api/photos
app.get("/api/photos", async (c) => {
  const url = new URL(c.req.url);
  const site = url.searchParams.get("site");

  const limitParam = parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = Number.isNaN(limitParam) ? 50 : Math.min(Math.max(1, limitParam), 100);

  const offsetParam = parseInt(url.searchParams.get("offset") || "0", 10);
  const offset = Number.isNaN(offsetParam) ? 0 : Math.max(0, offsetParam);

  let query = "SELECT * FROM photos WHERE exclude = 0 AND status = 'active' AND visibility = 'public'";
  const params: (string | number)[] = [];

  if (site) {
    query += " AND (site = ? OR site = 'both')";
    params.push(site);
  }

  query += " ORDER BY date DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const result = await c.env.DB.prepare(query).bind(...params).all<Photo>();

  return c.json({
    photos: result.results,
    meta: { limit, offset, count: result.results.length },
  });
});

// GET /api/collections/{slug}/photos
app.get("/api/collections/:slug/photos", async (c) => {
  const slug = c.req.param("slug");
  const collection = await c.env.DB.prepare(
    "SELECT slug, title, description FROM collections WHERE slug = ? AND is_public = 1"
  ).bind(slug).first<{ slug: string; title: string; description: string | null }>();

  if (!collection) return c.json({ error: "Collection not found" }, 404);

  const limitParam = parseInt(c.req.query("limit") || "50", 10);
  const limit = Number.isNaN(limitParam) ? 50 : Math.min(Math.max(1, limitParam), 100);
  const offsetParam = parseInt(c.req.query("offset") || "0", 10);
  const offset = Number.isNaN(offsetParam) ? 0 : Math.max(0, offsetParam);

  const result = await c.env.DB.prepare(`
    SELECT p.* FROM photos p
    JOIN photo_collections pc ON pc.photo_id = p.id
    WHERE pc.collection_slug = ?
      AND p.status = 'active'
      AND p.visibility = 'public'
    ORDER BY pc.position IS NULL, pc.position, p.date DESC
    LIMIT ? OFFSET ?
  `).bind(slug, limit, offset).all<Photo>();

  return c.json({
    collection,
    photos: result.results,
    meta: { limit, offset, count: result.results.length },
  });
});

// GET /api/people/{slug}/photos
app.get("/api/people/:slug/photos", async (c) => {
  const slug = c.req.param("slug");
  const person = await c.env.DB.prepare(
    "SELECT slug, display_name FROM people WHERE slug = ? AND is_public = 1"
  ).bind(slug).first<{ slug: string; display_name: string }>();

  if (!person) return c.json({ error: "Person not found" }, 404);

  const limitParam = parseInt(c.req.query("limit") || "50", 10);
  const limit = Number.isNaN(limitParam) ? 50 : Math.min(Math.max(1, limitParam), 100);
  const offsetParam = parseInt(c.req.query("offset") || "0", 10);
  const offset = Number.isNaN(offsetParam) ? 0 : Math.max(0, offsetParam);

  const result = await c.env.DB.prepare(`
    SELECT p.* FROM photos p
    JOIN photo_people pp ON pp.photo_id = p.id
    WHERE pp.person_slug = ?
      AND p.status = 'active'
      AND p.visibility = 'public'
    ORDER BY pp.position IS NULL, pp.position, p.date DESC
    LIMIT ? OFFSET ?
  `).bind(slug, limit, offset).all<Photo>();

  return c.json({
    person,
    photos: result.results,
    meta: { limit, offset, count: result.results.length },
  });
});

// GET /api/photos/{id-or-alias}
app.get("/api/photos/:id", async (c) => {
  const id = c.req.param("id");
  const photo = await resolvePhoto(c.env.DB, id);

  if (!photo) return c.json({ error: "Photo not found" }, 404);
  return c.json(photo);
});

// Redirect root to docs
app.get("/", (c) => c.redirect("/docs", 302));

// ============ ADMIN UI ROUTES ============

// GET /admin/ - Photo Grid
app.get("/admin/", async (c) => {
  const url = new URL(c.req.url);
  const pageParam = parseInt(url.searchParams.get("page") || "1", 10);
  const page = Number.isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
  const perPage = 50;
  const offset = (page - 1) * perPage;

  const result = await c.env.DB.prepare(
    "SELECT * FROM photos ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?"
  )
    .bind(perPage, offset)
    .all<Photo>();

  const countResult = await c.env.DB.prepare(
    "SELECT COUNT(*) as total FROM photos"
  ).first<{ total: number }>();

  const total = countResult?.total || 0;
  const totalPages = Math.ceil(total / perPage);
  const photos = result.results || [];

  const origin = url.origin;

  return c.html(
    <AdminLayout title="photo grid">
      <div class="page-title">
        <h1>photo grid</h1>
        <p>{total} photos · page {page} of {totalPages}</p>
      </div>

      {photos.length === 0 ? (
        <div class="empty-state">
          <h2>no photos found</h2>
          <p>upload some photos to get started</p>
        </div>
      ) : (
        <>
          <div class="photo-grid">
            {photos.map((photo) => (
              <article class="photo-card" key={photo.id} data-photo-id={photo.id}>
                <a href={`/admin/photos/${photo.id}`}>
                  <img
                    src={`${origin}/img/${photo.id}?w=200`}
                    alt={photo.title || "photo"}
                    loading="lazy"
                  />
                </a>
                <div class="photo-card-info">
                  <a href={`/admin/photos/${photo.id}`} class="photo-card-title">{photo.title || "untitled"}</a>
                  <div class="photo-card-meta">
                    {photo.date ? photo.date : "no date"}
                    {photo.width && photo.height ? ` · ${photo.width}x${photo.height}` : ""}
                  </div>
                  {photo.site && (
                    <div class="photo-card-tags">
                      <span class="tag">{photo.site}</span>
                      <span class="tag">{photo.visibility}</span>
                      <span class="tag">{photo.status}</span>
                    </div>
                  )}
                </div>
                <div class="photo-card-actions">
                  <a href={`/admin/photos/${photo.id}`}>edit</a>
                  {photo.source === "upload" && (
                    <button type="button" class="delete-photo" data-photo-id={photo.id}>delete</button>
                  )}
                </div>
              </article>
            ))}
          </div>

          {totalPages > 1 && (
            <div class="pagination">
              {page > 1 && <a href={`/admin?page=${page - 1}`}>← previous</a>}
              <span>page {page} of {totalPages}</span>
              {page < totalPages && <a href={`/admin?page=${page + 1}`}>next →</a>}
            </div>
          )}
          <script dangerouslySetInnerHTML={{ __html: `
            document.querySelectorAll('.delete-photo').forEach((button) => {
              button.addEventListener('click', async () => {
                const id = button.dataset.photoId;
                if (!id || !confirm('Permanently delete this uploaded photo? This cannot be undone.')) return;
                button.disabled = true;
                button.textContent = 'deleting…';
                try {
                  const quarantine = await fetch('/api/admin/photos/' + id, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'quarantined' }),
                  });
                  if (!quarantine.ok) throw new Error('could not quarantine photo');
                  const response = await fetch('/api/admin/photos/' + id + '?confirm=' + encodeURIComponent(id), {
                    method: 'DELETE',
                  });
                  const result = await response.json();
                  if (!response.ok) throw new Error(result.error || 'delete failed');
                  document.querySelector('[data-photo-id="' + CSS.escape(id) + '"]')?.remove();
                } catch (error) {
                  button.disabled = false;
                  button.textContent = 'delete';
                  alert(error instanceof Error ? error.message : 'delete failed');
                }
              });
            });
          `}} />
        </>
      )}
    </AdminLayout>
  );
});

app.get("/admin/upload", (c) => {
  return c.html(
    <AdminLayout title="upload photos">
      <a href="/admin" class="back-link">← back to grid</a>
      <div class="page-title">
        <h1>add photos</h1>
        <p>Select a few photos, choose where they belong, and keep this page open while they upload.</p>
      </div>
      <form id="upload-form" class="upload-panel" enctype="multipart/form-data">
        <div class="upload-field">
          <label for="images">photos</label>
          <input id="images" name="images" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" multiple required />
          <div class="upload-help">JPEG, PNG, WebP, or HEIC · 20 MB each · uploads run one at a time</div>
        </div>
        <div class="upload-field">
          <label for="destination">destination</label>
          <select id="destination" name="destination">
            <option value="portfolio">Portfolio — public gallery</option>
            <option value="editorial" selected>Editorial — unlisted, usable in posts</option>
            <option value="private">Private — not publicly available</option>
          </select>
        </div>
        <div class="upload-field">
          <label for="title">title (optional)</label>
          <input id="title" name="title" type="text" autocomplete="off" />
          <div class="upload-help">For multiple files, leave blank to use each filename.</div>
        </div>
        <div class="upload-field">
          <label for="date">date (optional)</label>
          <input id="date" name="date" type="date" />
        </div>
        <div class="upload-field">
          <label for="location">location (optional)</label>
          <input id="location" name="location" type="text" autocomplete="off" placeholder="Point Reyes, California" />
        </div>
        <div class="upload-field">
          <label for="tags">tags (optional)</label>
          <input id="tags" name="tags" type="text" autocomplete="off" placeholder="coast, fog, sunset" />
        </div>
        <button class="upload-submit" type="submit">upload photos</button>
        <div id="upload-queue" class="upload-queue" aria-live="polite"></div>
      </form>
      <script dangerouslySetInnerHTML={{ __html: `
        const form = document.getElementById('upload-form');
        const queue = document.getElementById('upload-queue');
        const submit = form.querySelector('button[type="submit"]');
        let uploading = false;
        window.addEventListener('beforeunload', (event) => {
          if (uploading) { event.preventDefault(); event.returnValue = ''; }
        });
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const files = Array.from(document.getElementById('images').files || []);
          if (!files.length) return;
          uploading = true;
          submit.disabled = true;
          queue.innerHTML = '';
          for (const file of files) {
            const row = document.createElement('div');
            row.className = 'upload-item';
            row.textContent = 'uploading ' + file.name + '…';
            queue.appendChild(row);
            const data = new FormData();
            data.set('image', file);
            data.set('destination', document.getElementById('destination').value);
            const title = document.getElementById('title').value.trim();
            if (title && files.length === 1) data.set('title', title);
            for (const name of ['date', 'location', 'tags']) {
              const value = document.getElementById(name).value.trim();
              if (value) data.set(name, value);
            }
            try {
              const response = await fetch('/api/admin/upload', { method: 'POST', body: data });
              const result = await response.json();
              if (!response.ok) throw new Error(result.error || 'upload failed');
              row.classList.add('success');
              row.innerHTML = (result.duplicate ? 'already exists: ' : 'uploaded: ') +
                '<a href="/admin/photos/' + result.id + '">' + file.name + '</a>';
            } catch (error) {
              row.classList.add('error');
              row.textContent = file.name + ': ' + (error instanceof Error ? error.message : 'upload failed');
            }
          }
          uploading = false;
          submit.disabled = false;
          submit.textContent = 'upload more photos';
        });
      `}} />
    </AdminLayout>
  );
});

// GET /admin/photos/{id} - Photo Detail
app.get("/admin/photos/:id", async (c) => {
  const id = c.req.param("id");
  const photo = await c.env.DB.prepare("SELECT * FROM photos WHERE id = ?")
    .bind(id)
    .first<Photo>();

  if (!photo) return c.text("Photo not found", 404);

  const exif = await c.env.DB.prepare("SELECT * FROM photo_exif WHERE photo_id = ?")
    .bind(id)
    .first<Record<string, string | number | null>>();

  const origin = new URL(c.req.url).origin;
  const standardWidths = [200, 400, 800, 1600];

  return c.html(
    <AdminLayout title={photo.title || "untitled photo"}>
      <a href="/admin" class="back-link">← back to grid</a>

      <div class="detail-layout">
        <div>
          <div class="detail-image">
            <img
              src={`${origin}/img/${photo.id}`}
              alt={photo.title || "photo"}
            />
          </div>
        </div>

        <div class="detail-sidebar">
          <div class="detail-panel">
            <h2>edit metadata</h2>
            <form id="metadata-form" class="edit-form">
              <label>title<input name="title" value={photo.title || ""} /></label>
              <label>caption<textarea name="caption">{photo.caption || ""}</textarea></label>
              <label>location<input name="location" value={photo.location || ""} /></label>
              <div class="edit-row">
                <label>date<input name="date" type="date" value={photo.date?.slice(0, 10) || dateInputValue(exif?.date_taken as string | null) || ""} /></label>
                <label>visibility
                  <select name="visibility">
                    <option value="public" selected={photo.visibility === "public"}>public</option>
                    <option value="unlisted" selected={photo.visibility === "unlisted"}>unlisted</option>
                    <option value="private" selected={photo.visibility === "private"}>private</option>
                  </select>
                </label>
              </div>
              <label>tags<input name="tags" value={tagsForInput(photo.tags)} placeholder="coast, fog, sunset" /></label>
              <div class="edit-row">
                <label>site<input name="site" value={photo.site || "both"} /></label>
                <label>status
                  <select name="status">
                    <option value="active" selected={photo.status === "active"}>active</option>
                    <option value="quarantined" selected={photo.status === "quarantined"}>quarantined</option>
                  </select>
                </label>
              </div>
              <label class="edit-checkbox"><input name="exclude" type="checkbox" checked={photo.exclude === 1} /> hide from compatibility listings</label>
              <button class="edit-submit" type="submit">save changes</button>
              <div id="edit-status" class="edit-status" aria-live="polite"></div>
            </form>
            <script dangerouslySetInnerHTML={{ __html: `
              document.getElementById('metadata-form').addEventListener('submit', async (event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const button = form.querySelector('button');
                const status = document.getElementById('edit-status');
                button.disabled = true;
                status.textContent = 'saving…';
                const data = new FormData(form);
                const tags = String(data.get('tags') || '').split(',').map(tag => tag.trim()).filter(Boolean);
                const body = {
                  title: String(data.get('title') || '') || null,
                  caption: String(data.get('caption') || '') || null,
                  location: String(data.get('location') || '') || null,
                  date: String(data.get('date') || '') || null,
                  tags: JSON.stringify(tags),
                  site: String(data.get('site') || 'both'),
                  status: String(data.get('status')),
                  visibility: String(data.get('visibility')),
                  exclude: data.get('exclude') === 'on',
                };
                try {
                  const response = await fetch('/api/admin/photos/${photo.id}', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                  });
                  const result = await response.json();
                  if (!response.ok) throw new Error(result.error || 'save failed');
                  status.textContent = 'saved';
                } catch (error) {
                  status.textContent = error instanceof Error ? error.message : 'save failed';
                } finally {
                  button.disabled = false;
                }
              });
            `}} />
          </div>

          {exif && (
            <div class="detail-panel">
              <h2>capture profile</h2>
              <div class="exif-grid">
                <div><strong>camera</strong>{[exif.make, exif.model].filter(Boolean).join(" ") || "—"}</div>
                <div><strong>lens</strong>{exif.lens_model || "—"}</div>
                <div><strong>captured</strong>{exif.date_taken || "—"}</div>
                <div><strong>exposure</strong>{exif.aperture ? `ƒ/${exif.aperture}` : "—"}{exif.iso ? ` · ISO ${exif.iso}` : ""}</div>
                <div><strong>focal length</strong>{exif.focal_length ? `${exif.focal_length}mm` : "—"}</div>
                <div><strong>location</strong>{exif.gps_latitude && exif.gps_longitude ? `${Number(exif.gps_latitude).toFixed(4)}, ${Number(exif.gps_longitude).toFixed(4)}` : "—"}</div>
              </div>
            </div>
          )}

          <div class="detail-panel">
            <h2>metadata</h2>
            <table class="meta-table">
              <tbody>
                <tr><td>id</td><td><code>{photo.id}</code></td></tr>
                <tr><td>title</td><td>{photo.title || "—"}</td></tr>
                <tr><td>location</td><td>{photo.location || "—"}</td></tr>
                <tr><td>date</td><td>{photo.date || "—"}</td></tr>
                <tr><td>dimensions</td><td>{photo.width && photo.height ? `${photo.width}x${photo.height}` : "—"}</td></tr>
                <tr><td>format</td><td>{photo.format}</td></tr>
                <tr><td>size</td><td>{photo.size_bytes ? `${(photo.size_bytes / 1024 / 1024).toFixed(2)} MB` : "—"}</td></tr>
                <tr><td>site</td><td>{photo.site}</td></tr>
                <tr><td>source</td><td>{photo.source || "—"}</td></tr>
                <tr><td>tags</td><td>{photo.tags || "—"}</td></tr>
                <tr><td>blurhash</td><td><code style="font-size: 0.7rem;">{photo.blurhash || "—"}</code></td></tr>
                <tr><td>created</td><td>{photo.created_at}</td></tr>
                <tr><td>updated</td><td>{photo.updated_at}</td></tr>
              </tbody>
            </table>
          </div>

          <div class="detail-panel">
            <h2>all sizes</h2>
            <div class="sizes-grid">
              {standardWidths.map((w) => (
                <div class="size-item" key={w}>
                  <img
                    src={`${origin}/img/${photo.id}?w=${w}`}
                    alt={`${w}px`}
                    loading="lazy"
                  />
                  <code>{w}px</code>
                  <button
                    type="button"
                    onclick={`navigator.clipboard.writeText('${origin}/img/${photo.id}?w=${w}'); this.textContent='copied!'; setTimeout(() => this.textContent='copy url', 1000);`}
                  >
                    copy url
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div class="detail-panel">
            <h2>original</h2>
            <div class="size-item">
              <button
                type="button"
                onclick={`navigator.clipboard.writeText('${origin}/img/${photo.id}'); this.textContent='copied!'; setTimeout(() => this.textContent='copy original url', 1000);`}
              >
                copy original url
              </button>
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
});

// ============ ADMIN API ROUTES ============

// PATCH /api/admin/photos/{id} - Edit metadata
app.patch("/api/admin/photos/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const allowedFields = [
    "title", "location", "date", "tags", "site", "exclude", "caption",
    "status", "visibility",
  ];
  const setClauses: string[] = [];
  const values: (string | number | null)[] = [];

  for (const field of allowedFields) {
    if (field in body) {
      const value = body[field];
      setClauses.push(`${field} = ?`);
      if (field === "exclude") {
        values.push(value ? 1 : 0);
      } else {
        if (field === "status" && !["active", "quarantined"].includes(value)) {
          return c.json({ error: "Invalid status" }, 400);
        }
        if (field === "visibility" && !["public", "unlisted", "private"].includes(value)) {
          return c.json({ error: "Invalid visibility" }, 400);
        }
        values.push(value === null ? null : String(value));
      }
    }
  }

  if (setClauses.length === 0) {
    return c.json({ error: "No valid fields to update" }, 400);
  }

  setClauses.push("updated_at = datetime('now')");
  values.push(id); // For WHERE clause

  const sql = `UPDATE photos SET ${setClauses.join(", ")} WHERE id = ?`;

  try {
    const update = await c.env.DB.prepare(sql).bind(...values).run();
    if (update.meta.changes !== 1) {
      return c.json({ error: "Photo not found" }, 404);
    }
    const photo = await c.env.DB.prepare("SELECT * FROM photos WHERE id = ?")
      .bind(id)
      .first<Photo>();
    return c.json(photo);
  } catch (error) {
    return c.json({ error: "Update failed" }, 500);
  }
});

// DELETE /api/admin/photos/{id} - Delete photo
app.delete("/api/admin/photos/:id", async (c) => {
  const id = c.req.param("id");
  const photo = await c.env.DB.prepare("SELECT * FROM photos WHERE id = ?")
    .bind(id)
    .first<Photo>();

  if (!photo) return c.json({ error: "Photo not found" }, 404);

  if (c.req.query("confirm") !== id) {
    return c.json({ error: "Deletion requires confirm=<photo-id>" }, 400);
  }

  if (photo.source !== "upload") {
    return c.json({ error: "Only admin-uploaded photos support direct deletion" }, 409);
  }

  if (photo.status !== "quarantined") {
    return c.json({ error: "Photo must be quarantined before deletion" }, 409);
  }

  const references = await c.env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM photo_aliases WHERE photo_id = ?) +
      (SELECT COUNT(*) FROM photo_climb_links WHERE photo_id = ?) +
      (SELECT COUNT(*) FROM photo_people WHERE photo_id = ?) AS total
  `).bind(id, id, id).first<{ total: number }>();

  if ((references?.total || 0) > 0) {
    return c.json({ error: "Photo is still referenced", references: references?.total }, 409);
  }

  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await c.env.PHOTOS_BUCKET.list({ prefix: `${photo.r2_key}/`, cursor });
    keys.push(...listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  try {
    for (let index = 0; index < keys.length; index += 1000) {
      await c.env.PHOTOS_BUCKET.delete(keys.slice(index, index + 1000));
    }
    const remaining = await c.env.PHOTOS_BUCKET.list({ prefix: `${photo.r2_key}/`, limit: 1 });
    if (remaining.objects.length > 0) return c.json({ error: "R2 deletion verification failed" }, 502);
  } catch {
    return c.json({ error: "R2 deletion failed; photo remains quarantined" }, 502);
  }

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM photo_collections WHERE photo_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id),
  ]);

  return c.json({ deleted: true, id, objects: keys.length });
});

// POST /api/admin/resize - Custom resize
app.post("/api/admin/resize", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { photoId, width } = body;

  if (!photoId || !width) {
    return c.json({ error: "photoId and width required" }, 400);
  }

  const w = parseInt(width, 10);
  if (Number.isNaN(w) || w < 1 || w > MAX_CUSTOM_WIDTH) {
    return c.json({ error: `width must be between 1 and ${MAX_CUSTOM_WIDTH}` }, 400);
  }

  const photo = await c.env.DB.prepare("SELECT * FROM photos WHERE id = ?")
    .bind(photoId)
    .first<Photo>();

  if (!photo) return c.json({ error: "Photo not found" }, 404);
  if (photo.status !== "active") {
    return c.json({ error: "Photo is not active" }, 409);
  }

  const r2Key = `${photo.r2_key}/w${w}.webp`;

  // Check if already exists
  const existing = await c.env.PHOTOS_BUCKET.get(r2Key);
  if (existing) {
    const origin = new URL(c.req.url).origin;
    return c.json({ url: `${origin}/img/${photoId}?w=${w}`, cached: true, width: w });
  }

  const transformed = await getOrCreateTransform(c.env, c.executionCtx, photo, w, r2Key);
  if (!transformed) return c.json({ error: "Transform failed or photo became inactive" }, 409);

  const origin = new URL(c.req.url).origin;
  return c.json({ url: `${origin}/img/${photoId}?w=${w}`, cached: false, width: w });
});

// POST /api/admin/upload - Upload new photo
app.post("/api/admin/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("image") as File | null;
  const requestedTitle = formData.get("title") as string | null;
  const location = formData.get("location") as string | null;
  const date = formData.get("date") as string | null;
  const site = (formData.get("site") as string | null) || "both";
  const tags = formData.get("tags") as string | null;
  const destination = (formData.get("destination") as string | null) || "editorial";

  if (!file) {
    return c.json({ error: "image file required" }, 400);
  }

  // Validate file type
  const allowedTypes = Object.keys(UPLOAD_TYPES);
  if (!allowedTypes.includes(file.type)) {
    return c.json({ error: "Only JPEG, PNG, WebP, HEIC, or HEIF allowed" }, 400);
  }

  // Validate file size (20MB)
  const MAX_SIZE = 20 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    return c.json({ error: "File too large (max 20MB)" }, 400);
  }

  const destinations = {
    portfolio: { visibility: "public", exclude: 0, collection: "portfolio" },
    editorial: { visibility: "unlisted", exclude: 1, collection: "kylies-photos-content" },
    private: { visibility: "private", exclude: 1, collection: null },
  } as const;
  if (!(destination in destinations)) return c.json({ error: "Invalid destination" }, 400);
  const publication = destinations[destination as keyof typeof destinations];

  // Generate ID and determine format from MIME type
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const format = UPLOAD_TYPES[file.type];
  const r2Key = `photos/${id}`;

  // Upload original to R2
  const arrayBuffer = await file.arrayBuffer();
  const profile = await profilePhoto(arrayBuffer);
  const effectiveDate = date || dateInputValue(profile?.dateTaken ?? null);
  const effectiveLocation = location || await locationFromExistingPhotos(c.env.DB, profile);
  const hashBytes = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const sha256 = Array.from(new Uint8Array(hashBytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const duplicate = await c.env.DB.prepare("SELECT id FROM photos WHERE sha256 = ? LIMIT 1")
    .bind(sha256)
    .first<{ id: string }>();
  if (duplicate) {
    return c.json({
      id: duplicate.id,
      url: `${new URL(c.req.url).origin}/img/${duplicate.id}`,
      duplicate: true,
    });
  }
  await c.env.PHOTOS_BUCKET.put(`${r2Key}/original.${format}`, arrayBuffer, {
    httpMetadata: { contentType: file.type },
  });

  // Try to get dimensions from the Images binding
  let width: number | null = null;
  let height: number | null = null;
  try {
    const stream = file.stream() as ReadableStream<Uint8Array>;
    const info = await c.env.IMAGES.info(stream);
    if ("width" in info && "height" in info) {
      width = info.width || null;
      height = info.height || null;
    }
  } catch {
    // Dimensions extraction failed, leave as null
  }

  // Insert into D1 using parameterized query
  const sql = `
    INSERT INTO photos (
      id, r2_key, title, location, date, width, height, format,
      site, source, tags, exclude, status, visibility, size_bytes, sha256, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `;

  try {
    await c.env.DB.prepare(sql)
      .bind(
        id,
        r2Key,
        requestedTitle?.trim() || file.name.replace(/\.[^.]+$/, ""),
        effectiveLocation,
        effectiveDate,
        width,
        height,
        format,
        site,
        "upload",
        tags ?? "[]",
        publication.exclude,
        "active",
        publication.visibility,
        file.size,
        sha256
      )
      .run();
    if (publication.collection) {
      await c.env.DB.prepare("INSERT INTO photo_collections (photo_id, collection_slug) VALUES (?, ?)")
        .bind(id, publication.collection)
        .run();
    }
    if (profile) {
      await c.env.DB.prepare(`
        INSERT INTO photo_exif (
          photo_id, make, model, lens_model, focal_length, aperture,
          exposure_time, iso, exposure_compensation, date_taken,
          gps_latitude, gps_longitude, gps_altitude, software,
          orientation, color_space
          , image_description, artist, copyright
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id, profile.make, profile.model, profile.lensModel, profile.focalLength,
        profile.aperture, profile.exposureTime, profile.iso,
        profile.exposureCompensation, profile.dateTaken, profile.latitude,
        profile.longitude, profile.altitude, profile.software,
        profile.orientation, profile.colorSpace, profile.imageDescription,
        profile.artist, profile.copyright
      ).run();
    }
  } catch (error) {
    // Clean up R2 if DB insert fails
    await c.env.PHOTOS_BUCKET.delete(`${r2Key}/original.${format}`);
    await c.env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
    return c.json({ error: "Database insert failed" }, 500);
  }

  const created = await c.env.DB.prepare("SELECT * FROM photos WHERE id = ?").bind(id).first<Photo>();
  if (!created) return c.json({ error: "Photo metadata missing after upload" }, 500);
  const transform = await getOrCreateTransform(c.env, c.executionCtx, created, 800, `${r2Key}/w800.webp`);
  if (!transform) return c.json({ error: "Photo saved but preview generation failed", id }, 500);

  return c.json({
    id,
    url: `${new URL(c.req.url).origin}/img/${id}`,
    title: created.title,
    width,
    height,
    duplicate: false,
    destination,
    profile,
  });
});

// ============ IMAGE TRANSFORM HELPERS ============

async function getOrCreateTransform(
  env: Env,
  ctx: ExecutionContext,
  photo: Photo,
  width: number,
  targetKey: string
): Promise<R2ObjectBody | null> {
  const cacheKey = targetKey;

  const existing = inFlightTransforms.get(cacheKey);
  if (existing) return existing;

  const transformPromise = (async (): Promise<R2ObjectBody | null> => {
    try {
      if (!(await isPhotoActive(env.DB, photo.id))) return null;

      const originalKey = `${photo.r2_key}/original.${photo.format}`;
      const original = await env.PHOTOS_BUCKET.get(originalKey);
      if (!original) return null;

      const transform = async (input: ReadableStream): Promise<ArrayBuffer> => {
        const transformed = await env.IMAGES.input(input)
          .transform({ width, fit: "scale-down" })
          .output({ format: "image/webp", quality: 85 });
        return transformed.response().arrayBuffer();
      };

      let transformedBuffer: ArrayBuffer;
      try {
        transformedBuffer = await transform(original.body);
      } catch (originalError) {
        // Some migrated originals are malformed or much larger than their
        // metadata indicates. Their retained source URL is the safest repair
        // input; the generated WebP is still written to canonical R2.
        if (!photo.source_url) throw originalError;
        const sourceUrl = new URL(photo.source_url);
        if (!["http:", "https:"].includes(sourceUrl.protocol)) throw originalError;

        const source = await fetch(sourceUrl, { headers: { Accept: "image/*" } });
        if (!source.ok || !source.body) throw originalError;
        transformedBuffer = await transform(source.body);
      }

      await env.PHOTOS_BUCKET.put(targetKey, transformedBuffer, {
        httpMetadata: { contentType: "image/webp" },
      });

      if (!(await isPhotoActive(env.DB, photo.id))) {
        await env.PHOTOS_BUCKET.delete(targetKey);
        return null;
      }

      return await env.PHOTOS_BUCKET.get(targetKey);
    } catch (error) {
      console.error("Transform error:", error);
      return null;
    } finally {
      inFlightTransforms.delete(cacheKey);
    }
  })();

  inFlightTransforms.set(cacheKey, transformPromise);
  return transformPromise;
}

// ============ OPENAPI SPEC ============

function getOpenApiSpec(baseUrl: string): object {
  return {
    openapi: "3.0.3",
    info: {
      title: "photos-api",
      description:
        "Shared photo storage API for kylies.photos and kylieis.online. Provides image serving with on-demand resizing and photo metadata.",
      version: "1.0.0",
      contact: { name: "Kylie Czajkowski", url: "https://kylieis.online" },
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/img/{photoId}": {
        get: {
          summary: "Get photo image",
          description:
            "Serves the photo image. Optionally resize by specifying width. Resized images are converted to WebP and cached.",
          tags: ["Images"],
          parameters: [
            {
              name: "photoId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "The canonical photo ID or a compatibility alias",
              example: "517c0f03a93c",
            },
            {
              name: "w",
              in: "query",
              required: false,
              schema: { type: "integer", enum: [200, 400, 800, 1600] },
              description: "Resize width in pixels. Omit for original.",
            },
          ],
          responses: {
            "200": {
              description: "Photo image",
              content: {
                "image/jpeg": { schema: { type: "string", format: "binary" } },
                "image/webp": { schema: { type: "string", format: "binary" } },
              },
            },
            "400": { description: "Invalid width parameter" },
            "404": { description: "Photo not found" },
          },
        },
      },
      "/api/photos": {
        get: {
          summary: "List photos",
          description: "Returns a paginated list of photos with optional filtering by site.",
          tags: ["Metadata"],
          parameters: [
            {
              name: "site",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Filter by site (e.g., 'climb-log')",
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", default: 50, maximum: 100 },
              description: "Number of photos to return (max 100)",
            },
            {
              name: "offset",
              in: "query",
              required: false,
              schema: { type: "integer", default: 0 },
              description: "Offset for pagination",
            },
          ],
          responses: {
            "200": {
              description: "List of photos",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      photos: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Photo" },
                      },
                      meta: {
                        type: "object",
                        properties: {
                          limit: { type: "integer" },
                          offset: { type: "integer" },
                          count: { type: "integer" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/collections/{slug}/photos": {
        get: {
          summary: "List photos in a public collection",
          tags: ["Collections"],
          parameters: [
            {
              name: "slug",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", default: 50, maximum: 100 },
            },
            {
              name: "offset",
              in: "query",
              schema: { type: "integer", default: 0 },
            },
          ],
          responses: {
            "200": { description: "Ordered public collection photos" },
            "404": { description: "Public collection not found" },
          },
        },
      },
      "/api/people/{slug}/photos": {
        get: {
          summary: "List public photos for an approved person",
          tags: ["People"],
          parameters: [
            {
              name: "slug",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", default: 50, maximum: 100 },
            },
            {
              name: "offset",
              in: "query",
              schema: { type: "integer", default: 0 },
            },
          ],
          responses: {
            "200": { description: "Ordered public photos for the person" },
            "404": { description: "Public person not found" },
          },
        },
      },
      "/api/photos/{photoId}": {
        get: {
          summary: "Get photo metadata",
          description: "Returns metadata for a single photo by canonical ID or compatibility alias.",
          tags: ["Metadata"],
          parameters: [
            {
              name: "photoId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "The canonical photo ID or a compatibility alias",
              example: "517c0f03a93c",
            },
          ],
          responses: {
            "200": {
              description: "Photo metadata",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Photo" },
                },
              },
            },
            "404": { description: "Photo not found" },
          },
        },
      },
    },
    components: {
      schemas: {
        Photo: {
          type: "object",
          properties: {
            id: { type: "string", example: "517c0f03a93c" },
            title: { type: "string", nullable: true, example: "Paintbrush on Spencer Peak" },
            caption: { type: "string", nullable: true },
            location: { type: "string", nullable: true, example: "Caribou-Targhee NF, Idaho" },
            date: { type: "string", format: "date", nullable: true, example: "2024-08-04" },
            width: { type: "integer", nullable: true, example: 768 },
            height: { type: "integer", nullable: true, example: 1024 },
            blurhash: { type: "string", nullable: true, example: "L:E|G2f+Wot7t:WDjZbIx^oJo0kC" },
            format: { type: "string", example: "jpeg" },
            size_bytes: { type: "integer", nullable: true },
            site: { type: "string", example: "climb-log" },
            source: { type: "string", nullable: true, example: "flickr" },
            tags: { type: "string", nullable: true },
            exclude: { type: "integer", enum: [0, 1] },
            status: { type: "string", enum: ["active", "quarantined"] },
            visibility: { type: "string", enum: ["public", "unlisted", "private"] },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
      },
    },
    tags: [
      { name: "Images", description: "Image serving endpoints" },
      { name: "Metadata", description: "Photo metadata endpoints" },
      { name: "Collections", description: "Curated public photo collections" },
      { name: "People", description: "Approved public subject groupings" },
    ],
  };
}

export default app;
