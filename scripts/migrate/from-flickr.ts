#!/usr/bin/env npx tsx
/**
 * Migrate photos from Flickr to R2 + D1
 *
 * Usage:
 *   FLICKR_API_KEY=xxx FLICKR_USER_ID=xxx npx tsx scripts/migrate/from-flickr.ts
 *
 * Options:
 *   --dry-run     Preview what would be migrated without making changes
 *   --album=ID    Only migrate a specific album
 *   --limit=N     Limit number of photos to migrate
 *   --site=NAME   Set site value (default: climb-log)
 */

import { execSync } from "child_process";

const FLICKR_API_KEY = process.env.FLICKR_API_KEY;
const FLICKR_USER_ID = process.env.FLICKR_USER_ID;
const DRY_RUN = process.argv.includes("--dry-run");
const SITE = process.argv.find((a) => a.startsWith("--site="))?.split("=")[1] || "climb-log";
const LIMIT = parseInt(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] || "0", 10);
const ALBUM_ID = process.argv.find((a) => a.startsWith("--album="))?.split("=")[1];

interface FlickrPhoto {
  id: string;
  secret: string;
  server: string;
  farm: number;
  title: string;
  isprimary?: string;
  datetaken?: string;
  latitude?: string;
  longitude?: string;
  description?: { _content: string };
  tags?: string;
  url_o?: string;
  width_o?: string;
  height_o?: string;
  originalsecret?: string;
  originalformat?: string;
}

interface FlickrAlbum {
  id: string;
  title: { _content: string };
  description: { _content: string };
}

async function flickrApi<T>(method: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL("https://api.flickr.com/services/rest/");
  url.searchParams.set("method", method);
  url.searchParams.set("api_key", FLICKR_API_KEY!);
  url.searchParams.set("user_id", FLICKR_USER_ID!);
  url.searchParams.set("format", "json");
  url.searchParams.set("nojsoncallback", "1");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Flickr API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function getAlbums(): Promise<FlickrAlbum[]> {
  const data = await flickrApi<{ photosets: { photoset: FlickrAlbum[] } }>(
    "flickr.photosets.getList"
  );
  return data.photosets.photoset;
}

async function getAlbumPhotos(albumId: string): Promise<FlickrPhoto[]> {
  const data = await flickrApi<{ photoset: { photo: FlickrPhoto[] } }>(
    "flickr.photosets.getPhotos",
    {
      photoset_id: albumId,
      extras: "date_taken,geo,tags,url_o,description,original_format",
    }
  );
  return data.photoset.photo;
}

async function getAllPhotos(): Promise<FlickrPhoto[]> {
  const data = await flickrApi<{ photos: { photo: FlickrPhoto[] } }>(
    "flickr.people.getPhotos",
    {
      extras: "date_taken,geo,tags,url_o,description,original_format",
      per_page: "500",
    }
  );
  return data.photos.photo;
}

function getOriginalUrl(photo: FlickrPhoto): string {
  if (photo.url_o) return photo.url_o;
  const format = photo.originalformat || "jpg";
  const secret = photo.originalsecret || photo.secret;
  return `https://farm${photo.farm}.staticflickr.com/${photo.server}/${photo.id}_${secret}_o.${format}`;
}

async function downloadPhoto(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status}`);
  }
  return res.arrayBuffer();
}

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

async function uploadToR2(photoId: string, data: ArrayBuffer, format: string): Promise<void> {
  const key = `photos/${photoId}/original.${format}`;
  // Use wrangler to upload to R2
  const tempFile = `/tmp/${photoId}.${format}`;
  const fs = await import("fs/promises");
  await fs.writeFile(tempFile, Buffer.from(data));

  execSync(
    `wrangler r2 object put photos-bucket/${key} --file=${tempFile} --content-type=image/${format}`,
    { stdio: "pipe" }
  );

  await fs.unlink(tempFile);
}

async function insertToD1(photo: {
  id: string;
  flickrId: string;
  r2Key: string;
  title: string;
  caption: string;
  date: string;
  width: number;
  height: number;
  format: string;
  tags: string[];
}): Promise<void> {
  const sql = `
    INSERT INTO photos (id, notion_id, r2_key, title, caption, date, width, height, format, site, source, tags)
    VALUES ('${photo.id}', NULL, '${photo.r2Key}', '${photo.title.replace(/'/g, "''")}', 
            '${photo.caption.replace(/'/g, "''")}', '${photo.date}', ${photo.width}, ${photo.height}, 
            '${photo.format}', '${SITE}', 'flickr', '${JSON.stringify(photo.tags).replace(/'/g, "''")}')
    ON CONFLICT (id) DO NOTHING;
  `;

  execSync(`wrangler d1 execute photos-db --remote --command="${sql.replace(/"/g, '\\"')}"`, {
    stdio: "pipe",
  });
}

async function migrate() {
  if (!FLICKR_API_KEY || !FLICKR_USER_ID) {
    console.error("Error: FLICKR_API_KEY and FLICKR_USER_ID environment variables required");
    process.exit(1);
  }

  console.log(`Flickr Migration ${DRY_RUN ? "(DRY RUN)" : ""}`);
  console.log(`Site: ${SITE}`);
  console.log("");

  let photos: FlickrPhoto[];

  if (ALBUM_ID) {
    console.log(`Fetching photos from album ${ALBUM_ID}...`);
    photos = await getAlbumPhotos(ALBUM_ID);
  } else {
    console.log("Fetching all photos...");
    photos = await getAllPhotos();
  }

  if (LIMIT > 0) {
    photos = photos.slice(0, LIMIT);
  }

  console.log(`Found ${photos.length} photos to migrate\n`);

  let migrated = 0;
  let failed = 0;

  for (const flickrPhoto of photos) {
    const photoId = generateId();
    const format = flickrPhoto.originalformat || "jpg";
    const r2Key = `photos/${photoId}`;

    console.log(`[${migrated + failed + 1}/${photos.length}] ${flickrPhoto.title || flickrPhoto.id}`);

    if (DRY_RUN) {
      console.log(`  Would migrate: flickr:${flickrPhoto.id} -> ${r2Key}`);
      migrated++;
      continue;
    }

    try {
      // Download from Flickr
      const url = getOriginalUrl(flickrPhoto);
      console.log(`  Downloading from Flickr...`);
      const imageData = await downloadPhoto(url);

      // Upload to R2
      console.log(`  Uploading to R2...`);
      await uploadToR2(photoId, imageData, format);

      // Insert metadata to D1
      console.log(`  Inserting metadata...`);
      await insertToD1({
        id: photoId,
        flickrId: flickrPhoto.id,
        r2Key,
        title: flickrPhoto.title || "",
        caption: flickrPhoto.description?._content || "",
        date: flickrPhoto.datetaken?.split(" ")[0] || "",
        width: parseInt(flickrPhoto.width_o || "0", 10),
        height: parseInt(flickrPhoto.height_o || "0", 10),
        format,
        tags: flickrPhoto.tags?.split(" ") || [],
      });

      console.log(`  Done!`);
      migrated++;
    } catch (error) {
      console.error(`  Failed: ${error}`);
      failed++;
    }
  }

  console.log(`\nMigration complete: ${migrated} migrated, ${failed} failed`);
}

migrate().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
