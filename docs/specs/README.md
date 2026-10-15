# Specification Status

Use this index before implementing an older plan. A document can remain useful
as history without remaining executable guidance.

| Document | Status | Recommendation |
|---|---|---|
| [`mobile-photo-admin.md`](./mobile-photo-admin.md) | Active, phase 1 shipped | Upload, editing, search, bulk actions, references, deletion, EXIF/HEIC, AI captions, maps, and hike mapping are live. Track remaining hardening in that spec. |
| [`canonical-photo-service.md`](./canonical-photo-service.md) | Active, refresh needed | Architecture remains authoritative. Rewrite migration-era sections after the local import and `climb-log` storage retirement complete. |
| [`../deploy-canonical-foundation.md`](../deploy-canonical-foundation.md) | Historical | Foundation deployment is complete. Keep for incident archaeology; do not execute its Wrangler-era commands. |
| [`../../TODO.md`](../../TODO.md) | Paused snapshot | Contains May 2026 counts, branches, and Wrangler commands. Replace useful remaining tasks with current issues/specs, then archive or delete it. |

## Suggested Next Specs

### Refresh entirely: post-import operations

Replace the old migration TODO with a short runbook covering import
verification, exact rollback manifests, collection curation, transform repair,
alias/reference audits, and backup/restore drills.

### Iterate: canonical consumer contract

After `climb-log` stops writing its local photo table, update both repositories'
consumer/service contracts around the final state: canonical metadata and R2,
same-origin image proxying, and no reverse synchronization.

### Implemented narrowly: AI captions and EXIF

The older `feature/mcp` spike must not be revived because its migrations
conflict. The replacement stores a reviewed subset of EXIF, keeps GPS protected,
and offers opt-in AI caption suggestions that never auto-save.
