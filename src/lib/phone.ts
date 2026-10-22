/**
 * Nigerian mobile numbers. Accepts what people type on WhatsApp:
 * "0803 123 4567", "08031234567", "+234 803 123 4567", "2348031234567", "803-123-4567".
 * Mobile numbers are 0 + 10 digits; the first three national digits are 70x, 80x, 81x, 90x or 91x.
 */
export type PhoneResult =
  | { ok: true; e164: string; display: string; masked: string }
  | { ok: false; reason: 'not_a_number' | 'wrong_length' | 'not_nigerian_mobile' };

const MOBILE_PREFIX = /^(70|80|81|90|91)\d$/;

export function normalizeNigerianPhone(raw: string): PhoneResult {
  const trimmed = raw.trim();
  if (/[a-z]/i.test(trimmed)) return { ok: false, reason: 'not_a_number' };
  let digits = trimmed.replace(/[^\d]/g, '');
  if (digits.length === 0) return { ok: false, reason: 'not_a_number' };

  if (digits.startsWith('234')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  // A leading 0 after the country code ("+234 0803...") is a common typo.
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length !== 10) return { ok: false, reason: 'wrong_length' };
  if (!MOBILE_PREFIX.test(digits.slice(0, 3))) return { ok: false, reason: 'not_nigerian_mobile' };

  const e164 = `+234${digits}`;
  return {
    ok: true,
    e164,
    display: `+234 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`,
    masked: `+234 ${digits.slice(0, 3)} *** ${digits.slice(6)}`,
  };
}

/** "+2349076565434" → "0907 656 5434", the way Nigerians write it. */
export function localDisplay(e164: string): string {
  const d = e164.replace(/^\+234/, '');
  return `0${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

/** A valid-looking number that is probably a placeholder or typo: 08000000000, 08011111111, 08012345678. */
export function looksMadeUp(e164: string): boolean {
  const d = e164.replace(/^\+234/, '').slice(3); // the 7 subscriber digits
  if (/^(\d)\1{6}$/.test(d)) return true;
  return '01234567890'.includes(d) || '98765432109'.includes(d);
}

/**
 * What the customer reads when a phone number can't be used: what is wrong, and what a right one looks
 * like. `who` is "the recipient's" or "John's".
 */
export function phoneProblemMessage(raw: string, who: string): string {
  const r = normalizeNigerianPhone(raw);
  const digits = raw.replace(/[^\d]/g, '');
  const example = 'like 0803 123 4567';
  if (r.ok) return looksMadeUp(r.e164) ? `Just checking: is ${localDisplay(r.e164)} really ${who} number? It looks like a placeholder. If it's right, reply YES; if not, send the correct one.` : '';
  if (r.reason === 'not_a_number') return `I couldn't find a phone number in that. Could you send ${who} number? It should be 11 digits, ${example}.`;
  if (r.reason === 'not_nigerian_mobile') return `${raw.trim()} doesn't look like a Nigerian mobile number (they start with 070, 080, 081, 090 or 091). Could you check ${who} number and send it again?`;
  const national = digits.startsWith('234') ? digits.length - 3 + 1 : digits.startsWith('0') ? digits.length : digits.length + 1;
  return national < 11
    ? `${who[0]!.toUpperCase()}${who.slice(1)} number looks incomplete: I got ${digits.length} digits, and Nigerian mobile numbers have 11 (${example}). Could you send it again?`
    : `${who[0]!.toUpperCase()}${who.slice(1)} number looks too long: I got ${digits.length} digits, and Nigerian mobile numbers have 11 (${example}). Could you check it?`;
}
