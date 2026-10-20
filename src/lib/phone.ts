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
