# photos-api - Agent Guidelines

This repository is the canonical photo metadata, storage, and delivery service for `kylies.photos` and `kylieis.online`.

## Structure

| Task | Location |
|---|---|
| Worker routes, admin UI, OpenAPI, transforms | `src/index.tsx` |
| D1 schema changes | `migrations/` |
| Remote data migrations and backfills | `scripts/` |
| Integration checks | `scripts/test-integration.ts` |
| Worker bindings and deployment | `cloudflare.config.ts` |

Keep Worker behavior in `src/index.tsx` unless a deliberate architecture change says otherwise. Local scripts are Node programs and are not bundled into the Worker.

## Canonical Ownership

- Treat `photos-db` and `photos-bucket` as the canonical photo store.
- Treat `climb-log` as the application repository that deploys `kylies.photos`, not as a second photo service.
- Do not add a new bidirectional sync between the repositories. Consumers reference canonical photo IDs or compatibility aliases.
- Preserve published `kylies.photos` image references. Blog content, climb previews, generated fallbacks, and hard-coded `/img/{id}` URLs can depend on legacy UUIDs and short IDs.
- Keep storage, listing, and usage separate. A photo can be absent from a public collection while remaining addressable as an unlisted editorial or climb asset.

## Database Migrations

- Use numbered files in `migrations/` for every schema change.
- Before changing or applying migrations, query production `d1_migrations` and `PRAGMA table_info(...)`. Do not infer deployed schema from files or TypeScript types.
- Test the full migration chain against a fresh local database before applying it remotely.
- Never edit a migration already applied to production. Reconcile unapplied migrations deliberately before adding a later migration.
- Do not add manual schema prerequisites. Fresh databases and production must reach the same schema through the migration chain.

## R2 And Image Delivery

- Originals use `photos/{id}/original.{format}`.
- Generated transforms use `photos/{id}/w{width}.webp`.
- The Images binding rejects `.input()` over 20 MB. Originals above `IMAGES_INPUT_LIMIT_BYTES` resize from `photos/{id}/transform-source.webp` (4096px long edge), created locally with `sharp` by the importer, or for existing photos by `npm run transform-sources:apply` after a reviewed `transform-sources:plan`. The Worker cannot create one, so admin uploads above the limit are rejected.
- Keep `r2_key` unique across photos.
- Preserve in-flight transform coalescing when changing image delivery.
- Recheck active D1 state after transform writes; isolate-local in-flight tracking cannot coordinate deletion across Worker isolates.
- Treat one-year immutable client caching as irreversible for clients that already fetched an image.
- Quarantine metadata before deleting objects. For final deletion, inventory the complete prefix, delete and verify R2 objects, then remove D1 metadata.
- Never suppress an R2 deletion failure or delete D1 first; the metadata is required to retry cleanup safely.

## Gear Assets

- Gear product images live in `gear_assets` and under `gear/{notionPageId}/{version}/` in `photos-bucket`, never in `photos`, aliases, or collections. Logic is in `src/gear-assets.ts` (Worker) and `src/gear-image.ts` (pure, unit tested).
- climb-log's nightly Notion sync is the only writer, through the `GearAssets` RPC entrypoint over a service binding. There is no HTTP write route.
- Ingest normalizes once: background removal only for opaque sources, a JS crop to the alpha bounding box, then a fit into a transparent 800×800 frame with 6% padding. Bump `GEAR_PIPELINE_VERSION` to reprocess everything on the next syncs.
- The local Images binding ignores `trim` and cannot run `segment` or raw `rgba` output, so the pipeline crops in JS and segmentation falls back to `needs_review` locally.
- Superseded versions go to `gear_asset_retired_prefixes` and are deleted after 7 days, R2 first and verified, then the row. Old version URLs 302 to the current one.

## Publication Model

- Visibility is the one publication control, labeled in admin: `public` = **Listed** (portfolio, recent photos, photo pages, automatic hike fallbacks, and anywhere linked), `unlisted` = **Link-only** (only where linked: posts, trip reports, formal hike links, and features), `private` = **Private** (not served). Rules and labels live in `src/publication.ts`.
- `exclude` is legacy and derived: 0 for Listed, 1 otherwise. Nothing edits it directly; `/api/photos` and kylieis.online still read it.
- Managed collections follow visibility: Listed kylies.photos photos are in `portfolio`, Link-only photos in `kylies-photos-content`, private and inactive photos in neither. Visibility, site, and reactivation recompute membership; quarantine alone keeps it so a restore brings it back.
- Features are opt-in collections independent of visibility (`FEATURE_COLLECTIONS`), edited as checkboxes. Any photo that is not private can be featured, so Link-only photos can be featured without being listed. Turning a feature off records a row in `collection_opt_outs` so automatic fills never re-add it; only changed boxes are written.
- `about` is a feature that feeds the kylies.photos /about rotation. climb-log's nightly sync adds Listed kylies.photos photos tagged `kylie` through the `PhotoCollections` RPC entrypoint (`src/about-collection.ts`), skipping opt-outs; it never removes.
- Collection endpoints serve Listed photos, plus Link-only photos in feature collections. The portfolio serves Listed photos only.

## Visibility And References

- Do not treat legacy `exclude` or Link-only as proof that an image is unused. Link-only images appear in published content.
- Resolve all canonical IDs and compatibility aliases before deciding that a photo is unreferenced.
- Preserve direct image and metadata behavior consistently. Listing filters alone do not make an image private.
- Destructive scripts must default to dry-run, emit a reviewable manifest, require explicit confirmation, and be safe to rerun.

## Authentication

- `/admin` and `/api/admin/*` are expected to sit behind Cloudflare Access.
- The Worker validates `Cf-Access-Jwt-Assertion` against `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`. Missing configuration denies access.
- Configure `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` outside the repository before deploying admin changes.
- Keep credentials in ignored local environment files. Never print or commit tokens.

## Commands

```bash
npm install            # runtime deps include `jose` (Access JWT); required before dev/deploy
npm run typecheck
npm run db:migrate:local
npm run dev
npm run test:local
```

Run remote migrations and deployment only when explicitly requested. Use the `cf` scripts in `package.json`; `wrangler.jsonc` remains only for legacy migration scripts until they are converted.

- `cloudflare.config.ts` is authoritative for Worker bindings. Keep `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` declared as required secrets so `cf deploy` preserves the existing values.
- The local photo importer requires `--account-id`, `--database-id`, and the reviewed manifest digest when applying; it uses `cf` for D1 and R2 operations.
- Deploying admin changes without `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` set as Worker vars will return `403` for every `/admin*` and `/api/admin/*` route (deny-by-default), not fail open.
- When applying a migration out of band (e.g. via the Cloudflare MCP because local `wrangler --remote` is unauthenticated), insert the matching `d1_migrations` row so the ledger stays consistent with `wrangler d1 migrations`.

## Anti-patterns

- Never copy canonical originals into a consumer-owned R2 bucket.
- Never use title or date alone as a permanent photo identity.
- Never remove an alias until every published and generated reference has been audited.
- Never make a bulk mutation without D1 exports, R2 inventories, a rollback path, and post-operation verification.
