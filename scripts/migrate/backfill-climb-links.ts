#!/usr/bin/env npx tsx
/**
 * Backfill photo_climb_links from Notion relation data
 *
 * This script:
 * 1. Queries Notion for all photos with **`related_climb`** relations
 * 2. Maps Notion page IDs to photo IDs in D1
 * 3. Inserts links into photo_climb_links table
 *
 * Run AFTER the main from-notion.ts migration completes.
 *
 * Usage:
 *   NOTION_API_KEY=xxx NOTION_DATABASE_ID=xxx npx tsx scripts/migrate/backfill-climb-links.ts
 *
 * Options:
 *   --dry-run   Preview without making changes
 */

import { execSync } from "child_process";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const DRY_RUN = process.argv.includes("--dry-run");

interface NotionPage {
  id: string;
  properties: Record<string, NotionProperty>;
}

interface NotionProperty {
  type: string;
  relation?: { id: string }[];
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

async function queryAllPages(): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let startCursor: string | undefined;

  do {
    const result = await notionApi<{
      results: NotionPage[];
      has_more: boolean;
      next_cursor: string | null;
    }>(`/databases/${NOTION_DATABASE_ID}/query`, {
      start_cursor: startCursor,
      page_size: 100,
    });
    pages.push(...result.results);
    startCursor = result.has_more ? result.next_cursor ?? undefined : undefined;
  } while (startCursor);

  return pages;
}

// ============ D1 Helpers ============

function getPhotoIdMap(): Map<string, string> {
  // Get mapping of notion_id -> photo_id from D1
  const result = execSync(
    `wrangler d1 execute photos-db --remote --command="SELECT id, notion_id FROM photos WHERE notion_id IS NOT NULL" --json`,
    { stdio: "pipe" }
  );
  const data = JSON.parse(result.toString());
  const rows = data[0]?.results || [];

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.notion_id, row.id);
  }
  return map;
}

function getExistingLinks(): Set<string> {
  // Get existing links to avoid duplicates
  try {
    const result = execSync(
      `wrangler d1 execute photos-db --remote --command="SELECT photo_id, climb_id FROM photo_climb_links" --json`,
      { stdio: "pipe" }
    );
    const data = JSON.parse(result.toString());
    const rows = data[0]?.results || [];

    const set = new Set<string>();
    for (const row of rows) {
      set.add(`${row.photo_id}:${row.climb_id}`);
    }
    return set;
  } catch {
    return new Set();
  }
}

function insertClimbLink(photoId: string, climbId: string): void {
  const sql = `INSERT OR IGNORE INTO photo_climb_links (photo_id, climb_id) VALUES ('${photoId}', '${climbId}')`;
  execSync(`wrangler d1 execute photos-db --remote --command="${sql}"`, {
    stdio: "pipe",
  });
}

// ============ Main ============

async function main() {
  if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
    console.error("Error: NOTION_API_KEY and NOTION_DATABASE_ID required");
    process.exit(1);
  }

  console.log(`Backfill photo_climb_links ${DRY_RUN ? "(DRY RUN)" : ""}`);
  console.log("");

  // Get photo ID mapping from D1
  console.log("Fetching photo ID mapping from D1...");
  const photoIdMap = getPhotoIdMap();
  console.log(`Found ${photoIdMap.size} photos with notion_id`);

  // Get existing links
  console.log("Fetching existing climb links...");
  const existingLinks = getExistingLinks();
  console.log(`Found ${existingLinks.size} existing links`);

  // Query Notion for all photos
  console.log("Querying Notion for photo relations...");
  const pages = await queryAllPages();
  console.log(`Found ${pages.length} photos in Notion`);
  console.log("");

  let linksAdded = 0;
  let linksSkipped = 0;
  let photosWithLinks = 0;

  for (const page of pages) {
    const relations = page.properties.related_climb?.relation || [];
    if (relations.length === 0) continue;

    const photoId = photoIdMap.get(page.id);
    if (!photoId) {
      console.log(`  [SKIP] Notion page ${page.id} not found in D1`);
      continue;
    }

    photosWithLinks++;

    for (const rel of relations) {
      const climbId = rel.id;
      const linkKey = `${photoId}:${climbId}`;

      if (existingLinks.has(linkKey)) {
        linksSkipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would insert link: ${photoId} -> ${climbId}`);
      } else {
        insertClimbLink(photoId, climbId);
      }
      linksAdded++;
    }
  }

  console.log("");
  console.log("=== Summary ===");
  console.log(`Photos with climb relations: ${photosWithLinks}`);
  console.log(`Links added: ${linksAdded}`);
  console.log(`Links skipped (already exist): ${linksSkipped}`);

  if (DRY_RUN) {
    console.log("");
    console.log("(Dry run - no changes made. Remove --dry-run to execute.)");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
