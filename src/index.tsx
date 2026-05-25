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
 *   DELETE /api/admin/photos/{id}  - Delete photo
 *   POST /api/admin/resize         - Custom resize
 *   POST /api/admin/upload         - Upload new photo
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";

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
  flickr_id: string | null;
  accent_color: string | null;
  source_url: string | null;
  created_at: string;
  updated_at: string;
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
      `}} />
    </head>
    <body>
      <header class="admin-header">
        <div class="admin-header-inner">
          <a href="/admin">photos-api admin</a>
          <nav>
            <a href="/admin">grid</a>
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

// ============ JWT VALIDATION MIDDLEWARE ============

async function verifyAccessJWT(request: Request): Promise<boolean> {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return false;
  // Cloudflare Access validates at the edge. This is defense-in-depth.
  // In production, you could verify the JWT signature here with jose.
  return true;
}

// ============ APP SETUP ============

const app = new Hono<{ Bindings: Env }>();

// CORS for public API routes
app.use("/api/*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  if (c.req.method === "OPTIONS") return c.body(null);
  await next();
});

// Admin API routes require JWT validation
app.use("/api/admin/*", async (c, next) => {
  const jwt = c.req.header("Cf-Access-Jwt-Assertion");
  if (!jwt) {
    return c.json({ error: "Unauthorized" }, 403);
  }
  await next();
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

  const photo = await env.DB.prepare("SELECT * FROM photos WHERE id = ?")
    .bind(photoId)
    .first<Photo>();

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

  let query = "SELECT * FROM photos WHERE exclude = 0";
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

// GET /api/photos/{id}
app.get("/api/photos/:id", async (c) => {
  const id = c.req.param("id");
  const photo = await c.env.DB.prepare("SELECT * FROM photos WHERE id = ?")
    .bind(id)
    .first<Photo>();

  if (!photo) return c.json({ error: "Photo not found" }, 404);
  return c.json(photo);
});

// Redirect root to docs
app.get("/", (c) => c.redirect("/docs", 302));

// ============ ADMIN UI ROUTES ============

// GET /admin - Photo Grid
app.get("/admin", async (c) => {
  const url = new URL(c.req.url);
  const pageParam = parseInt(url.searchParams.get("page") || "1", 10);
  const page = Number.isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
  const perPage = 50;
  const offset = (page - 1) * perPage;

  const result = await c.env.DB.prepare(
    "SELECT * FROM photos WHERE exclude = 0 ORDER BY date DESC LIMIT ? OFFSET ?"
  )
    .bind(perPage, offset)
    .all<Photo>();

  const countResult = await c.env.DB.prepare(
    "SELECT COUNT(*) as total FROM photos WHERE exclude = 0"
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
              <a href={`/admin/photos/${photo.id}`} class="photo-card" key={photo.id}>
                <img
                  src={`${origin}/img/${photo.id}?w=200`}
                  alt={photo.title || "photo"}
                  loading="lazy"
                />
                <div class="photo-card-info">
                  <div class="photo-card-title">{photo.title || "untitled"}</div>
                  <div class="photo-card-meta">
                    {photo.date ? photo.date : "no date"}
                    {photo.width && photo.height ? ` · ${photo.width}x${photo.height}` : ""}
                  </div>
                  {photo.site && (
                    <div class="photo-card-tags">
                      <span class="tag">{photo.site}</span>
                    </div>
                  )}
                </div>
              </a>
            ))}
          </div>

          {totalPages > 1 && (
            <div class="pagination">
              {page > 1 && <a href={`/admin?page=${page - 1}`}>← previous</a>}
              <span>page {page} of {totalPages}</span>
              {page < totalPages && <a href={`/admin?page=${page + 1}`}>next →</a>}
            </div>
          )}
        </>
      )}
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

  const allowedFields = ["title", "location", "date", "tags", "site", "exclude", "caption"];
  const updates: string[] = [];

  for (const field of allowedFields) {
    if (field in body) {
      const value = body[field];
      if (field === "exclude") {
        updates.push(`${field} = ${value ? 1 : 0}`);
      } else {
        const escaped = String(value).replace(/'/g, "''");
        updates.push(`${field} = '${escaped}'`);
      }
    }
  }

  if (updates.length === 0) {
    return c.json({ error: "No valid fields to update" }, 400);
  }

  updates.push("updated_at = datetime('now')");

  const sql = `UPDATE photos SET ${updates.join(", ")} WHERE id = '${id.replace(/'/g, "''")}'`;

  try {
    await c.env.DB.prepare(sql).run();
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

  // Delete from D1
  await c.env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();

  // Delete from R2 (delete all objects under photos/{id}/)
  try {
    const prefix = `photos/${id}/`;
    const listed = await c.env.PHOTOS_BUCKET.list({ prefix });
    for (const obj of listed.objects) {
      await c.env.PHOTOS_BUCKET.delete(obj.key);
    }
  } catch {
    // R2 delete failures are non-critical
  }

  return c.json({ success: true, deleted: id });
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

  const r2Key = `${photo.r2_key}/w${w}.webp`;

  // Check if already exists
  const existing = await c.env.PHOTOS_BUCKET.get(r2Key);
  if (existing) {
    const origin = new URL(c.req.url).origin;
    return c.json({ url: `${origin}/img/${photoId}?w=${w}`, cached: true, width: w });
  }

  // Generate transform
  const originalKey = `${photo.r2_key}/original.${photo.format}`;
  const original = await c.env.PHOTOS_BUCKET.get(originalKey);
  if (!original) return c.json({ error: "Original not found" }, 404);

  try {
    const transformed = await c.env.IMAGES.input(original.body)
      .transform({ width: w, fit: "scale-down" })
      .output({ format: "image/webp", quality: 85 });

    const buffer = await transformed.response().arrayBuffer();
    await c.env.PHOTOS_BUCKET.put(r2Key, buffer, {
      httpMetadata: { contentType: "image/webp" },
    });

    const origin = new URL(c.req.url).origin;
    return c.json({ url: `${origin}/img/${photoId}?w=${w}`, cached: false, width: w });
  } catch (error) {
    return c.json({ error: "Transform failed" }, 500);
  }
});

// POST /api/admin/upload - Upload new photo
app.post("/api/admin/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("image") as File | null;
  const title = formData.get("title") as string | null;
  const location = formData.get("location") as string | null;
  const date = formData.get("date") as string | null;
  const site = (formData.get("site") as string | null) || "kylieis-online";
  const tags = formData.get("tags") as string | null;

  if (!file) {
    return c.json({ error: "image file required" }, 400);
  }

  // Validate file type
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(file.type)) {
    return c.json({ error: "Only JPEG, PNG, WebP allowed" }, 400);
  }

  // Validate file size (20MB)
  const MAX_SIZE = 20 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    return c.json({ error: "File too large (max 20MB)" }, 400);
  }

  // Generate ID
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const format = file.type === "image/png" ? "png" : "jpeg";
  const r2Key = `photos/${id}`;

  // Upload original to R2
  const arrayBuffer = await file.arrayBuffer();
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

  // Insert into D1
  const esc = (s: string | null) => (s ? s.replace(/'/g, "''") : "");
  const sql = `
    INSERT INTO photos (
      id, r2_key, title, location, date, width, height, format,
      site, source, tags, exclude, size_bytes, created_at, updated_at
    ) VALUES (
      '${id}',
      '${r2Key}',
      ${title ? `'${esc(title)}'` : "NULL"},
      ${location ? `'${esc(location)}'` : "NULL"},
      ${date ? `'${esc(date)}'` : "NULL"},
      ${width || "NULL"},
      ${height || "NULL"},
      '${format}',
      '${esc(site)}',
      'upload',
      ${tags ? `'${esc(tags)}'` : "'[]'"},
      0,
      ${file.size},
      datetime('now'),
      datetime('now')
    )
  `;

  try {
    await c.env.DB.prepare(sql).run();
  } catch (error) {
    // Clean up R2 if DB insert fails
    await c.env.PHOTOS_BUCKET.delete(`${r2Key}/original.${format}`);
    return c.json({ error: "Database insert failed" }, 500);
  }

  return c.json({
    id,
    url: `${new URL(c.req.url).origin}/img/${id}`,
    title,
    width,
    height,
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
  const cacheKey = `${photo.id}:${width}`;

  const existing = inFlightTransforms.get(cacheKey);
  if (existing) return existing;

  const transformPromise = (async (): Promise<R2ObjectBody | null> => {
    try {
      const originalKey = `${photo.r2_key}/original.${photo.format}`;
      const original = await env.PHOTOS_BUCKET.get(originalKey);
      if (!original) return null;

      const transformed = await env.IMAGES.input(original.body)
        .transform({ width, fit: "scale-down" })
        .output({ format: "image/webp", quality: 85 });

      const transformedBuffer = await transformed.response().arrayBuffer();

      await env.PHOTOS_BUCKET.put(targetKey, transformedBuffer, {
        httpMetadata: { contentType: "image/webp" },
      });

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
              description: "The photo ID",
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
      "/api/photos/{photoId}": {
        get: {
          summary: "Get photo metadata",
          description: "Returns metadata for a single photo by ID.",
          tags: ["Metadata"],
          parameters: [
            {
              name: "photoId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "The photo ID",
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
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
      },
    },
    tags: [
      { name: "Images", description: "Image serving endpoints" },
      { name: "Metadata", description: "Photo metadata endpoints" },
    ],
  };
}

export default app;
