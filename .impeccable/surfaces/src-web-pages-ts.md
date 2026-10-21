---
version: 1
slug: "src-web-pages-ts"
primary_target: "src/web/pages.ts"
related_targets: ["src/web/login.ts","src/web/handovers.ts"]
---

Scope: the dispatcher board (/board/*) and its sign-in page. Mode: Operate. Built code-first.

Audience and job: the dispatcher sees what needs a person, acts on it in one or two clicks, and
finds any delivery fast. The owner checks the day and integration health.

Constraints: the Cobalt world in design.md stays (user decision, 2026-10-21). No scripts (CSP).
Light and dark themes: follow the device, with a cookie toggle. 320 px to desktop.

## Direction contract
THESIS: a quiet five-tab workbench where Home is an inbox of things that need you. It replaces the
single long page that stacked every panel at once.
OWN-WORLD: Cobalt. Cool paper, hairline rules, one electric-blue signal for the current tab and the
primary action, mono for ids and measurements, a graphite band only for the Overview charts.
STORY: the dispatcher signs in and sees the alerts first, each with its one next action. The tabs
then hold one job each.
FIRST VIEWPORT: the bar holds the wordmark, tabs underlined in accent and the theme switch. Under
it come the h1 "Today", the announcement if one is set, a ranked alert list (urgent rows first,
each a full-width link), then four figures for today. On phones the tabs move to a fixed bottom bar
of five.
FORM: tabbed workbench; my first structure. seed: none (roll waived by the user: asked how far the redesign should go, they chose "Same look, new structure (Recommended)" — keep Cobalt, rebuild into the five pages Home, Deliveries, Handovers, Payments, System — on 2026-10-21; the structure was specified, so no concept roll ran).
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
