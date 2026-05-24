/**
 * photos-api - Shared photo storage for kylies.photos and kylieis.online
 *
 * Endpoints:
 *   GET /img/{photo-id}?w={width}  - Serve photo with optional resize
 *   GET /api/photos                - List photos (with filters)
 *   GET /api/photos/{id}           - Get single photo metadata
 */

// Supported widths for image transforms
const ALLOWED_WIDTHS = new Set([200, 400, 800, 1600]);

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for cross-origin requests from kylieis.online
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Route: /docs - Swagger UI
      if (path === "/docs" || path === "/docs/") {
        return handleDocs(url, corsHeaders);
      }

      // Route: /openapi.json - OpenAPI spec
      if (path === "/openapi.json") {
        return handleOpenApiSpec(url, corsHeaders);
      }

      // Route: /img/{photo-id}
      if (path.startsWith("/img/")) {
        return await handleImageRequest(request, env, ctx, corsHeaders);
      }

      // Route: /api/photos
      if (path === "/api/photos") {
        return await handleListPhotos(request, env, corsHeaders);
      }

      // Route: /api/photos/{id}
      const photoMatch = path.match(/^\/api\/photos\/([^/]+)$/);
      if (photoMatch) {
        return await handleGetPhoto(photoMatch[1], env, corsHeaders);
      }

      // Redirect root to docs
      if (path === "/" || path === "") {
        return Response.redirect(`${url.origin}/docs`, 302);
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Request error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};

/**
 * Handle image serving with optional transforms
 * URL: /img/{photo-id}?w={width}
 */
async function handleImageRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const url = new URL(request.url);
  const photoId = url.pathname.replace("/img/", "");
  const requestedWidth = url.searchParams.get("w");

  if (!photoId) {
    return new Response("Missing photo ID", { status: 400 });
  }

  // Look up photo in database
  const photo = await env.DB.prepare("SELECT * FROM photos WHERE id = ?")
    .bind(photoId)
    .first<Photo>();

  if (!photo) {
    return new Response("Photo not found", { status: 404 });
  }

  // Determine which variant to serve
  let r2Key: string;
  let width: number | null = null;

  if (requestedWidth && requestedWidth !== "original") {
    width = parseInt(requestedWidth, 10);
    if (!ALLOWED_WIDTHS.has(width)) {
      return new Response(
        `Invalid width. Allowed: ${Array.from(ALLOWED_WIDTHS).join(", ")}, original`,
        { status: 400 }
      );
    }
    r2Key = `${photo.r2_key}/w${width}.webp`;
  } else {
    // Original image
    r2Key = `${photo.r2_key}/original.${photo.format}`;
  }

  // Check if variant exists in R2
  let object = await env.PHOTOS_BUCKET.get(r2Key);

  // If variant doesn't exist and we need a resize, generate it
  if (!object && width) {
    object = await getOrCreateTransform(env, ctx, photo, width, r2Key);
  }

  if (!object) {
    // Fall back to original if transform failed
    const originalKey = `${photo.r2_key}/original.${photo.format}`;
    object = await env.PHOTOS_BUCKET.get(originalKey);

    if (!object) {
      return new Response("Photo file not found", { status: 404 });
    }

    // Return original with shorter cache and failure header
    return new Response(object.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": object.httpMetadata?.contentType || `image/${photo.format}`,
        "Cache-Control": "public, max-age=3600",
        "X-Transform-Failed": "true",
      },
    });
  }

  // Determine content type
  const contentType = width
    ? "image/webp"
    : object.httpMetadata?.contentType || `image/${photo.format}`;

  return new Response(object.body, {
    headers: {
      ...corsHeaders,
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "ETag": object.etag,
    },
  });
}

/**
 * Get or create a transformed image variant
 * Uses request coalescing to prevent duplicate transforms within an isolate
 */
async function getOrCreateTransform(
  env: Env,
  ctx: ExecutionContext,
  photo: Photo,
  width: number,
  targetKey: string
): Promise<R2ObjectBody | null> {
  const cacheKey = `${photo.id}:${width}`;

  // Check if transform is already in flight
  const existing = inFlightTransforms.get(cacheKey);
  if (existing) {
    return existing;
  }

  // Create transform promise
  const transformPromise = (async (): Promise<R2ObjectBody | null> => {
    try {
      // Get original image
      const originalKey = `${photo.r2_key}/original.${photo.format}`;
      const original = await env.PHOTOS_BUCKET.get(originalKey);

      if (!original) {
        return null;
      }

      // Transform using Cloudflare Images
      const transformed = await env.IMAGES.input(original.body)
        .transform({
          width,
          fit: "scale-down",
        })
        .output({
          format: "image/webp",
          quality: 85,
        });

      const transformedBuffer = await transformed.response().arrayBuffer();

      // Store variant in R2 and wait for completion before fetching
      await env.PHOTOS_BUCKET.put(targetKey, transformedBuffer, {
        httpMetadata: { contentType: "image/webp" },
      });

      // Now safely fetch the stored object
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

/**
 * List photos with optional filtering
 * Query params: site, limit, offset
 */
async function handleListPhotos(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const url = new URL(request.url);
  const site = url.searchParams.get("site");

  // Parse and validate limit/offset with safe defaults
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

  const result = await env.DB.prepare(query).bind(...params).all<Photo>();

  return Response.json(
    {
      photos: result.results,
      meta: { limit, offset, count: result.results.length },
    },
    { headers: corsHeaders }
  );
}

/**
 * Get single photo by ID
 */
async function handleGetPhoto(
  id: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const photo = await env.DB.prepare("SELECT * FROM photos WHERE id = ?")
    .bind(id)
    .first<Photo>();

  if (!photo) {
    return new Response("Photo not found", { status: 404, headers: corsHeaders });
  }

  return Response.json(photo, { headers: corsHeaders });
}

/**
 * OpenAPI specification
 */
function getOpenApiSpec(baseUrl: string): object {
  return {
    openapi: "3.0.3",
    info: {
      title: "photos-api",
      description: "Shared photo storage API for kylies.photos and kylieis.online. Provides image serving with on-demand resizing and photo metadata.",
      version: "1.0.0",
      contact: {
        name: "Kylie Czajkowski",
        url: "https://kylieis.online",
      },
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/img/{photoId}": {
        get: {
          summary: "Get photo image",
          description: "Serves the photo image. Optionally resize by specifying width. Resized images are converted to WebP and cached.",
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

/**
 * Serve OpenAPI JSON spec
 */
function handleOpenApiSpec(url: URL, corsHeaders: Record<string, string>): Response {
  const spec = getOpenApiSpec(url.origin);
  return Response.json(spec, {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

/**
 * Serve Swagger UI documentation page
 */
function handleDocs(url: URL, corsHeaders: Record<string, string>): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>photos-api | Documentation</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; padding: 0; }
    .swagger-ui .topbar { display: none; }
    .swagger-ui .info { margin: 20px 0; }
  </style>
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

  return new Response(html, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// Note: ImagesBinding type is auto-generated from wrangler.jsonc via `npx wrangler types`
