// `photos.site` stores one value per photo; consumers filter with
// `site = ? OR site = 'both'`. The admin presents it as a set of sites.

export type SiteCode = "climb-log" | "kylieis-online";
export type SiteValue = SiteCode | "both";

export const SITES: ReadonlyArray<{ code: SiteCode; label: string }> = [
  { code: "climb-log", label: "kylies.photos" },
  { code: "kylieis-online", label: "kylieis.online" },
];

export function isSiteCode(value: unknown): value is SiteCode {
  return SITES.some((site) => site.code === value);
}

export function sitesForValue(value: string | null): SiteCode[] {
  if (value === "both") return SITES.map((site) => site.code);
  return isSiteCode(value) ? [value] : [];
}

/** Accepts a stored value or a list of site codes; returns null for invalid or empty input. */
export function parseSite(input: unknown): SiteValue | null {
  if (input === "both" || isSiteCode(input)) return input;
  const values = Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
  const codes = new Set<SiteCode>();
  for (const value of values) {
    if (value === "both") SITES.forEach((site) => codes.add(site.code));
    else if (isSiteCode(value)) codes.add(value);
    else return null;
  }
  if (codes.size === 0) return null;
  return codes.size === SITES.length ? "both" : [...codes][0];
}

export function siteLabel(value: string | null): string {
  if (value === "both") return "both sites";
  return SITES.find((site) => site.code === value)?.label ?? (value || "no site");
}
