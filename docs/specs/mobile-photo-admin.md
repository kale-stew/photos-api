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
- `/admin` lists public, non-excluded photos and `/admin/photos/:id` displays
  metadata and generated sizes.
- `POST /api/admin/upload` accepts one JPEG, PNG, or WebP up to 20 MB.
- `PATCH /api/admin/photos/:id` edits metadata, lifecycle, and visibility.
- There is no upload UI, the detail page is read-only, and uploads do not use
  `sha256` for duplicate detection.
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

## Delivery Sequence

1. Upload page for JPEG/PNG/WebP, SHA dedupe, destination mapping, and immediate
   transform verification.
2. Mobile Safari and Android Chrome testing, including interruption and retry.
3. Editable detail page and admin search/filtering.
4. HEIC handling based on captured test files.
5. Retire the duplicate `climb-log` photo admin after redirects and climb mapper
   dependencies are verified.

## Acceptance Checks

- Upload one camera photo and a five-photo library selection from an iPhone.
- Retry an interrupted upload without creating duplicate D1 or R2 records.
- Upload a known duplicate and receive the existing canonical ID.
- Verify Portfolio appears publicly; Editorial resolves by ID but is absent
  from listings; Private is unavailable publicly.
- Edit metadata, copy a canonical URL, and see the 800px transform.
- Confirm unauthenticated and cross-origin mutations fail.
