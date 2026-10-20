# Features

What the Zuma Dispatch agent does, how each feature works, and what happens when part of it fails.
Each section ends with where to find the code and the tests. For the per-case evidence table see
[EDGE_CASES.md](EDGE_CASES.md); for design reasons see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Address resolution (`resolve_address`)

**What it does.** Turns whatever the customer typed ("opposite Shoprite, Jabi Lake Mall", "Garki
Area 11", "FC-02-A09-DB-09") into a confirmed place with a `place_id`. Later tools only accept that id,
so the model can never invent a location.

**How it works.**
1. **Too vague?** "Abuja" or "my house" gets `needs_detail` without calling any provider.
2. **NIPOST postcode?**
   - The new 5-segment format gets a NIPOST L1 validity check and the LGA name from NIPOST's reference
     data. A postcode alone means area-level only, so `needs_detail`: ask for a landmark.
   - A legacy 6-digit code is recognised but cannot be verified.
3. **Geocoder chain**, set by `GEOCODER_CHAIN` and `GEOCODER_MODE`:
   - `crosscheck` (default): the first two providers run in parallel.
     - **Agree** (within 400 m): `confirmed`, high confidence.
     - **Disagree**: `ambiguous`, and the customer picks from up to 3 labelled options.
     - **Second provider late** (more than 1.5 s after the first): answer from one source and finish
       the late call in the background, so it is cached for next time.
   - `fallback`: providers in order until one finds something.
4. **Service area:** within 40 km of the Central Business District. Anything outside comes back
   `out_of_area` (it is still resolved, so the customer is told what we found).
5. **Stable answers:** the same text returns the same `place_id`s for 6 hours. Chord re-asks every turn
   (see §9), so this keeps quotes and bookings stable.

**Statuses:** `confirmed` · `ambiguous` · `needs_detail` · `not_found` · `out_of_area`. Each carries a
`what_to_do` for the model.

**Fallbacks.**

| Failure | What happens |
|---|---|
| Provider slow or down | 4 s timeout, then the next provider; no new provider starts after 6 s |
| Every provider down | `GEOCODER_UNAVAILABLE`: try once more, then hand over |
| NIPOST down | The postcode is reported as `unavailable` and the text is still geocoded |
| Google not configured | Skipped automatically |

**Code:** `src/tools/resolveAddress.ts`, `src/geocode/*` · **Tests:** `test/units.test.ts` (judgement,
postcodes), `test/integrations.test.ts` (cross-check timing), `scripts/e2e.py`.

## 2. Quotes (`quote_delivery`)

**What it does.** Prices a trip from two `place_id`s and a package size (small / medium / large).
The price exists only on the server and is frozen for 30 minutes.

**How it works.**
- Road distance comes from `ROUTER_CHAIN`: OSRM, then ORS, then a straight line × 1.4 marked
  "approximate". The rate card in `src/business/rates.ts` applies: base fare covers 3 km, then a price
  per extra km, rounded up to ₦50.
- The same request returns the same unexpired quote, unless that quote is already booked: two customers
  never share a quote.
- Pickup timing follows rider hours (7am–8pm WAT, Monday–Saturday).

**Refusals:**

| Code | When |
|---|---|
| `SAME_LOCATION` | Pickup and drop-off less than 150 m apart |
| `OUT_OF_SERVICE_AREA` | Either end is outside the service area |
| `PLACE_TOO_VAGUE` | Either end is only known to LGA level |
| `TRIP_TOO_LONG` | More than 60 km by road |
| `PLACE_NOT_FOUND` | An invented or unknown `place_id` |
| `INVALID_ARGUMENTS` | Any extra key such as `price` |

**Fallbacks:** if no router works, the straight-line estimate is used and labelled; with no route at
all, `ROUTING_UNAVAILABLE`.

**Code:** `src/tools/quoteDelivery.ts`, `src/business/rates.ts`, `src/routing/route.ts` · **Tests:**
rate card examples checked against `skill/.../rate-card.md`.

## 3. Booking (`create_dispatch_job`)

**What it does.** Creates the job from a quote after an explicit yes (`customer_confirmed: true`).
Returns the job id (`ZD-XXXXX`) and a 4-digit handover code.

**Safeguards.**
- **One job per quote:** retries and double "yes" return the same job.
- **Duplicate-booking guard:** the same sender, recipient phone, size and route (both ends within
  200 m), unpaid and less than 2 h old, returns the existing job even under a new quote. Different
  senders are never merged.
- **Expired quote:** `QUOTE_EXPIRED`, so the agent re-quotes and asks again. Never silently re-priced.
- **Input clean-up:**
  - The phone is normalised to +234 E.164, with specific prompts for a wrong length or a non-mobile number.
  - Names are cleaned (control and zero-width characters stripped, URLs rejected).
  - The amount is copied from the quote, never from input.

**Code:** `src/tools/jobs.ts` · **Tests:** `scripts/e2e.py` (Booking, Lost context).

## 4. Payment: link or bank transfer (`create_payment_link`)

**What it does.** Gives the customer a way to pay the job's amount.

- `method: "link"` (default): a Paystack checkout that opens inside WhatsApp (card, transfer, USSD,
  bank). Paystack redirects to our `/pay/return` page afterwards.
- `method: "bank_transfer"`: Paystack issues a one-time account (bank, number, name, exact amount,
  30-minute expiry) that the agent sends as plain chat text.

**Safeguards.**
- The open link or account is reused rather than duplicated.
- Paystack is checked first, so an already-paid job is never given another link.
- A payment attempt row is written **before** calling Paystack. A timed-out call is retried once with
  the same reference; "duplicate reference" moves to the next attempt, and the orphan is still verified.
- At most 5 attempts per job, then a human takes over.
- Switching methods gets a "pay one way only" warning.
- Paystack never receives the customer's phone or email (placeholder `zd-xxxxx@example.com`).

**Not possible:** WhatsApp's own in-chat payments (WhatsApp Pay) are not available in Nigeria, which is
why we use Paystack.

**Code:** `src/tools/payments.ts`, `src/payments/paystack.ts` · **Tests:** `test/integrations.test.ts`
(timeout, duplicate, 429, not found), `scripts/e2e.py` (Payment, Bank transfer).

## 5. Payment confirmation (three independent paths)

**What it does.** Marks a job paid only when Paystack's verify API says `success` **and** the amount,
currency and reference all match what we asked for. Paystack's top-level `status: true` is ignored.

| Path | Trigger | Customer action needed |
|---|---|---|
| **A. Paystack webhook** `POST /hooks/paystack` | Paystack calls us the moment money lands (card, transfer, USSD) | **None.** The job flips to paid and the dispatcher sees it straight away |
| **B. Return page** `/pay/return` | Paystack redirects the customer after checkout | None (they just finish checkout) |
| **C. `verify_payment` tool** | The customer says "paid" or asks | Writes in the chat |

All three call the same function, `checkPayments()`, so the rules are identical.

**Webhook details.**
- **Signature first:** `x-paystack-signature` = HMAC-SHA512 of the raw body, keyed with our secret
  key. Missing or wrong signature: 401.
- **The payload is never trusted for money:** a signed `charge.success` only triggers verification with
  Paystack's API. A signed but false event cannot mark a job paid (an e2e check proves this).
- **Paystack's verify API down:** answer 503 so Paystack retries; paths B and C still work.
- **Duplicates and races:** compare-and-set job updates, an audit row per delivery, and the 10 s
  re-check throttle bypassed only for webhooks.
- **Unknown references** (other transactions on the same Paystack account): 200, logged, ignored.
- **Refunds and disputes:** the job is flagged "needs review" for a human.
- **Source IP:** checked against Paystack's published IPs and logged (defence in depth). The signature is what proves authenticity.

**What needs a person:** amount, currency or reference mismatch; paid twice; paid after cancelling;
reversal. Each gives `needs_review`, the agent hands over, and the board lists the reason.

**What the customer sees:** the checkout return page says "Payment received". Zuma confirms on the
customer's next message. Chord has no way for our server to post into the conversation unprompted: it
sends tools no conversation id (see FIELD_NOTES #10).

**Code:** `src/web/paystackWebhook.ts`, `src/payments/service.ts`, `src/payments/decide.ts` ·
**Tests:** `test/decide.test.ts`, `test/integrations.test.ts` (signature, tampering, unknown reference,
event shapes), `scripts/e2e.py` (forged-but-signed event leaves the job unpaid).

**Setup:** Paystack Dashboard → Settings → API Keys & Webhooks → Test Webhook URL:
`https://zuma-dispatch.obimz123.workers.dev/hooks/paystack`.

## 6. Status and tracking (`get_job_status`)

**What it does.** Tells the customer where their delivery is, using the status the dispatcher sets.

**The customer never has to dig for a job id.**
1. **Chord memory:** Zuma saves "Booking ZD-…" as a customer memory when it books. Chord loads that
   memory into every later turn, including new conversations.
2. **Conversation text:** job ids Zuma already sent are visible in the history.
3. **Phone + name lookup:** `get_job_status(recipient_phone, sender_name)` finds bookings from the last
   14 days. The first name is enough, the phone can be in any format, and several matches are listed for
   the customer to choose. It shows status and route only, never the handover code.

**Code:** `src/tools/jobs.ts` · **Tests:** `scripts/e2e.py` (Status without a job id).

## 7. Cancellation (`cancel_job`)

Only unpaid jobs can be cancelled. Paystack is checked first, so a payment that just landed is not lost.

- **A card payment mid-OTP** blocks the cancel.
- **An unpaid transfer account** does not block it, but the customer is told not to send money to it.
- **Paid jobs** go to a human, who handles refunds.
- The call is idempotent.

## 8. Admin / dispatcher board (`/board`)

The brief does not prescribe an admin tool. Our plan chose a server-rendered board over Google Sheets
(no extra integration, and the same database the tools use), so this is where the business sees
everything. Log in with HTTP Basic auth (any username, password `BOARD_TOKEN`).

**`/board`: all deliveries.**
- **Search** by job id (`zd-k45v7` works), recipient phone (any format), or part of a name or address.
- **Filter** by status, with a count per status. The latest 100 matches are shown.
- **Each row:** route, size, amount, sender → recipient, handover code, status, and how the job was paid
  (Paystack notification / checkout return page / customer check), with action buttons.
- **Panels:**
  - *Handed to a human*: from Chord's `conversation.escalated` webhook.
  - *Needs review*: amount mismatch, double payment, paid after cancel, refunds, disputes.
  - *Payment notifications*: Paystack webhooks, with the source-IP check.
  - *Recent tool calls*: tool, result, latency, provider path.
- Refreshes every 30 s.

**`/board/jobs/ZD-XXXXX`: everything about one delivery.**
- Sender, recipient (full phone), amount, handover code, package note, actions.
- **Pickup and drop-off:** what the customer typed, the resolved label, precision, which geocoder found
  it and with what confidence, postcode + NIPOST result, service-area check, and a map link.
- **Quote:** distance and its source (OSRM / ORS / estimated), ETA, rate card version, line-by-line breakdown.
- **Every payment attempt:** method (link / bank transfer), reference, Paystack status and gateway
  message, channel, the checkout link or transfer account (with expiry), and when it was paid.
- **Paystack notifications** for this job.
- **Full timeline:** every event, who did it (agent / system / dispatcher), and the detail
  (e.g. `via: paystack_webhook`).

**Actions:** mark dispatched → delivered, approve a reviewed payment, cancel.

**Protections:**
- A cross-site POST is refused (CSRF), and a stale page (version check) is refused with "changed since
  you loaded the page".
- Every value is HTML-escaped and a strict CSP is set. LIKE wildcards in the search are stripped.
- Unknown job or path: 404.

**Code:** `src/web/pages.ts` · **Tests:** `test/units.test.ts` (search parsing), smoke (login, CSRF),
manual run in `docs/EDGE_CASES.md` B1–B6.

## 9. Human handover and alerts

- **Handover:** Zuma calls Chord's built-in `handover_to_human` when an address fails twice, a payment
  needs review, the request is out of scope (refunds, intercity, complaints), or the customer asks for a
  person. The thread moves to `human_active` in Chord and an operator replies there.
- **Alert:** Chord POSTs `conversation.escalated` to our `/hooks/chord`.
  - Signature: HMAC-SHA256, checked against Chord's published test vector in our unit tests.
  - Deduplicated on `X-Chord-Delivery-Id`.
  - Listed on the board.
- **Setup:** Chord → Admin → Channels & Tools → Developer → Webhooks → Add webhook (preset "Human
  takeover") with URL `https://zuma-dispatch.obimz123.workers.dev/hooks/chord` and signing secret
  `CHORD_WEBHOOK_SECRET`.
- **Go-live extra:** Chord can also email a transcript on handover (`escalation-notifications`; needs a
  Chord API key).

## 10. Conversation memory (Chord-specific behaviour)

Chord gives the model only the text of the last 30 turns, not earlier tool results, and passes MCP
tools no conversation or customer id. The server is built so this cannot cause wrong outcomes:

| Problem | Handling |
|---|---|
| Re-asks every turn | Stable `resolve_address` answers |
| Could book twice | Duplicate-booking guard |
| Could reuse someone else's quote | Booked quotes are never re-issued |
| Forgets job ids | Memory + phone/name lookup |
| Might disown an id it sent | Skill rule: ids already sent are real |

## 11. Configuration and safety

**Config.** Everything is validated on every request (`src/config.ts`):
- The server refuses to run with live Paystack or NIPOST keys.
- The MCP endpoint requires the bearer token (constant-time compare) and refuses any `Origin` header
  (DNS-rebinding guard).
- Secrets live only in Worker secrets and `.env`.

**Logs.** These carry ids, error codes, latencies and provider paths; no phone numbers, names or secrets.

| Setting | Where | Default |
|---|---|---|
| `GEOCODER_CHAIN` / `GEOCODER_MODE` | `wrangler.jsonc` vars | `google,nominatim,photon,ors` / `crosscheck` |
| `ROUTER_CHAIN` | vars | `osrm,ors,straight_line` |
| `QUOTE_TTL_MINUTES`, `PROVIDER_TIMEOUT_MS` | vars | `30`, `4000` |
| `PAYSTACK_TEST_SECRET_KEY`, `NIPOST_API_KEY` | secrets | required, test keys only |
| `MCP_BEARER_TOKEN`, `BOARD_TOKEN` | secrets | required |
| `CHORD_WEBHOOK_SECRET` | secret | optional (escalation alerts) |
| `OPENROUTE_BASIC_KEY`, `GOOGLE_MAPS_API_KEY` | secrets | optional (provider skipped if unset) |
