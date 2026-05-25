#!/usr/bin/env npx tsx
/**
 * Map Centennial Checklist photos to photos-api IDs
 *
 * This script:
 * 1. Queries the Centennial Checklist Notion database
 * 2. Extracts Flickr photo IDs from **`img_url`**
 * 3. Looks up corresponding photos-api IDs via flickr_id
 * 4. Outputs a mapping for updating Notion or integrating with peak-list
 *
 * Usage:
 *   NOTION_API_KEY=xxx npx tsx scripts/migrate/map-centennial-photos.ts
 *
 * Options:
 *   --update-notion   Update Notion pages with photo_id property (requires property to exist)
 *   --json            Output as JSON instead of table
 */

import { execSync } from "child_process";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const CENTENNIAL_DB_ID = "d2c6ac15-7eb2-4fc4-99a4-691b6c853a0e";
const UPDATE_NOTION = process.argv.includes("--update-notion");
const OUTPUT_JSON = process.argv.includes("--json");

interface NotionPage {
  id: string;
  properties: {
    peak_name: { title: { plain_text: string }[] };
    img_url: { url: string | null };
    elevation: { number: number | null };
    first_completed_on: { date: { start: string } | null };
  };
}

interface PeakMapping {
  peakName: string;
  notionPageId: string;
  flickrUrl: string | null;
  flickrId: string | null;
  photosApiId: string | null;
  photosApiUrl: string | null;
  elevation: number | null;
  completed: string | null;
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
    throw new Error(`Notion API error: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

async function queryAllPeaks(): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let startCursor: string | undefined;

  do {
    const result = await notionApi<{
      results: NotionPage[];
      has_more: boolean;
      next_cursor: string | null;
    }>(`/databases/${CENTENNIAL_DB_ID}/query`, {
      start_cursor: startCursor,
      page_size: 100,
    });
    pages.push(...result.results);
    startCursor = result.has_more ? result.next_cursor ?? undefined : undefined;
  } while (startCursor);

  return pages;
}

// ============ Helpers ============

function extractFlickrId(url: string | null): string | null {
  if (!url) return null;
  // URL format: https://live.staticflickr.com/65535/51807025013_a5d55db3be_b.jpg
  const match = url.match(/\/(\d+)_[a-f0-9]+_[a-z]\.jpg$/i);
  return match?.[1] || null;
}

function getPhotosApiMapping(): Map<string, { id: string; title: string }> {
  const result = execSync(
    `wrangler d1 execute photos-db --remote --command="SELECT id, flickr_id, title FROM photos WHERE flickr_id IS NOT NULL" --json`,
    { stdio: "pipe", cwd: "/Users/kski/Developer/photos-api" }
  );
  const data = JSON.parse(result.toString());
  const rows = data[0]?.results || [];

  const map = new Map<string, { id: string; title: string }>();
  for (const row of rows) {
    map.set(row.flickr_id, { id: row.id, title: row.title });
  }
  return map;
}

// ============ Main ============

async function main() {
  if (!NOTION_API_KEY) {
    console.error("Error: NOTION_API_KEY required");
    process.exit(1);
  }

  console.error("Fetching Centennial Checklist from Notion...");
  const peaks = await queryAllPeaks();
  console.error(`Found ${peaks.length} peaks\n`);

  console.error("Fetching photos-api flickr_id mapping...");
  const photosApiMap = getPhotosApiMapping();
  console.error(`Found ${photosApiMap.size} photos with flickr_id\n`);

  const mappings: PeakMapping[] = [];

  for (const peak of peaks) {
    const peakName = peak.properties.peak_name.title[0]?.plain_text || "Unknown";
    const flickrUrl = peak.properties.img_url.url;
    const flickrId = extractFlickrId(flickrUrl);
    const photosApiEntry = flickrId ? photosApiMap.get(flickrId) : null;

    mappings.push({
      peakName,
      notionPageId: peak.id,
      flickrUrl,
      flickrId,
      photosApiId: photosApiEntry?.id || null,
      photosApiUrl: photosApiEntry
        ? `https://photos-api.kylieski.workers.dev/img/${photosApiEntry.id}`
        : null,
      elevation: peak.properties.elevation.number,
      completed: peak.properties.first_completed_on.date?.start || null,
    });
  }

  // Sort by elevation descending
  mappings.sort((a, b) => (b.elevation || 0) - (a.elevation || 0));

  if (OUTPUT_JSON) {
    console.log(JSON.stringify(mappings, null, 2));
  } else {
    // Summary stats
    const withFlickr = mappings.filter((m) => m.flickrUrl).length;
    const mapped = mappings.filter((m) => m.photosApiId).length;
    const unmapped = mappings.filter((m) => m.flickrUrl && !m.photosApiId).length;
    const noPhoto = mappings.filter((m) => !m.flickrUrl).length;

    console.log("=== Centennial Photos Mapping ===\n");
    console.log(`Total peaks:        ${mappings.length}`);
    console.log(`With Flickr URL:    ${withFlickr}`);
    console.log(`Mapped to API:      ${mapped}`);
    console.log(`Not yet mapped:     ${unmapped} (photo not in photos-api yet)`);
    console.log(`No photo:           ${noPhoto}`);
    console.log("");

    // Table of mapped peaks
    if (mapped > 0) {
      console.log("--- Mapped Peaks ---");
      console.log("Peak Name".padEnd(30) + "Elevation".padEnd(12) + "photos-api ID");
      console.log("-".repeat(60));
      for (const m of mappings.filter((m) => m.photosApiId)) {
        console.log(
          m.peakName.padEnd(30) +
            (m.elevation?.toLocaleString() || "").padEnd(12) +
            m.photosApiId
        );
      }
      console.log("");
    }

    // Table of unmapped peaks (have Flickr URL but not in photos-api)
    if (unmapped > 0) {
      console.log("--- Unmapped Peaks (Flickr photo not yet migrated) ---");
      console.log("Peak Name".padEnd(30) + "Flickr ID");
      console.log("-".repeat(45));
      for (const m of mappings.filter((m) => m.flickrUrl && !m.photosApiId)) {
        console.log(m.peakName.padEnd(30) + (m.flickrId || ""));
      }
      console.log("");
    }

    // Peaks without any photo
    if (noPhoto > 0) {
      console.log("--- Peaks Without Photos ---");
      for (const m of mappings.filter((m) => !m.flickrUrl)) {
        console.log(`  ${m.peakName}`);
      }
    }
  }

  if (UPDATE_NOTION) {
    console.error("\n--update-notion not yet implemented");
    // TODO: Add photo_id property to Centennial DB and update pages
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
