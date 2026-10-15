export interface LocationAnchor {
  location: string;
  latitude: number;
  longitude: number;
}

export interface LocationMatch {
  location: string;
  distanceKm: number;
  supportingPhotos: number;
}

export interface LocationLabel {
  location: string;
  count?: number;
}

const COORDINATE_LOCATION = /^-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+$/;
const GENERIC_TERMS = new Set([
  "alaska", "area", "arizona", "basin", "california", "canyon", "capitol",
  "colorado", "county", "creek", "death", "falls", "forest", "hawaii",
  "idaho", "lake", "lakes", "maine", "montana", "mount", "national",
  "nevada", "north", "oregon", "park", "pass", "peak", "pennsylvania",
  "range", "recreation", "south", "state", "utah", "washington", "wyoming",
]);
const FEATURE_TERMS = new Set(["basin", "canyon", "creek", "falls", "lake", "lakes", "pass", "peak"]);

export function isHumanLocation(location: string): boolean {
  return Boolean(location.trim()) && !COORDINATE_LOCATION.test(location.trim());
}

export function distanceKm(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number
): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const earthRadiusKm = 6371;
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians(longitudeB - longitudeA);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB))
    * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(a));
}

export function matchExistingLocation(
  latitude: number,
  longitude: number,
  anchors: LocationAnchor[],
  maximumDistanceKm = 40
): LocationMatch | null {
  const grouped = new Map<string, { labels: Map<string, number>; distances: number[] }>();

  for (const anchor of anchors) {
    if (!isHumanLocation(anchor.location)) continue;
    const distance = distanceKm(latitude, longitude, anchor.latitude, anchor.longitude);
    if (distance > maximumDistanceKm) continue;
    const normalized = anchor.location.trim().toLocaleLowerCase();
    const group = grouped.get(normalized) || { labels: new Map<string, number>(), distances: [] as number[] };
    group.labels.set(anchor.location.trim(), (group.labels.get(anchor.location.trim()) || 0) + 1);
    group.distances.push(distance);
    grouped.set(normalized, group);
  }

  const candidates = [...grouped.values()].map((group) => {
    const [location, supportingPhotos] = [...group.labels.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const distance = Math.min(...group.distances);
    return {
      location,
      distanceKm: distance,
      supportingPhotos,
      score: distance - Math.min(supportingPhotos - 1, 5) * 1.5,
    };
  }).sort((a, b) => a.score - b.score || a.distanceKm - b.distanceKm);

  if (!candidates[0]) return null;
  const { location, distanceKm: distance, supportingPhotos } = candidates[0];
  return { location, distanceKm: distance, supportingPhotos };
}

function terms(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/\d+/g, " ")
    .split(/[^a-z]+/)
    .filter((term) => term.length >= 4 && !GENERIC_TERMS.has(term)));
}

function allWords(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase().replace(/\.[^.]+$/, "").split(/[^a-z]+/).filter(Boolean));
}

export function matchExistingLocationText(
  hint: string,
  labels: LocationLabel[]
): { location: string; matchedTerms: string[] } | null {
  const hintTerms = terms(hint);
  const requiredFeatures = [...allWords(hint)].filter((term) => FEATURE_TERMS.has(term));
  if (hintTerms.size === 0) return null;
  const candidates = labels.flatMap((label) => {
    if (!isHumanLocation(label.location)) return [];
    const labelWords = allWords(label.location);
    if (requiredFeatures.some((feature) => !labelWords.has(feature))) return [];
    const matchedTerms = [...terms(label.location)].filter((term) => hintTerms.has(term));
    if (matchedTerms.length === 0) return [];
    return [{
      location: label.location,
      matchedTerms,
      score: matchedTerms.reduce((sum, term) => sum + term.length, 0),
      count: label.count || 1,
    }];
  }).sort((a, b) => b.score - a.score || b.count - a.count || a.location.localeCompare(b.location));

  if (!candidates[0]) return null;
  if (candidates[1] && candidates[1].score === candidates[0].score
    && candidates[1].count === candidates[0].count) return null;
  return { location: candidates[0].location, matchedTerms: candidates[0].matchedTerms };
}
