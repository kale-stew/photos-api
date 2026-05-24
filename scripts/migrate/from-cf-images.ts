#!/usr/bin/env npx tsx
/**
 * Migrate photos from Cloudflare Images to photos-api (R2 + D1)
 *
 * This script:
 * 1. Downloads images from imagedelivery.net
 * 2. Uploads originals to R2
 * 3. Stores metadata in D1
 *
 * Usage:
 *   npx tsx scripts/migrate/from-cf-images.ts
 *
 * Options:
 *   --dry-run   Preview without making changes
 */

import { execSync } from "child_process";
import * as fs from "fs/promises";

const DRY_RUN = process.argv.includes("--dry-run");

// Photos from kylieis.online content.ts
const CF_IMAGES_PHOTOS = [
  // San Francisco / Bay Area
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/d2b975ee-c056-45ea-833b-069480c72300/public', alt: 'Golden Gate Bridge tower from the walkway', location: 'San Francisco, CA', date: '2026-02' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/4d95873b-909c-464e-0617-1cde69bd5000/public', alt: 'Sunset behind the Cliff House', location: 'Ocean Beach, SF, CA', date: '2026-01' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/20e6d214-7cbb-4434-efd8-bc8f6ddc5500/public', alt: 'Sunset over the Pacific at Baker Beach', location: 'Baker Beach, SF, CA', date: '2025-11' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/b014a68a-10f8-4c86-9e64-4450ee609700/public', alt: 'Sunset on Mount Sutro', location: 'Inner Sunset, SF, CA', date: '2026-01' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/c4caf090-5888-47fc-b6b7-deeddfa70500/public', alt: 'Otis on a hike at Pedro Point', location: 'Pacifica, CA', date: '2026-02' },
  // Colorado
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/c58fda33-f329-4047-4f2e-fddb70a23a00/public', alt: 'Top of the Elk Camp chairlift', location: 'Aspen-Snowmass, CO', date: '2026-02' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/ea123215-7183-4a2e-e20b-a99d37d97500/public', alt: 'Scrambling up the second Flatiron', location: 'Boulder, CO', date: '2025-10' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/26b26e1a-07e1-4881-a523-ee919401ba00/public', alt: 'Sunset alpenglow against Little Bear Peak', location: 'San Juan Mountains, CO', date: '2025-07' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/f75c9da1-6767-4b82-ed99-5c202c176f00/public', alt: 'Skiing uphill at Ski Cooper', location: 'Leadville, CO', date: '2026-01' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/43c1083e-1b74-4055-e962-6f9727091c00/public', alt: 'Goat friend at sunrise on Mount Sniktau', location: 'Loveland Pass, Colorado', date: '2025-07' },
  // California
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/c561c0ac-0866-4b4b-7777-c4d663580700/public', alt: 'Descending Glacier Point towards the Mist Trail', location: 'Yosemite National Park, CA', date: '2025-08' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/c939fc9b-a368-47e1-a3d0-afcf75a3ed00/public', alt: 'Storm clouds over Half Dome', location: 'Yosemite National Park, CA', date: '2025-08' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/8abfa21c-7c98-4ca0-0569-4d920e4fa000/public', alt: 'Tunnel View of Yosemite Valley', location: 'Yosemite National Park, CA', date: '2025-04' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/b966686d-364a-4364-60fe-2c5512b89a00/public', alt: 'Ascending Mount Morrison in the fall', location: 'Mammoth Lakes, CA', date: '2025-12' },
  // Hawaii
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/52bfe7f1-63d7-4899-697c-22cabada3600/public', alt: 'Sun shadows at Waimea Bay', location: 'Oahu, HI', date: '2025-12' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/3ecfdf28-96db-4bf7-33dc-2733c79ad800/public', alt: 'Sunset off the east coast of Kauaʻi', location: 'Lihue, HI', date: '2025-12' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/aad40c68-a46b-4e2e-636a-7d1143197400/public', alt: 'HanakāpīʻAi Beach on the Napali Coast', location: 'Kauaʻi, HI', date: '2025-12' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/7bce8dfc-e822-4754-35aa-534b1210e800/public', alt: 'Aerial view of the Napali Coast', location: 'Kauaʻi, HI', date: '2025-12' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/a023ab45-f2d2-4bac-2265-bff003b13f00/public', alt: 'Sunrise from the Kailalau Trail', location: 'Kauaʻi, HI', date: '2025-12' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/e7b1bcd5-13b7-45b9-aad6-510345539a00/public', alt: 'The Napali Coast seen from sea', location: 'Kauaʻi, HI', date: '2025-12' },
  // Norway
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/25c7e70b-467e-42f4-d9d9-6a99be358900/public', alt: 'Sunset on the Arctic Sea', location: 'Langsundkjeften, Norway', date: '2026-04' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/4c58f676-2f66-41b1-64aa-8d4f167c8300/public', alt: 'View out the back of our sailboat', location: 'Vannøya, Norway', date: '2026-04' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/7821ed9d-f915-4400-8d02-88e6909b4000/public', alt: 'Sunset seen from sailboat', location: 'Ulisuolu, Norway', date: '2026-04' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/363f550d-7d89-444a-685f-73a63268fa00/public', alt: 'Northern lights seen from the water', location: 'Stakkvik, Norway', date: '2026-04' },
  // Other
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/ab9fd024-c8e4-4f96-4f17-7fde8d3f7b00/public', alt: 'Canyoneering through Horseplay Canyon', location: 'North Wash, UT', date: '2026-02' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/f998d48a-6d38-4d08-d5d2-c08bc14c3800/public', alt: 'Chicago skyline along Lake Michigan', location: 'Chicago, IL', date: '2025-10' },
  // Timeline milestones
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/e781d047-cb85-4ff1-c159-713d9d4ba300/public', alt: 'Moved to San Francisco', location: 'San Francisco, CA', date: '2025-11' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/3377d417-525a-46a7-c097-5bd1d396ef00/public', alt: 'Climbed Kilimanjaro', location: 'Kilimanjaro National Park, Tanzania', date: '2023-09' },
  { src: 'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/1a8ad2d9-9f80-45ad-1ccb-ca8fbd1f4000/public', alt: 'First Conference Talk', location: 'San Francisco, CA', date: '2018-04' },
];

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function extractCfImageId(url: string): string {
  // Extract ID from: https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/d2b975ee-c056-45ea-833b-069480c72300/public
  const match = url.match(/\/([a-f0-9-]{36})\/public$/);
  return match ? match[1] : "";
}

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function uploadToR2(photoId: string, data: Buffer, format: string): Promise<void> {
  const key = `photos/${photoId}/original.${format}`;
  const tempFile = `/tmp/${photoId}.${format}`;
  await fs.writeFile(tempFile, data);

  execSync(
    `wrangler r2 object put photos-bucket/${key} --file="${tempFile}" --content-type=image/${format} --remote`,
    { stdio: "pipe" }
  );

  await fs.unlink(tempFile);
}

async function insertToD1(photo: {
  id: string;
  cfImageId: string;
  title: string;
  location: string;
  date: string;
  sizeBytes: number;
}): Promise<void> {
  const esc = (s: string) => s.replace(/'/g, "''");
  
  // Parse date - input is YYYY-MM, need YYYY-MM-01
  const dateVal = photo.date.length === 7 ? `${photo.date}-01` : photo.date;

  const sql = `
    INSERT INTO photos (
      id, r2_key, title, location, date, format,
      site, source, tags, exclude, source_url, size_bytes, created_at, updated_at
    ) VALUES (
      '${photo.id}',
      'photos/${photo.id}',
      '${esc(photo.title)}',
      '${esc(photo.location)}',
      '${dateVal}',
      'jpeg',
      'kylieis-online',
      'cloudflare-images',
      '[]',
      0,
      'https://imagedelivery.net/I5sMCdZloThK9NfMgVFKOw/${photo.cfImageId}/public',
      ${photo.sizeBytes},
      datetime('now'),
      datetime('now')
    )
    ON CONFLICT (id) DO UPDATE SET
      title = excluded.title,
      location = excluded.location,
      updated_at = datetime('now');
  `;

  execSync(`wrangler d1 execute photos-db --remote --command="${sql.replace(/"/g, '\\"')}"`, {
    stdio: "pipe",
  });
}

async function migrate() {
  console.log(`Cloudflare Images → R2/D1 Migration ${DRY_RUN ? "(DRY RUN)" : ""}`);
  console.log(`Total photos: ${CF_IMAGES_PHOTOS.length}\n`);

  let migrated = 0;
  let failed = 0;

  for (const photo of CF_IMAGES_PHOTOS) {
    const cfImageId = extractCfImageId(photo.src);
    const photoId = generateId();

    console.log(`[${migrated + failed + 1}/${CF_IMAGES_PHOTOS.length}] ${photo.alt}`);

    if (DRY_RUN) {
      console.log(`  CF Image ID: ${cfImageId}`);
      console.log(`  Would download and upload to R2`);
      migrated++;
      continue;
    }

    try {
      // Download from Cloudflare Images
      console.log(`  Downloading from Cloudflare Images...`);
      const imageData = await downloadImage(photo.src);
      const sizeBytes = imageData.length;

      // Upload to R2
      console.log(`  Uploading to R2 (${(sizeBytes / 1024 / 1024).toFixed(2)} MB)...`);
      await uploadToR2(photoId, imageData, "jpeg");

      // Insert metadata to D1
      console.log(`  Saving metadata...`);
      await insertToD1({
        id: photoId,
        cfImageId,
        title: photo.alt,
        location: photo.location,
        date: photo.date,
        sizeBytes,
      });

      console.log(`  Done! (${photoId})`);
      migrated++;
    } catch (error) {
      console.error(`  Failed: ${error}`);
      failed++;
    }
  }

  console.log(`\nMigration complete: ${migrated} processed, ${failed} failed`);
  
  // Output the photo IDs for reference
  if (!DRY_RUN && migrated > 0) {
    console.log(`\nFetch migrated photo IDs with:`);
    console.log(`  wrangler d1 execute photos-db --remote --command="SELECT id, title FROM photos WHERE site='kylieis-online'" --json`);
  }
}

migrate().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
