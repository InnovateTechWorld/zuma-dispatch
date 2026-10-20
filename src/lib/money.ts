/** Formats integer kobo as a naira string for WhatsApp, e.g. 345000 -> "₦3,450". */
export function formatNaira(kobo: number): string {
  if (!Number.isInteger(kobo)) throw new Error(`kobo must be an integer, got ${kobo}`);
  const naira = kobo / 100;
  const hasKobo = kobo % 100 !== 0;
  return `₦${naira.toLocaleString('en-NG', {
    minimumFractionDigits: hasKobo ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

/** Rounds kobo up to the nearest `step` naira (prices end in a round number). */
export function roundUpToNaira(kobo: number, stepNaira: number): number {
  const step = stepNaira * 100;
  return Math.ceil(kobo / step) * step;
}
