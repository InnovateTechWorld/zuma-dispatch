import { escapeHtml as h } from '../lib/text';

/**
 * The visual system shared by every HTML page this Worker serves: the dispatcher board, its
 * sign-in page, the job detail page and the customer's payment-return page.
 * Design decisions are recorded in /design.md; change them there first.
 *
 * No JavaScript anywhere: the CSP forbids scripts, so every control (filters, actions, sign-out)
 * is a plain link or form and works with scripts disabled.
 */
export const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const HTML_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  // same-origin: our own form posts carry a real Origin; outside links (Paystack, Google, maps) get nothing.
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': CSP,
};

const FONTS = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap';

const CSS = `/* Hallmark · genre: modern-minimal · macrostructure: workbench (app variant) · theme: cobalt · enrichment: none (app page) · nav: N9 · footer: Ft2
 * Hallmark · pre-emit critique: P4 H5 E4 S5 R5 V4
 * contrast: pass (40–41) · deviations from cobalt: no ⌘K palette and no reveal script (CSP forbids scripts)
 */
:root{
  --color-paper:oklch(98.5% 0.004 250);--color-paper-2:oklch(96.2% 0.007 252);--color-surface:oklch(99.4% 0.002 250);
  --color-ink:oklch(24% 0.02 258);--color-ink-2:oklch(34% 0.018 257);--color-muted:oklch(48% 0.018 256);
  --color-rule:oklch(90.5% 0.008 255);--color-rule-2:oklch(82% 0.012 255);
  --color-accent:oklch(54% 0.2 257);--color-accent-hover:oklch(48% 0.2 258);--color-accent-ink:oklch(99% 0.003 250);
  --color-accent-text:oklch(50% 0.2 258);--color-accent-wash:oklch(95% 0.03 256);--color-focus:oklch(58% 0.2 256);
  --color-graphite:oklch(22% 0.016 260);--color-graphite-2:oklch(27% 0.018 260);--color-graphite-rule:oklch(35% 0.018 260);
  --color-graphite-ink:oklch(95% 0.006 250);--color-graphite-muted:oklch(75% 0.014 255);
  --color-bad:oklch(50% 0.19 27);--color-bad-wash:oklch(96% 0.025 27);--color-ok:oklch(48% 0.13 150);
  --st-awaiting_payment:oklch(48% 0.03 256);--st-paid:oklch(50% 0.2 258);--st-dispatched:oklch(48% 0.1 215);
  --st-delivered:oklch(47% 0.13 150);--st-payment_failed:oklch(51% 0.13 62);--st-amount_mismatch:oklch(50% 0.19 27);--st-cancelled:oklch(53% 0.01 256);
  --viz-awaiting_payment:oklch(72% 0.03 256);--viz-paid:oklch(66% 0.18 257);--viz-dispatched:oklch(75% 0.11 210);
  --viz-delivered:oklch(75% 0.15 152);--viz-payment_failed:oklch(80% 0.13 75);--viz-amount_mismatch:oklch(67% 0.18 27);--viz-cancelled:oklch(55% 0.012 256);
  --viz-track:oklch(31% 0.016 260);
  --font-display:"Space Grotesk",ui-sans-serif,system-ui,sans-serif;
  --font-body:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --font-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --space-3xs:.25rem;--space-2xs:.5rem;--space-xs:.75rem;--space-sm:1rem;--space-md:1.5rem;--space-lg:2rem;--space-xl:3rem;--space-2xl:4.5rem;
  --text-2xs:.6875rem;--text-xs:.75rem;--text-sm:.875rem;--text-base:.9375rem;--text-md:1.0625rem;--text-lg:1.375rem;--text-xl:1.75rem;--text-2xl:2.25rem;
  --radius:6px;--radius-lg:10px;--control:2.75rem;--control-sm:2.25rem;
  --ease-out:cubic-bezier(0.16,1,0.3,1);--dur:160ms;
}
@media (prefers-color-scheme:dark){:root{
  --color-paper:oklch(17% 0.014 258);--color-paper-2:oklch(21% 0.016 258);--color-surface:oklch(19.5% 0.015 258);
  --color-ink:oklch(95% 0.006 250);--color-ink-2:oklch(87% 0.01 252);--color-muted:oklch(72% 0.014 255);
  --color-rule:oklch(29% 0.016 258);--color-rule-2:oklch(40% 0.018 258);
  --color-accent:oklch(68% 0.16 257);--color-accent-hover:oklch(74% 0.14 257);--color-accent-ink:oklch(17% 0.02 260);
  --color-accent-text:oklch(77% 0.13 257);--color-accent-wash:oklch(26% 0.05 258);--color-focus:oklch(74% 0.15 256);
  --color-graphite:oklch(12.5% 0.012 260);--color-graphite-2:oklch(16% 0.014 260);--color-graphite-rule:oklch(27% 0.016 260);
  --color-bad:oklch(72% 0.16 27);--color-bad-wash:oklch(24% 0.05 27);--color-ok:oklch(76% 0.14 150);
  --st-awaiting_payment:oklch(76% 0.03 256);--st-paid:oklch(76% 0.14 257);--st-dispatched:oklch(80% 0.1 210);
  --st-delivered:oklch(80% 0.14 152);--st-payment_failed:oklch(83% 0.12 75);--st-amount_mismatch:oklch(74% 0.16 27);--st-cancelled:oklch(68% 0.01 256);
  --viz-track:oklch(24% 0.016 260);
}}
*,*::before,*::after{box-sizing:border-box}
html,body{overflow-x:clip}
html{-webkit-text-size-adjust:100%;color-scheme:light dark}
body{margin:0;background:var(--color-paper);color:var(--color-ink-2);font:400 var(--text-base)/1.55 var(--font-body);font-feature-settings:"cv11","ss01"}
a{color:var(--color-accent-text);text-decoration-thickness:1px;text-underline-offset:2px}
a:hover{color:var(--color-ink)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--color-focus);outline-offset:2px;border-radius:var(--radius)}
h1,h2,h3{font-family:var(--font-display);color:var(--color-ink);font-style:normal;letter-spacing:-0.02em;margin:0;overflow-wrap:anywhere;min-width:0}
h1{font-size:clamp(1.5rem,1.15rem + 1.2vw,2rem);font-weight:600;line-height:1.1}
h2{font-size:var(--text-lg);font-weight:600;line-height:1.2}
h3{font-size:var(--text-md);font-weight:600;line-height:1.3}
p{margin:0}
code,.mono{font-family:var(--font-mono);font-size:.92em}
.label{font:500 var(--text-2xs)/1.2 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--color-muted)}
.muted{color:var(--color-muted)}
.num{font-variant-numeric:tabular-nums}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.wrap{width:100%;max-width:80rem;margin:0 auto;padding-inline:clamp(1rem,3vw,2rem)}
.stack>*+*{margin-top:var(--space-sm)}

/* N9 · edge-aligned bar */
.bar{border-bottom:1px solid var(--color-rule);background:var(--color-paper)}
.bar__in{display:flex;align-items:center;justify-content:space-between;gap:var(--space-sm);min-height:3.5rem}
.brand{display:flex;align-items:center;gap:var(--space-2xs);text-decoration:none;color:var(--color-ink);font:600 var(--text-md)/1 var(--font-display);letter-spacing:-0.02em;white-space:nowrap}
.brand:hover{color:var(--color-ink)}
.brand__mark{width:.625rem;height:.625rem;border-radius:2px;background:var(--color-accent)}
.chip{display:inline-flex;align-items:center;gap:var(--space-3xs);height:1.375rem;padding:0 var(--space-2xs);border:1px solid var(--color-rule-2);border-radius:999px;font:500 var(--text-2xs)/1 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--color-muted);white-space:nowrap}
.bar__end{display:flex;align-items:center;gap:var(--space-xs)}
.bar__end a{white-space:nowrap;font-size:var(--text-sm)}

/* buttons — default · hover · focus-visible · active · disabled · loading · error · success */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-2xs);height:var(--control);padding:0 var(--space-sm);border:1px solid var(--color-rule-2);border-radius:var(--radius);background:var(--color-surface);color:var(--color-ink);font:500 var(--text-sm)/1 var(--font-body);white-space:nowrap;cursor:pointer;text-decoration:none;
  transition:background-color var(--dur) var(--ease-out),border-color var(--dur) var(--ease-out),color var(--dur) var(--ease-out)}
.btn:hover{border-color:var(--color-ink-2);background:var(--color-paper-2);color:var(--color-ink)}
.btn:active{background:var(--color-rule)}
.btn:disabled,.btn[aria-disabled="true"]{opacity:.55;cursor:not-allowed;border-color:var(--color-rule)}
.btn[aria-busy="true"]{cursor:progress;color:var(--color-muted)}
.btn[data-state="error"]{border-color:var(--color-bad);color:var(--color-bad)}
.btn[data-state="success"]{border-color:var(--color-ok);color:var(--color-ok)}
.btn--primary{background:var(--color-accent);border-color:var(--color-accent);color:var(--color-accent-ink)}
.btn--primary:hover{background:var(--color-accent-hover);border-color:var(--color-accent-hover);color:var(--color-accent-ink)}
.btn--primary:active{background:var(--color-accent-text);border-color:var(--color-accent-text)}
.btn--sm{height:var(--control-sm);padding:0 var(--space-xs);font-size:var(--text-xs)}
.btn--danger{color:var(--color-bad)}
.btn--danger:hover{border-color:var(--color-bad);color:var(--color-bad);background:var(--color-bad-wash)}
.btn--ghost{border-color:transparent;background:transparent}
form.inline{display:inline}
.actions{display:flex;flex-wrap:wrap;gap:var(--space-2xs);align-items:center}

/* fields — 1px border in every state; focus is an outline; helper slot reserved */
.field{display:grid;gap:var(--space-3xs)}
.field label{font:500 var(--text-sm)/1.3 var(--font-body);color:var(--color-ink)}
.input,.select{height:var(--control);width:100%;min-width:0;padding:0 var(--space-xs);border:1px solid var(--color-rule-2);border-radius:var(--radius);background:var(--color-surface);color:var(--color-ink);font:400 var(--text-base)/1 var(--font-body);outline:2px solid transparent;outline-offset:1px;
  transition:border-color var(--dur) var(--ease-out),background-color var(--dur) var(--ease-out)}
.input::placeholder{color:var(--color-muted);opacity:1}
.input:hover,.select:hover{border-color:var(--color-ink-2)}
.input:focus-visible,.select:focus-visible{outline:2px solid var(--color-focus);outline-offset:1px;border-color:var(--color-focus);border-radius:var(--radius)}
.input:disabled{opacity:.55;cursor:not-allowed}
.input[aria-invalid="true"]{border-color:var(--color-bad);background:var(--color-bad-wash)}
.helper{min-height:1lh;font-size:var(--text-sm);color:var(--color-muted)}
.helper--error{color:var(--color-bad)}

/* notices (flash messages) */
.notice{display:flex;gap:var(--space-xs);align-items:baseline;padding:var(--space-xs) var(--space-sm);border:1px solid var(--color-rule);border-radius:var(--radius);background:var(--color-paper-2);color:var(--color-ink);font-size:var(--text-sm)}
.notice--error{border-color:var(--color-bad);background:var(--color-bad-wash)}
.notice .label{flex:none}

/* status pills */
.pill{display:inline-flex;align-items:center;gap:var(--space-3xs);height:1.5rem;padding:0 var(--space-2xs);border:1px solid currentColor;border-radius:999px;font:500 var(--text-xs)/1 var(--font-body);white-space:nowrap}
.pill::before{content:"";width:.375rem;height:.375rem;border-radius:50%;background:currentColor}
${['awaiting_payment', 'paid', 'dispatched', 'delivered', 'payment_failed', 'amount_mismatch', 'cancelled'].map((s) => `.s-${s}{color:var(--st-${s})}.v-${s}{background:var(--viz-${s})}`).join('')}

/* tables */
.table-wrap{overflow-x:auto;border:1px solid var(--color-rule);border-radius:var(--radius-lg);background:var(--color-surface)}
table{border-collapse:collapse;width:100%;font-size:var(--text-sm)}
th,td{text-align:left;padding:var(--space-xs) var(--space-sm);border-bottom:1px solid var(--color-rule);vertical-align:top}
tr:last-child>td{border-bottom:0}
th{font:500 var(--text-2xs)/1.2 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--color-muted);white-space:nowrap;background:var(--color-paper-2)}
td .sub{display:block;margin-top:var(--space-3xs);font-size:var(--text-xs);color:var(--color-muted)}
tbody tr:hover>td{background:var(--color-paper-2)}
.empty{padding:var(--space-lg) var(--space-sm);color:var(--color-muted);text-align:left}

/* sections — hairlines do the work, no boxed cards */
.section{padding-block:var(--space-lg);border-top:1px solid var(--color-rule)}
.section__head{display:flex;flex-direction:column;gap:var(--space-3xs);margin-bottom:var(--space-sm)}
.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 var(--space-xl)}
details>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:var(--space-2xs);min-height:var(--control)}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"+";font-family:var(--font-mono);color:var(--color-muted);width:1ch}
details[open]>summary::before{content:"−"}

/* Ft2 · single line */
.foot{border-top:1px solid var(--color-rule);padding-block:var(--space-md) var(--space-lg);margin-top:var(--space-lg);font:400 var(--text-xs)/1.5 var(--font-mono);color:var(--color-muted)}

@media (max-width:48rem){
  .grid-2{grid-template-columns:minmax(0,1fr)}
  .bar__end .hide-sm{display:none}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

export interface PageOptions {
  title: string;
  body: string;
  status?: number;
  refreshSeconds?: number;
  headers?: Record<string, string>;
  /** Extra CSS appended after the shared system (page-specific components, still token-only). */
  css?: string;
}

export function page(opts: PageOptions): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">${opts.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : ''}
<title>${h(opts.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>${CSS}${opts.css ?? ''}</style></head><body>${opts.body}</body></html>`;
  return new Response(html, { status: opts.status ?? 200, headers: { ...HTML_HEADERS, ...opts.headers } });
}

/** WAT (UTC+1, no DST) "10-20 14:05 WAT". */
export const time = (ms: number) => new Date(ms + 3_600_000).toISOString().slice(5, 16).replace('T', ' ') + ' WAT';

export function statusPill(status: string): string {
  return `<span class="pill s-${h(status)}">${h(status.replaceAll('_', ' '))}</span>`;
}

export function notice(message: string | null, tone: 'info' | 'error' = 'info'): string {
  if (!message) return '';
  return `<div class="notice${tone === 'error' ? ' notice--error' : ''}" role="${tone === 'error' ? 'alert' : 'status'}"><span class="label">${tone === 'error' ? 'Problem' : 'Done'}</span><span>${h(message)}</span></div>`;
}

export function topBar(businessName: string, end: string): string {
  return `<header class="bar"><div class="wrap bar__in"><a class="brand" href="/board"><span class="brand__mark" aria-hidden="true"></span>${h(businessName)}</a><div class="bar__end">${end}</div></div></header>`;
}

export function footLine(text: string): string {
  return `<footer class="wrap"><p class="foot">${text}</p></footer>`;
}

/** The board's top bar: wordmark, test-mode chip, Handovers link and Sign out (session users only). */
export function boardBar(businessName: string, signedIn: boolean): string {
  return topBar(
    businessName,
    `<a href="/board/handovers">Handovers</a><span class="chip hide-sm">Test mode</span>${
      signedIn ? '<form class="inline" method="post" action="/board/logout"><button class="btn btn--sm btn--ghost" type="submit">Sign out</button></form>' : ''
    }`,
  );
}
