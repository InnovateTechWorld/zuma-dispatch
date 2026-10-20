/**
 * Outbound HTTP with a hard timeout and a typed result instead of exceptions.
 * Workers subrequests have no built-in time limit, so every call sets its own.
 */
export type HttpFailure = 'timeout' | 'network' | 'http' | 'parse';

export type HttpResult<T> =
  | { ok: true; status: number; data: T; headers: Headers; ms: number }
  | { ok: false; failure: HttpFailure; status: number | null; body: string | null; headers: Headers | null; ms: number };

export interface HttpOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

export const USER_AGENT = 'ZumaDispatch/0.1 (take-home demo; contact via https://zuma-dispatch.obimz123.workers.dev)';

export async function fetchJson<T>(url: string, opts: HttpOptions): Promise<HttpResult<T>> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    return {
      ok: false,
      failure: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
      status: null,
      body: null,
      headers: null,
      ms: Date.now() - started,
    };
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { ok: false, failure: 'network', status: res.status, body: null, headers: res.headers, ms: Date.now() - started };
  }
  if (!res.ok) {
    return { ok: false, failure: 'http', status: res.status, body: text.slice(0, 2000), headers: res.headers, ms: Date.now() - started };
  }
  try {
    return { ok: true, status: res.status, data: JSON.parse(text) as T, headers: res.headers, ms: Date.now() - started };
  } catch {
    return { ok: false, failure: 'parse', status: res.status, body: text.slice(0, 2000), headers: res.headers, ms: Date.now() - started };
  }
}

/** Short label for traces: "nominatim:ok:312ms", "ors:http502:4001ms". */
export function traceLabel(name: string, r: HttpResult<unknown>, extra = ''): string {
  const outcome = r.ok ? 'ok' : r.failure === 'http' ? `http${r.status}` : r.failure;
  return `${name}:${outcome}${extra ? `:${extra}` : ''}:${r.ms}ms`;
}
