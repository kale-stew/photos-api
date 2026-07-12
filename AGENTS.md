# photos-api - Agent Guidelines

This repository is the canonical photo metadata, storage, and delivery service for `kylies.photos` and `kylieis.online`.

## Structure

| Task | Location |
|---|---|
| Worker routes, admin UI, OpenAPI, transforms | `src/index.tsx` |
| D1 schema changes | `migrations/` |
| Remote data migrations and backfills | `scripts/` |
| Integration checks | `scripts/test-integration.ts` |
| Worker bindings | `wrangler.jsonc` |

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
- Keep `r2_key` unique across photos.
- Preserve in-flight transform coalescing when changing image delivery.
- Recheck active D1 state after transform writes; isolate-local in-flight tracking cannot coordinate deletion across Worker isolates.
- Treat one-year immutable client caching as irreversible for clients that already fetched an image.
- Quarantine metadata before deleting objects. For final deletion, inventory the complete prefix, delete and verify R2 objects, then remove D1 metadata.
- Never suppress an R2 deletion failure or delete D1 first; the metadata is required to retry cleanup safely.

## Visibility And References

- Do not treat legacy `exclude` as proof that an image is unused. It historically means hidden from gallery listings, and excluded images may still appear in published content.
- Resolve all canonical IDs and compatibility aliases before deciding that a photo is unreferenced.
- Preserve direct image and metadata behavior consistently. Listing filters alone do not make an image private.
- Destructive scripts must default to dry-run, emit a reviewable manifest, require explicit confirmation, and be safe to rerun.

## Authentication

- `/admin` and `/api/admin/*` are expected to sit behind Cloudflare Access.
- The Worker validates `Cf-Access-Jwt-Assertion` against `TEAM_DOMAIN` and `POLICY_AUD`. Missing configuration denies access.
- Configure `TEAM_DOMAIN` and `POLICY_AUD` outside the repository before deploying admin changes.
- Keep credentials in ignored local environment files. Never print or commit tokens.

## Commands

```bash
npm run typecheck
npm run db:migrate:local
npm run dev
npm run test:local
```

Run remote migrations and deployment only when explicitly requested. Inspect package scripts before deploying because deployment hooks may perform remote synchronization.

## Anti-patterns

- Never copy canonical originals into a consumer-owned R2 bucket.
- Never use title or date alone as a permanent photo identity.
- Never remove an alias until every published and generated reference has been audited.
- Never make a bulk mutation without D1 exports, R2 inventories, a rollback path, and post-operation verification.
