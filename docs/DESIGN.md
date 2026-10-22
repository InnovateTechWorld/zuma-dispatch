---
name: Zuma Dispatch web pages
description: Cobalt instrument panel for the dispatcher board, its sign-in page, the job pages and the payment-return page.
colors:
  accent: "oklch(54% 0.2 257)"
  accent-hover: "oklch(48% 0.2 258)"
  accent-text: "oklch(50% 0.2 258)"
  accent-ink: "oklch(99% 0.003 250)"
  accent-wash: "oklch(95% 0.03 256)"
  focus: "oklch(58% 0.2 256)"
  paper: "oklch(98.5% 0.004 250)"
  paper-2: "oklch(96.2% 0.007 252)"
  surface: "oklch(99.4% 0.002 250)"
  ink: "oklch(24% 0.02 258)"
  ink-2: "oklch(34% 0.018 257)"
  muted: "oklch(48% 0.018 256)"
  rule: "oklch(90.5% 0.008 255)"
  rule-2: "oklch(82% 0.012 255)"
  graphite: "oklch(22% 0.016 260)"
  graphite-2: "oklch(27% 0.018 260)"
  graphite-rule: "oklch(35% 0.018 260)"
  graphite-ink: "oklch(95% 0.006 250)"
  graphite-muted: "oklch(75% 0.014 255)"
  bad: "oklch(50% 0.19 27)"
  bad-wash: "oklch(96% 0.025 27)"
  ok: "oklch(48% 0.13 150)"
  ok-wash: "oklch(96.5% 0.025 150)"
  warn: "oklch(51% 0.13 62)"
  warn-wash: "oklch(96.5% 0.03 75)"
  st-awaiting-payment: "oklch(48% 0.03 256)"
  st-paid: "oklch(50% 0.2 258)"
  st-dispatched: "oklch(48% 0.1 215)"
  st-delivered: "oklch(47% 0.13 150)"
  st-payment-failed: "oklch(51% 0.13 62)"
  st-amount-mismatch: "oklch(50% 0.19 27)"
  st-cancelled: "oklch(53% 0.01 256)"
  viz-awaiting-payment: "oklch(72% 0.03 256)"
  viz-paid: "oklch(66% 0.18 257)"
  viz-dispatched: "oklch(75% 0.11 210)"
  viz-delivered: "oklch(75% 0.15 152)"
  viz-payment-failed: "oklch(80% 0.13 75)"
  viz-amount-mismatch: "oklch(67% 0.18 27)"
  viz-cancelled: "oklch(55% 0.012 256)"
  viz-track: "oklch(31% 0.016 260)"
typography:
  display:
    fontFamily: "Space Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.5rem, 1.15rem + 1.2vw, 2rem)"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  figure:
    fontFamily: "Space Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Space Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Space Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "\"cv11\", \"ss01\""
  control:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1
  label:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.06em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.92em"
    fontWeight: 400
rounded:
  radius: "6px"
  radius-lg: "10px"
  full: "999px"
spacing:
  3xs: "0.25rem"
  2xs: "0.5rem"
  xs: "0.75rem"
  sm: "1rem"
  md: "1.5rem"
  lg: "2rem"
  xl: "3rem"
  2xl: "4.5rem"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.radius}"
    padding: "0 1rem"
    height: "2.75rem"
  button-hover:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.radius}"
    padding: "0 1rem"
    height: "2.75rem"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.accent-ink}"
  button-small:
    padding: "0 0.75rem"
    height: "2.25rem"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.bad}"
  button-danger-hover:
    backgroundColor: "{colors.bad-wash}"
    textColor: "{colors.bad}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius}"
    padding: "0 0.75rem"
    height: "2.75rem"
  input-invalid:
    backgroundColor: "{colors.bad-wash}"
    textColor: "{colors.ink}"
  pill:
    typography: "{typography.control}"
    rounded: "{rounded.full}"
    padding: "0 0.5rem"
    height: "1.5rem"
  chip:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0 0.5rem"
    height: "1.375rem"
  tab:
    textColor: "{colors.ink-2}"
    typography: "{typography.control}"
    height: "2.75rem"
  tab-current:
    textColor: "{colors.ink}"
  tabbar-tab:
    textColor: "{colors.ink-2}"
    height: "3.75rem"
  count:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.full}"
    height: "1.25rem"
  count-urgent:
    backgroundColor: "{colors.bad}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.full}"
    height: "1.25rem"
  notice:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius}"
    padding: "0.75rem 1rem"
  notice-warn:
    backgroundColor: "{colors.warn-wash}"
    textColor: "{colors.ink}"
  notice-error:
    backgroundColor: "{colors.bad-wash}"
    textColor: "{colors.ink}"
  team-notice:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius}"
    padding: "0.75rem 1rem"
  alert-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-2}"
    padding: "1rem"
  alert-row-urgent:
    backgroundColor: "{colors.bad-wash}"
  empty-state:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.radius-lg}"
    padding: "2rem 1rem"
  overview-band:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.radius-lg}"
  message-team:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius-lg}"
    padding: "0.75rem 1rem"
---

# Design System: Zuma Dispatch web pages

The locked design system for every HTML page the Worker serves: the five board tabs (Home,
Deliveries, Handovers, Payments, System), the job pages, the sign-in page, and the customer's
payment-return page (`/pay/return`). The tokens live in one place, `src/web/layout.ts`; change them
there and here together. Do not restyle a page on its own.

## Overview

**Creative North Star: "The Instrument Panel"**

Calm and precise, with real numbers only and no marketing copy. The audience is the dispatcher and
the business owner, on a laptop at a desk or a phone on the move; on `/pay/return`, a WhatsApp
customer for a few seconds. They come to see what is waiting, advance a job, check how a payment was
confirmed, and find one delivery fast.

Genre: modern-minimal. Theme: Cobalt. Cool near-white paper, one electric-blue signal, hairline
structure, tight 6 px radii. The board is a tabbed workbench: each tab holds one job, and Home is
an inbox of the things that need a person. Deviations from Cobalt: no ⌘K palette and no reveal
animation. The CSP allows **no scripts**, so every control (tabs, sub-tabs, filters, theme switch,
actions, sign-out) is a link or a form and works with JavaScript off.

**Key Characteristics:**
- Five tabs, each a real URL; sub-views are links with their own URLs too.
- Hairlines separate everything; no shadows, no boxed marketing cards.
- One accent, used for the current tab, the primary action, focus and the brand mark.
- Light, dark, or match device, chosen per browser and rendered on the server.
- Every figure is a D1 count labelled with what it counts and over which period.

## Colors

Cool, low-chroma neutrals carry the page; one cobalt blue signals; red, amber and green mean state,
never decoration. Every value is OKLCH. The frontmatter holds the light theme; the dark theme
overrides the same names.

### Primary
- **Cobalt** (`--color-accent`): primary button fill, focus ring family, the current tab's underline,
  the brand mark. Hover deepens it (`--color-accent-hover`).
- **Cobalt Text** (`--color-accent-text`): links, the "To do" tone, CTA labels in the alert list, the
  current tab's icon.
- **Cobalt Wash** (`--color-accent-wash`): the team notice banner, team bubbles in a handover, the
  pressed theme button, text selection.

### Neutral
- **Paper / Paper 2 / Surface** (`--color-paper`, `--color-paper-2`, `--color-surface`): page; table
  heads, hover rows, chat background; tables, fields, framed lists.
- **Ink / Ink 2 / Muted** (`--color-ink`, `--color-ink-2`, `--color-muted`): headings and values; body
  text; secondary text (at least 4.5:1).
- **Rule / Rule 2** (`--color-rule`, `--color-rule-2`): hairlines; control borders.
- **Graphite** (`--color-graphite` and its `-2`, `-rule`, `-ink`, `-muted`): the one dark band, on
  Deliveries › Overview only.

### State
- **Bad / Bad Wash**: urgent tone and badges, errors, stopped steps, undelivered messages, urgent
  alert rows.
- **Warn / Warn Wash**: the "Check" tone, the tries-left sign-in notice, warning chips.
- **Ok / Ok Wash**: working service chips, the "nothing needs you" mark.
- **Status text** (`--st-*`): one per job status, used by the pills. Awaiting payment = slate, paid =
  cobalt, dispatched = teal, delivered = green, payment failed = amber, amount mismatch = red,
  cancelled = grey.
- **Chart fills** (`--viz-*`, `--viz-track`): the same seven statuses at higher lightness, for the
  graphite band (at least 3:1).

### Dark theme

| Token | Dark | | Token | Dark |
|---|---|---|---|---|
| `--color-paper` | 17% 0.014 258 | | `--color-accent` | 68% 0.16 257 |
| `--color-paper-2` | 21% 0.016 258 | | `--color-accent-hover` | 74% 0.14 257 |
| `--color-surface` | 19.5% 0.015 258 | | `--color-accent-ink` | 17% 0.02 260 |
| `--color-ink` | 95% 0.006 250 | | `--color-accent-text` | 77% 0.13 257 |
| `--color-ink-2` | 87% 0.01 252 | | `--color-accent-wash` | 26% 0.05 258 |
| `--color-muted` | 72% 0.014 255 | | `--color-focus` | 74% 0.15 256 |
| `--color-rule` | 29% 0.016 258 | | `--color-bad` / `-wash` | 72% 0.16 27 / 24% 0.05 27 |
| `--color-rule-2` | 40% 0.018 258 | | `--color-ok` / `-wash` | 76% 0.14 150 / 23% 0.04 150 |
| `--color-graphite` | 12.5% 0.012 260 | | `--color-warn` / `-wash` | 83% 0.12 75 / 25% 0.045 75 |
| `--color-graphite-2` | 16% 0.014 260 | | `--viz-track` | 24% 0.016 260 |
| `--color-graphite-rule` | 27% 0.016 260 | | `--st-*` | about 76–83% L |

Graphite ink and muted, and the `--viz-*` fills, are the same in both themes.

### Named Rules
**The One Signal Rule.** The accent covers less than 5% of any screen. Row buttons are outlined. A
filled primary button appears once per view: Search, Sign in, Send, Take over, or the next step on a
job page.

**The Text Too Rule.** Colour never carries state alone. Every pill, tone, chip and badge also
carries its meaning as text (or screen-reader text for badges).

## Typography

**Display Font:** Space Grotesk 500/600 (fallback ui-sans-serif, system-ui)
**Body Font:** Inter 400/500/600 (fallback ui-sans-serif, system-ui, -apple-system, Segoe UI)
**Label/Mono Font:** JetBrains Mono 400/500 (fallback ui-monospace, SFMono-Regular, Menlo)

**Character:** a slightly technical grotesk for names and numbers, a neutral workhorse for text, and
a mono for anything a person might copy or compare.

### Hierarchy
- **Display**: page titles (`h1`). On the job page the title is the job id, set in mono 500.
- **Figure**: the big numbers on the Overview band. Home's "At a glance" figures use the headline size.
- **Headline**: section heads (`h2`).
- **Title**: `h3`, alert titles, service names, empty-state titles, handover names, step names (at
  the control size).
- **Body**: text and tables. Long lines stop at about 56–72ch.
- **Control**: buttons, tabs, pills, tone pills.
- **Label**: UPPERCASE mono for table heads, fact terms, chips, chart captions, message meta lines
  and the flash label.
- **Mono**: job ids, references, handover codes, plates, the footer.

### Named Rules
**The Upright Rule.** Headings are never italic. Numbers use tabular figures (`.num`).

**The No-Kicker Rule.** No labels above headings: no eyebrow, kicker or small caption over an h1, h2
or h3. A page title starts the page; a section head starts its section. The job page's back link
("← Deliveries") is navigation, not a label, and is the one thing allowed above an h1. Mono labels
name data (table heads, fact terms, figure terms, chart captions); they never introduce a heading.

## Layout

- **Container:** max width 80rem, inline padding clamp(1rem, 3vw, 2rem). Spacing scale 3xs to 2xl
  (0.25 to 4.5 rem).
- **Shell, every signed-in page:** skip link; the bar (N9: wordmark left; test-mode chip, theme
  switch and Sign out right); the tab row; the page; a one-line mono footer (Ft2) with "times in WAT
  (UTC+1)".
- **Page head:** h1 with an optional muted line under it (date, counts, "updated" time) and optional
  controls on the right (Auto-refresh, Check again).
- **Home:** h1 "Today"; the team notice if set; "Needs you"; "At a glance"; "Latest deliveries"
  (five rows). Sections sit `--space-xl` apart.
- **Deliveries:** sub-tabs List and Overview. List: search with the primary Search button, city and
  status filter chips, a result line, the jobs table. Overview: the graphite band.
- **Job page:** back link, job id, status pill, the Summary / Payment / Timeline sub-tabs, then the
  view.
- **Handovers:** waiting cards, then earlier ones. A conversation is a two-column grid (chat,
  20rem side panel). Under 64rem the side panel stacks first.
- **Payments:** sub-tabs To review, Paystack notifications and Chat notices. **System:** sub-tabs
  Status (the service rows) and Agent tool calls.
- **Breakpoint 48rem:** the tab row hides and a fixed bottom bar of five appears. Two-column grids
  stack. The test-mode chip hides in the board bar. The theme switch folds to one button.
- **Refresh:** opt-in only (Auto-refresh, 30 s meta refresh), with a Stop link.

**The No Sideways Rule.** No horizontal page scroll at 320 / 375 / 414 / 768 px (`overflow-x: clip`
on html and body). No clickable text wraps. Wide data tables scroll inside their own frame.

## Elevation & Depth

Flat. There are no shadows anywhere. Depth comes from tone: paper, then paper 2 for heads and hover,
then surface for framed lists and tables, all divided by 1 px hairlines. The only dark surface is
the graphite band on Deliveries › Overview, and its charts are server-rendered HTML/CSS. The phone
tab bar is fixed but flat: a top hairline on paper.

**The Hairline Rule.** Sections are separated by a 1 px rule, never by a shadow or a filled card.

## Shapes

- Controls, notices and the theme group: 6 px (`radius`).
- Table frames, framed lists (alerts, figures, services), empty states, chat bubbles, handover cards,
  the Overview band: 10 px (`radius-lg`).
- Pills, tone pills, chips, counts and filter chips: fully round.
- The brand mark and chart swatches: a 2 px square. Chart bars: 3 px.
- Borders are 1 px in every state. Dashed borders mean "nothing here" or "not a message": empty
  states, the locked composer, chat notices.

## Components

### Buttons
- **Default:** outlined, 44 px tall (`--control`), surface fill, rule-2 border. Hover darkens the
  border and fills paper 2. Active fills rule.
- **States:** focus-visible (2 px focus outline, offset 2 px, instant), disabled (opacity 0.55,
  `not-allowed`, native `disabled`), `aria-busy`, and `data-state` error / success.
- **Variants:** primary (cobalt fill), danger (Cancel; red text, red wash on hover), ghost (Sign out,
  the phone theme button, "Hand back to Zuma without replying"), small (36 px, `--control-sm`) for
  rows. List rows never show Cancel: it cannot be undone, so it lives on the job page.

### Fields
- A 1 px border in every state; focus is an outline plus a focus-coloured border; `aria-invalid`
  turns the border red and the fill red wash.
- A helper line whose height is reserved (`1lh`), so an error never shifts the page.

### Navigation: tabs
- **Desktop:** a row of five under the bar, each an authored 18 px icon plus a label. The current
  tab is ink, weight 600, with a cobalt icon and a 2 px cobalt underline on the row's hairline.
- **Phone (under 48rem):** a fixed bottom bar of five equal cells, 3.75rem tall (`--tabbar`), icon
  over a 2xs label, safe-area padding below. The current cell gets a 2 px cobalt line at its top
  (the middle half). The body reserves the bar's height.
- **Badges:** a round count after the label (top-right of the icon on phones), capped at "99+", with
  screen-reader text ("3 waiting"). Deliveries counts paid jobs ready to dispatch; Handovers counts
  chats waiting for a person; Payments counts reviews, stuck chats and failed notices; System counts
  failing services. Neutral badges are paper 2 with a rule-2 border. **Urgent badges are solid red**:
  Handovers whenever it has a count, Payments when a review or stuck chat is among them.

### Sub-tabs
- Links, so each view has its own URL (`/board/deliveries/overview`, `/board/jobs/ZD-…?view=payments`).
- Same tab type at 36 px, on a hairline, with the current one marked by a 2 px **ink** underline
  (the cobalt underline belongs to the main tabs). An optional neutral count follows the label.

### "Needs you" alert list (Home)
- One framed list (radius-lg, surface), rows divided by hairlines. Each row is a full-width link:
  title (title type) with a tone pill, a one-line detail (70ch max), and one CTA on the right
  ("Open handovers →"). On phones the CTA drops under the detail.
- **Tone pills:** Urgent (red), Check (amber, `--color-warn`), To do (cobalt text), For info (muted).
  Same shape as status pills, 22 px tall.
- **Urgent rows are tinted** red wash and stay tinted on hover. Other rows hover to paper 2.
- **Ranking:** urgent first (chats waiting, payments to review, chats stuck after a notice), then
  Check (sheet sync, Chord unreachable, misconfiguration, failed notices, broken tool calls), then To
  do (ready to dispatch), then For info (out with a rider). The heading shows the total and an
  "N urgent" count on the right.
- **Empty:** a framed row with a green dot, "Nothing needs you right now." and what would appear.

### "At a glance" figures (Home)
- Four cells in one frame divided by hairlines (two by two on phones): Booked today, Paid today,
  Awaiting payment now, Out with riders now.
- Each cell is a muted term, a headline-size tabular value, and a small line that **names its
  period** ("1 of them paid (WAT day)", "1 job, any booking day", "3 more ready to dispatch"). Cells
  that have a list link to it; the value turns cobalt on hover.

### Team notice banner
- The owner's optional announcement (`BOARD_ANNOUNCEMENT`, plain text, 280 characters) on Home and
  the sign-in page. Cobalt wash, cobalt 1 px border, radius 6 px, a megaphone icon, and a bold "Team
  notice:" lead-in. `role="note"`.

### Notices
- **Flash:** a one-line notice after an action with a mono label ("Done" / "Problem"), `role=status`
  / `alert`. Error tone uses red border and wash.
- **Sign-in, info:** a plain notice (`role=status`): "You are signed out." or a session that ended.
- **Sign-in, warning:** amber border and warn wash (`role=alert`) once three or fewer tries are left
  ("2 tries left before sign-in pauses for 15 minutes on this network.").
- **Sign-in, lockout:** the field's error helper says when to try again; the field and Sign in are
  disabled and the response is 429 with `Retry-After`.

### Theme switch
- A plain form posting to `/board/theme`; no script. Desktop: a three-button segmented group (Match
  device, Light, Dark; authored icons), 36 px cells divided by a hairline, `aria-pressed`. The
  pressed one is cobalt wash with cobalt text. Phones: one ghost button that moves to the next
  choice and names it.
- The choice is saved in the `zd_theme` cookie for a year (HttpOnly, SameSite=Lax); Match device
  deletes it. The server writes `data-theme` on `<html>`. Dark tokens apply under
  `prefers-color-scheme: dark` unless the choice is light, and always when it is dark.

### Empty state
- A dashed rule-2 frame, radius 10 px, 2rem by 1rem padding. A title in title type, then one
  sentence on what would appear here and why it is empty. Never a row of zeros.

### Service status rows (System)
- One framed list, a row per connection: name (title type) with a muted one-line role under it, a
  status chip, a detail sentence with the last-seen time, and small row buttons (View, Open, Resync
  all). On phones the four columns stack.
- **Chips:** round, mono uppercase label. Working / Receiving / On = ok; Needs a look / Unreachable =
  warn; Failed / Misconfigured / broke = bad; Off / Nothing yet / Quiet = neutral muted.

### Status pills and state chips
- **Pills:** round, 24 px, 1 px border and dot in the status colour, status as text.
- **State chips** (handovers): Waiting for you (cobalt text), Back with Zuma (muted), Paused (amber).
  Same shape.

### Tables and phone list rows
- Mono uppercase heads on paper 2; rows divided by hairlines; hover paper 2; framed at 10 px.
- **Jobs on phones (under 48rem):** the table drops its head and frame. Each job is one row block:
  **id · status pill · amount on one line**, then the route; row actions under it at full 44 px
  height. People, package and city live on the job page.
- **Filters on phones** fold into a `details` control: "Filters · Both cities · all statuses", which
  opens the same city and status chips. Desktop shows the chips inline.

### Job page
- **Progress steps:** Booked, Paid, Dispatched, Delivered as a 3 px track (cobalt done, half for
  current), horizontal on desktop and vertical on phones. A stopped state (payment failed, amount
  mismatch, cancelled) is red.
- **Next-step strip:** a framed row under the steps with one bold sentence on what happens next and
  the actions the status allows on the right (primary for dispatch and deliver, danger for Cancel).
- **Views (sub-tabs):** Summary (booking facts, pickup and drop-off, handover link, chat notice),
  Payment (quote breakdown, payment attempts, Paystack notifications; counted) and Timeline (every
  event with time, change and actor; counted).
- **Facts:** a two-column list, mono uppercase terms; one column on phones.

### Charts (`src/web/charts.ts`, Deliveries › Overview only)
- On the graphite band: four figures, then the pipeline (stacked status bar with a linked legend),
  7-day columns (paid vs not paid) and horizontal breakdown bars. Server-rendered HTML/CSS,
  `aria-hidden` with a text or table equivalent. Empty data gets a sentence, never a row of zeros
  pretending to be a chart.

### Handover conversation (`src/web/handovers.ts`)
- Chat bubbles on paper 2. Customer: left, surface. Zuma (AI): right, surface. Team: right, cobalt
  wash with a cobalt border, the one accent in the transcript. Notices (Chord's and ours): centred,
  dashed, muted.
- Each bubble has a mono meta line (who · time WAT) and pre-wrapped text. An undelivered message gets
  a red border and a "Not delivered" line.
- The composer is a textarea plus Send (primary) and Send and hand back (secondary), with a ghost
  "Hand back to Zuma without replying" under it. When Zuma holds the chat, a dashed lock panel offers
  Take over (primary).
- The side panel (state chip, customer, channel, job link) comes first on narrow screens.

### Motion
- Colour and border transitions only, 160 ms with `cubic-bezier(0.16, 1, 0.3, 1)`. None under
  `prefers-reduced-motion`. Focus rings appear instantly.

## Do's and Don'ts

### Do:
- **Do** take every colour and font from a token. Add any new value to `layout.ts` as a token first.
- **Do** label every figure with what it counts and over which period (days are WAT). Every figure
  is a D1 count.
- **Do** give every list one CTA per row and every view one filled primary button.
- **Do** make every control a link or a form, so it works with scripts off.
- **Do** pass every interpolated value through `escapeHtml`.
- **Do** keep sub-views on their own URLs so they can be shared and refreshed.

### Don't:
- **Don't** put a label, eyebrow or kicker above a heading.
- **Don't** use the graphite band anywhere but Deliveries › Overview.
- **Don't** add shadows or filled cards; separate with hairlines.
- **Don't** let colour alone carry a state.
- **Don't** invent numbers or show zeros as a chart.
- **Don't** cause horizontal page scroll at 320 px or wrap clickable text.
