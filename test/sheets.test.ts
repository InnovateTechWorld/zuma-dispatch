import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseServiceAccount, rowFromRange, signedAssertion, SHEETS_SCOPE } from '../src/sheets/google';
import { HEADERS, mirrorStatus, syncJob, toRow, type MirrorEnv } from '../src/sheets/mirror';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = {
  type: 'service_account',
  client_email: 'zuma-mirror@demo-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};
const SA_JSON = JSON.stringify(SA);
const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

afterEach(() => vi.restoreAllMocks());

describe('Google service-account auth', () => {
  it('signs an RS256 JWT that verifies with the public key, with the right claims', async () => {
    const jwt = await signedAssertion(parseServiceAccount(SA_JSON)!, 1_800_000_000);
    const [h, c, sig] = jwt.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${c}`);
    expect(verifier.verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims).toMatchObject({ iss: SA.client_email, scope: SHEETS_SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: 1_800_000_000, exp: 1_800_003_600 });
  });

  it('rejects malformed keys instead of failing later', () => {
    expect(parseServiceAccount('')).toBeNull();
    expect(parseServiceAccount('not json')).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ client_email: 'x' }))).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ client_email: 'x', private_key: 'abc' }))).toBeNull();
  });

  it('reads the row number from an updatedRange', () => {
    expect(rowFromRange('Deliveries!A7:P7')).toBe(7);
    expect(rowFromRange("'Deliveries'!A12:P12")).toBe(12);
    expect(rowFromRange(undefined)).toBeNull();
  });
});

describe('sheet rows', () => {
  const job = {
    id: 'ZD-AAAAA', status: 'awaiting_payment', created_at: Date.UTC(2026, 9, 20, 13, 0), updated_at: Date.UTC(2026, 9, 20, 13, 5), paid_at: null,
    sender_name: '=HYPERLINK("http://evil","x")', recipient_name: 'Bola Musa', recipient_phone: '+2348031234567', amount_kobo: 195000,
    pickup: 'Jabi Lake Mall', dropoff: 'Wuse Market', package_size: 'small', distance_m: 5130, method: 'bank_transfer', paid_via: null,
  };
  it('has one value per header, masks the phone, and keeps formula-looking text as text', () => {
    const row = toRow(job, 'https://x');
    expect(row).toHaveLength(HEADERS.length);
    expect(row[5]).toBe('+234 803 *** 4567');
    expect(row[3]).toBe('=HYPERLINK("http://evil","x")'); // written with valueInputOption=RAW (asserted below)
    expect(row[2]).toBe('2026-10-20 14:00'); // WAT
    expect(row[10]).toBe('₦1,950');
    expect(row[11]).toBe('Bank transfer');
    expect(row[15]).toBe('https://x/board/jobs/ZD-AAAAA');
  });
  it('reports configuration state', () => {
    const base = { DB: {} as D1Database, PROVIDER_TIMEOUT_MS: '4000' };
    expect(mirrorStatus(base)).toBe('not_configured');
    expect(mirrorStatus({ ...base, GOOGLE_SHEET_ID: SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON: '{bad' })).toBe('invalid_config');
    expect(mirrorStatus({ ...base, GOOGLE_SHEET_ID: 'short', GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON })).toBe('invalid_config');
    expect(mirrorStatus({ ...base, GOOGLE_SHEET_ID: SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON })).toBe('enabled');
  });
});

// ------------------------------------------------------------------ syncJob against a stubbed Google API
/** A D1 stand-in that answers syncJob's queries by what they look like. */
function mirrorDb(opts: { mappedRow?: number | null; mappedRows?: number }) {
  const writes: string[] = [];
  let mapped = opts.mappedRow;
  const db = {
    writes,
    prepare(sql: string) {
      const bound = (...args: unknown[]) => ({
          async first() {
            if (sql.includes('FROM jobs j')) {
              return { id: args[0], status: 'paid', created_at: 1, updated_at: 2, paid_at: 3, sender_name: 'Ada', recipient_name: 'Bola', recipient_phone: '+2348031234567', amount_kobo: 195000, pickup: 'A', dropoff: 'B', package_size: 'small', distance_m: 5000, method: 'link', paid_via: 'paystack_webhook' };
            }
            if (sql.startsWith('SELECT row_number')) return mapped === undefined ? null : { row_number: mapped };
            if (sql.includes('COUNT(*)')) return { n: opts.mappedRows ?? 0 };
            return null;
          },
          async run() {
            writes.push(sql.split(' ').slice(0, 3).join(' '));
            if (sql.startsWith('INSERT INTO sheet_rows')) {
              const fresh = mapped === undefined;
              if (fresh) mapped = null;
              return { meta: { changes: fresh ? 1 : 0 } };
            }
            if (sql.startsWith('DELETE FROM sheet_rows')) mapped = undefined;
            return { meta: { changes: 1 } };
          },
        });
      // Like D1, a statement can be run without bind() when it has no parameters.
      return Object.assign(bound(), { bind: bound });
    },
  };
  return db as unknown as D1Database & { writes: string[] };
}

function google(handlers: { append?: () => Response; update?: () => Response }) {
  const calls: { method: string; url: string; body?: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? String(init.body) : undefined });
    if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
    if (url.includes('fields=sheets.properties.title')) return Response.json({ sheets: [{ properties: { title: 'Deliveries' } }] });
    if (url.includes(':append')) return handlers.append?.() ?? Response.json({ updates: { updatedRange: 'Deliveries!A2:P2' } });
    if (init?.method === 'PUT') return handlers.update?.() ?? Response.json({ updatedRange: 'x' });
    return Response.json({});
  });
  return calls;
}

describe('syncJob', () => {
  const env = (db: D1Database): MirrorEnv => ({ DB: db, GOOGLE_SHEET_ID: SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON, PROVIDER_TIMEOUT_MS: '4000' });

  it('first job: writes the header, appends the row as RAW and remembers the row number', async () => {
    const db = mirrorDb({});
    const calls = google({});
    await syncJob(env(db), 'ZD-AAAAA', 'https://x');
    const append = calls.find((c) => c.url.includes(':append'))!;
    expect(append.url).toContain('valueInputOption=RAW');
    expect(calls.some((c) => c.method === 'PUT' && decodeURIComponent(c.url).includes('Deliveries!A1:Q1'))).toBe(true); // header
    expect(db.writes).toContain('UPDATE sheet_rows SET'); // row number stored
    expect(db.writes.some((w) => w.startsWith('INSERT INTO sheet_state'))).toBe(true);
  });

  it('known job: updates its own row in place', async () => {
    const calls = google({});
    await syncJob(env(mirrorDb({ mappedRow: 5, mappedRows: 9 })), 'ZD-AAAAA', 'https://x');
    expect(calls.some((c) => c.method === 'PUT' && decodeURIComponent(c.url).includes('Deliveries!A5:Q5'))).toBe(true);
    expect(calls.some((c) => c.url.includes(':append'))).toBe(false);
  });

  it('another sync is appending this job right now: does nothing (no duplicate row)', async () => {
    const calls = google({});
    await syncJob(env(mirrorDb({ mappedRow: null, mappedRows: 3 })), 'ZD-AAAAA', 'https://x');
    expect(calls.some((c) => c.url.includes('sheets.googleapis.com'))).toBe(false);
  });

  it('Google failing: releases the claim, records the failure, never throws', async () => {
    const db = mirrorDb({ mappedRows: 3 });
    google({ append: () => new Response('backend error', { status: 503 }) });
    await expect(syncJob(env(db), 'ZD-AAAAA', 'https://x')).resolves.toBeUndefined();
    expect(db.writes).toContain('DELETE FROM sheet_rows');
    expect(db.writes.some((w) => w.startsWith('INSERT INTO sheet_state'))).toBe(true);
  });

  it('mirror off: no Google calls at all', async () => {
    const calls = google({});
    await syncJob({ DB: mirrorDb({}), PROVIDER_TIMEOUT_MS: '4000' }, 'ZD-AAAAA', 'https://x');
    expect(calls).toHaveLength(0);
  });
});

describe('local servers do not write to the shared sheet', async () => {
  const { writesAllowed } = await import('../src/sheets/mirror');
  const env = { DB: {} as D1Database, PROVIDER_TIMEOUT_MS: '4000' };
  it('blocks localhost and 127.0.0.1 unless explicitly allowed; production is allowed', () => {
    expect(writesAllowed(env, 'http://127.0.0.1:8787')).toBe(false);
    expect(writesAllowed(env, 'http://localhost:8787')).toBe(false);
    expect(writesAllowed({ ...env, SHEET_MIRROR_ALLOW_LOCAL: '1' }, 'http://127.0.0.1:8787')).toBe(true);
    expect(writesAllowed(env, 'https://zuma-dispatch.obimz123.workers.dev')).toBe(true);
  });
});
