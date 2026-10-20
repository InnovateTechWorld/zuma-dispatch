/**
 * Constant-time secret comparison. Both sides are hashed first so the comparison
 * length never depends on the secret, then compared with timingSafeEqual.
 */
export async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(provided)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** Extracts the token from "Authorization: Bearer <token>". Returns null if absent or malformed. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

/** Extracts the password from HTTP Basic auth (username is ignored). */
export function basicPassword(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match?.[1]) return null;
  try {
    const decoded = atob(match[1]);
    const idx = decoded.indexOf(':');
    return idx === -1 ? null : decoded.slice(idx + 1);
  } catch {
    return null;
  }
}
