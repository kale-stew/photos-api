export const MAX_TAG_SUGGESTIONS = 6;

export function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  }
}

function singular(tag: string): string {
  return tag.replace(/ies$/, "y").replace(/(?<!s)s$/, "");
}

/**
 * Turns a model's free-text answer into tags in the existing style: short,
 * lowercase, deduplicated, excluding tags the photo already has. A suggestion
 * that differs from a library tag only by plural form takes the library's
 * spelling, and library tags sort first so the vocabulary stays consistent.
 */
export function parseTagSuggestions(raw: string, vocabulary: string[], existing: string[]): string[] {
  const known = new Set(vocabulary.map((tag) => tag.toLowerCase()));
  const knownBySingular = new Map([...known].map((tag) => [singular(tag), tag]));
  const have = new Set(existing.map((tag) => tag.toLowerCase()));
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const piece of raw.split(/[,\n;]+/)) {
    const cleaned = piece
      .toLowerCase()
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
      .replace(/[#"'`.]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const tag = known.has(cleaned) ? cleaned : knownBySingular.get(singular(cleaned)) ?? cleaned;
    if (!tag || tag.length > 24 || !/^[a-z0-9][a-z0-9 -]*$/.test(tag)) continue;
    if (tag.split(" ").length > 3 || have.has(tag) || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return [...tags.filter((tag) => known.has(tag)), ...tags.filter((tag) => !known.has(tag))]
    .slice(0, MAX_TAG_SUGGESTIONS);
}
