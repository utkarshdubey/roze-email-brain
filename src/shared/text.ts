// Hashing (cache keys, stable ids), text tidying, and name comparisons. Nothing here guesses that two
// names are the same thing; it reports what is literally compatible and leaves the judgement to callers.

import { createHash } from "node:crypto";

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Locale-independent, so a sorted brain renders identically on every machine. */
export function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

const ORGANIZATION_STOPWORDS = new Set([
  "and",
  "aps",
  "co",
  "com",
  "company",
  "corp",
  "corporation",
  "dk",
  "for",
  "inc",
  "incorporated",
  "limited",
  "llc",
  "ltd",
  "net",
  "of",
  "org",
  "plc",
  "so",
  "the",
  "us",
  "usa",
]);

/** By code point, so a truncated subject never ends mid-emoji. */
export function sliceCharacters(value: string, limit: number): string {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError("text limit must be a non-negative integer");
  return Array.from(value).slice(0, limit).join("");
}

export function cleanText(value: unknown, limit = 500): string {
  const source = value === null || value === undefined || value === false || value === 0 ? "" : value;
  return sliceCharacters(String(source).split(/\s+/u).filter(Boolean).join(" "), limit);
}

/** Marketing mail pads previews with invisible joiners and zero-width characters. */
export function cleanSnippet(value: string): string {
  return value
    .replace(/[\u034f\u200b-\u200d\u2060\ufeff\u00ad]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function createSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 60) || "unnamed";
}

/** NFKD + case-fold identity key (ß→ss, final sigma folded, marks stripped); guesses nothing. */
export function normalizeNameKey(name: string): string {
  const caseFolded = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ς/g, "σ")
    .replace(/\p{M}/gu, "");
  return (caseFolded.match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}

function splitOrganizationName(value: string): { compact: string; parts: Set<string> } {
  const tokens = normalizeNameKey(value).split(" ").filter(Boolean);
  const meaningful = tokens.filter((token) => !ORGANIZATION_STOPWORDS.has(token));
  const parts = new Set(meaningful.length > 0 ? meaningful : tokens);
  return { compact: [...parts].sort().join(""), parts };
}

function setIsSubset(left: Set<string>, right: Set<string>): boolean {
  for (const token of left) {
    if (!right.has(token)) return false;
  }
  return true;
}

export function organizationNamesAreCompatible(a: string, b: string): boolean {
  const left = splitOrganizationName(a);
  const right = splitOrganizationName(b);
  if (left.parts.size === 0 || right.parts.size === 0) return false;
  return left.compact === right.compact || setIsSubset(left.parts, right.parts) || setIsSubset(right.parts, left.parts);
}

export function textContainsWholeName(text: string, name: string): boolean {
  const needle = name.trim().toLowerCase();
  if (needle.length < 3) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "u").test(text.toLowerCase());
}

export function wordsFromText(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/ß/g, "ss")
      .replace(/ς/g, "σ")
      .match(/[a-z0-9]+/g) ?? []
  );
}
