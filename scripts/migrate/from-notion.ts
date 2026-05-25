#!/usr/bin/env npx tsx
/**
 * Migrate photos from Notion database to D1 + R2
 *
 * This script:
 * 1. Reads photo metadata from Notion
   * 2. Downloads original images from Flickr (using **`href`** URLs)
 * 3. Uploads originals to R2
 * 4. Stores metadata in D1
 *
 * Usage:
 *   NOTION_API_KEY=xxx NOTION_DATABASE_ID=xxx FLICKR_API_KEY=xxx npx tsx scripts/migrate/from-notion.ts
 *
 * Options:
 *   --dry-run       Preview without making changes
 *   --metadata-only Sync metadata only, skip image download/upload
 *   --limit=N       Limit number of photos to process
 *   --site=NAME     Set site value (default: climb-log)
 */

import { execSync } from "child_process";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const FLICKR_API_KEY = process.env.FLICKR_API_KEY;
const DRY_RUN = process.argv.includes("--dry-run");
const METADATA_ONLY = process.argv.includes("--metadata-only");
const SITE = process.argv.find((a) => a.startsWith("--site="))?.split("=")[1] || "climb-log";
const LIMIT = parseInt(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] || "0", 10);

interface NotionPage {
  id: string;
  created_time: string;
  last_edited_time: string;
  properties: Record<string, NotionProperty>;
}

interface NotionProperty {
  type: string;
  title?: { plain_text: string }[];
  rich_text?: { plain_text: string }[];
  date?: { start: string; end?: string };
  number?: number;
  url?: string;
  checkbox?: boolean;
  relation?: { id: string }[];
  created_time?: string;
}

interface PhotoData {
  id: string;
  notionId: string;
  title: string;
  location: string;
  date: string;
  width: number;
  height: number;
  tags: string[];
  exclude: boolean;
  accentColor: string;
  flickrUrl: string;
  flickrId: string | null;
  relatedClimbs: string[];
}

// ============ Notion API ============

async function notionApi<T>(endpoint: string, body?: object): Promise<T> {
  const url = `https://api.notion.com/v1${endpoint}`;
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API error: ${res.status} ${text}`);
  }

  return res.json() as Promise<T>;
}

async function queryAllPages(): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let startCursor: string | undefined;

  do {
    const result = await notionApi<{
      results: NotionPage[];
      has_more: boolean;
      next_cursor?: string;
    }>(`/databases/${NOTION_DATABASE_ID}/query`, {
      start_cursor: startCursor,
      page_size: 100,
    });

    pages.push(...result.results);
    startCursor = result.has_more ? result.next_cursor : undefined;
    console.log(`  Fetched ${pages.length} entries...`);
  } while (startCursor);

  return pages;
}

// ============ Property Extraction ============

function getText(prop: NotionProperty | undefined): string {
  if (!prop) return "";
  if (prop.type === "title") return prop.title?.map((t) => t.plain_text).join("") || "";
  if (prop.type === "rich_text") return prop.rich_text?.map((t) => t.plain_text).join("") || "";
  if (prop.type === "url") return prop.url || "";
  return "";
}

function getNumber(prop: NotionProperty | undefined): number {
  return prop?.number || 0;
}

function getDate(prop: NotionProperty | undefined): string {
  return prop?.date?.start || "";
}

function getCheckbox(prop: NotionProperty | undefined): boolean {
  return prop?.checkbox || false;
}

function getRelations(prop: NotionProperty | undefined): string[] {
  return prop?.relation?.map((r) => r.id) || [];
}

function parseNotionPage(page: NotionPage): PhotoData {
  const props = page.properties;

  // Extract Flickr photo ID from URL
  // URL format: https://live.staticflickr.com/65535/54298770097_79735eefd4_b.jpg
  const flickrUrl = getText(props.href);
  let flickrId: string | null = null;
  const flickrMatch = flickrUrl.match(/\/(\d+)_[a-f0-9]+_[a-z]\.jpg$/i);
  if (flickrMatch) {
    flickrId = flickrMatch[1];
  }

  // Parse tags from rich_text (comma or space separated)
  const tagsRaw = getText(props.tags);
  const tags = tagsRaw ? tagsRaw.split(/[,\s]+/).filter(Boolean) : [];

  return {
    id: generateId(),
    notionId: page.id,
    title: getText(props.title),
    location: getText(props.area_fallback), // **`area_fallback`** → **`location`**
    date: getDate(props.taken_on), // **`taken_on`**
    width: getNumber(props.width),
    height: getNumber(props.height),
    tags,
    exclude: getCheckbox(props.exclude),
    accentColor: getText(props.accent_color), // **`accent_color`**
    flickrUrl,
    flickrId,
    relatedClimbs: getRelations(props.related_climb), // **`related_climb`**
  };
}

// ============ Flickr API ============

async function getFlickrOriginalUrl(photoId: string): Promise<{ url: string; format: string } | null> {
  if (!FLICKR_API_KEY) return null;

  const url = new URL("https://api.flickr.com/services/rest/");
  url.searchParams.set("method", "flickr.photos.getSizes");
  url.searchParams.set("api_key", FLICKR_API_KEY);
  url.searchParams.set("photo_id", photoId);
  url.searchParams.set("format", "json");
  url.searchParams.set("nojsoncallback", "1");

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;

    const data = (await res.json()) as {
      sizes?: { size: { label: string; source: string }[] };
    };

    // Find Original or largest available
    const sizes = data.sizes?.size || [];
    const original = sizes.find((s) => s.label === "Original");
    const large = sizes.find((s) => s.label === "Large" || s.label === "Large 2048");

    const best = original || large;
    if (!best) return null;

    const format = best.source.endsWith(".png") ? "png" : "jpeg";
    return { url: best.source, format };
  } catch {
    return null;
  }
}

async function downloadImage(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download: ${res.status}`);
  }
  return res.arrayBuffer();
}

// ============ R2 & D1 Operations ============

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

async function uploadToR2(photoId: string, data: ArrayBuffer, format: string): Promise<void> {
  const key = `photos/${photoId}/original.${format}`;
  const tempFile = `/tmp/${photoId}.${format}`;
  const fs = await import("fs/promises");
  await fs.writeFile(tempFile, Buffer.from(data));

  execSync(
    `wrangler r2 object put photos-bucket/${key} --file="${tempFile}" --content-type=image/${format} --remote`,
    { stdio: "pipe" }
  );

  await fs.unlink(tempFile);
}

async function upsertToD1(photo: PhotoData, r2Key: string, format: string, sizeBytes: number | null): Promise<void> {
  // Escape single quotes for SQL
  const esc = (s: string) => s.replace(/'/g, "''");

  const sql = `
    INSERT INTO photos (
      id, notion_id, r2_key, title, location, date, width, height, format,
      site, source, tags, exclude, accent_color, flickr_id, source_url, size_bytes, created_at, updated_at
    ) VALUES (
      '${photo.id}',
      '${photo.notionId}',
      '${r2Key}',
      '${esc(photo.title)}',
      '${esc(photo.location)}',
      '${photo.date}',
      ${photo.width || "NULL"},
      ${photo.height || "NULL"},
      '${format}',
      '${SITE}',
      'flickr',
      '${esc(JSON.stringify(photo.tags))}',
      ${photo.exclude ? 1 : 0},
      ${photo.accentColor ? `'${esc(photo.accentColor)}'` : "NULL"},
      ${photo.flickrId ? `'${photo.flickrId}'` : "NULL"},
      ${photo.flickrUrl ? `'${esc(photo.flickrUrl)}'` : "NULL"},
      ${sizeBytes || "NULL"},
      datetime('now'),
      datetime('now')
    )
    ON CONFLICT (notion_id) DO UPDATE SET
      title = excluded.title,
      location = excluded.location,
      date = excluded.date,
      width = COALESCE(excluded.width, photos.width),
      height = COALESCE(excluded.height, photos.height),
      tags = excluded.tags,
      exclude = excluded.exclude,
      accent_color = COALESCE(excluded.accent_color, photos.accent_color),
      updated_at = datetime('now');
  `;

  execSync(`wrangler d1 execute photos-db --remote --command="${sql.replace(/"/g, '\\"')}"`, {
    stdio: "pipe",
  });
}

async function insertClimbLinks(photoId: string, climbIds: string[]): Promise<void> {
  // Skip climb links for now - the climb_id references don't exist in this DB
  // These links can be populated later when climb data is migrated
  if (climbIds.length === 0) return;

  // Store climb IDs in a way that doesn't require foreign key validation
  // For now, just log them - the relation data is preserved in Notion
  console.log(`    (Skipping ${climbIds.length} climb links - climb data not yet migrated)`);
}

async function getExistingNotionIds(): Promise<Set<string>> {
  try {
    const result = execSync(
      `wrangler d1 execute photos-db --remote --command="SELECT notion_id FROM photos WHERE notion_id IS NOT NULL" --json`,
      { stdio: "pipe" }
    );
    const data = JSON.parse(result.toString());
    const ids = data[0]?.results?.map((r: { notion_id: string }) => r.notion_id) || [];
    return new Set(ids);
  } catch {
    return new Set();
  }
}

// ============ Main Migration ============

async function migrate() {
  if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
    console.error("Error: NOTION_API_KEY and NOTION_DATABASE_ID required");
    process.exit(1);
  }

  if (!METADATA_ONLY && !FLICKR_API_KEY) {
    console.error("Error: FLICKR_API_KEY required for image download (use --metadata-only to skip)");
    process.exit(1);
  }

  console.log(`Notion → R2/D1 Migration ${DRY_RUN ? "(DRY RUN)" : ""}`);
  console.log(`Site: ${SITE}`);
  console.log(`Mode: ${METADATA_ONLY ? "Metadata only" : "Full migration (download images)"}`);
  console.log("");

  // Fetch all pages from Notion
  console.log("Fetching entries from Notion...");
  let pages = await queryAllPages();

  if (LIMIT > 0) {
    pages = pages.slice(0, LIMIT);
  }
  console.log(`\nProcessing ${pages.length} entries\n`);

  // Get existing entries
  console.log("Checking existing entries in D1...");
  const existingIds = await getExistingNotionIds();
  console.log(`Found ${existingIds.size} existing entries\n`);

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const page of pages) {
    const photo = parseNotionPage(page);
    const isNew = !existingIds.has(photo.notionId);

    console.log(`[${migrated + skipped + failed + 1}/${pages.length}] ${photo.title || photo.notionId}`);

    if (DRY_RUN) {
      console.log(`  ${isNew ? "NEW" : "UPDATE"}: notion:${photo.notionId}`);
      if (photo.flickrId) {
        console.log(`  Flickr ID: ${photo.flickrId}`);
      }
      if (!METADATA_ONLY && photo.flickrId) {
        console.log(`  Would download original from Flickr`);
      }
      migrated++;
      continue;
    }

    try {
      let r2Key = `photos/${photo.id}`;
      let format = "jpeg";
      let sizeBytes: number | null = null;

      // Download and upload image if not metadata-only
      if (!METADATA_ONLY && photo.flickrId && isNew) {
        // Get original URL from Flickr API
        console.log(`  Fetching original URL from Flickr...`);
        const original = await getFlickrOriginalUrl(photo.flickrId);

        if (original) {
          console.log(`  Downloading original...`);
          const imageData = await downloadImage(original.url);
          sizeBytes = imageData.byteLength;
          format = original.format;

          console.log(`  Uploading to R2 (${(sizeBytes / 1024 / 1024).toFixed(2)} MB)...`);
          await uploadToR2(photo.id, imageData, format);
        } else {
          // Fall back to the _b.jpg URL from Notion
          console.log(`  Original not available, downloading _b variant...`);
          const imageData = await downloadImage(photo.flickrUrl);
          sizeBytes = imageData.byteLength;

          console.log(`  Uploading to R2...`);
          await uploadToR2(photo.id, imageData, format);
        }
      } else if (!isNew) {
        // Keep existing r2_key for updates
        console.log(`  Updating metadata only (image already exists)`);
      }

      // Upsert metadata to D1
      console.log(`  Saving metadata...`);
      await upsertToD1(photo, r2Key, format, sizeBytes);

      // Insert climb links
      if (photo.relatedClimbs.length > 0) {
        console.log(`  Linking to ${photo.relatedClimbs.length} climbs...`);
        await insertClimbLinks(photo.id, photo.relatedClimbs);
      }

      console.log(`  Done!`);
      migrated++;
    } catch (error) {
      console.error(`  Failed: ${error}`);
      failed++;
    }
  }

  console.log(`\nMigration complete: ${migrated} processed, ${skipped} skipped, ${failed} failed`);
}

migrate().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
