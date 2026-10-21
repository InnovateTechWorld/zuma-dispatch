# Design — Zuma Dispatch web pages

The locked design system for every HTML page the Worker serves: the dispatcher board (`/board`), its
sign-in page, the job pages, and the customer's payment-return page (`/pay/return`). The tokens live in
one place, `src/web/layout.ts`; change them there and here together. Do not restyle a page on its own.

## Who and what

- **Audience:** the dispatcher and the business owner, on a laptop at a desk or a phone on the move.
  On `/pay/return`, a WhatsApp customer for a few seconds.
- **Use:** see what is waiting, advance a job, check how a payment was confirmed, find one delivery fast.
- **Tone:** an instrument panel. Calm and precise, with real numbers only and no marketing copy.

## Genre · theme · structure

- **Genre:** modern-minimal. **Theme:** Cobalt: cool near-white paper, one electric-blue signal,
  hairline structure, tight 6 px radii.
- **Structure:** a tool-first workbench.
  - Header (N9: wordmark left, test-mode chip and Sign out right).
  - The things waiting on the dispatcher.
  - **One dark graphite band** holding the overview charts.
  - The deliveries list, then secondary panels.
  - One-line footer (Ft2).
- **Deviation from Cobalt:** no ⌘K palette and no reveal animation. The CSP allows **no scripts**, so
  every control is a link or a form and works with JavaScript off. A dark mode is added, following the
  device setting.

## Type

| Role | Face | Use |
|---|---|---|
| Display | Space Grotesk 500/600 | page titles, section heads, big figures, step names |
| Body | Inter 400/500/600 | text, tables, buttons, fields |
| Mono | JetBrains Mono 400/500 | job ids, references, UPPERCASE labels (0.06em tracking), table heads |

Headings are never italic. Display line-height is 1.1. Numbers use tabular figures (`.num`).

## Colour (OKLCH, light / dark)

| Token | Light | Dark | Role |
|---|---|---|---|
| `--color-paper` | 98.5% 0.004 250 | 17% 0.014 258 | page |
| `--color-surface` | 99.4% 0.002 250 | 19.5% 0.015 258 | tables, fields |
| `--color-ink` / `-2` | 24% 0.02 258 / 34% | 95% / 87% | headings / body |
| `--color-muted` | 48% 0.018 256 | 72% 0.014 255 | secondary text (≥ 4.5:1) |
| `--color-rule` | 90.5% 0.008 255 | 29% 0.016 258 | hairlines |
| `--color-accent` | 54% 0.2 257 | 68% 0.16 257 | primary button, focus, the brand mark |
| `--color-graphite` | 22% 0.016 260 | 12.5% 0.012 260 | the one dark band |
| `--st-*` | ~50% L | ~78% L | status text (pills), one per status |
| `--viz-*` | ~70% L | same | chart fills on graphite (≥ 3:1) |

- The accent covers less than 5% of any screen. Row buttons are outlined. A filled primary button
  appears once per view: Search, Sign in, or the next step on a job page.
- Status colours: awaiting payment = slate, paid = cobalt, dispatched = teal, delivered = green,
  payment failed = amber, amount mismatch = red, cancelled = grey. Every pill also carries the status
  as text.

## Space · shape · motion

- Spacing scale `--space-3xs` … `--space-2xl` (0.25 → 4.5 rem).
- Controls are 44 px (`--control`); compact row buttons are 36 px.
- Radii: 6 px controls, 10 px table frames, pills fully round. No shadows, no boxed cards: hairlines
  separate sections.
- Motion: colour and border transitions only, 160 ms ease-out. None under `prefers-reduced-motion`.
  Focus rings appear instantly (2 px outline).

## Components

- **Buttons:** default, hover, focus-visible, active, disabled (opacity + `not-allowed` + native
  `disabled`), `aria-busy`, and `data-state` error/success. Variants: primary, danger (Cancel),
  ghost (Sign out), small.
- **Fields:** a 1 px border in every state, focus as an outline, `aria-invalid` for errors, and a
  helper line whose height is reserved so an error never shifts the page.
- **Notices:** a one-line flash after an action ("Done" / "Problem"), `role=status` / `alert`.
- **Charts** (`src/web/charts.ts`): pipeline (stacked status bar + linked legend), 7-day columns
  (paid vs not paid), and horizontal breakdown bars. Server-rendered HTML/CSS. `aria-hidden` with a
  text or table equivalent. Empty data gets a sentence, never a row of zeros pretending to be a chart.
- **Tables:** mono uppercase heads. On phones (< 48 rem) the jobs table becomes two-column cards with
  labels.
- **Handover conversation** (`src/web/handovers.ts`): chat bubbles on `--color-paper-2`.
  - Customer: left, surface.
  - Zuma (AI): right, surface.
  - Team: right, `--color-accent-wash` with an accent border, the one accent in the transcript.
  - Notices (Chord's and ours): centred, dashed, muted.
  - Each bubble has a mono meta line (who · time WAT) and pre-wrapped text. An undelivered message gets a
    red border and a "Not delivered" line.
  - The composer is a textarea plus two buttons: Send (primary) and Send and hand back (secondary).
  - A side panel (state chip, customer, channel, job link) comes first on narrow screens.
- **State chips** (`.state`): Waiting for you (accent text), Back with Zuma (muted), Paused (amber).
  Same shape as status pills.
- **Progress steps:** Booked → Paid → Dispatched → Delivered, horizontal on desktop and vertical on phones.
  A stopped state (payment failed, amount mismatch, cancelled) is shown in red.

## Rules every page keeps

- No horizontal scroll at 320 / 375 / 414 / 768 px (`overflow-x: clip` on html and body). No clickable
  text wraps.
- Every colour and font comes from a token. Any new value is added as a token first.
- No invented numbers: every figure is a D1 count, and labels say what is counted and over which period
  (days are WAT).
- Every interpolated value goes through `escapeHtml`.
