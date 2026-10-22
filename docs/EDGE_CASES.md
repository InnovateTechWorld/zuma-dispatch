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
| A1 | Raw NIPOST postcode, any format (`FC-02-A09-DB-09`, `fc02a09db09`, `FC 02 A09 DB 09`) | Parsed, then LGA from NIPOST, area from the fixed FCT table, `needs_detail` | U `findPostcode`; live MCP run (TESTING.md) |
| A2 | NIPOST's sandbox codes (`FC-01-A01-KP-27` …) | NIPOST answers `not_found`. They are in Abaji (FCT), ~89 km from the centre: in coverage since the two-state change, so `needs_detail` | U; live MCP run; NIPOST re-checked 2026-10-20 18:20 |
| A3 | Geocoder places an LGA in the wrong spot (Photon: "Abaji" → FCT Administration, Garki) | FCT uses the fixed area-council table; elsewhere a result must name the LGA | U `namesLga`; live: Abaji now 88.8 km every time |
| A4 | Postcode + landmark matching places elsewhere ("Abaji General Hospital" → Wuse, Bauchi) | Matches more than 35 km from the postcode's area are dropped; if none remain, the postcode's area is used | U `withinKm`; live MCP run |
| A5 | Lagos postcode (`LA-01-…`) | Area named (Agege, Lagos), in coverage, `needs_detail`; other states' postcodes → `out_of_area` | Live MCP run |
| A7 | Tester wants a postcode that "just knows where I am" | Four demo postcodes (FCT 1, Lagos 3, incl. the Paystack office), test keys only, `nipost_status: "demo"` | U (parse, state, test-key gate); E (`la11zdmps01` → Paystack office); live quotes ₦3,000 / ₦2,850, interstate refused |
| A6 | Cached answers computed by older logic | Stable-answer cache key versioned (now `resolve:v5:`, bumped when the result shape changes) | Code; live: a pre-v5 cached answer lacked `confirm` until the bump |
| A8 | Customer gives exact demo postcodes: a separate "is that right?" per address wastes turns | `confirm: "in_quote"`: one quote message reads both addresses back and asks "Please check both addresses. Are they correct? Reply YES to continue, or tell me which one is wrong." | U `demoConfirm`, `quoteView`; live MCP: Paystack office → UNILAG ₦3,000 with the address-check question |
| A9 | A landmark that two providers agree on but is the wrong place | Map results are always `ask_first`: read back and confirmed before quoting | U (`confirmedInQuote` false for non-demo); live MCP: Ikeja City Mall → `ask_first` |
| A10 | Mixed: one postcode, one landmark | The landmark is confirmed first; the quote still uses the address-check question, so both are seen together before the yes | Live MCP: Paystack office → Ikeja City Mall ₦1,950, address-check question |
| A11 | Demo postcode in the other state | `ask_first` with the interstate note; the quote is refused (`INTERSTATE_NOT_SUPPORTED`) | U `demoConfirm(…, 'FC')`; live MCP: Jabi postcode with a Lagos hint |
| A12 | "No, the pickup is wrong" / "yes but medium" / "how long?" after the combined question | Not a yes: re-resolve that address and re-quote, re-quote the new size, or answer and ask again | Skill v12 step 4 |
| A13 | Zuma re-runs the tools on the next turn (Chord shows it only the text) and narrates the check: "My earlier message did match… ignore my last correction… your YES stands" | `history_note` and skill v13: never mention re-checks, "matched", "valid" or "stands"; just give the next step | Simulator 2026-10-21 (josh): seen once with v12, then fixed; U `HISTORY_NOTE` |
| A14 | The quote said "reply YES and I will book it", then asked for names and phone | The quote question only confirms ("Reply YES to continue"). The details come next as one list of only what's missing, then the reservation with no second yes | U: no "book" in either closing question; skill v13 steps 3–6 |
| A15 | Simulator says "The agent didn't answer" (reply took 26 s: tools 0.15 s, the rest model time) | The reply was delivered; press refresh, don't resend. Skill v14 trimmed 12.8 KB → 5.8 KB, `history_note` shortened, and Zuma reuses the Quote ref / job id from the chat instead of re-running resolve + quote on later turns (two fewer model steps on the "yes"/details turn) | Chord thread 6ad8a618…: inbound 12:46:32, reply 12:46:58, `sent`; U `HISTORY_NOTE` length |
| A16 | Bank transfer chosen, but Zuma only said "Reply sent once you have made the transfer" with no account number (the account was created: Test Bank, ₦3,000) | `create_payment_link` now returns a ready `message_for_customer` with the bank, account number, account name, exact amount and expiry (12-hour time); the link version keeps the URL on its own line; skill v15: send it as is | U `transferMessage`, `linkMessage`; live MCP booking → transfer → cancel showed every field |
| A17 | Replies sounded robotic | Skill v15 tone: a friendly person at a courier desk, contractions, first name once known, varied openings. Ready messages are warmer ("Great, Joshua! Your delivery to Bola Ahmed is reserved as ZD-…", "Are both addresses right? If yes, just reply YES…", "Payment received: … Thank you!"). Names are shown capitalised | U `reservedMessage`, closing questions |
| 17 | Landmark addresses ("Jabi Lake Mall") | Geocoder chain: Nominatim + Photon cross-check by default, Google if a key is set, ORS last. | E |
| 18 | Same name, different places ("Shoprite") | Providers disagreeing by more than 400 m, or one provider returning places more than 3 km apart → `ambiguous` with up to 3 candidates for the customer to pick. | U "Shoprite Lugbe case", E (production returned Jabi, Wuse II, Wuse branches) |
| 19 | Too vague ("Abuja", "my house") | `needs_detail` without calling any provider. | E "just 'Abuja'" |
| 20 | NIPOST postcode only (`FC-02-A09-DB-09`) | NIPOST L1 validity check plus LGA name (Abuja Municipal) → area-level place, honestly labelled "area of postcode …" → `needs_detail` (ask for a landmark). Never `ambiguous`. | E, U `findPostcode` |
| 21 | NIPOST sandbox returns `not_found` | Reported as `nipost_status: not_found` and never blocks; the LGA from the reference endpoint still locates the area. | E, FIELD_NOTES #1 |
| 22 | Invalid NIPOST code | `not_found`: "ask them to check it or describe the place". | Code |
| 23 | Legacy 6-digit code (`900288`) | Recognised and not sent to NIPOST (no API). The rest of the text is geocoded. A code alone → `needs_detail`. | U |
| 24 | Phone numbers mistaken for postcodes | Runs of 7+ digits are not treated as legacy codes. | U |
| 25 | Lagos address ("Ikeja City Mall") | In coverage, labelled `state: "Lagos"`; Lagos → Lagos quotes and books | E (Lagos quote, booking, cancel) |
| P1 | Handover code shown before payment ("Booked!") | Booking returns no code; it says "reserved"; the code comes only with the paid confirmation | E ("booking is reserved without a handover code") |
| P2 | Customer says "I have sent it" while the card is still processing | `verify_payment` → `in_progress` with a ready message ("Thanks, … still processing … I'll confirm"); skill: "sent / done / I don pay" are payment claims, never "send another package" | Simulator (2026-10-21): it replied "Is there anything else you'd like to send?"; fixed in skill v10 |
| P3 | Customer asks after payment "when will the rider come?" | Rider assigned at payment; confirmation names rider, vehicle, plate and gives the code | U `chooseRider`, message tests; local approve run (Tunde, LSD 553 XA) |
| P4 | `verify_payment` on a job already paid (e.g. a dispatcher approved it) | Returns the paid confirmation; never "no link, send one" or "under review" | Local: was `NO_PAYMENT_LINK`, now paid + rider + code |
| P5 | Two paths confirm the same payment at once | One rider (`WHERE rider_id IS NULL`), one `rider_assigned` event | Code |
| H2 | Dispatcher double-clicks Send or refreshes after sending | Form nonce claimed in `board_replies` first; the second submit sends nothing | U |
| H3 | Reply to a chat Zuma holds | Chord 409 → "Take it over first"; a Take over button is shown | U |
| H4 | Message refused by the channel | "Not delivered" shown with Chord's reason | U |
| H5 | Send and hand back, send fails | Never hands back | U |
| H6 | Empty / over-4,000-character reply | Refused before any Chord call | U |
| H7 | Reply from a local dev server | Refused (local guard) | U; local browser run |
| H8 | Already handed back by someone else | 409 → explained, nothing changes | U |
| H9 | After a hand-back the AI "corrects" the team's reply and re-escalates | Replies signed "— Zuma Dispatch team"; closing line on hand-back; skill v11 rule | Live: re-escalated before the fix; after it, Zuma took the new request |
| H10 | The simulator hides messages from people | Known simulator limit (its `/state` feed has none); Chord marks them sent; WhatsApp shows them | Live, `/state` inspected |
| H11 | "i want a refund" gets no visible reply in the simulator (Chord's built-in handover ends the AI's turn; its "connecting you" line and our acknowledgement are system/operator messages the simulator hides) | `hand_to_team`: Zuma's own reply ("I've passed this to our support team…") is an AI turn, then the server takes over once that reply is posted (20 s cap). Board: "handed over by Zuma", "Customer told: yes", no second acknowledgement | U `matchThread`, `takeOverAfterReply`; live: unmatched message → `HANDOVER_UNAVAILABLE`, nothing taken over (FIELD_NOTES #22) |
| H12 | `hand_to_team` can't tell which chat (two customers typing the same words at once, Chord down, local server) | Error → Zuma uses the built-in handover; WhatsApp still gets Chord's line + our acknowledgement | U ambiguous → not guessed |
| H13 | A person takes the chat while the server is waiting to take over | The wait sees `human_active` and does nothing | U |
| P6 | Agent confirms payment, then our automatic notice repeats it seconds later | verify_payment claims the notice as `agent_confirmed`; if the customer already saw the notice on a real channel, the agent sends a short follow-up with the rider and code instead | U `noteAgentConfirmed` (none / sent / record_only) |
| P7 | Agent shortened the paid message to "Your delivery is paid and booked", losing the rider and code | what_to_do: reply word for word; message now says the rider is on the way | Simulator 2026-10-21; skill v16 |
| P8 | Simulator: after "paid", Zuma said only "Is there anything else I can help you with?", then later "the earlier rider details and handover code were right". Our automatic notice had been posted into Chord's record 16 s before "paid"; the simulator can't show it, but the AI read it as something it had already said | Notices are no longer posted into chats whose channel can't show them (`channel_cannot_show`); Zuma confirms in its own reply. `verify_payment`: send its message word for word even if an earlier message seems to say it | Live run ZD-XSE4F (Chord record: notice 10:06:20, "paid" 10:06:36); U: simulator chat → skipped, no scheduled task |
| A18 | Zuma said "Correction to what I said above: your delivery was already booked… nothing was duplicated" | It re-called create_dispatch_job for the job id; `already_booked` now says not to mention it; skill bans "already booked, nothing was duplicated" | Live run ZD-XSE4F |
| A19 | Recipient's phone is incomplete, too long, not a Nigerian mobile, or not a number | `INVALID_DETAILS` carries a ready message saying exactly what is wrong (digit count, valid prefixes, an example) | U `phoneProblemMessage`; live: 10 digits, 12 digits, 060… each refused with its own message |
| A20 | A placeholder-looking number (08000000000, 08011111111, 08012345678) | Asked once: "Just checking: is 0800 000 0000 really John's number?"; books after a yes (`recipient_phone_confirmed`) | U `looksMadeUp`; live |
| A21 | A typo in a valid-looking number | The reserved message reads the number back ("to John Doe (0907 656 5434)"); a correction before payment = cancel, re-quote (fresh Quote ref, same price), book. Rebooking a cancelled job's quote gives `QUOTE_ALREADY_USED` with that instruction | Live: book → cancel → same quote refused → re-quote same ₦3,000 → rebooked → cancelled |
| A22 | "No 23 Saint Finbarrs Road" (Akoka) found nothing: house number, "Saint" vs "St", "Finbarrs" vs the map's "Finbarr road" | When nothing usable comes back, retry with a cleaned spelling (in parallel with the area); the house number the customer gave is kept in the label for the rider | U `cleanedQuery`, `houseNumber`; live: → "23 Finbarr road, Akoka, Bariga, Shomolu" |
| A23 | "Saint Finbarrs College, Akoka": offered St Gregory's and St Mary's (they share only "Saint"/"College"), or a St Finbarr's church in Jos | Results must match the place's own name (the first distinctive word; abbreviations like UNILAG/LUTH match the initials); with the city known, same-named places elsewhere lose to the area the customer named | U `isRelevant`; live: → "Akoka, Bariga, Shomolu, Lagos State" (area) |
| A24 | A place that is not on the map at all (the college is missing from OpenStreetMap) | Area fallback: confirmed at `area` precision with "not on the map; only the area was found", ask for the street or a landmark for the rider; can still be quoted once the area is confirmed | Live (A23); "saint finbarrs school akoka lagos" no longer matches CMS Grammar School |
| A25 | Regressions from stricter matching | Ten common landmarks re-checked live after the change: Jabi Lake Mall, Ikeja City Mall, Wuse Market, Computer Village, Eko Hotel, Lekki Conservation Centre, Murtala Muhammed Airport, Ota (still out of area), Yaba Market (known rough spot, unchanged), UNILAG, Shoprite (still asks which) | Live 2026-10-22 |
| T1 | "Where is the rider?": "I don't have a live map location" | Simulated position from the job's timestamps (15-minute approach, then trip time once dispatched), minutes away, km and a map link; same moment gives the same answer; outside rider hours it says when | U `simulateRider` (all phases); live: ZD-QFJ5F at pickup with map link |
| B33 | Opening a handover jumped down the page; long chats made the page scroll forever | Fixed-height message panel that scrolls inside itself, opens at the newest message with no script (reversed column), reply box pinned under it; no `#reply` jumps; phone: details fold into "About this chat" | M: 1366 and 375 px: page at top, panel at newest, Send visible, no sideways scroll |
| H1 | Handed to a human but the customer sees nothing | Server posts "You're now connected to the Zuma Dispatch support team…" on the escalation webhook; board column "Customer told" | Local signed webhook: agent → attempted (skipped locally), human take-over → not sent |
| C7 | The agent retracts or apologises for correct earlier answers (it can't see earlier tool results) | `history_note` in every tool result (context only, never mentioned); "Quote ref Q-…" in the quote text; skill: no unneeded apologies, never talk about tools or earlier messages | Simulator: v6–v8 retracted or apologised; v9 clean on the same 3 turns (FIELD_NOTES #18) |
| ST1 | Lagos → Abuja (or Abuja → Lagos) | `quote_delivery` → `INTERSTATE_NOT_SUPPORTED`; the agent offers a human | E; simulator: declined before quoting, human offered |
| ST2 | An Abuja place named during a Lagos booking | `what_to_do` carries an interstate note before quoting | E |
| ST3 | Border suburbs in other states (Mararaba, Karu: Nasarawa; Suleja: Niger; Ota, Arepo, Agbara: Ogun) | `out_of_area`, named | U (22 towns vs OSM's own state); E (Ota, Suleja) |
| ST4 | Same name in both cities ("Shoprite") | Skill: ask "Is this in Abuja or Lagos?"; with `state` the other city's matches are dropped | U `preferState`; live MCP run; simulator asked exactly that |
| ST5 | Every match is outside both states ("Ota, Ogun State" → two Ogun places) | One `out_of_area`, not a "which one?" question | Live MCP run |
| ST6 | Duplicate labels ("Badagry, Lagos State" twice) | Merged | Live MCP run |
| ST7 | Just "Lagos" / "Eko" | `needs_detail` | E |
| ST8 | NIPOST sandbox codes (Abaji, FCT) | Now in coverage → `needs_detail` (ask for a landmark) | E |
| ST9 | Places resolved before the change (stored in-area flag from the old 40 km rule) | Quotes judge the coordinates again; migration 0010 backfills `state` | Code |
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
| 35 | Very long trip inside a state | Priced per km up to 160 km by road; beyond that → `TRIP_TOO_LONG` (a wrong-geocode guard) | Code |
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
| 51 | Board CSRF (the session cookie, or browser-cached credentials, would be sent automatically) | POST needs a same-origin `Origin`/`Sec-Fetch-Site`. A stale page is caught by the version check. | M: cross-site POST → 403; stale version → "changed since you loaded" |
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

## "Payment received" pushed into the chat (FEATURES §5a)

| # | Case | Handling | Evidence |
|---|---|---|---|
| N1 | Paid by webhook / return page / dispatcher approval, customer silent | Conversation found by the agent message that contains the job id; one MESSAGE task queued | U (whole send against a fake Chord API) |
| N2 | Paid because the customer asked in the chat | Nothing pushed; the agent confirms in its reply (no duplicate) | Code path (`via: verify` does not trigger) |
| N3 | Paystack retries, or webhook + return page together | Atomic claim in `chat_notices`: one notice per job | U "sends at most once" |
| N4 | Job id appears in chats with two different customers | Sent only to the booker (the chat where the agent first sent the id); a tie is never guessed | U `pickThread`; live: ZD-2RWZ9, mentioned in two simulator chats, picked the booking chat |
| N5 | A customer typed someone else's job id | Only agent turns count | U `agentMentioned` |
| N6 | Same customer, two conversations | The most recently active one | U |
| N7 | A human holds or paused the chat | Not sent (Chord would deliver over the operator) | U; live: ZD-2RWZ9's booking chat was handed to a human, so `skipped: human_handling`, nothing sent |
| N8 | Customer writing right now | Not sent if their message is under 90 s old and unanswered; the agent will confirm | U |
| N9 | Outside WhatsApp's 24-hour window | Not sent | U |
| N10 | Key missing a scope / Chord down / timeout | Recorded as `failed` with Chord's reason; never throws; webhook unaffected | U; live: `chord_http_403: Missing required permission: thread:read` with the narrow key |
| N11 | Worker evicted mid-send | A `pending` claim older than 5 min can be retaken | Code (`claim`) |
| N12 | Dispatcher wants to retry | "Send again" on the job page retries failed / skipped only; a queued notice is never resent | Code; local run (blocked as `local_server`) |
| N13 | Local test server with the real key in `.env` | Sends nothing unless `CHORD_NOTICES_ALLOW_LOCAL=1` | U; local e2e (42 checks, no Chord calls made) |
| N15 | Chat is on a surface Chord cannot push to (the simulator) | `DIRECT_LINE` writes it into the conversation record (the agent knows); board says `record_only` instead of "delivered" | Live: ZD-H01G4 task COMPLETED, turn in Chord's record, not shown in the simulator |
| N16 | Operator route side effects | Chord sends "connecting you with a teammate" and fires `conversation.escalated` on take-over; opt-in only; board filters our own escalations | Live: both observed; board showed no false handover |
| N17 | Hand-back fails | Retried 3 times; then flagged on the job page and the "waiting on you" strip (agent would stay silent otherwise) | U |
| N18 | A person takes the chat between our check and our take-over | Take-over 409 means skipped, nothing posted | U |
| N14 | The agent sees a message it did not write | Skill v5: a "Payment received: …" message is from our system; treat it as true and don't ask for "paid" | Live: after the notice, "what happens now?" got "Your payment is confirmed and the booking is with the dispatcher" (it also re-checked with `verify_payment`) |

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
| B7 | Filter button "did nothing" | Root cause: the board was opened through a link with the password embedded in it (`https://user:pass@host/board`). The form's relative action inherits those credentials, and Chromium silently drops navigations to URLs with embedded credentials. *Fix:* a sign-in page with a cookie session, so no URL carries a password; status filters are plain links | M: reproduced (click → no request, no console error), then fixed; `?q=ada&status=paid` → 1 match in the browser (FIELD_NOTES #12) |
| B8 | Auto-refresh wiped the search box mid-typing | Refresh is off by default; `live=1` turns it on and survives filters and actions | M |
| B9 | Our own form posts refused as "cross-site" | Under `Referrer-Policy: no-referrer`, browsers send `Origin: null` on form posts. Now `Sec-Fetch-Site` is checked first, `Origin: null` is never trusted as same-site, and the policy is `same-origin` | U `crossSite`; M: sign-in in the browser |
| B10 | Password guessing | 10 wrong tries per IP per 15 min → 429 + `Retry-After`; every attempt is counted atomically before the password is compared, so parallel guesses cannot slip under the limit and the 11th is not even checked; Basic auth counts too; a correct password clears the count | U `lockoutSeconds`; local run: 10 × 401, then 429 `Retry-After: 900`, a correct password from that IP also 429, another IP 200 |
| B11 | Stolen or leftover cookie | Sign out deletes the row; sessions expire after 12 h; rotating `BOARD_TOKEN` voids all sessions; D1 holds only the hash | M: after sign-out, the job URL redirects to sign-in |
| B12 | Open redirect through `next=` | Only `/board…` paths with safe characters; `//evil`, absolute URLs, `..`, backslashes → `/board` | U `safeNext` |
| B13 | Session ends while a form is being submitted | No change is made; redirect to sign-in with "sign in and do it again" | Code path in `boardGate` |
| B14 | Browser shows its own password popup | No `WWW-Authenticate` header is ever sent from `/board` | S ("browsers never get a password popup": wrong Basic credentials, header absent) |
| B15 | Narrow phones | Rows become two-column cards; steps stack; no sideways scroll at 320/375/414/768 | M: `scrollWidth` = viewport at all four widths (a screen-reader-only table caused 17 px overflow at 320; fixed) |
| B16 | Charts with no data / misleading counts | Empty states say so; "How payments were confirmed" counts only jobs currently paid or later (a paid-then-cancelled mismatch no longer inflates it) | U charts; M |
| B17 | A crafted link puts words on the board (`/board?msg=Payment approved`) | The message after an action travels signed with a key derived from `BOARD_TOKEN`; unsigned or tampered messages are not shown | U `readFlash` |
| B18 | Opening a board link from the sheet, chat or email | The cookie is `SameSite=Lax`, so a link from another site arrives signed in; cross-site POSTs still never carry it and are refused by the CSRF check | U cookie flags |
| B19 | Approving a reviewed payment | Sets `paid_at` and records `via: dispatcher`, so the job counts in "Paid today" and the sheet's Paid at / Paid via columns | Code path in `boardAction` |
| B20 | Odd form values (`action=constructor`) | Actions are looked up with `Object.hasOwn`, so unknown keys get "Unknown action." instead of a 500 | Code path |
| B21 | Everything on one long page (the user's complaint) | Five tabs (Home, Deliveries, Handovers, Payments, System), each with sub-tabs that have their own URLs; Home shows only what needs a person, today's numbers and the latest five jobs | M: every page at 1366, 375 and 320 px, light and dark |
| B22 | Old links to `/board?status=paid` (sheet, bookmarks, flash redirects) | `/board` with `status`, `q` or `city` → 302 to `/board/deliveries` with the same query | Local run: `302 → /board/deliveries?status=paid` |
| B23 | Chord slow or down while the board loads | Waiting-chat count has a 2 s request timeout plus a 2.5 s hard cap; on failure the badge is left off and Home says "Could not reach Chord" (never "nobody is waiting") | U `alertsFrom` (unreachable) |
| B24 | Expected tool refusals look like outages | Only `INTERNAL_ERROR`, `UNKNOWN_TOOL`, `PAYMENT_PROVIDER_BUSY` and `*_UNAVAILABLE` count as "broke"; out-of-area, not-found and between-state answers are refusals | U `isFault`; local data: 213 errors, all refusals → no alert |
| B25 | Theme switch abused or broken | Unknown value, cross-site post or GET → no cookie, redirect to a safe board page; a `back` outside `/board` → `/board`; from the sign-in page the safe `next` is kept; "Match device" deletes the cookie; the cookie is HttpOnly + SameSite=Lax | U `readTheme`, `themeCookie`, `safeBack`; local curl for each case |
| B26 | Theme choice vs device setting | Light/dark choice wins over `prefers-color-scheme`; "Match device" follows it; works without JavaScript | M: dark cookie on a light-emulated device renders dark; Match device on light renders light |
| B27 | Flash message repeats after changing theme | The return path drops `msg`, `sig` and `tone` | U `hereWithoutFlash` |
| B28 | Warn before the sign-in lockout | Tries 7–9 show "3/2/1 tries left"; the 10th shows "No tries left" and disables the form; the 11th gets 429 | Local run with one client IP: exactly that sequence |
| B29 | Owner needs to tell staff something | `BOARD_ANNOUNCEMENT` banner on sign-in and Home; whitespace collapsed, 280-character cap, HTML-escaped, absent when empty | U `announcementText`, `announcement` |
| B30 | Phone width with five tabs | Fixed bottom tab bar (icons + labels, 60 px targets, safe-area inset); the body is padded so it never covers content; the theme switch becomes one button | M: 320 px, no overflow, no wrapped labels |
| B31 | Badge numbers get huge | Badges cap at "99+"; screen readers hear "Handovers, 3 waiting" | Code path in `tabLinks` |
| B32 | Unknown board path, unknown job, bad conversation id | 404 inside the board shell with tabs and a link onward; no Chord call is made for it | Local run: `/board/nope` 404, `/board/jobs/ZD-00000` 404 |

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
| M9 | Token signing | RS256 JWT built with WebCrypto, verified by Node's crypto in tests | U, live (Google accepted it) |
| M10 | Local dev server pointed at the production sheet | Writes refused unless `SHEET_MIRROR_ALLOW_LOCAL=1` | U, live (local resync refused) |
| M11 | Every job mirrored after heavy activity | 37/37 jobs mapped, highest row 38, no stuck claims after a full e2e run on production | Live, D1 query |

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

- Chat notices cover "payment received" only. Other unprompted updates (rider assigned, delivered) would
  use the same mechanism but are not built.
- Rate limiting of our own endpoint relies on Cloudflare plus the bearer token. There is no per-sender quota.
- The handover code is generated and shown but not verified at delivery.
