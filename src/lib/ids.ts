// Crockford-style alphabet without I, L, O, U: easy to read aloud and type on a phone.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomCode(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 32]; // 256 is a multiple of 32, so no modulo bias
  return out;
}

export const newPlaceId = () => `P-${randomCode(8)}`;
export const newQuoteId = () => `Q-${randomCode(8)}`;
export const newJobId = () => `ZD-${randomCode(5)}`;

/** Paystack references allow only alphanumerics, '-', '.' and '='. */
export const paymentReference = (jobId: string, attempt: number) => `${jobId}-${attempt}`;

/** Four-digit code the sender gives the recipient for handover. Never starts with 0 to avoid WhatsApp trimming. */
export function newHandoverCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 9000;
  return String(1000 + n);
}

/**
 * Accepts ids the way people actually type them on WhatsApp: lower case, spaces,
 * missing hyphen, O instead of 0. Returns the canonical form or null.
 */
export function normalizeId(raw: string, prefix: 'P' | 'Q' | 'ZD', bodyLength: number): string | null {
  const cleaned = raw
    .toUpperCase()
    .replace(/[\s_]/g, '')
    .replace(/^#/, '');
  const body = cleaned.startsWith(`${prefix}-`)
    ? cleaned.slice(prefix.length + 1)
    : cleaned.startsWith(prefix)
      ? cleaned.slice(prefix.length)
      : cleaned;
  const fixed = body.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (fixed.length !== bodyLength) return null;
  for (const ch of fixed) if (!ALPHABET.includes(ch)) return null;
  return `${prefix}-${fixed}`;
}
