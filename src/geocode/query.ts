/**
 * How customers write an address vs how the map has it. Live case (2026-10-22): "No 23 Saint Finbarrs
 * Road, Akoka" found nothing anywhere, while the map has "Finbarr road" in Bariga, next to Akoka; and
 * "Saint Finbarrs College, Akoka" (not on the map at all) came back as St Gregory's and St Mary's,
 * which share only "Saint" and "College". So:
 *  - retry with a cleaned-up spelling (no house number, "Saint" → "St", "Finbarrs Road" → "Finbarr Road");
 *  - drop results that share no distinctive word with what the customer typed;
 *  - if the place itself is not on the map, fall back to the area they named ("Akoka").
 * All pure, so it is unit-tested without the network.
 */

/** Words that say what kind of place it is, not which one. They never make a result relevant on their own. */
const GENERIC = new Set([
  'no', 'number', 'plot', 'house', 'block', 'flat', 'the', 'of', 'and', 'at', 'in', 'by', 'near', 'opposite', 'beside', 'behind', 'off', 'along', 'after', 'before',
  'saint', 'st', 'road', 'rd', 'street', 'avenue', 'ave', 'close', 'crescent', 'drive', 'way', 'lane', 'estate', 'junction', 'bus', 'stop', 'roundabout',
  'college', 'school', 'secondary', 'primary', 'university', 'church', 'mosque', 'market', 'mall', 'plaza', 'hotel', 'hospital', 'bank', 'filling', 'station',
  'area', 'phase', 'lagos', 'abuja', 'fct', 'nigeria', 'state', 'please', 'my', 'our', 'his', 'her', 'office', 'shop', 'gate', 'main', 'new', 'old',
]);
const TYPE_WORDS = /^(road|rd|street|st|avenue|ave|close|crescent|drive|way|lane|college|school|church|estate)$/;

const words = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);

/** The house number the customer gave ("No 23 …", "23, …", "Plot 5 …"), kept for the rider. */
export function houseNumber(text: string): string | null {
  const m = /^\s*(?:(?:no\.?|number|plot|house|block)\s*)?(\d{1,4}[a-z]?)\b[\s,]+(?=\D)/i.exec(text);
  return m ? m[1]!.toUpperCase() : null;
}

/** A spelling closer to how the map writes it, or null when it would be the same text. */
export function cleanedQuery(text: string): string | null {
  let s = text.replace(/^\s*(?:(?:no\.?|number|plot|house|block)\s*)?\d{1,4}[a-z]?\b[\s,]+(?=\D)/i, '');
  s = s.replace(/\bsaint\b/gi, 'St').replace(/\bst\.\s*/gi, 'St ').replace(/[’']s\b/gi, '').replace(/[’']/g, '');
  // "Finbarrs Road" → "Finbarr Road": a plural-looking name right before a type word is usually a possessive.
  s = s.replace(/\b([a-z]{4,})s(?=\s+(?:road|rd|street|avenue|close|crescent|drive|way|lane|college|school|church|estate)\b)/gi, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  return s && s.toLowerCase() !== text.trim().toLowerCase() ? s : null;
}

/** The area the customer named after the place ("…, Akoka", "… in Akoka Lagos"), if any. */
export function areaPart(text: string): string | null {
  const inMatch = /\b(?:in|at|around)\s+([a-z][a-z .-]{2,40})$/i.exec(text.trim());
  // "…, Akoka", "… in Akoka", or the words after the kind of place ("finbarrs school akoka lagos").
  const afterType = /\b(?:road|rd|street|avenue|close|crescent|drive|way|lane|college|school|church|estate|market|mall|hospital|hotel)\s+([a-z][a-z .-]{2,40})$/i.exec(text.trim());
  const after = inMatch?.[1] ?? (text.includes(',') ? text.slice(text.lastIndexOf(',') + 1) : afterType?.[1] ?? '');
  const area = words(after).filter((w) => !TYPE_WORDS.test(w)).join(' ');
  return area.length >= 3 && area !== text.trim().toLowerCase() ? area : null;
}

/** The words that identify this particular place ("finbarrs", "akoka"), without kinds of place or filler. */
export function distinctiveWords(text: string): string[] {
  return words(text).filter((w) => w.length >= 4 && !GENERIC.has(w) && !/^\d+[a-z]?$/.test(w));
}

/**
 * Is this map result the place the customer named? The first distinctive word is the place's own name
 * ("finbarrs" in "saint finbarrs school akoka lagos"; "akoka" after it is only the area), so it must
 * match. Compared on the first five letters, so "Finbarrs" matches "Finbarr". An abbreviation matches
 * the label's initials ("UNILAG", "LUTH"). With only generic words typed ("the school"), everything is kept.
 */
export function isRelevant(label: string, text: string): boolean {
  const want = distinctiveWords(text);
  if (!want.length) return true;
  const name = want[0]!;
  const have = words(label);
  const stem = name.slice(0, 5);
  if (have.some((h) => h.startsWith(stem) || (h.length >= 4 && name.startsWith(h.slice(0, 5))))) return true;
  const initials = label.split(/[\s,()/-]+/).filter((w) => /^[A-Z]/.test(w) && !/^(of|and|the)$/i.test(w)).map((w) => w[0]!.toLowerCase()).join('');
  return name.length <= 7 && initials.includes(name);
}
