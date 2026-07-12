# Canonical Photo Service

## Summary

`photos-api` is the single source of truth for photo metadata, originals, transforms, stable identifiers, publication state, and relationships used by `kylies.photos` and `kylieis.online`.

The service distinguishes storage from publication. A stored photo may be publicly listed, directly addressable but unlisted, private, or quarantined. Consumer repositories do not copy canonical photo objects into their own storage.

The corresponding consumer contract is documented in [`climb-log`](https://github.com/kale-stew/climb-log/blob/main/docs/specs/photos-api-consumer.md).

## Context

`kylies.photos` historically embedded a fork of this service, copied metadata into another D1 database, copied objects into another R2 bucket, and generated short identifiers for published URLs. That duplication created divergent records without creating a separate product boundary.

Published Markdown, climb previews, generated fallbacks, timeline entries, and hard-coded image URLs depend on identifiers from both systems. Gallery exclusion does not prove that an image is unused.

The desired collection is intentionally curated from high-quality originals. Legacy images remain only when they contribute to the portfolio or support published content and climb history.

## Goals

- Maintain one canonical photo record and object hierarchy.
- Preserve existing published image URLs through aliases.
- Separate public listing, direct addressability, and lifecycle state.
- Support a curated portfolio and approved public people groupings.
- Keep editorial and climb assets addressable without placing them in the portfolio.
- Make destructive cleanup reviewable, reversible, and verifiable.
- Let consumers migrate without deleting their fallback data in the same change.

## Non-goals

- Automatically publish every stored photo.
- Use AI scoring as the final curation decision.
- Introduce face recognition or infer people automatically.
- Preserve bidirectional database or object synchronization.
- Rewrite all historical content URLs during the initial cutover.
- Track rollout progress in this document.

## Decisions

### Canonical identity

`photos.id` is the canonical identifier. `photo_aliases` maps historical Notion IDs, consumer UUIDs, and generated short IDs to that canonical identifier.

Canonical IDs are checked before aliases. Aliases are globally unique. Alias generation must fail on collisions rather than selecting an arbitrary photo.

Each `photos.r2_key` is unique. Deletion never operates on a prefix shared by another record.

Titles, dates, locations, and source URLs are audit signals, not identities.

### Lifecycle and visibility

Lifecycle and visibility are independent:

- `active`: eligible to be served according to visibility.
- `quarantined`: retained for recovery but unavailable publicly.
- `public`: eligible for public collections and direct delivery.
- `unlisted`: omitted from public collections but available by canonical ID or alias.
- `private`: available only to authenticated administration.

Legacy `exclude` remains a compatibility field during migration. It means hidden from legacy gallery queries and must not be interpreted as unreferenced.

### Collections

Collections determine intentional listing and ordering. The initial stable collection slugs are:

- `portfolio`: the primary curated collection.
- `kylies-photos-content`: unlisted editorial assets used by published site content.

Climb relationships remain in `photo_climb_links`; they are not duplicated as collection membership.

`GET /api/photos` remains a compatibility endpoint during cutover. It changes to the portfolio view only after consumers no longer rely on legacy `site` filtering.

### People

People are manually assigned through `photo_people`. Only people explicitly marked public receive a public slug and appear through `GET /api/people/:slug/photos`.

The person is a subject of the image, not its owner. Authorship remains with the photographer represented by this service.

### Editorial assets

Editorial assets do not require a separate public content API. They remain directly addressable through `/img/:identifier` and belong to the unlisted content collection so deletion safeguards can detect their use.

New content uses canonical IDs. Existing legacy URLs remain valid through aliases and the consumer compatibility route.

### Deletion

Quarantine and deletion are separate operations.

The direct admin endpoint does not physically delete records or objects. It verifies quarantine and reference state, then requires a future, separately reviewed cleanup workflow that is outside this foundation change.

That cleanup workflow records the original metadata and complete R2 inventory in a pending deletion ledger before removing objects. It deletes and verifies the complete unique prefix, removes D1 metadata, and marks the ledger complete. Retries preserve the original snapshot and union newly discovered keys into the inventory.

Every transform verifies active state before and after writing. If a photo becomes inactive while another Worker isolate is transforming it, the writer removes the newly created object. Because quarantined metadata remains until the cleanup workflow, any failed cleanup remains discoverable through the canonical prefix inventory.

Destructive tools default to dry-run and emit a manifest. D1 exports and R2 inventories are prerequisites for bulk deletion.

### Administration

All `/admin` and `/api/admin/*` routes validate the Cloudflare Access JWT signature, issuer, audience, and expiry. Missing Access configuration denies access. Header presence alone is never authorization.

## API Contract

### Images

`GET /img/:identifier` accepts a canonical ID or alias. Active public and unlisted photos are available. Private and quarantined photos are unavailable through public delivery routes. A future authenticated binary route must validate Access tokens rather than trusting header presence.

### Metadata

`GET /api/photos/:identifier` follows the same identifier and visibility rules as image delivery.

### Collections

`GET /api/collections/:slug/photos` returns ordered active public photos only when the collection itself is public.

### People

`GET /api/people/:slug/photos` returns active public photos only when the person is public.

### Compatibility

Legacy `site`, `exclude`, and `/api/photos` behavior remains available until the consumer cutover is complete. Compatibility behavior is removed only after repository and production reference audits pass.

## Migration

1. Verify production migration history and schema directly.
2. Apply the canonical schema through D1 migrations.
3. Populate Notion-ID aliases from canonical metadata.
4. Generate short aliases deterministically, review the stable desired-state manifest, and reject collisions.
5. Import consumer reference classifications as climb links or unlisted content membership.
6. Deploy alias-aware routes without changing legacy list semantics.
7. Switch consumers to canonical metadata and image delivery.
8. Verify all literal and generated consumer references.
9. Retire duplicate consumer storage in a separate change.
10. Import curated originals, publish the portfolio, and quarantine unreferenced legacy records.

## Rollback

- Schema additions are additive during cutover.
- Consumer storage remains intact until canonical resolution is verified in production.
- The consumer compatibility route can be switched back to local resolution without restoring objects.
- Quarantined objects remain in place until the recovery period and restoration test pass.
- Failed R2 deletion leaves D1 metadata intact so cleanup can be retried.

## Acceptance Criteria

- Every canonical ID and imported alias resolves to exactly one photo.
- Alias generation reports no collisions.
- Reapplying a partially or fully applied alias manifest is safe.
- Every published consumer image reference resolves through the canonical service.
- Portfolio listings contain only intentional public members.
- Editorial and climb assets remain addressable but absent from portfolio listings.
- Private and quarantined assets are unavailable to unauthenticated requests.
- A referenced photo cannot be deleted through the admin API.
- R2 failures cannot leave an untracked object or a metadata-free retry state.
- Both consumer sites render successfully from canonical photo data before duplicate storage is retired.

## Rejected Alternatives

### Separate climb and portfolio services

Rejected because `climb-log` is the repository behind `kylies.photos`, not a separate ownership domain. Separate stores recreate synchronization and identity drift.

### Continue bidirectional synchronization

Rejected because two writable copies cannot provide a stable source of truth and duplicate object storage without adding user value.

### Rewrite every legacy URL immediately

Rejected because aliases provide a safer compatibility boundary and avoid a large content-only migration during service cutover.

### Treat excluded photos as deletable

Rejected because published content already references excluded records directly.

### Publish editorial assets through a separate endpoint

Rejected because no consumer requires an editorial listing. Direct unlisted delivery plus explicit membership provides the necessary behavior and deletion safety.
