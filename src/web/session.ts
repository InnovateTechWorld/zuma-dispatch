/**
 * Dispatcher board sign-in: server-side sessions in D1 behind an HttpOnly cookie.
 *
 * - The cookie holds 32 random bytes; D1 stores only their SHA-256, so a database read cannot
 *   be replayed as a cookie.
 * - Each session remembers a fingerprint of BOARD_TOKEN. Rotating the secret signs everyone out.
 * - "Sign out" deletes the row, so a copied cookie stops working at once (not just at expiry).
 * - Failed passwords are counted per client IP (hashed). Ten in 15 minutes locks that IP out for
 *   the rest of the window.
 */

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 10;

const enc = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `__Host-` pins the cookie to this exact origin over HTTPS; plain HTTP (local dev) cannot use it. */
export function cookieName(url: URL): string {
  return url.protocol === 'https:' ? '__Host-zd_board' : 'zd_board';
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim() || null;
  }
  return null;
}

export function sessionCookie(url: URL, value: string, maxAgeSeconds: number): string {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${cookieName(url)}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${secure}`;
}

/** Only same-site board paths may be a post-login destination (no open redirect). */
export function safeNext(raw: string | null): string {
  if (!raw || raw.length > 300) return '/board';
  if (!/^\/board(\/[A-Za-z0-9-]+)*\/?(\?[A-Za-z0-9_.~%+=&-]*)?$/.test(raw)) return '/board';
  if (raw.startsWith('/board/login') || raw.startsWith('/board/logout')) return '/board';
  return raw;
}

async function passwordFingerprint(boardToken: string): Promise<string> {
  return (await sha256Hex(`zuma-board-session:${boardToken}`)).slice(0, 32);
}

export async function createSession(db: D1Database, boardToken: string, now: number): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await db.batch([
    db.prepare('DELETE FROM board_sessions WHERE expires_at < ?').bind(now),
    db
      .prepare('INSERT INTO board_sessions (token_hash, password_fp, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256Hex(token), await passwordFingerprint(boardToken), now, now + SESSION_TTL_MS),
  ]);
  return token;
}

export async function sessionValid(db: D1Database, request: Request, url: URL, boardToken: string, now: number): Promise<boolean> {
  const token = readCookie(request, cookieName(url));
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
  const row = await db
    .prepare('SELECT 1 AS ok FROM board_sessions WHERE token_hash = ? AND password_fp = ? AND expires_at > ?')
    .bind(await sha256Hex(token), await passwordFingerprint(boardToken), now)
    .first<{ ok: number }>();
  return Boolean(row);
}

export async function endSession(db: D1Database, request: Request, url: URL): Promise<void> {
  const token = readCookie(request, cookieName(url));
  if (token && /^[0-9a-f]{64}$/.test(token)) {
    await db.prepare('DELETE FROM board_sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }
}

/**
 * Is this form post coming from another site (CSRF)?
 * - Sec-Fetch-Site (all current browsers) is the most reliable signal: only same-origin passes
 *   ("none" means the user typed or reloaded it themselves).
 * - Otherwise a real Origin must match. "Origin: null" is what browsers send under a strict
 *   referrer policy or from sandboxed frames, so it is not trusted as same-site.
 * - Neither header (curl, scripts): allowed; the session cookie is SameSite=Strict anyway.
 */
export function crossSite(request: Request, url: URL): boolean {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = request.headers.get('Origin');
  if (origin === null) return false;
  return origin !== url.origin;
}

// ------------------------------------------------------------------ failed-login throttle
export async function clientKey(request: Request): Promise<string> {
  return sha256Hex(`zuma-board-ip:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`);
}

/** Seconds until this client may try again, or 0 if it may try now. */
export async function lockedFor(db: D1Database, key: string, now: number): Promise<number> {
  const row = await db
    .prepare('SELECT window_start, failures FROM board_login_failures WHERE ip_hash = ?')
    .bind(key)
    .first<{ window_start: number; failures: number }>();
  if (!row || now - row.window_start >= LOGIN_WINDOW_MS || row.failures < LOGIN_MAX_FAILURES) return 0;
  return Math.ceil((row.window_start + LOGIN_WINDOW_MS - now) / 1000);
}

/** Counts a failure; a window older than 15 minutes starts again at 1. */
export async function recordFailure(db: D1Database, key: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO board_login_failures (ip_hash, window_start, failures) VALUES (?1, ?2, 1)
       ON CONFLICT (ip_hash) DO UPDATE SET
         failures     = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE failures + 1 END,
         window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END`,
    )
    .bind(key, now, LOGIN_WINDOW_MS)
    .run();
}

export async function clearFailures(db: D1Database, key: string, now: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM board_login_failures WHERE ip_hash = ?').bind(key),
    db.prepare('DELETE FROM board_login_failures WHERE window_start < ?').bind(now - LOGIN_WINDOW_MS),
  ]);
}
