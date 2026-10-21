import type { Config } from '../config';
import type { Env } from '../env';
import { escapeHtml as h } from '../lib/text';
import { readFlash } from './flash';
import { footLine, ICON, notice, page, themeSwitch, topBar, type Theme } from './layout';
import { readSignals, tabBadges, type Signals } from './signals';

/** Who is looking at the board: a signed-in browser (cookie) or a script (Basic auth), and their theme. */
export interface BoardSession { signedIn: boolean; theme: Theme }

export type Tab = 'home' | 'deliveries' | 'handovers' | 'payments' | 'system';

const TABS: { key: Tab; label: string; href: string; icon: string }[] = [
  { key: 'home', label: 'Home', href: '/board', icon: ICON.home },
  { key: 'deliveries', label: 'Deliveries', href: '/board/deliveries', icon: ICON.box },
  { key: 'handovers', label: 'Handovers', href: '/board/handovers', icon: ICON.chat },
  { key: 'payments', label: 'Payments', href: '/board/payments', icon: ICON.card },
  { key: 'system', label: 'System', href: '/board/system', icon: ICON.pulse },
];

/** The current page without the one-off flash parameters, as a safe place to come back to. */
export function hereWithoutFlash(url: URL): string {
  const p = new URLSearchParams(url.search);
  for (const k of ['msg', 'sig', 'tone']) p.delete(k);
  const q = p.toString();
  return url.pathname + (q ? `?${q}` : '');
}

function tabLinks(active: Tab | null, sig: Signals | null): string {
  const badges = sig ? tabBadges(sig) : {};
  return TABS.map((t) => {
    const b = badges[t.key];
    const count = b && b.n > 0 ? `<span class="count${b.urgent ? ' count--urgent' : ''}" aria-hidden="true">${b.n > 99 ? '99+' : b.n}</span>` : '';
    const sr = b && b.n > 0 ? `<span class="sr">, ${b.n} ${t.key === 'handovers' ? 'waiting' : t.key === 'deliveries' ? 'ready to dispatch' : t.key === 'system' ? 'to check' : 'need you'}</span>` : '';
    return `<li><a class="tab" href="${t.href}"${t.key === active ? ' aria-current="page"' : ''}>${t.icon}<span>${t.label}</span>${sr}${count}</a></li>`;
  }).join('');
}

export interface ShellOptions {
  env: Env;
  config: Config;
  session: BoardSession;
  url: URL;
  active: Tab | null;
  title: string;
  body: string;
  css?: string;
  status?: number;
  refreshSeconds?: number;
  /** Already read by the page (Home needs them too); read here otherwise. */
  signals?: Signals | null;
  /** Skip the signals read (e.g. a 404), so the page never waits on Chord. */
  noSignals?: boolean;
  foot?: string;
}

/** Every signed-in board page: bar, tabs (top row on desktop, bottom bar on phones), flash, body, footer. */
export async function shell(o: ShellOptions): Promise<Response> {
  const [sig, flash] = await Promise.all([
    o.signals !== undefined ? Promise.resolve(o.signals) : o.noSignals ? Promise.resolve(null) : readSignals(o.env, Date.now()).catch(() => null),
    readFlash(o.url, o.config.boardToken),
  ]);
  const links = tabLinks(o.active, sig);
  const end = `<span class="chip hide-sm">Test mode</span>${themeSwitch(o.session.theme, hereWithoutFlash(o.url))}${
    o.session.signedIn ? '<form class="inline" method="post" action="/board/logout"><button class="btn btn--sm btn--ghost" type="submit">Sign out</button></form>' : ''
  }`;
  return page({
    title: `${o.title} · ${o.config.businessName}`,
    status: o.status,
    refreshSeconds: o.refreshSeconds,
    css: o.css,
    theme: o.session.theme,
    bodyClass: 'has-tabbar',
    body: `<a class="skip" href="#main">Skip to content</a>
${topBar(o.config.businessName, end)}
<nav class="nav" aria-label="Board"><div class="wrap"><ul>${links}</ul></div></nav>
<main class="wrap main" id="main">${flash ? `<div class="flash">${notice(flash.msg, flash.error ? 'error' : 'info')}</div>` : ''}${o.body}</main>
${footLine(o.foot ?? `${h(o.config.businessName)} · test mode · times in WAT (UTC+1)`)}
<nav class="tabbar" aria-label="Board (bottom)"><ul>${links}</ul></nav>`,
  });
}

/** Page heading: title, an optional line under it, and optional controls on the right. */
export function pageHead(title: string, sub = '', end = '', crumb = ''): string {
  return `<div class="phead"><div>${crumb}<h1>${title}</h1>${sub ? `<p class="phead__sub">${sub}</p>` : ''}</div>${end ? `<div class="phead__end">${end}</div>` : ''}</div>`;
}

/** Second-level tabs inside a page (links, so each view has its own URL). */
export function subTabs(label: string, items: { href: string; label: string; n?: number; current: boolean }[]): string {
  return `<nav aria-label="${h(label)}"><ul class="subtabs">${items
    .map((i) => `<li><a class="tab" href="${h(i.href)}"${i.current ? ' aria-current="page"' : ''}>${h(i.label)}${i.n ? `<span class="count">${i.n > 99 ? '99+' : i.n}</span>` : ''}</a></li>`)
    .join('')}</ul></nav>`;
}

/** An empty state that says what would appear here and why it is empty. */
export function blank(title: string, text: string): string {
  return `<div class="blank"><b>${title}</b>${text}</div>`;
}
