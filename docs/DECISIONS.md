# Decisions, and why

The main choices behind Zuma Dispatch: what we picked, what else we considered, and the evidence. Entries
marked "FN #" refer to the full build log, [FIELD_NOTES_FULL.md](FIELD_NOTES_FULL.md). Screenshots are in
[screenshots/](screenshots/).

**Contents**
1. [Scope: two states, same-day, no interstate](#1-scope-two-states-same-day-no-interstate)
2. [NIPOST postcodes and our four demo codes](#2-nipost-postcodes-and-our-four-demo-codes)
3. [Finding addresses: four geocoders, Google first](#3-finding-addresses-four-geocoders-google-first)
4. [Coverage is a state boundary, not a radius](#4-coverage-is-a-state-boundary-not-a-radius)
5. [The booking conversation: order and the fast path](#5-the-booking-conversation-order-and-the-fast-path)
6. [Prices come from the server, never the model](#6-prices-come-from-the-server-never-the-model)
7. [Payments: Paystack link or bank transfer, webhook plus re-check](#7-payments-paystack-link-or-bank-transfer-webhook-plus-re-check)
8. [Riders, phone numbers and tracking are simulated](#8-riders-phone-numbers-and-tracking-are-simulated)
9. [Handover: our own tool instead of Chord's](#9-handover-our-own-tool-instead-of-chords)
10. [The tools write the customer's words](#10-the-tools-write-the-customers-words)
11. [Hosting: Cloudflare Workers and D1](#11-hosting-cloudflare-workers-and-d1)
12. [The dispatcher board: server-rendered, no JavaScript](#12-the-dispatcher-board-server-rendered-no-javascript)
13. [What we left out](#13-what-we-left-out)
14. [The rider side: designed, not built](#14-the-rider-side-designed-not-built)
15. [What stopped us, and what we'd build with more time or resources](#15-what-stopped-us-and-what-wed-build-with-more-time-or-resources)

---

## 1. Scope: two states, same-day, no interstate

- **Chosen:** deliveries within the FCT (Abuja) or within Lagos State, booked and paid in one WhatsApp chat.
- **Why these two:** they are Nigeria's two largest courier markets, and a business in each runs the same
  way: a phone, a rider pool and a WhatsApp number.
- **Interstate is refused** at the quote (`INTERSTATE_NOT_SUPPORTED`) with a human offered. It needs
  waybills, park drop-offs and multi-day tracking, which is a different product.

## 2. NIPOST postcodes and our four demo codes

**The ask.** Customers should be able to give a NIPOST postcode instead of describing a place.

**What NIPOST gives a test key** (checked 2026-10-20 and again later; FN #1, #15, #17):

| Call | Result with our test key |
|---|---|
| `/healthz`, `/v1/reference/states`, `/v1/reference/lgas` | Work (FCT has 6 councils; Lagos has 20 LGAs) |
| `/v1/lookup` level 1, for the 5 sandbox codes the docs say "always resolve under a test key" | `{"valid":false,"status":"not_found"}` for every one |
| `/v1/lookup` level 2 and up (names, coordinates) | `403 level_not_granted` ("granted up to lookup level 1") |
| Autocomplete | `suggestions: []` for every prefix |

Exact coordinates need level 5, which means a live key and business verification (KYB). A test key can
therefore tell us a code's state and LGA, but never a building.

**Why postcodes are worth supporting now.** NIPOST's national digital postcode system went live on
**1 October 2026**. It gives each building an 11-character code over five levels (state, LGA, district,
area, building), the same structure our parser reads ([Leadership](https://leadership.ng/nipost-launches-digital-postcode-system-to-improve-deliveries-emergency-response/)).
- At the launch, poor addressing was blamed for ₦50–80 billion a year in missed and failed deliveries
  ([BusinessDay](https://businessday.ng/technology/article/nigeria-launches-digital-postcode-to-solve-the-where-problem-behind-n80bn-losses/)).
- BusinessDay calls adoption "the immediate challenge": the codes only pay off once couriers build them
  into their booking.
- A courier that accepts postcodes in the chat today is early, and nothing here has to be rebuilt when a
  live level-5 key arrives. Only the demo table comes out.

**Options considered.**
1. *Use NIPOST's sandbox codes.* They don't resolve, and all five are in Abaji, 89 km from central Abuja.
2. *Mock NIPOST's API.* This would hide real behaviour from a reviewer, and the code path would differ
   from production.
3. *Wait for NIPOST.* It doesn't help the demo.
4. **Chosen: four demo codes, clearly marked**, answered inside `resolve_address` before NIPOST is called.

| Demo code | Place | State / LGA (real) |
|---|---|---|
| `FC-02-ZDM-JB-01` | Jabi Lake Mall, Jabi, Abuja | FCT / Abuja Municipal |
| `LA-11-ZDM-PS-01` | Paystack office, 3A Ladoke Akintola Street, Ikeja GRA | Lagos / Ikeja |
| `LA-20-ZDM-NS-01` | Lagos National Stadium, Surulere | Lagos / Surulere |
| `LA-19-ZDM-UL-01` | University of Lagos (UNILAG), Akoka | Lagos / Shomolu |

- **The district segment `ZDM`** ("Zuma Dispatch deMo") is letters only. Real NIPOST districts are a
  letter plus two digits (`A01`), so a demo code can never collide with a real one.
- **The state and LGA segments are real**, so the rest of the pipeline treats the code normally.
- **Test keys only.** Demo codes are active only with a `nipost_test_` key and are reported as
  `nipost_status: "demo"`. Every other postcode still goes through real NIPOST, which supplies the area,
  and Zuma asks for a landmark.
- **Checked coordinates.** Each place's coordinates came from OpenStreetMap, and a unit test checks that
  each lies inside its own state boundary.
- **Why use them:** a demo code names one exact place, so it skips the "is this the right place?" question
  (section 5). That makes the 3-minute demo short and repeatable: ₦2,850–₦3,000 small-package quotes over
  11–13 km.
- **To retire them:** with a live level-5 key, delete the table; nothing else changes.

## 3. Finding addresses: four geocoders, Google first

**Chain:** Google Places (New) → Nominatim → Photon → OpenRouteService, in "cross-check" mode
(`GEOCODER_CHAIN`, `GEOCODER_MODE` in `wrangler.jsonc`).

- **Why more than one.** Free geocoders disagree in Nigeria. "Yaba Market" came back as "Yaba College of
  Technology, Ikeja", and "Lekki Phase 1" as a marine-supply shop. When two providers agree within 400 m,
  confidence is high. When they disagree, Zuma offers choices instead of guessing.
- **Why Google was added (2026-10-22).** "No 23 Saint Finbarrs Road, Akoka" found nothing on any free
  provider, and "Saint Finbarrs College" came back as St Gregory's and St Mary's
  ([08](screenshots/08-finbarrs-road-not-found.png)). Two fixes went in:
  - Our own query cleaning (`src/geocode/query.ts`) retries "Saint" as "St" without the house number, drops
    results that don't share the place's own name, and falls back to the area the customer named.
  - Google Places then found the street and the college.
- **Cost control.** Text Search has 5,000 free requests a month, then $32 per 1,000.
  - The key is restricted to the Places API (New) and capped at **150 requests a day** in Google Cloud.
  - Results are cached for 30 days (Google's limit for cached coordinates), and empty results for 1 day.
  - If the cap is hit, Google errors and the free providers answer instead. The service gets less precise
    but never stops.
- **Speed.** The second opinion gets 1.5 s after the first answer. Any later answer finishes in the
  background and fills the cache. Cold lookups went from 8 s to about 1.5 s (FN #5).
- **Stable answers.** The same text gives the same place ids for 6 hours, because the model re-runs tools
  every turn (FIELD_NOTES #2).
- **Read-back is the real safety net.** For any address that isn't a demo code, Zuma reads the label back
  and gets a "yes" before booking. No geocoder is right often enough to skip that.

## 4. Coverage is a state boundary, not a radius

- **The old 40 km circle around Abuja was wrong both ways.** It left out Gwagwalada, Kuje, Kwali and Abaji,
  which are in the FCT. It included Mararaba, which is in Nasarawa State.
- **Chosen:** OpenStreetMap's state outlines for the FCT and Lagos, embedded in the code and simplified to
  about 50 m. A point-in-polygon test is instant and costs no API call.
- **Tested** against OpenStreetMap's own state for 22 border towns: Zuba vs Suleja, Nyanya vs Mararaba,
  Alagbado vs Ota, Agbara and others.
- **Simplification matters.** A coarser 1 km outline wrongly put Madalla and Mararaba inside the FCT (FN #16).

## 5. The booking conversation: order and the fast path

**Order:**
1. Both addresses.
2. Package size.
3. Quote, with a single closing question.
4. The customer's "yes".
5. Sender name, recipient name and phone.
6. Reserve.
7. Payment.
8. Confirmation, with the rider and handover code.

Each step asks for one thing, in plain English.

- **The fast path.** A demo postcode is an exact, known place, so its address check sits inside the quote
  message: "Are both addresses right? If yes, just reply YES." Any other address is read back and confirmed
  first. One "yes" covers both the addresses and the price.
- **The handover code arrives only after payment,** and the server enforces it: `create_dispatch_job`
  never returns it. An owner's test caught the agent saying "Booked!" with a code before any money moved
  (FN #19).
- **Phone numbers are checked.**
  - Nigerian mobiles must have 11 digits and a 070/080/081/090/091 prefix.
  - Too short, too long and placeholder-looking numbers each get a specific reply ("I got 13 digits…").
  - The number is read back in the reservation message.
- **WhatsApp formatting.** No `**` (WhatsApp doesn't render Markdown), and short blocks separated by blank
  lines ([11](screenshots/11-markdown-asterisks.png) and
  [11b](screenshots/11b-payment-confirmation-one-paragraph.png) show the before).

## 6. Prices come from the server, never the model

- **Rate card:** small ₦1,500, medium ₦2,000, large ₦3,500 for the first 3 km, plus ₦150, ₦180 or ₦300
  per extra km. Distances are road distances, and totals are rounded up to ₦50
  ([rate-card.md](../skill/zuma-dispatch/references/rate-card.md)).
- **Routing:** OSRM, then OpenRouteService. If both fail, a straight line × 1.4, and the quote says
  "estimated".
- **Quotes** are valid for 30 minutes and can be used for one booking only. "Give me 50% off" and prompt
  injection get "prices are fixed by distance and size" (FN #13).

## 7. Payments: Paystack link or bank transfer, webhook plus re-check

- **Two ways to pay:** a Paystack checkout link (card, transfer or USSD), or bank-transfer details sent
  straight into the chat (Charge API). The customer can switch, and is told to "pay only one way".
- **Paid means Paystack says so.** The webhook signature is checked, and Paystack's API is then asked again
  before a job is marked paid. "I have paid" triggers the same check and never counts as proof.
- **Test mode only.** The server refuses non-test keys on purpose. Going live is a deliberate change
  ([GO_LIVE.md](GO_LIVE.md)).
- **Limit found:** test mode can't simulate money arriving at a Charge-API transfer account. The transfer
  path was proven through checkout's "I've sent the money" button instead (FN #7).

## 8. Riders, phone numbers and tracking are simulated

There are no real riders or GPS in a take-home, so these parts are simulated and labelled as such on the
board.

- **Riders.** There is a roster of six made-up riders: in each state, two on motorbikes and one with a car. One is assigned automatically at payment
  (right state, right vehicle, least busy), once only.
- **Phone numbers.** Rider numbers are **0800 000 0101 to 0106**: valid-looking but unassigned, so no real
  person can be called by a tester.
- **Names with roles.** The confirmation says "Tunde (rider)" and "Anthony (recipient)", so the customer
  knows who is who.
- **Tracking.** The rider's position is computed from the job's timestamps (`src/business/tracking.ts`):
  - About 3 km to the pickup over 15 minutes, then waiting there.
  - Pickup to drop-off over the quoted trip time once the board marks the job dispatched.
  - The position only moves forward, and is the same on every call.
  - Each update has a Google Maps pin link, a plain URL that opens the Maps app on a phone. It needs no
    API key and costs nothing. It replaced an OpenStreetMap link because customers know Google Maps
    ([13](screenshots/13-working-tracking.png) shows the earlier link).
- **Why simulate rather than say "no live location":** the earlier answer, "I don't have a live map
  location", read as a broken product ([03b](screenshots/03b-paid-no-rider-no-live-map.png)). A real
  build would read the rider app's GPS at the same place in the code.

## 9. Handover: our own tool instead of Chord's

- **Chord's built-in handover gives the customer no reply in the simulator** (FIELD_NOTES #1).
- `hand_to_team` returns Zuma's reply, then takes the chat over after that reply is posted. The board
  marks it "handed over by Zuma" and doesn't send a second acknowledgement.
- **Fallback.** If our tool can't find the chat, Zuma uses Chord's built-in one.
- **Outside rider hours** (7am–8pm, Monday to Saturday) the reply says when the team will answer.
- **Dispatchers answer from our board.** It uses Chord's take-over, message and hand-back APIs. Replies
  are signed "— Zuma Dispatch team" so the AI doesn't mistake them for its own (FN #21). A person's reply
  costs 0 credits.

## 10. The tools write the customer's words

- **Ready-made text.** Every result the customer must read exactly (quote, transfer details, payment
  confirmation, phone problems) comes with a `message_for_customer` that Zuma sends word for word.
- **Why:** the model dropped the account number from transfer details
  ([03](screenshots/03-transfer-without-account-number.png)). It also dropped the rider and code from
  confirmations, and added apologies.
- **Short skill for speed.** The skill was cut from 12.8 KB to under 8 KB to avoid simulator timeouts. The
  facts live in the tools, the tone and order live in the skill.

## 11. Hosting: Cloudflare Workers and D1

- **Why:** a public HTTPS URL for Chord's MCP connection, free, no server to look after, and SQLite (D1)
  for jobs, quotes, payments, the tool-call log and the geocode cache.
- **The cost of the free plan** is 10 ms of CPU per request. The MCP SDK's defaults used 28–48 ms. Using
  the low-level server with schemas compiled once brought it to a median of 4 ms (FN #2). Go-live should
  still use the $5/month plan.
- **Google Sheet mirror.** Every job is copied to a sheet the owner already knows how to use. Local test
  runs never write to it (FN #11).

## 12. The dispatcher board: server-rendered, no JavaScript

- **Pages:** Home (alerts and today), Deliveries, Handovers, Payments and System, in light and dark
  ([14](screenshots/14-board-deliveries-overview.png) Deliveries overview, [15](screenshots/15-board-handovers.png) Handovers).
- **No JavaScript at all,** with a strict Content Security Policy. There is less to break on a cheap
  laptop, nothing to build, and no script injection.
- **Sign-in** uses a session cookie, not Basic auth. A password in the URL made Chrome silently drop form
  submissions (FN #12).

## 13. What we left out

| Left out | Why |
|---|---|
| Interstate and other states | A different product (waybills, parks, multi-day) |
| Real riders, GPS and a rider app | Simulated (section 8); the rider side is designed in section 14 |
| Cash on delivery | Needs rider cash handling and reconciliation; payment first keeps the dispatcher whole |
| Live money and a real WhatsApp number | The brief forbids connecting personal numbers; see [GO_LIVE.md](GO_LIVE.md) |
| Multi-stop deliveries and choosing a pickup time | One pickup, one drop-off, as soon as a rider is free (next working day after hours) |

## 14. The rider side: designed, not built

**Decision:** no rider teammate in this submission. The dispatcher board plays the rider's part: marking a
job dispatched or delivered moves the simulated rider and changes what Zuma tells the customer. Below is
how it would be built.

**Why not now.**
1. **The brief rewards a small agent that works end to end.** It asks for one useful job, done start
   to finish, and says a small agent that works beats an ambitious one that half runs. The customer
   side took 19 skill versions to get right. A second teammate would add new failure points days before
   the deadline.
2. **The result can't be shown in the simulator.** Its whole value is "rider says delivered → customer
   is told". That message would be pushed into the customer's chat, and the simulator never displays
   pushed messages. The AI would also read it as its own words (FIELD_NOTES #3).
3. **A rider can't be identified in the simulator.** Every new simulator chat arrives as a new person
   (FIELD_NOTES_FULL #14), and MCP tools get no caller identity. So nothing could stop a customer from
   typing "delivered" as if they were the rider. That would be a security hole, not a feature.

**The design (about 1–1.5 days on a real WhatsApp number):**
- **Teammate and number.** A second teammate, "Zuma Rider", on its own WhatsApp number. Chord assigns
  each number to one teammate, so riders never talk to the customer agent. It has a short skill:
  "you help Zuma Dispatch riders update their jobs; you never talk to customers".
- **Who is the rider.** The rider's WhatsApp phone must match a phone on the roster
  (`src/business/riders.ts` already has a `phone` per rider). Unknown numbers get "this number is not
  registered as a rider" and nothing else.
  - Chord doesn't pass the sender to tools, so until it does (the FIELD_NOTES #3 ask), the server finds
    the chat the way `hand_to_team` does and reads the participant's phone from the thread.
  - If that can't be done safely, the rider tools refuse rather than guess.
- **Rider tools** (on the same MCP server, behind the same token):
  - `my_jobs`: the rider's paid and dispatched jobs today. It shows pickup, drop-off, recipient first name
    and a masked phone, and never the payment.
  - `update_job(job_id, step)`, where `step` is one of:
    - `at_pickup`: tells the customer "Tunde is at the pickup".
    - `collected`: the job becomes `dispatched`, the same transition the board's "Mark dispatched" uses,
      with the same version check, so the board and the rider can't race each other.
    - `delivered`: needs the recipient's handover code. A wrong code is refused. After three wrong codes
      the job goes to the board as "check with the recipient", and nothing is marked delivered.
  - `share_location`: the rider sends WhatsApp's live or current location. Then `get_job_status` gives
    the customer the real position when it is under 10 minutes old, and the simulated one otherwise.
    Whether Chord passes location messages through to the agent still needs to be checked.
- **Customer messages.** "Picked up" and "Delivered" go out through the same notice route as "Payment
  received": WhatsApp only, once per job and step, and inside WhatsApp's 24-hour window.
- **Board.** Each status change shows who made it ("by rider Tunde" or "by dispatcher"). A job assigned
  to a rider who hasn't sent `collected` within 45 minutes shows as an alert on Home.
- **Assignment.** This stays automatic at payment. With real riders, add "accept within 5 minutes or it
  goes to the next rider", using the same `chooseRider` ranking.
- **Cost.** Each rider message is an AI turn (about 0.1 credit). If that grows, WhatsApp quick-reply
  buttons ("Collected", "Delivered") keep messages short, or a web page per job removes the AI from the
  rider's side entirely.

## 15. What stopped us, and what we'd build with more time or resources

The brief allows not building everything, provided we say what stopped us, what we tried, and what we'd
build with more time or resources. A short version is in [SUBMISSION.md](../SUBMISSION.md).

**What stopped us, and what we tried:**

| Stopped by | What we tried | Where it landed |
|---|---|---|
| NIPOST test keys locate nothing. The docs' "always resolve" sandbox codes return `not_found`, and level 2 and up is `403 level_not_granted` | Every code format, NIPOST's own sandbox codes, the reference endpoints (FN #1, #15) | Real postcodes give the state and LGA. Four marked demo codes stand in for exact places (section 2) |
| The simulator never shows operator or pushed messages | Chord's scheduled MESSAGE, then take-over → message → hand-back; asked TSG (FN #14, #21) | Zuma confirms payments and handovers in its own reply. Pushed notices are kept for WhatsApp |
| Tools get no conversation id | Searched recent threads for the job id; needed a Full access key for `thread:read` (FN #14) | Works, but costs Chord API calls; the board hit the key's rate limit once (FN #24) |
| No WhatsApp number to connect | Chord's rent-a-number pool: "No numbers are available to rent right now". The brief rules out personal numbers | Everything runs in the simulator; the WhatsApp steps are in [GO_LIVE_CHECKLIST.md](GO_LIVE_CHECKLIST.md) |
| Paystack test mode can't make money arrive at an API-issued transfer account | Proved the transfer path through checkout's "I've sent the money" button instead (FN #7) | Transfer details work in the chat; confirmation is proven through checkout |

**What we'd build next, in order:**

| # | Feature | Needs | Why this order |
|---|---|---|---|
| 1 | A real WhatsApp number on Zuma | A business number, or Chord's rental pool | It makes "Payment received" visible to customers. Everything else assumes it |
| 2 | The rider side (section 14) | Item 1, plus real riders with phones | It replaces the simulated map with real positions and checks the handover code at delivery |
| 3 | "Picked up" and "Delivered" messages to the sender | Item 1 (same route as "Payment received") | It is the most common customer question after "where is my rider?" |
| 4 | Refunds from the board | Paystack Refund API; dispatcher approval on the board | Today a person refunds in Paystack's dashboard; the board can approve and record it |
| 5 | Exact addresses from postcodes | A live NIPOST key with business verification (level 5) | It retires the four demo codes; customers give a postcode instead of directions |
| 6 | Deliveries to the next state (Mararaba, Ota, Suleja) | A partner courier, priced per zone | These are the most common refusals today: suburbs just across the state line |
| 7 | Drop the thread search | Chord passing the thread id to tools (FIELD_NOTES #3) | Fewer Chord API calls, no Full access key, no rate-limit risk |
| 8 | Production hardening | Cloudflare Workers paid plan ($5 a month), rotated secrets, owner-run Google billing | It removes the 10 ms CPU ceiling (FN #2) before real traffic |

Deliberately **not** on the list: cash on delivery. It puts cash with riders and needs daily reconciliation;
paying first keeps the dispatcher whole.

