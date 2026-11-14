// Image replacement keeps the photo ID, so /img/{id} URLs keep resolving but
// serve new bytes. Clients that cached the old bytes under an immutable header
// keep them; a version query parameter (ignored by /img) gives fresh URLs.

export function imageVersion(photo: { sha256: string | null; updated_at: string }): string {
  if (photo.sha256) return photo.sha256.slice(0, 12);
  return photo.updated_at.replace(/\D/g, "");
}

export function versionedImagePath(id: string, version: string, width?: number): string {
  const params = new URLSearchParams();
  if (width) params.set("w", String(width));
  params.set("v", version);
  return `/img/${id}?${params}`;
}

// Everything under the photo prefix except the new original was derived from,
// or is, the previous image: old originals, width transforms, transform sources.
export function staleObjectKeys(keys: string[], r2Key: string, keepKey: string): string[] {
  const prefix = `${r2Key}/`;
  return keys.filter((key) => key.startsWith(prefix) && key !== keepKey);
}
