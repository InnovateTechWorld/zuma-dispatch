# Edge cases and how they are handled

Every row names the code that handles the case and the evidence that it works.

**Evidence key:**
- **U**: unit test (`npm test`, `test/*.test.ts`).
- **E**: end-to-end check (`python3 scripts/e2e.py <url>`), run against both local and production.
- **S**: smoke test (`scripts/mcp-smoke.sh <url>`).
- **M**: manual run, described in the row (Paystack test checkout in the browser, 2026-10-20).

## Money and trust

| # | Case | Handling | Evidence |
|---|---|---|---|
| 1 | The model states or invents a price | No tool accepts a price. Schemas are `.strict()`, so an extra `price`/`amount` key is rejected with "prices are worked out by the server". The job amount is copied from the stored quote; the Paystack amount from the job. | E "model tries to pass a price", S |
| 2 | The model books without the customer's yes | `customer_confirmed` must be the literal `true`. Otherwise the error tells the model to read back the details and ask "Shall I book it?" | E "no explicit yes", S |
| 3 | Customer says "I've paid" (or sends a screenshot) | Only `verify_payment` can mark a job paid, after asking Paystack. The skill forbids saying "paid" without it. | E "unpaid -> not_paid_yet" |
| 4 | Paystack returns `status:true` for an unpaid transaction | The top-level `status` is ignored. Paid only if `data.status == "success"` **and** amount, currency and reference match. | U `decideAttempt` (8 cases) |
| 5 | Successful payment with the wrong amount, currency or reference | Job → `amount_mismatch`, payment → `mismatch`. The agent gets `needs_review` and hands over. The board shows the reason. | U "flags a successful payment with the wrong amount" |
| 6 | Freshly created checkout shows as `abandoned` | Treated as "not paid yet" and the link is reused. It is only replaced after an hour or on failure. | U, M (seen on a real probe) |
| 7 | `ongoing`/`pending`/`processing`/`queued` | `in_progress`: the customer is told to finish the OTP/transfer. `cancel_job` refuses while a payment is in progress. | U |
| 8 | Customer pays twice (two links) | All recent attempts are verified. More than one success → `needs_review` "paid N times, one needs refunding". | Code path in `payments/service.ts`; U `combine` |
| 9 | Customer pays the link of a cancelled job | Detected on verify and on the return page → `needs_review` "paid for a cancelled job, refund needed". Recorded once only. | M: paid ZD-ZDZ9Q after cancel; return page said "We are checking your payment", verify returned needs_review, board listed it once |
| 10 | Two checks race (return page + agent) | Job transitions are compare-and-set (`UPDATE … WHERE status IN (…)` + `meta.changes`) in a D1 batch, with the event written only if the update won. | M: return page and verify both ran for ZD-K45V7; one `status_changed` event |
| 11 | Paystack rate limit (100/min in test mode) | Each reference is re-verified at most once per 10 s. A 429 → `PAYMENT_PROVIDER_BUSY` "ask them to message again in a minute; do not retry in a loop". | Code: `RECHECK_INTERVAL_MS`, `paystack.ts` |
| 12 | Paystack initialize times out | The attempt row is written **before** the call. Retry once with the same reference. `duplicate_reference` → the first call got through but we lost the URL, so move to the next attempt number. The orphan is still verified later. | Code: `newAttempt` |
| 13 | Double tap on "send link" | Returns the same open link (`reused_existing_link`). A truly concurrent second request hits `UNIQUE(job_id, attempt)` and gets "wait a few seconds". | E "second request reuses the same link" |
| 14 | More than 5 payment links for a job | `TOO_MANY_PAYMENT_ATTEMPTS` → hand over. | Code |
| 15 | Paystack redirect used as proof | `/pay/return` verifies server-side before showing "Payment received". | M |
| 16 | Live keys used by mistake | Server refuses to serve tools unless keys start `sk_test_` / `nipost_test_`. The error names the variable but never the value. | U "config safety" |

## Bank transfer (Paystack "Pay with Transfer")

| # | Case | Handling | Evidence |
|---|---|---|---|
| T1 | Customer wants an account number instead of a link | `create_payment_link(method: "bank_transfer")` → Paystack Charge API issues a one-time account (bank, number, name, exact amount, 30 min expiry) sent straight into the chat | E "transfer details", M (Test Bank account returned) |
| T2 | Asks for the details twice | Same open account returned while more than 8 min remain; then fresh details | E "asking again returns the same account" |
| T3 | Says "sent" before the bank confirms | `awaiting_transfer` with the details repeated; "transfers can take a few minutes, message again shortly"; never "paid" | E "nothing sent yet -> awaiting_transfer"; M: checkout transfer for ZD-YMK4G simulated with "I've sent the money" → verify returned `paid` ~30 s later |
| T4 | Switches between link and transfer | New method allowed; the agent is told to warn "pay only one way". If both are paid → double-payment review (row 8) | E "switches to a card link" |
| T5 | Wrong amount transferred | Paystack reverses inexact transfers. If one ever settles, verify's amount check → `amount_mismatch` → human | U (row 5) |
| T6 | Account expired unpaid | After expiry + 15 min grace it counts as "not paid" (not "in progress"), so new details can be issued and cancel isn't blocked; late arrivals are still verified by reference | U `isAwaitingTransfer`, code `expiredTransfer` |
| T7 | Cancel with an unpaid transfer account open | Allowed (no money moved), with "don't send money to the transfer account; if you already did, a dispatcher refunds". A card payment mid-OTP still blocks cancel | E "cancel allowed while the transfer account is unpaid" |
| T8 | WhatsApp in-chat payment ("WhatsApp Pay") | Not available in Nigeria (officially India, Brazil, Singapore, Mexico). The Paystack link opens in WhatsApp's in-app browser; transfer details are plain chat text | Research, README |

## Addresses

| # | Case | Handling | Evidence |
|---|---|---|---|
| 17 | Landmark addresses ("Jabi Lake Mall") | Geocoder chain: Nominatim + Photon cross-check by default, Google if a key is set, ORS last. | E |
| 18 | Same name, different places ("Shoprite") | Providers disagreeing by more than 400 m, or one provider returning places more than 3 km apart → `ambiguous` with up to 3 candidates for the customer to pick. | U "Shoprite Lugbe case", E (production returned Jabi, Wuse II, Wuse branches) |
| 19 | Too vague ("Abuja", "my house") | `needs_detail` without calling any provider. | E "just 'Abuja'" |
| 20 | NIPOST postcode only (`FC-02-A09-DB-09`) | NIPOST L1 validity check plus LGA name (Abuja Municipal) → area-level place, honestly labelled "area of postcode …" → `needs_detail` (ask for a landmark). Never `ambiguous`. | E, U `findPostcode` |
| 21 | NIPOST sandbox returns `not_found` | Reported as `nipost_status: not_found` and never blocks; the LGA from the reference endpoint still locates the area. | E, FIELD_NOTES #1 |
| 22 | Invalid NIPOST code | `not_found`: "ask them to check it or describe the place". | Code |
| 23 | Legacy 6-digit code (`900288`) | Recognised and not sent to NIPOST (no API). The rest of the text is geocoded. A code alone → `needs_detail`. | U |
| 24 | Phone numbers mistaken for postcodes | Runs of 7+ digits are not treated as legacy codes. | U |
| 25 | Outside Abuja ("Ikeja City Mall, Lagos") | Resolves normally anywhere in Nigeria, then `out_of_area` (40 km radius). `quote_delivery` also refuses it. | E |
| 26 | Geocoder returns a point outside Nigeria | Dropped (Nigeria bounding box and coordinate validity). | Code `keep()` |
| 27 | Nonsense text | `not_found` with landmark guidance. The skill escalates after two failures. | E |
| 28 | A provider is slow or down | Per-call timeout (4 s). In cross-check, once the first answers the second gets 1.5 s more, then it finishes in the background into the cache. The chain stops starting new providers after 6 s. All down → `GEOCODER_UNAVAILABLE` "try once, then hand over". | E timings (8 s → ~1.5 s) |
| 29 | Repeated lookups / Nominatim policy | D1 cache (30 days for hits, 1 day for empty results), identifying User-Agent, at most 1 Nominatim request per second per isolate. | E "repeat lookup served from cache" |
| 30 | The model passes coordinates or invents a place id | No coordinate inputs exist. Unknown `place_id` → `PLACE_NOT_FOUND` "call resolve_address first". | E |
| 31 | Pickup = drop-off | Same id or less than 150 m apart → `SAME_LOCATION`. | E |

## Quotes and jobs

| # | Case | Handling | Evidence |
|---|---|---|---|
| 32 | Router down (OSRM/ORS) | Falls back to straight line × 1.4. The quote is marked `approximate_distance` and the agent says "estimated". | Code `routing/route.ts` |
| 33 | Asking for the same quote twice | The same unexpired quote is returned (stable price, no duplicate rows). | E "reuses the quote" |
| 34 | Quote expired (30 min) | `create_dispatch_job` → `QUOTE_EXPIRED` "re-quote, tell the new price, get a fresh yes". Never silently re-priced. | Code |
| 35 | Very long trip inside the radius | More than 60 km by road → `TRIP_TOO_LONG`. | Code |
| 36 | Area-level place (e.g. "Garki") | Quoting is allowed, and the agent is told to also ask for a landmark for the rider. | Code |
| 37 | Double "yes" / retried booking | `UNIQUE(quote_id)`: the same job is returned (`already_booked`). Concurrent inserts are caught and also return the winner. | E "double 'yes'" |
| 38 | Bad phone ("12345", UK number, landline) | Normalised to +234 E.164. Wrong length, non-mobile prefix or letters each get a specific prompt. | U (10 cases), E |
| 39 | Junk names, zero-width characters, URLs | Cleaned (NFC, control and zero-width characters stripped). Fewer than 2 letters or a URL → asked again. | U |
| 40 | Ids typed loosely (`zd7k3qp`, `#ZD-7K3QO`) | Normalised (case, hyphen, O→0, I/L→1). | U, E (lower case id accepted) |
| 41 | SQL injection via ids | Ids are validated against the alphabet before any query, and every query is parameterised. | U |
| 42 | After-hours booking | Bookings are accepted any time. `pickup_timing` says "tomorrow/Monday from 7am" (WAT, no DST). | U (4 cases) |
| 43 | Cancel before payment | Checks every open Paystack attempt first. In progress → refuse. Paid → refuse and hand over. Idempotent. | E, M (cancel refused for paid ZD-K45V7) |
| 44 | Cancel or change after payment | `CANNOT_CANCEL` → human (refunds are human-only). | M |
| 45 | Status asked for an unknown job | `JOB_NOT_FOUND` "ask for the id from the booking message". | E |

## Server and platform

| # | Case | Handling | Evidence |
|---|---|---|---|
| 46 | Missing or wrong bearer token | 401 with `WWW-Authenticate`, constant-time compare, token never logged. | S |
| 47 | Browser / DNS-rebinding request | Any `Origin` header → 403 (Chord sends none; checked on 4 captured requests). | S |
| 48 | GET/DELETE on /mcp | 405 (stateless server). | S |
| 49 | Chord calls `tools/list` without `initialize` | Works: the server is stateless. | Observed in Chord's discovery |
| 50 | Free-plan CPU limit (10 ms) | Low-level SDK server, Workers JSON-schema validator, schemas compiled and warmed at module load. | FIELD_NOTES #2 (median 4 ms) |
| 51 | Board CSRF (Basic auth is sent automatically) | POST needs a same-origin `Origin`/`Sec-Fetch-Site`. A stale page is caught by the version check. | M: cross-site POST → 403; stale version → "changed since you loaded" |
| 52 | HTML injection on the board (names, labels) | Every value is escaped, plus a strict CSP (`default-src 'none'`). | U `escapeHtml` |
| 53 | PII in logs | Logs carry ids, codes, latencies and provider paths only. The phone is masked in tool output; the full number is shown only on the authenticated board. | Code review |
| 54 | Cloudflare blocks unusual clients | `Python-urllib` gets Cloudflare error 1010 before the Worker runs. Chord's Java client and curl are fine. Scripts set their own User-Agent. | FIELD_NOTES #4 |

## Payment notifications (Paystack webhook)

| # | Case | Handling | Evidence |
|---|---|---|---|
| W1 | Customer pays and never says "paid" | Paystack webhook → re-verify with the API → job paid, board shows "paid via Paystack notification" | Simulator run (see FIELD_NOTES #10) |
| W2 | Forged or tampered webhook | HMAC-SHA512 signature over the raw body; missing, wrong or tampered → 401 | U (3 cases), E "bad signature -> 401" |
| W3 | Correctly signed but false "success" (e.g. replayed or mis-sent) | The payload is never trusted: the server re-verifies with Paystack; unpaid stays unpaid | E "signed 'charge.success' for an unpaid link" |
| W4 | Paystack's verify API down during the webhook | 503 so Paystack retries; return page and `verify_payment` still work | Code `paystackWebhook.ts` |
| W5 | Duplicate deliveries / webhook + return page + agent at once | Compare-and-set transitions; one `status_changed` event; an audit row per delivery | Code, U (`combine`) |
| W6 | Event for a reference that isn't ours | 200, logged as `unknown_reference` | U, E |
| W7 | Refund or dispute | Job flagged `needs_review` with the reason | U (event shapes), code |
| W8 | Request not from Paystack's IPs | Logged (`ip_trusted = no` on the board); the signature decides | Code |
| W9 | Webhook URL not configured | Paths B (return page) and C (`verify_payment`) still confirm | E (all payment checks pass without it) |

## Status without a job id

| # | Case | Handling | Evidence |
|---|---|---|---|
| S1 | Same conversation | Job id is in the conversation text and Customer Memory | Simulator |
| S2 | New conversation, same customer | Chord memory ("Booking ZD-…") is loaded into the prompt | Simulator (FIELD_NOTES #10) |
| S3 | No id anywhere | `get_job_status(recipient_phone, sender_name)` with any phone format and first name | E "found by recipient phone (any format) + first name" |
| S4 | Wrong name / someone guessing | `JOB_NOT_FOUND`; needs both factors; never returns the handover code | E "wrong sender name", "never reveals the handover code" |
| S5 | Several bookings match | Listed (drop-off, when booked) for the customer to choose | Code |
| S6 | Neither id nor details | `NEED_JOB_REFERENCE`: check memory, else ask | E |

## Admin board

| # | Case | Handling | Evidence |
|---|---|---|---|
| B1 | Find one delivery among many | Search by job id (any case), phone (any format), name or address; status filter with counts | U `searchFilter`; local run: id → 1, phone → 7, name → 7, status=paid → 1 |
| B2 | Bogus filter values | Unknown status is ignored; LIKE wildcards stripped; values are bound parameters | U, local run (`status=hacked` → all jobs) |
| B3 | See everything about a job | Detail page: places (+ how each was found), quote breakdown, all payment attempts, Paystack notifications, timeline | Local run (ZD-K45V7, ZD-FHMY8) |
| B4 | Unknown job / path | 404 page | Local run |
| B5 | Two dispatchers click at once / stale page | Version check + compare-and-set | Earlier manual run (FIELD_NOTES, EDGE_CASES #51) |
| B6 | Payment arrived without the customer writing | Row shows "paid via Paystack notification" | Local run: ZD-FHMY8 paid only by the webhook |

## Google Sheet mirror

| # | Case | Handling | Evidence |
|---|---|---|---|
| M1 | Google API down or quota exceeded | Background sync, error caught, shown on the board, repaired on the next change or by Resync | U "Google failing" |
| M2 | Two quick changes on a new job | Row claimed in D1 first, so no duplicate rows | U "another sync is appending" |
| M3 | Job changes later | Its own row updated in place | U "known job" |
| M4 | Tab deleted or renamed | Recreated (with header) and append retried once | Code `syncJob` |
| M5 | Owner edits or sorts the sheet | Never read back; Resync all rebuilds from D1 | Code `resyncAll` |
| M6 | Formula injection via names or addresses | `valueInputOption=RAW` | U (asserts RAW + raw text kept) |
| M7 | PII in a shareable sheet | Phone masked | U |
| M8 | Mirror not configured or bad key | No Google calls; `/health` + board say so | U "mirror off", `mirrorStatus` |
| M9 | Token signing | RS256 JWT built with WebCrypto, verified by Node's crypto in tests | U |

## Conversation memory (Chord-specific)

| # | Case | Handling | Evidence |
|---|---|---|---|
| C1 | The model can't see earlier tool results and re-resolves every turn | Same text → same `place_id` for 6 h (stable answers), so it gets the same quote back | E "same text -> same place_id" |
| C2 | The model "forgets" a booking and books again | Duplicate guard: same sender + recipient phone + size + route (within 200 m), unpaid, < 2 h → the existing job is returned | E "re-booked under a different quote id", simulator (FIELD_NOTES #9) |
| C3 | Different senders to the same recipient | Never merged (sender name is part of the match) | E "a different sender … is NOT merged" |
| C4 | Two customers ask for the same trip | A quote that has a job is never re-issued | E reruns (35/35 twice on production) |
| C5 | The model disowns an id it already sent | Skill v2 rule: ids already sent are real; continue with them | Simulator: after v2 the agent continued with real job ids |
| C6 | Test traffic colliding with real conversations | The e2e script uses unique identities per run | FIELD_NOTES #9 |

## Known gaps (deliberately not built)

- No Paystack webhook: payment is verified on demand and on the return page. A late payment is
  noticed only when someone checks. That is the go-live item #1.
- No proactive WhatsApp messages: the agent replies only when the customer writes.
- Rate limiting of our own endpoint relies on Cloudflare plus the bearer token. There is no per-sender quota.
- The handover code is generated and shown but not verified at delivery.
