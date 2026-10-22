# Architecture

## The pieces

```
 WhatsApp simulator ──► Chord teammate "Zuma" ──(MCP, Streamable HTTP, bearer)──► Cloudflare Worker  zuma-dispatch
 (chat.tsglabs.dev)     skill: zuma-dispatch-booking                              │
                        managed model                                             ├─ /mcp        8 tools (stateless JSON-RPC), incl. hand_to_team
                                                                                  ├─ /mcp/test-cleanup  test scripts remove their own runs (bearer)
                                                                                  ├─ /pay/return Paystack redirect → verify → "payment received"
                                                                                  ├─ /board      admin board: sign-in, overview charts, jobs, job pages
                                                                                  ├─ /hooks/paystack  payment notifications (HMAC-SHA512)
                                                                                  ├─ /hooks/chord     handover alerts (HMAC-SHA256)
                                                                                  ├─ → Chord API     "payment received" into the customer's chat (scheduled MESSAGE)
                                                                                  └─ /health     config + DB check
                                                                                       │
          ┌──────────────────────┬─────────────────────┬──────────────────┬──────────┴─────────┐
          ▼                      ▼                     ▼                  ▼                    ▼
   NIPOST Postcode API   Geocoders (chain)      Routers (chain)     Paystack (test)      D1 (SQLite, ENAM)
   validity + LGA names  Google · Nominatim ·   OSRM · ORS ·        initialize/verify    places, quotes, jobs,
                         Photon · ORS           straight line                            payments, events, cache
```

- **Chord** owns the conversation: the model, the skill instructions and WhatsApp delivery. Handover
  goes through our `hand_to_team` tool (Chord's built-in one is the fallback; FIELD_NOTES #1). It calls our tools over MCP from AWS us-east (observed: `Java-http-client`).
- **The Worker** owns every fact that matters: locations, prices, bookings and payment state. The
  model only passes ids the Worker issued, so it cannot invent a price or a location.

## One booking, end to end

```
customer text ──► resolve_address ×2 ──► place_id (P-…) ──► quote_delivery ──► quote_id (Q-…, price frozen 30 min)
     "yes" ──► create_dispatch_job (customer_confirmed:true) ──► job_id (ZD-…, reserved; amount from quote; no code yet)
           ──► create_payment_link ──► Paystack checkout (reference ZD-…-n, amount from job)
 "paid" ──► verify_payment ──► Paystack verify ──► status/amount/currency/reference all match? ──► job paid
                                                                    ──► rider assigned ──► code + rider to the customer
                                    ▲
            Paystack redirect ──► /pay/return (same verify code path)
dispatcher ──► /board ──► dispatched ──► delivered      customer ──► get_job_status
```

## Job states

```
                 ┌────────────── cancel_job / board ─────────────┐
                 ▼                                               │
 (quote) ──► awaiting_payment ──verify:paid──► paid ──board──► dispatched ──board──► delivered
                 │      ▲                        ▲
     verify:failed      │ new link + paid        │ board: approve
                 ▼      │                        │
            payment_failed               amount_mismatch ◄── verify: success but amount/currency/reference wrong
```

Every change is a compare-and-set `UPDATE … WHERE status IN (…)`. Its `job_events` row is written in
the same D1 batch, and only if the update changed a row. The board and two concurrent verifies therefore
cannot double-apply a transition.

Payment attempts have their own states: `initializing` (row written before calling Paystack),
`initialized`, then Paystack's (`abandoned`, `ongoing`, `pending`, `processing`, `queued`, `success`,
`failed`, `reversed`), plus our `mismatch` and `not_found`.

## Address resolution

1. **Too vague?** ("Abuja", "my house") → `needs_detail` without calling anything.
2. **Postcode?**
   - New NIPOST format: in parallel, NIPOST L1 validity and the LGA name from `/v1/reference/lgas` (cached 30 days).
     - Postcode only → geocode the LGA → one honest area-level place → `needs_detail`.
     - Postcode + words → geocode "words, LGA".
   - Legacy 6-digit codes are noted but not verifiable.
3. **Geocoder chain** (`GEOCODER_CHAIN`, `GEOCODER_MODE`). Unavailable providers (no key) are skipped and traced.
   - `fallback`: in order, until one finds something.
   - `crosscheck`: the first two in parallel.
     - Agree within 400 m → `high` confidence.
     - Disagree → `ambiguous`; the customer picks.
     - Second answer more than 1.5 s late → answer from one source (`medium`) and finish the late call in the background into the cache.
     - Nothing found → the remaining providers in order (6 s budget).
   - Each provider: 4 s timeout, D1 cache (30 days for hits, 1 day for empty results), Nigeria-only results, precision mapped to `exact | street | area | lga`.
4. **Service area:** the whole FCT and the whole of Lagos State (point-in-polygon on embedded OSM
   boundaries, `src/business/states.ts`). Outside → `out_of_area`. A quote needs both ends in the same
   state (`INTERSTATE_NOT_SUPPORTED` otherwise).

## Why these choices

| Decision | Why | Alternative considered |
|---|---|---|
| Ids, not values, cross the model boundary | The model cannot invent or tweak a price, amount or coordinate. The schema rejects extra keys with a steering message. | Validating model-supplied prices server-side (still lets it say a wrong number) |
| Stateless MCP, JSON responses, no sessions | Chord's discovery calls `tools/list` without `initialize`; Workers isolates are short-lived. | `McpAgent` (Durable Objects): deprecated by Cloudflare, and sessions add failure modes |
| SDK v1 low-level `Server` + cfworker validator, schemas compiled at load | Free plan allows 10 ms CPU per request: 48 ms → median 4 ms (FIELD_NOTES_FULL #2) | `McpServer` (converts schemas per request), `agents` package (large dependency tree) |
| Cloudflare Workers + D1 | No cold start (Chord waits about 60 s per reply), persistent SQLite, free HTTPS | Render (sleeps and wipes the disk on free), Railway (trial), Fly (needs a card) |
| D1 in ENAM, not WEUR | The Worker runs next to its caller (Chord, IAD). WEUR would add ~80–90 ms per query | Smart Placement (moves the Worker; our other calls are global anyway) |
| Pluggable geocoder chain + cross-check | Free OSM geocoders disagree and miss Nigerian landmarks; disagreement is turned into a question to the customer | One provider (fast but wrong silently), Google only (needs a billing account) |
| OSRM for distance, ORS second, straight line last | OSRM answered in 0.5 s; ORS took 18 s / timed out in tests | ORS only |
| Payment attempt row written before initialize | A timed-out initialize can still be verified by reference; `duplicate_reference` is recoverable | Insert after success (a lost response orphans a real transaction) |
| Find the chat by the job id the agent sent, then a Chord MESSAGE task | Chord gives tools no conversation id; the agent's own booking message is an exact, private key, and any doubt means "don't send" | Guessing by phone or time (wrong customer risk), operator take-over + message (pauses the agent) |
| Board sign-in page + D1 sessions, not HTTP Basic | Basic auth puts credentials in URLs people share, which broke the board's forms in Chromium, and it cannot sign out; sessions can be revoked and the lockout slows guessing | Signed stateless cookies (no real sign-out), keep Basic (no lockout, browser popup) |
| Google Sheet as a one-way mirror, not the store | The owner gets a familiar phone view; the money logic keeps compare-and-set safety; Sheets outages never block bookings | Sheets as the database (no atomic updates, quotas, human edits break it) |
| Paystack webhook + re-verify, return page and `verify_payment` as fallbacks | Payments are noticed without the customer writing; the payload is never trusted | Trusting the webhook body (forgeable if the key leaks, no amount check) |
| Placeholder Paystack email `zd-xxxxx@example.com` | Paystack requires an email; WhatsApp customers rarely give one; we never send their phone number to Paystack | Phone-derived email (Paystack's suggestion; leaks PII) |

## Data model

See `migrations/0001_init.sql` … `0013_jobs_date_indexes.sql`. Money is integer kobo,
times are epoch ms (UTC; displayed as WAT = UTC+1, no DST).

| Table | Holds | Key constraints |
|---|---|---|
| `places` | every resolved candidate (label, lat/lng, precision, postcode status, provider, in-area flag, `state` FC/LA) | lat/lng ranges |
| `quotes` | frozen price, breakdown, distance source, approximate flag, expiry | `amount_kobo > 0`, `currency = 'NGN'` |
| `jobs` | sender/recipient, amount (from quote), status, handover code (released after payment), rider (assigned at payment), version | `UNIQUE(quote_id)` |
| `payments` | one row per Paystack attempt (reference `ZD-xxxxx-n`) | `UNIQUE(job_id, attempt)` |
| `job_events` | append-only audit trail (actor: agent / system / dispatcher) | n/a |
| `geocode_cache` | provider answers keyed by provider + normalised query | n/a |
| `tool_calls` | tool, ok/error code, latency, provider path; no PII | n/a |
| `paystack_events` | each Paystack webhook delivery: event, reference, outcome, source-IP check | dedupe key |
| `chord_events` | each Chord webhook delivery (e.g. `conversation.escalated`) | `delivery_id` |
| `sheet_rows`, `sheet_state` | which sheet row holds which job; last sync result | `job_id` |
| `board_sessions` | dispatcher sign-ins: SHA-256 of the cookie, password fingerprint, expiry | `token_hash` |
| `board_login_failures` | failed sign-ins per hashed IP in a 15-minute window | `ip_hash` |
| `chat_notices` | "payment received" pushed into a Chord conversation: state, reason, thread and task ids | `(job_id, kind)` |

## Configuration

`wrangler.jsonc` vars (non-secret): `GEOCODER_CHAIN`, `GEOCODER_MODE`, `ROUTER_CHAIN`,
`QUOTE_TTL_MINUTES`, `PROVIDER_TIMEOUT_MS`, `BUSINESS_NAME`, `BUSINESS_CITY`. Secrets:
`PAYSTACK_TEST_SECRET_KEY`, `NIPOST_API_KEY`, `MCP_BEARER_TOKEN`, `BOARD_TOKEN`, optional
`OPENROUTE_BASIC_KEY`, `GOOGLE_MAPS_API_KEY`, `CHORD_WEBHOOK_SECRET`, `GOOGLE_SHEET_ID`,
`GOOGLE_SERVICE_ACCOUNT_JSON`, `SHEET_MIRROR_ALLOW_LOCAL` (local only; leave unset), `CHORD_API_KEY` and
`CHORD_NOTICES_ALLOW_LOCAL` (local only). Vars `CHORD_API_BASE`, `CHORD_WORKSPACE_ID`, `CHORD_TEAMMATE_ID`, `CHORD_NOTICE_ROUTE`. `loadConfig` validates everything on every request.
It refuses non-test keys and reports problem names (never values) on `/health`.
