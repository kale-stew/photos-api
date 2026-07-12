# Deploy Runbook: Canonical Foundation (main)

One-time deploy of the merged canonical photo service (`0003_canonical_photo_service.sql`
schema + alias-aware routes + Cloudflare Access enforcement) to production.

Run these from an **authenticated** shell (`wrangler whoami` shows the `kylieski`
account). The opencode personal profile shell is not authenticated for `--remote`;
this runbook is for a normal terminal.

## Current state (already done via MCP, verify before deploying)

Production `photos-db` is already migrated and backfilled:

- `d1_migrations` includes `0003_canonical_photo_service.sql`.
- `photo_aliases` has 1748 rows: 573 `notion-id`, 602 `canonical-short-id`,
  573 `legacy-short-id`. No collisions.
- Published short IDs resolve: `991d0662` → `807ba02e102a` (404 hero),
  `9943163a` → `e90d795c01ee` (OG default); both photos are `active`/`public`.

Verify:

```sh
wrangler d1 execute photos-db --remote --command \
  "SELECT (SELECT count(*) FROM photo_aliases) AS aliases,
          (SELECT group_concat(name) FROM d1_migrations) AS migrations"
```

The **running Worker is still the pre-canonical code**. It does not yet use
`resolvePhoto`, collections/people routes, or Access JWT verification. This
deploy activates them.

## Prerequisites (blockers)

1. **`wrangler.local.jsonc`** — gitignored; provides `account_id` and
   `database_id`. Without it `wrangler deploy` cannot resolve the target.
   Format is in `.env.example` / the `wrangler.jsonc` note.

2. **Cloudflare Access Worker vars** — the `requireAccess` middleware denies
   **every** `/admin*` and `/api/admin/*` request with `403` unless both are set
   (deny-by-default, by design). Set before/with deploy or admin goes dark:

   ```sh
   wrangler secret put CF_ACCESS_TEAM_DOMAIN   # e.g. <team>.cloudflareaccess.com
   wrangler secret put CF_ACCESS_AUD           # the Access application AUD tag
   ```

   (Or add them to `vars` in `wrangler.jsonc`/`wrangler.local.jsonc`. Never commit
   the values to the repo.) Confirm the Access application still fronts the
   `photos-api` admin routes in the Cloudflare dashboard.

3. **Dependencies** — `jose` is a runtime dep on `main`:

   ```sh
   npm install
   ```

## Deploy

```sh
npm install
npm run typecheck
# optional local smoke: npm run db:migrate:local && npm run test:local
npm run deploy            # wrangler deploy — NO predeploy sync hook on main
```

`main`'s `deploy` script is a plain `wrangler deploy`. Do **not** reintroduce the
`feature/mcp` `predeploy: sync:from-climb-log` hook — bidirectional sync is a
non-goal (see `docs/specs/canonical-photo-service.md`).

## Post-deploy verification

```sh
BASE=https://photos-api.<...>.workers.dev   # or the custom domain

# alias resolution (legacy short id -> canonical), public metadata
curl -s "$BASE/api/photos/991d0662" | jq '.id'          # 807ba02e102a
curl -s "$BASE/api/photos/9943163a" | jq '.id'          # e90d795c01ee
curl -sI "$BASE/img/991d0662" | head -1                  # 200

# collection + list still work
curl -s "$BASE/api/collections/portfolio/photos" | jq '.collection.slug'
curl -s "$BASE/api/photos?limit=1" | jq '.photos | length'

# Access enforcement: admin denies without a valid JWT
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api/admin/photos"   # 403
```

If admin returns `403` with a *valid* Access session, the `CF_ACCESS_*` values
are wrong — recheck the team domain (hostname or full origin) and AUD tag.

## Rollback

- Schema is additive; no DB rollback needed.
- To revert behavior, redeploy the previous Worker version
  (`wrangler rollback` or deploy the prior commit). The alias data remains and is
  harmless to the old code.
- Consumer (`climb-log`) cutover is a separate later change; nothing here touches
  the consumer or its local store.
