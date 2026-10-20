// Control characters, zero-width characters, line/paragraph separators and BOM (ASCII-only source on purpose).
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\ufeff]', 'g');

/** Removes control characters and collapses whitespace. Keeps letters from any script. */
export function cleanText(raw: string, maxLength: number): string {
  return raw
    .normalize('NFC')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** A person's name: at least two letters, no URLs or digits-only strings. */
export function cleanPersonName(raw: string): string | null {
  const name = cleanText(raw, 80);
  if (name.length < 2) return null;
  if (/https?:\/\/|www\./i.test(name)) return null;
  const letters = name.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 2) return null;
  return name;
}

/** Escapes text for safe inclusion in HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Normalises a free-text query for cache keys: lower case, single spaces, no trailing punctuation. */
export function normalizeQuery(raw: string): string {
  return cleanText(raw, 300)
    .toLowerCase()
    .replace(/[.,;:!?]+$/g, '')
    .replace(/\s*,\s*/g, ', ');
}
