# Setup, tools and operations

How to run, deploy and connect Zuma Dispatch, and what each tool does. The overview is in the
[README](../README.md).

## Repository layout

```
skill/zuma-dispatch/        SKILL.md + references/ (faq, rate-card) — uploaded to Chord
src/
  index.ts                  routing, bearer auth + Origin check on /mcp, /health
  mcp/                      stateless MCP server, tool wrapper (validation, errors, logging)
  tools/                    the 8 tools: index.ts (schemas + descriptions) and handlers
  geocode/                  NIPOST postcodes, provider adapters, chain + cross-check, D1 cache
  routing/                  OSRM → ORS → straight-line distance
  payments/                 Paystack client, pure payment decision, verification service
  business/                 business profile (service area, hours) and the rate card
  web/                      /board sign-in + sessions, tab shell, Home alerts, Deliveries, Payments, System, job pages, handovers, charts, /pay/return
  db/, lib/                 data access; ids, phone, money, text, geo, http helpers
migrations/                 D1 schema
test/                       unit tests (vitest, plain Node)
scripts/                    mcp-smoke.sh, e2e.py, check-skill.py
docs/, notes/               architecture, edge cases, field notes, research
```

## The tools

| Tool | What it does | Safety |
|---|---|---|
| `resolve_address(text, role, state?)` | Landmark, address or postcode → `confirmed` / `ambiguous` / `needs_detail` / `not_found` / `out_of_area`, with a `place_id` and its `state` | Geocoder cross-check; NIPOST validity + LGA; FCT + Lagos State boundaries |
| `quote_delivery(pickup_place_id, dropoff_place_id, package_size)` | Road distance → rate card → `quote_id`, total, breakdown, valid 30 min | Price only from the server; same request → same quote |
| `create_dispatch_job(quote_id, names, recipient_phone, customer_confirmed: true)` | Reserves the job and returns its id (the handover code comes only after payment) | Needs explicit yes; one job per quote; amount copied from quote; phone normalised |
| `create_payment_link(job_id, method?)` | `link`: Paystack checkout (opens in WhatsApp; card, transfer, USSD). `bank_transfer`: one-time account number, bank and exact amount sent in the chat (30 min) | Reuses open details; checks Paystack first; timeout-safe references; warns if both methods are open |
| `verify_payment(job_id)` | Asks Paystack; `paid` only if status + amount + currency + reference match | Compare-and-set; double payment / paid-after-cancel → human review |
| `get_job_status(job_id \| recipient_phone + sender_name)` | Status set by dispatchers, in plain words; finds the customer's latest job without an id | Read-only; the lookup needs both phone and name and never returns the handover code |
| `cancel_job(job_id, reason)` | Cancels an unpaid job | Verifies Paystack first; paid jobs go to a human |
| `hand_to_team(reason, customer_message, job_id?)` | Returns the line Zuma sends, then hands the chat to a person once that reply is posted | Matches exactly one recent chat or none; takes over within 20 s; Chord's built-in handover is the fallback |

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
| NIPOST Postcode API | postcode validity (L1), LGA names | `NIPOST_API_KEY` (test) | Test key: free, 600/min; sandbox data effectively empty (FIELD_NOTES_FULL #1) | 0.6–0.7 s |
| Nominatim (OSM) | geocoding | none | ≤1 req/s, identifying UA, must cache; **tracking apps must self-host** | 0.3–1.1 s, good on landmarks |
| Photon (komoot) | geocoding | none | "please be fair", no SLA | 1–4 s, often > 4 s |
| Google Places (New) | geocoding (best Nigerian POI coverage) | `GOOGLE_MAPS_API_KEY` | Text Search Pro 5,000 free/month (then $32/1,000); needs billing account | **enabled 2026-10-22**: key restricted to Places API (New), daily cap 150 Text Search requests (≤ 4,650/month, inside the free tier) |
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
npm test                              # 282 unit tests: pricing, payment decisions, geocoder judgement + timing, webhook signatures, Paystack failures, parsing, config, board sign-in, Home alerts, theme, charts, sheet mirror, handovers
```
```bash
scripts/mcp-smoke.sh                  # protocol, auth, board sign-in, CSRF, webhook checks (25)
```
```bash
python3 scripts/e2e.py                # booking, payment, webhooks, lookup, lost-context guards and edge cases against real providers (54)
```
```bash
python3 scripts/check-skill.py        # skill package vs Chord's limits
```

**The scripts clean up after themselves.**
- `e2e.py` and `mcp-smoke.sh` tag every tool call with `X-Request-ID: test-<run>-…`. On exit they call
  `POST /mcp/test-cleanup {"run": "<run>"}`, which uses the same bearer token as `/mcp`. This happens
  whether the run passes, fails, errors or is stopped with Ctrl-C.
- The endpoint deletes only that run's data:
  - jobs whose sender **and** recipient carry the run's `E2E … <run>` names, booked in the last 24 hours;
  - their payments, events, notices, sheet rows and quotes;
  - Paystack webhook log entries for those jobs, or for the run's made-up `E2E-<run>-…` references;
  - the tagged tool calls.
- If the owner's Google Sheet had rows for those jobs, it is rebuilt without them.
- It refuses a run id that isn't 5 digits, and deletes nothing if more than 40 jobs match.
- Resolved places stay. Real customers share them through the 6-hour address cache.
- `python3 scripts/e2e.py <url> --keep` leaves a run's data for debugging, and
  `python3 scripts/e2e.py <url> --cleanup <run>` removes it later.


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

See [docs/FEATURES.md](FEATURES.md) §5 and §9.

**"Payment received" in the chat, without the customer writing (optional).**
- After Paystack's webhook confirms a payment, the server finds the customer's Chord conversation (the
  agent message that contains the job id) and queues a Chord `MESSAGE` into it through the chat's
  WhatsApp / Telegram / Slack connector. The simulator cannot display pushed messages: there it lands in
  Chord's record, so the agent knows the job is paid.
- Set `CHORD_API_KEY`. It needs `thread:read` and `teammate:update`, which the dashboard offers only under
  Full access.
- Safety rules (privacy, human takeover, customer typing, 24-hour window, once per job) are in
  [docs/FEATURES.md](FEATURES.md) §5a.

## Google Sheet mirror (optional)

A read-only "Deliveries" tab updated after every change, for the owner's phone. D1 stays the source of
truth. Setup and failure handling are in [docs/FEATURES.md](FEATURES.md) §12. Set
`GOOGLE_SHEET_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON`, then press **Resync all** on the board.
A local dev server never writes to the sheet (it would overwrite production rows) unless
`SHEET_MIRROR_ALLOW_LOCAL=1`, and then only with a separate test sheet.

## Connect it to Chord

1. **Admin → Channels & Tools → Tools → Custom tools (MCP) → Add server.**
   - Name `Zuma Dispatch tools`, URL `https://…/mcp`, Auth type **bearer**, Auth token = `MCP_BEARER_TOKEN`.
   - ⚠ **Chrome autofills this form with your Chord login** (email into URL, password into token). Clear both fields before pasting (FIELD_NOTES_FULL #3).
2. Use the row's **⋯ → Health**, then **⋯ → Tools**. You should see `Health: ok` and 8 tools.
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
- `/board` has a sign-in page with server-side sessions (HttpOnly, Secure, SameSite=Lax cookie; 10-tries-per-15-min lockout), a same-origin check on POSTs (CSRF), escapes all output, and a CSP that allows no scripts.
- Secrets live only in Worker secrets and `.env` (gitignored). Live keys are refused at runtime.
- No PII in logs. Phones are masked in tool output, and the full number appears only on the board.
- Paystack never receives the customer's phone or email (placeholder `zd-xxxxx@example.com`).
