/**
 * The `about` collection feeds the kylies.photos about-page rotation. Every public
 * kylies.photos photo tagged `kylie` joins it, including photos hidden from listings,
 * which is how a photo can rotate on /about without appearing anywhere else.
 *
 * climb-log's nightly sync calls `fillAboutCollection` through the `PhotoCollections`
 * RPC entrypoint. It only adds; to drop a photo from the rotation, remove its tag and
 * its `about` membership.
 */

import { parseTags } from "./tag-suggestions";

export const ABOUT_COLLECTION = "about";
export const ABOUT_TAG = "kylie";

export interface AboutCandidate {
  id: string;
  tags: string | null;
}

export interface AboutFillResult {
  added: string[];
  total: number;
}

export function isAboutPhoto(tags: string | null): boolean {
  return parseTags(tags).some((tag) => tag.toLowerCase() === ABOUT_TAG);
}

/** Tagged photos not yet in the collection, in the order given. */
export function missingAboutPhotos(candidates: AboutCandidate[], members: Set<string>): string[] {
  return candidates.filter(({ id, tags }) => !members.has(id) && isAboutPhoto(tags)).map(({ id }) => id);
}

export async function fillAboutCollection(
  db: D1Database,
  options: { dryRun?: boolean } = {},
): Promise<AboutFillResult> {
  const [candidates, members] = await Promise.all([
    db.prepare(`
      SELECT id, tags FROM photos
      WHERE status = 'active' AND visibility = 'public' AND (site = 'climb-log' OR site = 'both')
      ORDER BY date DESC, id
    `).all<AboutCandidate>(),
    db.prepare("SELECT photo_id FROM photo_collections WHERE collection_slug = ?")
      .bind(ABOUT_COLLECTION)
      .all<{ photo_id: string }>(),
  ]);
  const memberIds = new Set((members.results ?? []).map(({ photo_id }) => photo_id));
  const added = missingAboutPhotos(candidates.results ?? [], memberIds);

  if (!options.dryRun && added.length > 0) {
    const insert = db.prepare("INSERT OR IGNORE INTO photo_collections (photo_id, collection_slug) VALUES (?, ?)");
    for (let offset = 0; offset < added.length; offset += 50) {
      await db.batch(added.slice(offset, offset + 50).map((id) => insert.bind(id, ABOUT_COLLECTION)));
    }
  }

  return { added, total: memberIds.size + added.length };
}
