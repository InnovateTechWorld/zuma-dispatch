import { describe, expect, it } from 'vitest';
import { pickupWindow } from '../src/business/profile';
import { priceTrip } from '../src/business/rates';
import { loadConfig } from '../src/config';
import type { Env } from '../src/env';
import { judge } from '../src/geocode/chain';
import { findPostcode } from '../src/geocode/postcode';
import type { Candidate } from '../src/geocode/providers';
import { newHandoverCode, newJobId, normalizeId, paymentReference } from '../src/lib/ids';
import { formatNaira } from '../src/lib/money';
import { normalizeNigerianPhone } from '../src/lib/phone';
import { cleanPersonName, escapeHtml } from '../src/lib/text';

describe('rate card (examples match skill/references/rate-card.md)', () => {
  it.each([
    ['small', 2_000, '₦1,500'], // within the first 3 km
    ['small', 5_130, '₦1,950'], // Jabi Lake Mall -> Wuse Market by road: ceil(2.13)=3 extra km -> 1500+450
    ['medium', 12_400, '₦3,800'], // ceil(9.4)=10 -> 2000+1800
    ['large', 22_000, '₦9,200'], // ceil(19)=19 -> 3500+5700
  ] as const)('%s, %d m -> %s', (size, metres, total) => {
    expect(formatNaira(priceTrip(size, metres).totalKobo)).toBe(total);
  });
  it('never returns a fraction of a naira and always rounds up to ₦50', () => {
    for (let m = 0; m < 60_000; m += 777) {
      const k = priceTrip('medium', m).totalKobo;
      expect(k % 5_000).toBe(0);
    }
  });
});

describe('Nigerian phone numbers', () => {
  it.each(['0803 123 4567', '08031234567', '+234 803 123 4567', '2348031234567', '+234 0803 123 4567', '803-123-4567'])('accepts %s', (raw) => {
    const r = normalizeNigerianPhone(raw);
    expect(r.ok && r.e164).toBe('+2348031234567');
  });
  it('masks for display', () => {
    const r = normalizeNigerianPhone('08031234567');
    expect(r.ok && r.masked).toBe('+234 803 *** 4567');
  });
  it.each([
    ['0803123456', 'wrong_length'],
    ['0603 123 4567', 'not_nigerian_mobile'],
    ['call me', 'not_a_number'],
    ['+44 7700 900123', 'wrong_length'],
  ])('rejects %s (%s)', (raw, reason) => {
    const r = normalizeNigerianPhone(raw);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe(reason);
  });
});

describe('ids', () => {
  it('normalises ids the way customers type them', () => {
    expect(normalizeId('zd-7k3qp', 'ZD', 5)).toBe('ZD-7K3QP');
    expect(normalizeId('ZD7K3QP', 'ZD', 5)).toBe('ZD-7K3QP');
    expect(normalizeId('#ZD-7K3QO', 'ZD', 5)).toBe('ZD-7K3Q0'); // O typed for 0
    expect(normalizeId('ZD-7K3', 'ZD', 5)).toBeNull();
    expect(normalizeId("'; DROP TABLE jobs;--", 'ZD', 5)).toBeNull();
  });
  it('payment references use only characters Paystack allows', () => {
    for (let i = 0; i < 50; i++) expect(paymentReference(newJobId(), 3)).toMatch(/^[A-Za-z0-9.=-]+$/);
  });
  it('handover codes are 4 digits and never start with 0', () => {
    for (let i = 0; i < 200; i++) expect(newHandoverCode()).toMatch(/^[1-9]\d{3}$/);
  });
});

describe('NIPOST postcode detection', () => {
  it('finds the new format in any style and keeps the rest of the address', () => {
    expect(findPostcode('FC-02-A09-DB-09')).toMatchObject({ kind: 'nipost', code: 'FC-02-A09-DB-09', state: 'FC', lga: '02', rest: '' });
    expect(findPostcode('fc02a09db09')).toMatchObject({ code: 'FC-02-A09-DB-09' });
    expect(findPostcode('Banex Plaza, postcode FC 02 A09 DB 09')).toMatchObject({ code: 'FC-02-A09-DB-09', rest: 'Banex Plaza' });
  });
  it('ignores codes with an unknown state or a 00 segment', () => {
    expect(findPostcode('ZZ-02-A09-DB-09')).toBeNull();
    expect(findPostcode('FC-00-A09-DB-09')).toBeNull();
  });
  it('recognises legacy 6-digit codes but not phone numbers', () => {
    expect(findPostcode('Wuse 2, 900288')).toMatchObject({ kind: 'legacy', code: '900288', rest: 'Wuse 2' });
    expect(findPostcode('call 08031234567')).toBeNull();
  });
});

describe('geocoder judgement', () => {
  const c = (lat: number, lng: number, provider: Candidate['provider'] = 'nominatim'): Candidate => ({ label: `${lat},${lng}`, lat, lng, precision: 'exact', provider });
  const jabiShoprite = c(9.0755, 7.4250, 'photon');
  const lugbeShoprite = c(8.9800, 7.3700, 'nominatim');
  it('two providers agreeing within 400 m -> one candidate, high confidence', () => {
    const v = judge([c(9.0685, 7.4659)], [c(9.0686, 7.4658, 'photon')]);
    expect(v).toMatchObject({ ambiguous: false, confidence: 'high' });
    expect(v.candidates).toHaveLength(1);
  });
  it('providers disagreeing (the "Shoprite Lugbe" case) -> ambiguous, both offered', () => {
    const v = judge([lugbeShoprite], [jabiShoprite]);
    expect(v.ambiguous).toBe(true);
    expect(v.candidates).toHaveLength(2);
  });
  it('single provider, single answer -> medium confidence', () => {
    expect(judge([c(9.07, 7.42)], null)).toMatchObject({ ambiguous: false, confidence: 'medium' });
  });
  it('single provider returning far-apart places -> ambiguous', () => {
    expect(judge([jabiShoprite, lugbeShoprite], null).ambiguous).toBe(true);
  });
  it('nothing anywhere -> no candidates', () => {
    expect(judge([], [])).toMatchObject({ candidates: [] });
  });
});

describe('rider hours (WAT = UTC+1)', () => {
  it('Tuesday 10:00 WAT is within hours', () => {
    expect(pickupWindow(Date.UTC(2026, 9, 20, 9, 0)).now).toBe(true);
  });
  it('Tuesday 21:30 WAT -> tomorrow from 7am', () => {
    expect(pickupWindow(Date.UTC(2026, 9, 20, 20, 30)).note).toContain('tomorrow from 7am');
  });
  it('Saturday 21:00 WAT and Sunday -> Monday', () => {
    expect(pickupWindow(Date.UTC(2026, 9, 24, 20, 0)).note).toContain('Monday');
    expect(pickupWindow(Date.UTC(2026, 9, 25, 12, 0)).note).toContain('Monday');
  });
  it('Monday 06:30 WAT -> today', () => {
    expect(pickupWindow(Date.UTC(2026, 9, 26, 5, 30)).note).toContain('today');
  });
});

describe('config safety', () => {
  const base = {
    PAYSTACK_TEST_SECRET_KEY: 'sk_test_abc', NIPOST_API_KEY: 'nipost_test_abc', MCP_BEARER_TOKEN: 'x'.repeat(64), BOARD_TOKEN: 'y'.repeat(32),
    GEOCODER_CHAIN: 'nominatim,photon', GEOCODER_MODE: 'crosscheck', ROUTER_CHAIN: 'osrm,straight_line', QUOTE_TTL_MINUTES: '30', PROVIDER_TIMEOUT_MS: '4000',
  } as unknown as Env;
  it('accepts test keys', () => expect(loadConfig(base).ok).toBe(true));
  it('refuses a live Paystack key and names the variable without echoing it', () => {
    const r = loadConfig({ ...base, PAYSTACK_TEST_SECRET_KEY: 'sk_live_secret123' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.join()).toContain('PAYSTACK_TEST_SECRET_KEY');
    expect(!r.ok && r.problems.join()).not.toContain('secret123');
  });
  it('refuses a live NIPOST key, short tokens and unknown providers', () => {
    expect(loadConfig({ ...base, NIPOST_API_KEY: 'nipost_live_x' }).ok).toBe(false);
    expect(loadConfig({ ...base, MCP_BEARER_TOKEN: 'short' }).ok).toBe(false);
    expect(loadConfig({ ...base, GEOCODER_CHAIN: 'nominatim,bing' }).ok).toBe(false);
  });
});

describe('text safety', () => {
  it('cleans names and rejects junk', () => {
    expect(cleanPersonName('  Ada​  Obi \n')).toBe('Ada Obi');
    expect(cleanPersonName('12')).toBeNull();
    expect(cleanPersonName('http://x.com')).toBeNull();
  });
  it('escapes HTML', () => expect(escapeHtml('<b>"x"&</b>')).toBe('&lt;b&gt;&quot;x&quot;&amp;&lt;/b&gt;'));
});

describe('skill reference stays in sync with the pricing code', () => {
  it('every worked example in references/rate-card.md matches priceTrip', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const md = readFileSync(join(import.meta.dirname, '../skill/zuma-dispatch/references/rate-card.md'), 'utf8');
    const examples = [...md.matchAll(/^- (Small|Medium|Large), ([\d.]+) km.*?(₦[\d,]+)\**\.?$/gm)];
    expect(examples.length).toBeGreaterThanOrEqual(4);
    for (const [, size, km, total] of examples) {
      const s = size!.toLowerCase() as 'small' | 'medium' | 'large';
      expect(formatNaira(priceTrip(s, Number(km) * 1000).totalKobo), `${size} ${km} km`).toBe(total);
    }
  });
});

describe('bank transfer attempts', async () => {
  const { isAwaitingTransfer } = await import('../src/payments/service');
  const now = Date.UTC(2026, 9, 20, 12, 0);
  const row = (over: Record<string, unknown>) =>
    ({ method: 'bank_transfer', status: 'ongoing', transfer_expires_at: now + 20 * 60_000, ...over }) as never;
  it('an open transfer account with no money yet is awaiting transfer', () => {
    expect(isAwaitingTransfer(row({}), now)).toBe(true);
  });
  it('expired, paid, failed or card attempts are not', () => {
    expect(isAwaitingTransfer(row({ transfer_expires_at: now - 1 }), now)).toBe(false);
    expect(isAwaitingTransfer(row({ status: 'success' }), now)).toBe(false);
    expect(isAwaitingTransfer(row({ status: 'failed' }), now)).toBe(false);
    expect(isAwaitingTransfer(row({ method: 'link' }), now)).toBe(false);
  });
});

describe('secret comparison', async () => {
  const { secretsMatch, bearerToken, basicPassword } = await import('../src/lib/auth');
  it('matches only identical secrets, whatever the lengths', async () => {
    expect(await secretsMatch('abc', 'abc')).toBe(true);
    expect(await secretsMatch('abc', 'abd')).toBe(false);
    expect(await secretsMatch('', 'abc')).toBe(false);
    expect(await secretsMatch('abc'.repeat(100), 'abc')).toBe(false);
  });
  it('parses Bearer and Basic headers strictly', () => {
    const req = (v: string) => new Request('https://x', { headers: { Authorization: v } });
    expect(bearerToken(req('Bearer tok123'))).toBe('tok123');
    expect(bearerToken(req('Bearer'))).toBeNull();
    expect(bearerToken(req('Basic dTpw'))).toBeNull();
    expect(basicPassword(req(`Basic ${btoa('dispatcher:s3cret:x')}`))).toBe('s3cret:x');
    expect(basicPassword(req('Basic !!!'))).toBeNull();
  });
});

describe('board search', async () => {
  const { searchFilter } = await import('../src/web/pages');
  it('recognises a job id, a phone number, or free text', () => {
    expect(searchFilter('zd-k45v7')).toEqual({ sql: 'j.id = ?', binds: ['ZD-K45V7'] });
    expect(searchFilter('0803 123 4567')).toEqual({ sql: 'j.recipient_phone = ?', binds: ['+2348031234567'] });
    expect(searchFilter('Wuse')?.binds).toEqual(['%wuse%', '%wuse%', '%wuse%', '%wuse%']);
    expect(searchFilter('   ')).toBeNull();
  });
  it('strips LIKE wildcards so a search cannot match everything', () => {
    expect(searchFilter('%_%')?.binds[0]).toBe('%%');
  });
});

describe('NIPOST postcode areas', async () => {
  const { FCT_AREA_COUNCILS, findPostcode, namesLga } = await import('../src/geocode/postcode');
  const { withinKm, POSTCODE_AREA_KM } = await import('../src/tools/resolveAddress');
  const { stateOf } = await import('../src/business/states');

  it('knows all six FCT area councils; NIPOST\'s sandbox codes (Abaji) are inside our FCT coverage', () => {
    expect(Object.keys(FCT_AREA_COUNCILS).sort()).toEqual(['01', '02', '03', '04', '05', '06']);
    expect(findPostcode('FC-01-A01-KP-27')).toMatchObject({ kind: 'nipost', state: 'FC', lga: '01' });
    expect(FCT_AREA_COUNCILS['01']!.name).toBe('Abaji');
    for (const council of Object.values(FCT_AREA_COUNCILS)) expect(stateOf(council)).toBe('FC');
  });

  it('accepts a geocoder answer as an LGA only if it names that LGA (Photon returned the FCT Administration for Abaji)', () => {
    expect(namesLga('Abaji, FC', 'Abaji')).toBe(true);
    expect(namesLga('Federal Capital Territory Administration, Ahmadu Bello Way, Garki II', 'Abaji')).toBe(false);
    expect(namesLga('Agege, Lagos', 'Agege')).toBe(true);
  });

  it('keeps only landmark matches near the postcode area', () => {
    const abaji = FCT_AREA_COUNCILS['01']!;
    const wuseHospital = { lat: 9.0627, lng: 7.4687 };
    const nearAbaji = { lat: 8.48, lng: 6.95 };
    expect(withinKm([wuseHospital, nearAbaji], abaji, POSTCODE_AREA_KM)).toEqual([nearAbaji]);
  });
});

describe('service states: FCT and Lagos State, same-state deliveries only', async () => {
  const { stateOf } = await import('../src/business/states');
  const { preferState } = await import('../src/tools/resolveAddress');
  // Ground truth: OpenStreetMap's own state for each town (Nominatim addressdetails, 2026-10-20).
  const truth: [string, number, number, 'FC' | 'LA' | null][] = [
    ['Wuse', 9.0765, 7.4686, 'FC'], ['Abaji', 8.4737, 6.9445, 'FC'], ['Zuba', 9.0932, 7.216, 'FC'],
    ['Nyanya', 9.0228, 7.5693, 'FC'], ['Kubwa', 9.1527, 7.3411, 'FC'], ['Lugbe', 8.991, 7.3575, 'FC'],
    ['Suleja (Niger)', 9.2082, 7.1872, null], ['Mararaba (Nasarawa)', 9.029, 7.5932, null], ['Karu (Nasarawa)', 8.995, 7.7512, null],
    ['Ikeja', 6.6018, 3.3515, 'LA'], ['Lekki Phase 1', 6.4474, 3.4723, 'LA'], ['Epe', 6.5841, 3.9834, 'LA'],
    ['Badagry', 6.4393, 2.906, 'LA'], ['Ikorodu', 6.6191, 3.5041, 'LA'], ['Alagbado', 6.6597, 3.2558, 'LA'], ['Ijanikin', 6.4967, 3.1208, 'LA'],
    ['Ota (Ogun)', 6.6845, 3.233, null], ['Akute (Ogun)', 6.6815, 3.3747, null], ['Arepo (Ogun)', 6.7358, 3.419, null], ['Agbara (Ogun)', 6.5047, 3.1005, null],
    ['Kano', 12.0022, 8.592, null], ['Port Harcourt', 4.8156, 7.0498, null],
  ];
  it.each(truth)('%s', (_name, lat, lng, expected) => {
    expect(stateOf({ lat, lng })).toBe(expected);
  });

  it('with a state hint, drops matches in the other state but keeps out-of-area ones (and keeps all if nothing is left)', () => {
    const shopriteLekki = { lat: 6.4474, lng: 3.4723 };
    const shopriteJabi = { lat: 9.0765, lng: 7.4686 };
    const ota = { lat: 6.6845, lng: 3.233 };
    expect(preferState([shopriteJabi, shopriteLekki], 'LA')).toEqual([shopriteLekki]);
    expect(preferState([shopriteJabi, ota], 'LA')).toEqual([ota]);
    expect(preferState([shopriteJabi], 'LA')).toEqual([shopriteJabi]);
    expect(preferState([shopriteJabi, shopriteLekki], undefined)).toHaveLength(2);
  });
});
