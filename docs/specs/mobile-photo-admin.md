# Mobile Photo Admin

## Decision

Build one mobile-first admin in `photos-api`. Do not revive the embedded photo
admin in `climb-log`; retain its climb mapper only until it consumes canonical
photo endpoints.

The first release optimizes for adding a few photos from an iPhone while still
working well for desktop batches. It is not a digital asset manager or an
offline background uploader.

## Current State

- Cloudflare Access protects `/admin*` and `/api/admin/*`.
- `/admin` supports search, filters, pagination, selection, and safe bulk
  publication/lifecycle updates.
- `/admin/upload` uploads JPEG, PNG, WebP, HEIC, and HEIF sequentially with SHA
  duplicate reuse, destination controls, and optional formal hike assignment.
- `/admin/photos/:id` edits metadata, lifecycle, visibility, hike assignment,
  references, and shows protected EXIF plus an interactive map.
- AI caption suggestions use the existing title corpus for tone and require
  explicit review and save.
- Direct deletion quarantines first, blocks unresolved references, deletes and
  verifies the R2 prefix, then removes D1 metadata.
- The older `feature/mcp` spike contains useful search and EXIF ideas, but its
  migration numbers conflict with the canonical migration chain. Reimplement
  deliberately instead of cherry-picking it.

## Upload Experience

### 1. Choose

- Add an **Upload** action to the admin header and an `/admin/upload` page.
- Use `<input type="file" accept="image/*" multiple>` with a large mobile tap
  target. Offer a separate camera action using `capture="environment"`.
- Show local thumbnails immediately and upload files one at a time with visible
  progress, retry, and per-file errors.
- Keep the queue in page state. Warn before navigating away while work remains;
  do not claim uploads continue after mobile Safari suspends the page.

### 2. Review

For each file, prefill and allow editing:

- title
- capture date
- location
- tags
- destination: **Portfolio**, **Editorial**, or **Private**

Defaults:

| Destination | visibility | exclude | collection |
|---|---|---:|---|
| Portfolio | `public` | `0` | `portfolio` |
| Editorial | `unlisted` | `1` | `kylies-photos-content` |
| Private | `private` | `1` | none |

Do not expose the legacy `site` field as the primary publishing control.

### 3. Confirm

- Return the canonical ID and a same-origin image URL.
- Render the generated 800px transform before declaring success.
- Provide **Add another**, **Edit details**, and **Copy image URL** actions.

## Upload Contract

Extend `POST /api/admin/upload` rather than adding another storage path.

1. Validate MIME type and size before reading the complete body.
2. Calculate SHA-256 and reject or reuse exact duplicates before writing R2.
3. Extract dimensions and safe EXIF fields. Never store the complete EXIF blob.
4. Write the original to `photos/{id}/original.{format}`.
5. Insert D1 metadata and collection membership using the selected destination.
6. Generate the 800px transform and return only after it resolves.
7. Delete the new R2 prefix if metadata insertion fails.

Use idempotency keys per selected file so a mobile retry cannot create a second
photo. Keep uploads sequential initially; bounded concurrency can be added after
measuring Worker and mobile behavior.

## iPhone Formats

JPEG, PNG, and WebP remain the server baseline. Test actual iOS Photo Library
and camera submissions before promising HEIC support. If HEIC reaches the
browser unchanged, extract its metadata and convert client-side to JPEG before
upload; do not store an original that browsers and current transforms cannot
reliably consume.

## Admin Improvements

After upload works:

1. Add title/tag/location search and visibility filters to `/admin`.
2. Turn the detail metadata table into an edit form backed by the existing
   PATCH endpoint.
3. Add explicit **Move to portfolio**, **Make unlisted**, and **Quarantine**
   actions with confirmation.
4. Show collection membership, aliases, climb links, SHA-256, and transform
   status on detail pages.
5. Redirect legacy `climb-log` photo admin routes to canonical admin. Keep the
   climb mapper separate until canonical climb-link APIs replace it.

## Security

- Keep Cloudflare Access JWT verification deny-by-default.
- Require same-origin requests for state-changing browser endpoints and add a
  CSRF token to admin forms.
- Never put Access credentials or storage tokens in browser JavaScript.
- Rate-limit uploads per authenticated identity and log photo ID, actor, size,
  destination, and result without logging tokens or image bytes.
- Preserve quarantine-before-delete and reference checks.

## Delivery Status

- [x] Mobile upload page, SHA dedupe, destination mapping, and transform verification
- [x] Editable metadata and visible save confirmation
- [x] Search, filters, pagination, selection, and bulk publication updates
- [x] HEIC profiling and production HEIC-to-WebP transform test
- [x] Protected EXIF, map review, and conservative known-location suggestions
- [x] AI caption suggestions with manual review
- [x] Reference inspection/unlinking and safe physical deletion
- [x] Formal hike selection on upload/edit and canonical primary previews
- [ ] Test camera capture and five-photo selection on physical iOS and Android devices
- [ ] Add explicit per-file idempotency keys beyond SHA duplicate detection
- [ ] Add upload rate limits and actor-aware audit records
- [ ] Add search/filtering to the hike selector on the edit page
- [ ] Switch `climb-log` gallery from compatibility listing to `portfolio`
- [ ] Redirect and retire legacy `climb-log` photo admin routes
- [ ] Stop legacy photo cron writes, then audit and retire duplicate D1/R2 storage

## Acceptance Checks

- [ ] Upload one camera photo and a five-photo library selection from an iPhone.
- [ ] Retry an interrupted upload without creating duplicate D1 or R2 records.
- [x] Upload a known duplicate and receive the existing canonical ID.
- [x] Verify Portfolio appears publicly; Editorial resolves by ID but is absent
  from listings; Private is unavailable publicly.
- [x] Edit metadata, copy a canonical URL, and see the 800px transform.
- [x] Confirm unauthenticated and cross-origin mutations fail.
