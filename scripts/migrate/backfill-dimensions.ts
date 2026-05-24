import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import sharp from "sharp";

async function getPhotosMissingDimensions(): Promise<{id: string, source_url: string, r2_key: string}[]> {
  const result = execSync(
    `wrangler d1 execute photos-db --remote --command="SELECT id, source_url, r2_key FROM photos WHERE width IS NULL OR height IS NULL" --json`,
    { stdio: "pipe" }
  );
  const data = JSON.parse(result.toString());
  return data[0]?.results || [];
}

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function updateDimensions(id: string, width: number, height: number): Promise<void> {
  const sql = `UPDATE photos SET width = ${width}, height = ${height}, updated_at = datetime('now') WHERE id = '${id}'`;
  execSync(`wrangler d1 execute photos-db --remote --command="${sql}"`, { stdio: "pipe" });
}

async function backfill() {
  const photos = await getPhotosMissingDimensions();
  console.log(`Found ${photos.length} photos missing dimensions`);
  
  let success = 0;
  let failed = 0;
  
  for (const photo of photos) {
    console.log(`\n[${success + failed + 1}/${photos.length}] ${photo.id}`);
    console.log(`  Source: ${photo.source_url}`);
    
    try {
      const imageData = await downloadImage(photo.source_url);
      const metadata = await sharp(imageData).metadata();
      
      if (!metadata.width || !metadata.height) {
        console.log(`  Failed: Could not extract dimensions`);
        failed++;
        continue;
      }
      
      await updateDimensions(photo.id, metadata.width, metadata.height);
      console.log(`  Updated: ${metadata.width}x${metadata.height}`);
      success++;
    } catch (error) {
      console.log(`  Failed: ${error}`);
      failed++;
    }
  }
  
  console.log(`\nDone: ${success} updated, ${failed} failed`);
}

backfill().catch(console.error);
