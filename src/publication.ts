export type PublicationAction = "portfolio" | "editorial" | "private";
export type Visibility = "public" | "unlisted" | "private";

export interface Publication {
  visibility: Visibility;
  exclude: 0 | 1;
  collection: string | null;
}

/** Collections whose membership follows a photo's visibility. */
export const MANAGED_COLLECTIONS = ["portfolio", "kylies-photos-content"] as const;

export const PUBLICATIONS: Record<PublicationAction, Publication> = {
  portfolio: { visibility: "public", exclude: 0, collection: "portfolio" },
  editorial: { visibility: "unlisted", exclude: 1, collection: "kylies-photos-content" },
  private: { visibility: "private", exclude: 1, collection: null },
};

/**
 * The publication state a single-photo visibility change implies, matching the bulk actions.
 * Public photos reserved for kylieis.online stay out of the kylies.photos portfolio.
 */
export function publicationForVisibility(visibility: Visibility, site: string | null): Publication {
  if (visibility === "public") {
    return site === "kylieis-online" ? { ...PUBLICATIONS.portfolio, collection: null } : PUBLICATIONS.portfolio;
  }
  return visibility === "unlisted" ? PUBLICATIONS.editorial : PUBLICATIONS.private;
}

/** Replace managed collection membership; other collections are left alone. */
export function collectionStatements(db: D1Database, photoId: string, collection: string | null): D1PreparedStatement[] {
  const placeholders = MANAGED_COLLECTIONS.map(() => "?").join(", ");
  const statements = [
    db.prepare(`DELETE FROM photo_collections WHERE photo_id = ? AND collection_slug IN (${placeholders})`)
      .bind(photoId, ...MANAGED_COLLECTIONS),
  ];
  if (collection) {
    statements.push(db.prepare("INSERT INTO photo_collections (photo_id, collection_slug) VALUES (?, ?)")
      .bind(photoId, collection));
  }
  return statements;
}
