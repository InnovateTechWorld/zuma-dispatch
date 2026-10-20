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
   (see §10), so this keeps quotes and bookings stable.

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

**What the customer sees:**
- The checkout return page says "Payment received".
- When chat notices are on (§5a), "Payment received: ₦… for ZD-…" arrives in their chat within about a
  minute, without them writing.
- Otherwise Zuma confirms on the customer's next message.

**Code:** `src/web/paystackWebhook.ts`, `src/payments/service.ts`, `src/payments/decide.ts` ·
**Tests:** `test/decide.test.ts`, `test/integrations.test.ts` (signature, tampering, unknown reference,
event shapes), `scripts/e2e.py` (forged-but-signed event leaves the job unpaid).

**Setup:** Paystack Dashboard → Settings → API Keys & Webhooks → Test Webhook URL:
`https://zuma-dispatch.obimz123.workers.dev/hooks/paystack`.

## 5a. "Payment received" pushed into the chat (no customer message needed)

**The problem.**
- Paystack's webhook marks a job paid within seconds, but the customer only heard about it after writing again.
- Chord sends MCP tools no conversation id (FIELD_NOTES #9), so the server did not know which chat to
  write to. Field note #10 called this impossible. #14 corrects that.

**How it works** (`src/chord/notices.ts`):
1. **Trigger.** A job turns paid through Paystack's notification, the checkout return page, or a
   dispatcher approving a reviewed payment. These are the moments the customer is not in the chat.
   When the customer asked (`verify_payment`), the agent confirms in its own reply, so nothing is pushed.
2. **Find the conversation.**
   - `GET /v1/threads` lists this workspace's conversations active since 10 minutes before the booking.
   - For each, up to 8 and newest first, `GET /v1/threads/{id}/turns` looks for an **agent** message
     containing the job id. The agent always sends the id when it books. A customer typing an id does not count.
3. **Decide** (`pickThread`, pure and unit-tested). Send only when it is safe:

   | Situation | Result |
   |---|---|
   | One conversation, or several with the **same** customer | The most recently active one |
   | The id also appears in another customer's chat (they asked about it later) | Sent to the **person who booked**: the chat where the agent first sent the id. Nobody else is notified |
   | Two different customers were sent the id at the same moment | Not sent (`ambiguous_thread`); never guessed |
   | No agent message with the id | Not sent (`thread_not_found`) |
   | A human has taken over or paused the chat | Not sent (`human_handling`); Chord would deliver over the operator |
   | The customer wrote in the last 90 s and the agent has not answered | Not sent (`customer_mid_conversation`); the agent is about to confirm |
   | Customer's last message older than 23 h | Not sent (`outside_24h_window`); WhatsApp's free-text window |

4. **Send** (route `auto`, the default). `POST /v1/scheduled-tasks` with a `MESSAGE` task, picked up by
   Chord's queue within about 30 s.

   | Chat lives on | Platform | What the customer sees |
   |---|---|---|
   | WhatsApp / Telegram / Slack | that connector (`WHATSAPP` …) | the message, from the business number. Nothing changes hands |
   | Anything else (e.g. the simulator's `external_chat`) | `DIRECT_LINE` | nothing on that surface. It lands in Chord's conversation record, so the agent knows the job is paid; recorded as `queued` + `record_only` |

   - **Opt-in route `operator`** (`CHORD_NOTICE_ROUTE=operator`): take over → `POST /v1/threads/{id}/messages`
     → hand back. Chord sends it down the chat's own channel and reports `delivery_status` at once.
   - **Cost of the operator route:** the take-over makes Chord send the customer "One moment — connecting
     you with a teammate." first (seen live), and it fires `conversation.escalated`. So it is not the default.
   - The board hides those escalations: the take-over reason starts with `zuma-dispatch automated notice`,
     and a chat notice exists on that thread at that moment.
   - The hand-back is retried 3 times. If it still fails, the job page and the board's "waiting on you"
     strip say to press "Hand back to AI" in Chord.
   - Text: the same sentence `verify_payment` gives the agent (`src/business/messages.ts`), matching the job's
     status. For example: *"Payment received: ₦1,950 for ZD-H01G4. A dispatcher is assigning a rider now;
     pickup is usually within 45 minutes. The recipient gives the rider code 8960."*
   - Fixed text, no agent run, so no model credits.
5. **Once only.** A row in `chat_notices` (migration 0008) is claimed with an atomic UPSERT before
   anything is sent. Paystack retries, the return page and the webhook together, or two Workers at once
   send one message.
   - A claim stuck in `pending` for 5 minutes (Worker evicted) may be retaken.
   - A dispatcher's **Send again** retries only `failed` or `skipped`, never `queued`.
6. **Record.**
   - Every outcome lands in `chat_notices` (migrations 0008–0009; states `queued`, `sent`, `skipped`,
     `failed`) and the job timeline (`customer_notified` /
     `customer_notice_not_sent` with the reason).
   - The job page shows it in plain words with a Send again / Send now button.
   - The board shows totals.
   - `/health` reports `chat_payment_notices: enabled | not_configured | invalid_config`.

**Fails safe.**
- Chord down, a timeout (4 s per call), a 403 for a missing scope, or any exception is recorded as
  `failed` with Chord's reason (e.g. `chord_http_403: Missing required permission: thread:read`).
- The webhook was already answered, so Paystack is unaffected, and the agent still confirms when the
  customer writes.
- Logs carry the job id, outcome and thread id; never the message text or phone numbers.

**Local servers never post into real chats.** `.env` and production share one Chord workspace, so
`localhost` / `127.0.0.1` send nothing (`local_server`) unless `CHORD_NOTICES_ALLOW_LOCAL=1`.

**Configuration.**

| Setting | Where | Value |
|---|---|---|
| `CHORD_API_KEY` | secret | A Chord API key with `thread:read` + `teammate:update`. The dashboard offers `thread:read` only under **Full access** |
| `CHORD_WORKSPACE_ID`, `CHORD_TEAMMATE_ID` | `wrangler.jsonc` vars | This workspace and teammate |
| `CHORD_API_BASE` | var | `https://api.chordhq.xyz` |
| `CHORD_NOTICE_ROUTE` | var | `auto` (default: connector, else record-only) or `operator` (take over → post → hand back) |
| `CHORD_NOTICES_ALLOW_LOCAL` | `.env` | unset |

**The agent's side (skill v5).** A "Payment received: …" message in the conversation comes from Zuma's
system after Paystack confirmed. The agent treats it as true, does not repeat it, and does not ask the
customer to say "paid".

**Code:** `src/chord/notices.ts`, `src/business/messages.ts`, hook in `src/payments/service.ts`, board in
`src/web/pages.ts` · **Tests:** `test/notices.test.ts` (matching, privacy, human / typing / 24 h rules,
once-only, scope errors, Chord failures, local guard, the message text).

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
everything. The owner also gets a read-only Google Sheet copy (§12). The visual system (tokens, type,
components) is written down in [`design.md`](../design.md).

**Sign-in (`/board/login`).**
- A real sign-in page, not the browser's Basic-auth popup. The password is the `BOARD_TOKEN` secret.
- A session lasts 12 hours. The cookie is `__Host-zd_board`: HttpOnly, Secure, SameSite=Lax (so links from the sheet open signed in), 32 random
  bytes. D1 stores only its SHA-256 (`board_sessions`, migration 0007).
- **Sign out** deletes the session row, so a copied cookie stops working at once.
- **Rotating `BOARD_TOKEN` signs everyone out.** Each session stores a fingerprint of the password it was
  created under.
- **Ten wrong passwords in 15 minutes from one IP** lock that IP out for the rest of the window (429 with
  `Retry-After`). Only a hash of the IP is stored (`board_login_failures`).
- **Deep links survive sign-in:** `/board/jobs/ZD-K45V7` → sign in → back on that job. The `next` target
  must be a `/board` path (no open redirect).
- **Scripts and curl** may still send HTTP Basic credentials (any username). Browsers are never challenged
  for them, and wrong Basic passwords count against the same lockout.

**`/board`: all deliveries.**
- **Waiting on you:** chips for paid jobs ready to dispatch, jobs out for delivery, amount mismatches, and
  handovers from Chord in the last 24 h. Each chip is a link to that filter.
- **Overview** (the dark band). Every number is a live D1 count; nothing is estimated.
  - Four figures: booked today, paid today (₦), waiting for payment (₦ and jobs), and agent tool calls
    (% ok, median and p95 latency over the last 200).
  - *Where every job is now:* a stacked bar of all jobs by status, with a legend of counts and shares.
    Each segment and legend entry filters the list.
  - *Bookings, last 7 days:* one column per WAT day, split paid vs not paid, with totals and paid value.
  - *How payments were confirmed:* which path noticed the payment (Paystack notification, checkout return
    page, customer asked, dispatcher approval) and the method used (checkout link vs bank transfer). Only
    jobs currently paid, dispatched or delivered are counted.
  - Charts are plain HTML/CSS (no script, no images). Each is hidden from screen readers and paired with
    a screen-reader table or the legend text.
- **Filters:**
  - Status tabs with counts (plain links, so they work with scripts off).
  - A search box for job id (`zd-k45v7` works), recipient phone (any format), or part of a name or address.
  - Status and search combine; "Clear filters" resets both. The latest 100 matches are shown.
- **Each row:** job id and time, status (and how it was paid), route, package and distance, amount,
  sender → recipient with phone and handover code, and the actions allowed for that status.
- **After an action** you return to the same filtered view, with a one-line confirmation or problem.
  The line is signed by the server, so a crafted `?msg=` link cannot show text on the board.
- **Auto-refresh is off by default.** A 30 s refresh used to wipe whatever you were typing into the search
  box. "Turn on auto-refresh" adds `live=1`, which filters and actions keep.
- **Panels:**
  - *Handed to a human*: from Chord's `conversation.escalated` webhook.
  - *Payments needing review*: amount mismatch, double payment, paid after cancel, refunds, disputes.
  - *Paystack notifications*: with the source-IP check.
  - *Google Sheet mirror*: last sync, Open, Resync.
  - *Recent tool calls*: collapsed; tool, result, latency, provider path.

**`/board/jobs/ZD-XXXXX`: everything about one delivery.**
- **Progress:** Booked → Paid → Dispatched → Delivered with times. Shows where a job stopped (payment
  failed, amount mismatch, cancelled).
- **Booking:** sender, recipient (full phone), package and note, amount, handover code, and the actions.
- **Pickup and drop-off:** what the customer typed, the resolved label, precision, which geocoder found
  it and with what confidence, postcode + NIPOST result, service-area check, and a map link.
- **Quote:** distance and its source (OSRM / ORS / estimated), ETA, rate card version, line-by-line breakdown.
- **Every payment attempt:** method, reference, Paystack status and gateway message, channel, the checkout
  link or transfer account (with expiry), and when it was paid.
- **Paystack notifications** for this job, and the **full timeline** (every event, who did it, the detail).

**Actions:** mark dispatched → delivered, approve a reviewed payment (records the paid time and
"via dispatcher approval"), cancel.

**Layout:**
- Light and dark (follows the device setting).
- Phones: rows become two-column cards and the progress steps stack vertically. Checked at 320, 375,
  414 and 768 px, with no sideways scroll.

**Protections:**
- A cross-site POST is refused (CSRF). `Sec-Fetch-Site` is checked first, then `Origin`.
  `Referrer-Policy: same-origin`, so our own forms carry a real Origin (FIELD_NOTES #12) and outside links
  get no referrer.
- A stale page (version check) is refused with "changed since you loaded the page".
- Every value is HTML-escaped. The CSP allows no scripts at all; styles and fonts come only from inline
  CSS and Google Fonts. LIKE wildcards in the search are stripped. `noindex`.
- Unknown job or path: 404.

**Code:** `src/web/login.ts` (gate, sign-in), `src/web/session.ts` (sessions, lockout, CSRF),
`src/web/pages.ts` (board, job page), `src/web/charts.ts`, `src/web/layout.ts`.
**Tests:** `test/board.test.ts` (redirect safety, cookie flags, CSRF, lockout window, filters, charts, progress),
`test/units.test.ts` (search parsing), smoke (sign-in redirect, wrong password, CSRF, Basic for scripts),
and the browser runs in `docs/EDGE_CASES.md` B1–B16.

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
| `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON` | secrets | optional (sheet mirror, §12) |
| `SHEET_MIRROR_ALLOW_LOCAL` | `.env` | unset (local servers never write to the sheet) |
| `CHORD_API_KEY` (+ `CHORD_*` vars) | secret / vars | optional ("Payment received" pushed into the chat, §5a) |
| `CHORD_NOTICES_ALLOW_LOCAL` | `.env` | unset (local servers never post into real chats) |

## 12. Google Sheet mirror (owner's view on the phone)

**What it does.** Keeps a "Deliveries" tab in a Google Sheet up to date: one row per job, refreshed
after every change (booked, payment link, paid, dispatched, delivered, cancelled, needs review). The
owner sees the business from the Google Sheets app with no new login.

**Columns:** Job ID · Status · Booked (WAT) · Sender · Recipient · Recipient phone (masked) · Pickup ·
Drop-off · Size · Distance (km) · Amount · Payment method · Paid via · Paid at · Last update · Board link.

**Why a mirror and not the main store:**
- The money logic needs compare-and-set updates, so that the webhook, the return page and the agent
  confirming the same payment at the same moment cannot double-apply. Sheets has no equivalent.
- The Sheets API adds 0.3–1 s and per-minute write quotas to every call.
- Anyone with edit access can sort, delete or retype cells.

So D1 stays the source of truth, the sheet is a **read-only copy**, and actions stay on the board.

**How it works and fails safely:**

| Concern | Handling |
|---|---|
| Sync must never break a booking or payment | Runs in the background (`waitUntil`) after the response; every error is caught |
| Google down, quota hit, or key revoked | Failure recorded and shown on the board ("Last sync … failed (reason)"); the next change or **Resync all** repairs it |
| Two changes to a new job at once | The row is claimed in D1 before appending, so the second sync waits for the next change; no duplicate rows |
| Tab deleted or renamed by hand | Detected ("Unable to parse range"), the tab and header are recreated, then the append is retried once |
| First ever row | Tab created if missing, header written |
| Someone edits or sorts the sheet | Edits are never read back. **Resync all** rebuilds the tab and row map from D1 (newest 2,000 jobs) |
| Formula injection (a name like `=HYPERLINK(...)`) | Values written with `valueInputOption=RAW`, so text is never evaluated |
| Personal data in a shareable file | Recipient phone masked (`+234 803 *** 4567`); the full number only on the authenticated board |
| Mirror not configured or misconfigured | `/health` shows `sheet_mirror: not_configured / invalid_config`; nothing else changes |
| Token expiry | Access token cached per isolate and refreshed a minute before its 1-hour expiry |
| Local dev and production share `.env` but not a database | A local server (localhost / 127.0.0.1) never writes to the sheet unless `SHEET_MIRROR_ALLOW_LOCAL=1`, which you should use only with a separate test sheet; otherwise local row numbers would overwrite production rows |

**This deployment (set up 2026-10-20):**
- Google Cloud project "My First Project" (`lucky-ridge-432003-e0`; the account was at its project limit, so an existing unused project was reused).
- Sheets API enabled.
- Service account `zuma-sheet-mirror@lucky-ridge-432003-e0.iam.gserviceaccount.com`, with **no project roles**; its only access is Editor on one sheet.
- Sheet "Zuma Dispatch Deliveries (test mirror)", general access *Restricted*.

**Verified live:**

| Check | Result |
|---|---|
| Resync | 35 jobs written locally, then 33 and 37 on production |
| First write | Created the "Deliveries" tab and header by itself |
| New job | Appended at the next row |
| Status change | Updated the same row in place, no duplicate row |
| `=SUM(1+1) Ada` as a sender name | Stored as text, not evaluated |
| Phone | Masked |
| Every production job mirrored after the e2e run | 37 jobs, highest row 38, no stuck claims |
| Local server writing | Refused, with a message |

**Setup (about 10 minutes, in your Google account):**
1. Google Cloud console:
   1. Create (or pick) a project and enable the **Google Sheets API**.
   2. IAM & Admin → Service accounts → **Create service account** (no roles needed).
   3. Keys → Add key → **JSON**, and download it.
2. Create a Google Sheet (any name). **Share** it with the service account's `client_email` as **Editor**.
3. Copy the spreadsheet id from its URL (`https://docs.google.com/spreadsheets/d/<THIS PART>/edit`).
4. Add to `.env`:
   - `GOOGLE_SHEET_ID=<id>`
   - `GOOGLE_SERVICE_ACCOUNT_JSON=<the whole JSON on one line>`
5. Upload both as Worker secrets, then on the board press **Resync all** once to fill the sheet with existing jobs.

**Code:** `src/sheets/google.ts` (service-account JWT with WebCrypto, Sheets client), `src/sheets/mirror.ts`
(rows, sync, resync), `src/sheets/queue.ts` (hook used by the tools, payments and board) ·
**Tests:** `test/sheets.test.ts`:
- the RS256 JWT is verified with Node's crypto
- claims, a malformed key, row parsing, phone masking, RAW writes
- first sync (header + append + row map), update in place, concurrent claim, Google failing, mirror off
