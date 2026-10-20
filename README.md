# Zuma Dispatch: a WhatsApp delivery-booking agent on Chord

A Chord teammate for a made-up Abuja courier, **Zuma Dispatch**.
- A customer messages on WhatsApp with a pickup and a drop-off, in landmarks, street names or NIPOST postcodes.
- The agent finds both places, quotes a price the server calculates, books the job, sends a Paystack (test mode) payment link or bank-transfer account details and confirms payment with Paystack before telling the customer it's paid.
- Dispatchers see and advance jobs on a small board.

| | |
|---|---|
| Tool server (MCP) | `https://zuma-dispatch.obimz123.workers.dev/mcp` (bearer token) |
| Health | https://zuma-dispatch.obimz123.workers.dev/health |
| Admin / dispatcher board | https://zuma-dispatch.obimz123.workers.dev/board: every delivery, search and filters, job detail pages (Basic auth, password = `BOARD_TOKEN`) |
| Skill | [`skill/zuma-dispatch/`](skill/zuma-dispatch/SKILL.md) |
| Docs | [Features](docs/FEATURES.md) · [Architecture](docs/ARCHITECTURE.md) · [Edge cases](docs/EDGE_CASES.md) · [Field notes](docs/FIELD_NOTES.md) · [Research](notes/) |

Test keys and made-up data only. The server refuses to run with live Paystack or NIPOST keys.

## Repository layout

```
skill/zuma-dispatch/        SKILL.md + references/ (faq, rate-card) — uploaded to Chord
src/
  index.ts                  routing, auth (bearer / Basic), Origin check, /health
  mcp/                      stateless MCP server, tool wrapper (validation, errors, logging)
  tools/                    the 7 tools: index.ts (schemas + descriptions) and handlers
  geocode/                  NIPOST postcodes, provider adapters, chain + cross-check, D1 cache
  routing/                  OSRM → ORS → straight-line distance
  payments/                 Paystack client, pure payment decision, verification service
  business/                 business profile (service area, hours) and the rate card
  web/                      /pay/return and /board pages
  db/, lib/                 data access; ids, phone, money, text, geo, http helpers
migrations/                 D1 schema
test/                       unit tests (vitest, plain Node)
scripts/                    mcp-smoke.sh, e2e.py, check-skill.py
docs/, notes/               architecture, edge cases, field notes, research
```

## The tools

| Tool | What it does | Safety |
|---|---|---|
| `resolve_address(text, role)` | Landmark, address or postcode → `confirmed` / `ambiguous` / `needs_detail` / `not_found` / `out_of_area`, with a `place_id` | Geocoder cross-check; NIPOST validity + LGA; 40 km service area |
| `quote_delivery(pickup_place_id, dropoff_place_id, package_size)` | Road distance → rate card → `quote_id`, total, breakdown, valid 30 min | Price only from the server; same request → same quote |
| `create_dispatch_job(quote_id, names, recipient_phone, customer_confirmed: true)` | Books the job; returns job id + handover code | Needs explicit yes; one job per quote; amount copied from quote; phone normalised |
| `create_payment_link(job_id, method?)` | `link`: Paystack checkout (opens in WhatsApp; card, transfer, USSD). `bank_transfer`: one-time account number, bank and exact amount sent in the chat (30 min) | Reuses open details; checks Paystack first; timeout-safe references; warns if both methods are open |
| `verify_payment(job_id)` | Asks Paystack; `paid` only if status + amount + currency + reference match | Compare-and-set; double payment / paid-after-cancel → human review |
| `get_job_status(job_id)` | Status set by dispatchers, in plain words | Read-only |
| `cancel_job(job_id, reason)` | Cancels an unpaid job | Verifies Paystack first; paid jobs go to a human |

Every error carries a stable `code` and a `what_to_do` written for the model. Results are sent as
`structuredContent` and as JSON text.

## Address and routing providers (switchable)

Set in `wrangler.jsonc` → `vars`. A provider without a key is skipped automatically.

```jsonc
"GEOCODER_CHAIN": "google,nominatim,photon,ors",  // order matters
"GEOCODER_MODE": "crosscheck",                      // or "fallback"
"ROUTER_CHAIN": "osrm,ors,straight_line"
```

| Provider | Used for | Key | Free limits / policy | Measured here (2026-10-20) |
|---|---|---|---|---|
| NIPOST Postcode API | postcode validity (L1), LGA names | `NIPOST_API_KEY` (test) | Test key: free, 600/min; sandbox data effectively empty (FIELD_NOTES #1) | 0.6–0.7 s |
| Nominatim (OSM) | geocoding | none | ≤1 req/s, identifying UA, must cache; **tracking apps must self-host** | 0.3–1.1 s, good on landmarks |
| Photon (komoot) | geocoding | none | "please be fair", no SLA | 1–4 s, often > 4 s |
| Google Places (New) | geocoding (best Nigerian POI coverage) | `GOOGLE_MAPS_API_KEY` | Text Search Pro 5,000 free/month; needs billing account | not enabled |
| OpenRouteService | geocoding + routing fallback | `OPENROUTE_BASIC_KEY` | Geocoding 3,000/day, Directions 2,000/day | frequent 502s / 4 s timeouts; directions up to 18 s |
| OSRM demo | road distance | none | non-commercial, ≤1 req/s, no SLA | ~0.5 s |
| Paystack | payment links + verification | `PAYSTACK_TEST_SECRET_KEY` | Test mode 100 req/min | initialize ~0.9 s; a link request incl. verify ~0.4–1.7 s |

## Run it locally

Requirements: Node 20+ (tested on 24), a Cloudflare account, Paystack and NIPOST test keys.

```bash
npm install
```
```bash
npm install-scripts approve workerd esbuild   # npm 11 blocks install scripts by default
```
```bash
cp .env.example .env    # then fill in the keys; generate the two tokens with: openssl rand -hex 32
```
```bash
npm run db:migrate:local
```
```bash
npm run dev             # http://127.0.0.1:8787
```

Test it, no Chord credits needed:

```bash
npm test                              # 83 unit tests: pricing, payment decisions, geocoder judgement + timing, webhook signatures, Paystack failures, parsing, config
```
```bash
scripts/mcp-smoke.sh                  # protocol, auth, CSRF, webhook checks (18)
```
```bash
python3 scripts/e2e.py                # booking, payment, webhooks, lookup, lost-context guards and edge cases against real providers (42)
```
```bash
python3 scripts/check-skill.py        # skill package vs Chord's limits
```

To test a successful payment, open the printed checkout link and choose **Success** on
Paystack's test page (or card `4084 0840 8408 4081`, CVV `408`, any future expiry).

## Deploy

```bash
npx wrangler login
```
```bash
npx wrangler d1 create zuma_dispatch_v2 --location enam    # put the id in wrangler.jsonc
```
```bash
npm run db:migrate:remote
```
```bash
npx wrangler secret bulk secrets.json   # JSON of the secrets in .env.example; delete the file afterwards
```
```bash
npm run deploy && scripts/mcp-smoke.sh https://<your-worker>.workers.dev
```

## Webhooks (payment and escalation alerts)

| From | Our URL | Set it in | Secret |
|---|---|---|---|
| Paystack (payment landed) | `/hooks/paystack` | Paystack Dashboard → Settings → API Keys & Webhooks → Test Webhook URL | none extra (signed with the secret key) |
| Chord (customer handed to a human) | `/hooks/chord` | Chord → Admin → Channels & Tools → Developer → Webhooks → Add webhook ("Human takeover") | `CHORD_WEBHOOK_SECRET` |

See [docs/FEATURES.md](docs/FEATURES.md) §5 and §9.

## Google Sheet mirror (optional)

A read-only "Deliveries" tab updated after every change, for the owner's phone. D1 stays the source of
truth. Setup and failure handling are in [docs/FEATURES.md](docs/FEATURES.md) §12. Set
`GOOGLE_SHEET_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON`, then press **Resync all** on the board.

## Connect it to Chord

1. **Admin → Channels & Tools → Tools → Custom tools (MCP) → Add server.**
   - Name `Zuma Dispatch tools`, URL `https://…/mcp`, Auth type **bearer**, Auth token = `MCP_BEARER_TOKEN`.
   - ⚠ **Chrome autofills this form with your Chord login** (email into URL, password into token). Clear both fields before pasting (FIELD_NOTES #3).
2. Use the row's **⋯ → Health**, then **⋯ → Tools**. You should see `Health: ok` and 7 tools.
   - Saving alone does not contact the server.
3. **Teammates → Create a teammate**, then upload a ZIP of the skill folder's **contents**
   (`cd skill/zuma-dispatch && zip -r ../../dist/zuma-dispatch-skill.zip SKILL.md references`).
   Zipping the folder itself would prefix every path and break the `references/...` links.
4. On the review screen set **Autonomy → Act independently**. The default, "Suggest, I approve", queues every reply for approval.
5. Create the teammate. It starts **paused**, so go to Settings → Lifecycle → **Resume**.
   - The MCP tools are available automatically because the server is enabled in the workspace.
   - Settings → Tools does not list them, so check with one test message: its "How I did this" panel should show `mcp__Zuma_Dispatch_tools__…` calls.
   - One turn with two tool calls cost 0.08 credits.
6. Test in the in-app chat, then create a chat link at https://chat.tsglabs.dev ("Create chat link", business name "Zuma Dispatch").

## Security

- Bearer token on `/mcp`, checked in constant time. Any `Origin` header is refused (DNS-rebinding guard; Chord sends none).
- `/board` uses Basic auth, has a same-origin check on POSTs (CSRF), escapes all output and sets a strict CSP.
- Secrets live only in Worker secrets and `.env` (gitignored). Live keys are refused at runtime.
- No PII in logs. Phones are masked in tool output, and the full number appears only on the board.
- Paystack never receives the customer's phone or email (placeholder `zd-xxxxx@example.com`).

## How AI tools were used

Built with Claude Code (Claude Opus 5.5) as a pair programmer, with me directing and reviewing:
- **Research:** reading the Chord, NIPOST, OpenRouteService and Paystack docs; a best-practices survey with citations (`notes/`).
- **Probing the real APIs with curl:** this found the empty NIPOST sandbox, ORS timeouts, Paystack's `abandoned` semantics and Cloudflare 1010.
- **Writing the code, tests and docs:** all checked against live behaviour. The measurements (CPU per request, provider latency, Chord's request pattern) come from real logs, not assumptions.
- **What stayed human:** choosing the business and problem, approving every account action (keys, registering the server in Chord, Cloudflare), and entering secrets.

The agent itself runs entirely on Chord. This repository is its skill and its tool server.
