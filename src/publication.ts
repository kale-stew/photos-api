export type PublicationAction = "portfolio" | "editorial" | "private";
export type Visibility = "public" | "unlisted" | "private";
export const VISIBILITIES: Visibility[] = ["public", "unlisted", "private"];

/**
 * Visibility is the one publication control. `exclude` is kept for legacy readers and is
 * always derived from it: only Listed photos appear in automatic listings.
 */
export const VISIBILITY_LABELS: Record<Visibility, { label: string; description: string }> = {
  public: { label: "Listed", description: "Portfolio, recent photos, photo pages, and anywhere it is linked" },
  unlisted: { label: "Link-only", description: "Only where linked: posts, trip reports, hikes, and features" },
  private: { label: "Private", description: "Nowhere; image URLs return 404" },
};

export interface Publication {
  visibility: Visibility;
  exclude: 0 | 1;
  collection: string | null;
}

/** Collections whose membership follows a photo's visibility. */
export const MANAGED_COLLECTIONS = ["portfolio", "kylies-photos-content"] as const;

/** Opt-in placements, independent of visibility. Any photo that is not private can be featured. */
export const FEATURE_COLLECTIONS = [
  { slug: "about", label: "About rotation", description: "Rotates on the kylies.photos about page" },
] as const;
export type FeatureSlug = (typeof FEATURE_COLLECTIONS)[number]["slug"];
/** SQL list of feature slugs, for queries that treat feature collections differently. */
export const FEATURE_SLUGS_SQL = FEATURE_COLLECTIONS.map(({ slug }) => `'${slug}'`).join(", ");

export const PUBLICATIONS: Record<PublicationAction, Publication> = {
  portfolio: { visibility: "public", exclude: 0, collection: "portfolio" },
  editorial: { visibility: "unlisted", exclude: 1, collection: "kylies-photos-content" },
  private: { visibility: "private", exclude: 1, collection: null },
};

export function excludeFor(visibility: Visibility): 0 | 1 {
  return visibility === "public" ? 0 : 1;
}

/**
 * The publication state a visibility implies. Listed kylieis.online-only photos stay out of
 * the kylies.photos portfolio, and inactive photos cannot join a collection
 * (`photo_collections_require_active_photo`).
 */
export function publicationFor(visibility: Visibility, site: string | null, status = "active"): Publication {
  const base = visibility === "public" ? PUBLICATIONS.portfolio : visibility === "unlisted" ? PUBLICATIONS.editorial : PUBLICATIONS.private;
  const excluded = visibility === "public" && site === "kylieis-online";
  return { ...base, collection: status !== "active" || excluded ? null : base.collection };
}

export interface PublicationState {
  visibility: Visibility;
  site: string | null;
  status: string;
}

export interface PublicationPlan {
  /** Set when visibility, site, or reactivation means `exclude` and the managed collection are recomputed. */
  publication: Publication | null;
  features: Array<{ slug: FeatureSlug; on: boolean }>;
  error?: string;
}

/**
 * What a single-photo edit changes beyond its plain fields. Quarantine alone keeps
 * membership so a restore can bring it back; reactivation recomputes it.
 */
export function planPublication(
  current: PublicationState,
  next: PublicationState,
  members: Set<string>,
  features: Partial<Record<string, unknown>> | undefined,
): PublicationPlan {
  const reactivated = next.status === "active" && current.status !== "active";
  const publication =
    next.visibility !== current.visibility || next.site !== current.site || reactivated
      ? publicationFor(next.visibility, next.site, next.status)
      : null;

  const changes: PublicationPlan["features"] = [];
  for (const { slug } of FEATURE_COLLECTIONS) {
    const wanted = features?.[slug];
    if (typeof wanted !== "boolean" || wanted === members.has(slug)) continue;
    if (wanted && next.status !== "active") return { publication, features: [], error: "Activate the photo before featuring it" };
    if (wanted && next.visibility === "private") return { publication, features: [], error: "Private photos cannot be featured" };
    changes.push({ slug, on: wanted });
  }
  return { publication, features: changes };
}

/** Replace managed collection membership; feature collections are left alone. */
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

/**
 * Turn a feature on or off. Turning one off records an opt-out so automatic fills (such as the
 * `kylie` tag rule for `about`) never put the photo back.
 */
export function featureStatements(db: D1Database, photoId: string, slug: FeatureSlug, on: boolean): D1PreparedStatement[] {
  if (on) {
    return [
      db.prepare("DELETE FROM collection_opt_outs WHERE photo_id = ? AND collection_slug = ?").bind(photoId, slug),
      db.prepare("INSERT OR IGNORE INTO photo_collections (photo_id, collection_slug) VALUES (?, ?)").bind(photoId, slug),
    ];
  }
  return [
    db.prepare("DELETE FROM photo_collections WHERE photo_id = ? AND collection_slug = ?").bind(photoId, slug),
    db.prepare("INSERT OR IGNORE INTO collection_opt_outs (photo_id, collection_slug) VALUES (?, ?)").bind(photoId, slug),
  ];
}
