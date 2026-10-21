import type { Config } from '../config';
import type { Env } from '../env';
import { basicPassword, secretsMatch } from '../lib/auth';
import { escapeHtml as h } from '../lib/text';
import { log } from '../lib/log';
import { announcement, announcementText, footLine, page, themeSwitch, topBar, type Theme } from './layout';
import { board } from './pages';
import {
  clearFailures, clientKey, countAttempt, countAttemptDetailed, createSession, crossSite, endSession, LOGIN_MAX_FAILURES,
  readTheme, safeBack, safeNext, SESSION_TTL_MS, sessionCookie, sessionValid, themeCookie,
} from './session';

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', ...headers } });
}

/**
 * Every /board request comes through here.
 * - /board/login (GET form, POST password) and /board/logout (POST) are handled directly.
 * - Anything else needs a session cookie, or HTTP Basic credentials (kept for scripts and curl;
 *   browsers are never challenged for them, so they always see the sign-in page instead).
 */
export async function boardGate(request: Request, url: URL, env: Env, config: Config, ctx: ExecutionContext, requestId: string): Promise<Response> {
  const now = Date.now();
  const theme = readTheme(request);
  // The theme switch works signed in or not (the sign-in page has it too). It only sets a cookie.
  if (url.pathname === '/board/theme') {
    if (request.method !== 'POST') return redirect('/board');
    const form = await request.formData().catch(() => new FormData());
    const back = safeBack(String(form.get('back') ?? ''));
    const choice = String(form.get('theme') ?? '');
    if (crossSite(request, url) || !['light', 'dark', 'auto'].includes(choice)) return redirect(back);
    return redirect(back, { 'Set-Cookie': themeCookie(url, choice as Theme) });
  }
  if (url.pathname === '/board/login') {
    if (request.method === 'POST') return signIn(request, url, env, config, now, requestId, theme);
    if (await sessionValid(env.DB, request, url, config.boardToken, now)) return redirect(safeNext(url.searchParams.get('next')));
    return loginPage(env, config, { next: safeNext(url.searchParams.get('next')), info: loginInfo(url.searchParams.get('msg')), theme });
  }
  if (url.pathname === '/board/logout') {
    if (request.method !== 'POST') return redirect('/board');
    if (crossSite(request, url)) return forbidden();
    await endSession(env.DB, request, url);
    return redirect('/board/login?msg=signed_out', { 'Set-Cookie': sessionCookie(url, '', 0) });
  }

  // Scripts may send HTTP Basic credentials. They count against the same failed-login limit as the
  // form, so Basic auth is not a faster way to guess the password.
  const basic = basicPassword(request);
  let viaBasic = false;
  if (basic !== null) {
    const key = await clientKey(request);
    const wait = await countAttempt(env.DB, key, now);
    if (wait > 0) return plain(429, 'Too many wrong passwords. Try again later.', { 'Retry-After': String(wait) });
    viaBasic = await secretsMatch(basic, config.boardToken);
    if (!viaBasic) {
      log('warn', 'board_basic_failed', { request_id: requestId });
      return plain(401, 'Wrong board password.');
    }
    await clearFailures(env.DB, key, now);
  }
  if (!viaBasic && !(await sessionValid(env.DB, request, url, config.boardToken, now))) {
    if (request.method === 'GET' || request.method === 'HEAD') {
      return redirect(`/board/login?next=${encodeURIComponent(safeNext(url.pathname + url.search))}`);
    }
    // A form posted after the session ended: nothing is changed; sign in and redo it.
    return redirect('/board/login?msg=expired');
  }
  return board(request, url, env, config, ctx, { signedIn: !viaBasic, theme });
}

function loginInfo(code: string | null): string | null {
  if (code === 'signed_out') return 'You are signed out.';
  if (code === 'expired') return 'Your session ended before that change was saved. Sign in and do it again.';
  return null;
}

function plain(status: number, text: string, headers: Record<string, string> = {}): Response {
  // No WWW-Authenticate header: browsers must never show their own password prompt.
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}

function forbidden(): Response {
  return page({ title: 'Forbidden', status: 403, body: `<main class="wrap" style="padding-block:var(--space-xl)"><h1>Request blocked</h1><p class="muted" style="margin-top:var(--space-2xs)">This form was submitted from another site. <a href="/board/login">Open the board directly</a> and try again.</p></main>` });
}

async function signIn(request: Request, url: URL, env: Env, config: Config, now: number, requestId: string, theme: Theme): Promise<Response> {
  if (crossSite(request, url)) return forbidden();
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return loginPage(env, config, { next: '/board', error: 'Something went wrong reading the form. Try again.', status: 400, theme });
  }
  const next = safeNext(String(form.get('next') ?? ''));
  const key = await clientKey(request);
  const { wait, failures } = await countAttemptDetailed(env.DB, key, now);
  if (wait > 0) {
    log('warn', 'board_login_locked', { request_id: requestId });
    return loginPage(env, config, {
      theme,
      next,
      error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}.`,
      status: 429,
      headers: { 'Retry-After': String(wait) },
      disabled: true,
    });
  }
  const password = String(form.get('password') ?? '').slice(0, 256);
  if (!password || !(await secretsMatch(password, config.boardToken))) {
    log('warn', 'board_login_failed', { request_id: requestId, empty: !password });
    const left = LOGIN_MAX_FAILURES - failures;
    return loginPage(env, config, {
      next,
      theme,
      error: password ? 'That password is not right.' : 'Enter the board password.',
      warning: password && left <= 3 ? (left > 0 ? `${left} ${left === 1 ? 'try' : 'tries'} left before sign-in pauses for 15 minutes on this network.` : 'No tries left. Sign-in from this network is paused for 15 minutes.') : null,
      disabled: Boolean(password) && left <= 0,
      status: 401,
    });
  }
  await clearFailures(env.DB, key, now);
  const token = await createSession(env.DB, config.boardToken, now);
  log('info', 'board_login', { request_id: requestId });
  return redirect(next, { 'Set-Cookie': sessionCookie(url, token, SESSION_TTL_MS / 1000) });
}

interface LoginState {
  next: string;
  theme: Theme;
  error?: string;
  info?: string | null;
  warning?: string | null;
  status?: number;
  headers?: Record<string, string>;
  disabled?: boolean;
}

const LOGIN_CSS = `
.login{min-height:100dvh;display:grid;grid-template-rows:auto 1fr auto}
.login__main{display:grid;grid-template-columns:minmax(0,25rem) minmax(0,22rem);justify-content:space-between;gap:var(--space-xl);align-items:start;padding-block:clamp(2.5rem,10vh,6rem) clamp(3rem,12vh,7rem)}
.login__form{display:grid;gap:var(--space-md)}
.login__lede{max-width:44ch;color:var(--color-muted);margin-top:var(--space-2xs)}
.login__notes{display:grid;gap:var(--space-2xs)}
.login__notes:empty{display:none}
.login__notes .announce{margin:0}
.notice--warn{border-color:var(--color-warn);background:var(--color-warn-wash)}
.login__fields{display:grid;gap:var(--space-sm)}
.login__fields .btn{width:100%}
.login__aside{display:grid;gap:var(--space-sm);padding-top:var(--space-sm);border-top:1px solid var(--color-rule);font-size:var(--text-sm);color:var(--color-ink-2)}
.login__aside h2{font-size:var(--text-md)}
.login__aside ul{margin:0;padding:0;list-style:none;display:grid;gap:var(--space-xs)}
.login__aside li{display:grid;gap:.125rem}
.login__aside li b{color:var(--color-ink);font-weight:600}
@media (max-width:48rem){.login__main{grid-template-columns:minmax(0,1fr);gap:var(--space-lg);padding-block:var(--space-lg) var(--space-xl)}}
`;

function loginPage(env: Env, config: Config, s: LoginState): Response {
  const error = s.error ?? '';
  const back = `/board/login${s.next !== '/board' ? `?next=${encodeURIComponent(s.next)}` : ''}`;
  const notes = [
    announcement(announcementText(env.BOARD_ANNOUNCEMENT)),
    s.info ? `<div class="notice" role="status"><span>${h(s.info)}</span></div>` : '',
    s.warning ? `<div class="notice notice--warn" role="alert"><span>${h(s.warning)}</span></div>` : '',
  ].join('');
  const body = `<div class="login">
${topBar(config.businessName, `<span class="chip">Test mode</span>${themeSwitch(s.theme, back)}`, null)}
<main class="wrap login__main" id="main">
  <form class="login__form" method="post" action="/board/login" novalidate>
    <div><h1>Sign in to the board</h1><p class="login__lede">Bookings Zuma takes on WhatsApp, their payments, and the chats handed to you.</p></div>
    <div class="login__notes">${notes}</div>
    <input type="hidden" name="next" value="${h(s.next)}">
    <input type="text" name="username" value="dispatcher" autocomplete="username" hidden>
    <div class="login__fields">
    <div class="field">
      <label for="password">Board password</label>
      <input class="input" id="password" name="password" type="password" autocomplete="current-password" required autofocus
        ${error ? 'aria-invalid="true" ' : ''}aria-describedby="password-help"${s.disabled ? ' disabled' : ''}>
      <p class="helper${error ? ' helper--error' : ''}" id="password-help"${error ? ' role="alert"' : ''}>${h(error)}</p>
    </div>
    <button class="btn btn--primary" type="submit"${s.disabled ? ' disabled' : ''}>Sign in</button>
    </div>
  </form>
  <aside class="login__aside" aria-labelledby="about-h">
    <h2 id="about-h">Before you sign in</h2>
    <ul>
      <li><b>Test mode</b><span>Payments use Paystack test keys. No real money moves.</span></li>
      <li><b>Home comes first</b><span>Chats waiting for a person, payments to review and anything broken are listed at the top.</span></li>
      <li><b>Staying signed in</b><span>12 hours on this browser. ${LOGIN_MAX_FAILURES} wrong passwords in 15 minutes pauses sign-in from your network.</span></li>
      <li><b>Password</b><span>The <code>BOARD_TOKEN</code> secret on the server. Ask the owner if you don’t have it.</span></li>
    </ul>
  </aside>
</main>
${footLine(`${h(config.businessName)} · dispatcher board · test mode`)}
</div>`;
  return page({ title: `Sign in · ${config.businessName}`, body, status: s.status, headers: s.headers, css: LOGIN_CSS, theme: s.theme });
}
