import { fetchJson, type HttpResult } from '../lib/http';

/**
 * Google service-account auth for the Sheets API, done with WebCrypto (no SDK, nothing that needs
 * Node): a JWT signed RS256 with the account's private key is exchanged for a 1-hour access token.
 * Docs: https://developers.google.com/identity/protocols/oauth2/service-account#httprest
 */
export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

export function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw?.trim()) return null;
  try {
    const sa = JSON.parse(raw) as Partial<ServiceAccount>;
    if (typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string' || !sa.private_key.includes('PRIVATE KEY')) return null;
    return { client_email: sa.client_email, private_key: sa.private_key, token_uri: sa.token_uri };
  } catch {
    return null;
  }
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Builds the signed assertion (exported for tests). */
export async function signedAssertion(sa: ServiceAccount, nowSeconds: number): Promise<string> {
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT' });
  const claims = b64urlJson({ iss: sa.client_email, scope: SHEETS_SCOPE, aud: sa.token_uri ?? TOKEN_URI, iat: nowSeconds, exp: nowSeconds + 3600 });
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`)));
  return `${header}.${claims}.${b64url(sig)}`;
}

let cached: { email: string; token: string; expiresAt: number } | null = null;

/** Returns a cached access token, refreshing a minute before expiry. Throws on failure. */
export async function accessToken(sa: ServiceAccount, timeoutMs: number): Promise<string> {
  const now = Date.now();
  if (cached && cached.email === sa.client_email && cached.expiresAt - 60_000 > now) return cached.token;
  const assertion = await signedAssertion(sa, Math.floor(now / 1000));
  const res = await fetch(sa.token_uri ?? TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) throw new Error(`google token: ${res.status} ${data.error ?? ''} ${data.error_description ?? ''}`.trim());
  cached = { email: sa.client_email, token: data.access_token, expiresAt: now + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

/** Thin Sheets v4 client. Every call has a timeout and returns a typed result. */
export class Sheets {
  constructor(
    private readonly sa: ServiceAccount,
    readonly spreadsheetId: string,
    private readonly timeoutMs: number,
  ) {}

  private async call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<HttpResult<T>> {
    const token = await accessToken(this.sa, this.timeoutMs);
    return fetchJson<T>(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      body,
      timeoutMs: this.timeoutMs,
    });
  }

  tabs() {
    return this.call<{ sheets?: { properties?: { title?: string } }[] }>('GET', '?fields=sheets.properties.title');
  }
  addTab(title: string) {
    return this.call('POST', ':batchUpdate', { requests: [{ addSheet: { properties: { title } } }] });
  }
  /** RAW: values are stored exactly as given, so "=HYPERLINK(...)" in a name stays text (no formula injection). */
  update(range: string, values: string[][]) {
    return this.call<{ updatedRange?: string }>('PUT', `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { range, majorDimension: 'ROWS', values });
  }
  append(range: string, values: string[][]) {
    return this.call<{ updates?: { updatedRange?: string } }>(
      'POST',
      `/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { range, majorDimension: 'ROWS', values },
    );
  }
  clear(range: string) {
    return this.call('POST', `/values/${encodeURIComponent(range)}:clear`, {});
  }
}

/** "Deliveries!A7:P7" -> 7 */
export function rowFromRange(range: string | undefined): number | null {
  const m = /![A-Z]+(\d+)(?::[A-Z]+\d+)?$/.exec(range ?? '');
  return m ? Number(m[1]) : null;
}
