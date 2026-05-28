#!/usr/bin/env npx tsx
/**
 * Generate blurhash for photos missing them
 *
 * Usage:
 *   npx tsx scripts/migrate/generate-blurhash.ts
 *
 * Options:
 *   --dry-run     Preview what would be updated without making changes
 *   --limit=N     Limit number of photos to process
 *   --force       Regenerate blurhash even if one exists
 */

import { execSync } from "child_process";

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const LIMIT = parseInt(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] || "0", 10);

interface Photo {
  id: string;
  r2_key: string;
  format: string;
  blurhash: string | null;
}

async function getPhotosNeedingBlurhash(): Promise<Photo[]> {
  const condition = FORCE ? "1=1" : "blurhash IS NULL";
  const limitClause = LIMIT > 0 ? `LIMIT ${LIMIT}` : "";
  const command = `wrangler d1 execute photos-db --remote --command="SELECT id, r2_key, format, blurhash FROM photos WHERE ${condition} ${limitClause}" --json`;

  const result = execSync(command, { stdio: "pipe" });
  const data = JSON.parse(result.toString());
  return data[0]?.results || [];
}

async function downloadFromR2(r2Key: string, format: string): Promise<Buffer> {
  const key = `${r2Key}/original.${format}`;
  const tempFile = `/tmp/blurhash-${Date.now()}.${format}`;

  execSync(`wrangler r2 object get photos-bucket/${key} --file=${tempFile} --remote`, { stdio: "pipe" });

  const fs = await import("fs/promises");
  const data = await fs.readFile(tempFile);
  await fs.unlink(tempFile);

  return data;
}

async function generateBlurhash(imageBuffer: Buffer): Promise<string> {
  // Use sharp to decode and blurhash to encode
  // This requires: npm install sharp blurhash
  const sharp = (await import("sharp")).default;
  const { encode } = await import("blurhash");

  // Resize to small dimensions for blurhash (4x3 components = 20x15 effective pixels)
  const { data, info } = await sharp(imageBuffer)
    .resize(20, 20, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const hash = encode(new Uint8ClampedArray(data), info.width, info.height, 4, 3);
  return hash;
}

async function updateBlurhash(photoId: string, blurhash: string): Promise<void> {
  const sql = `UPDATE photos SET blurhash = '${blurhash}', updated_at = datetime('now') WHERE id = '${photoId}'`;
  execSync(`wrangler d1 execute photos-db --remote --command="${sql}"`, { stdio: "pipe" });
}

async function run() {
  console.log(`Blurhash Generator ${DRY_RUN ? "(DRY RUN)" : ""}`);
  console.log(`Force regenerate: ${FORCE}`);
  console.log("");

  console.log("Fetching photos needing blurhash...");
  const photos = await getPhotosNeedingBlurhash();
  console.log(`Found ${photos.length} photos\n`);

  if (photos.length === 0) {
    console.log("Nothing to do!");
    return;
  }

  let processed = 0;
  let failed = 0;

  for (const photo of photos) {
    console.log(`[${processed + failed + 1}/${photos.length}] ${photo.id}`);

    if (DRY_RUN) {
      console.log(`  Would generate blurhash for: ${photo.r2_key}`);
      processed++;
      continue;
    }

    try {
      // Download image from R2
      console.log(`  Downloading...`);
      const imageBuffer = await downloadFromR2(photo.r2_key, photo.format);

      // Generate blurhash
      console.log(`  Generating blurhash...`);
      const blurhash = await generateBlurhash(imageBuffer);

      // Update D1
      console.log(`  Updating database...`);
      await updateBlurhash(photo.id, blurhash);

      console.log(`  Done! (${blurhash})`);
      processed++;
    } catch (error) {
      console.error(`  Failed: ${error}`);
      failed++;
    }
  }

  console.log(`\nComplete: ${processed} processed, ${failed} failed`);
}

run().catch((e) => {
  console.error("Failed:", e);
  process.exit(1);
});
