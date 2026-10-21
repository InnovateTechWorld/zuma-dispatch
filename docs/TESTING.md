# What has been tested, and how

The state on 2026-10-20 (18:05 WAT), after the last deploy. "Live" means the real deployed Worker,
real Paystack test mode, and the real Chord teammate in the TSG simulator.

## The suites

| Suite | Command | Result | Covers |
|---|---|---|---|
| Unit | `npm test` | **168 / 168** (7 files) | pricing, payment verdicts, geocoder judgement and timing, phone and postcode parsing, config safety, webhook signatures, Paystack failures, sheet mirror, board sign-in / CSRF / lockout / filters / charts / progress / signed flash, chat notices, postcode areas, FCT + Lagos boundaries (22 towns vs OSM) |
| Typecheck | `npm run typecheck` | clean | `src/` and `test/` |
| Smoke | `scripts/mcp-smoke.sh <url>` | **23 / 23** local and production | MCP protocol and auth, Origin guard, tool list, schema refusal, board sign-in redirect, wrong password, no browser password popup, Basic auth for scripts, CSRF, `/pay/return` 404, Chord webhook signature |
| End to end | `python3 scripts/e2e.py <url>` | **53 / 53** local and production | the whole booking flow over MCP with real geocoders, routers, NIPOST and Paystack test mode: quotes, booking guards, link and bank transfer, verify, cancel, status lookup, webhook signature and replay, sheet sync; Lagos booking, Lagos→Abuja refused, border towns, sandbox postcode |
| Skill check | `python3 scripts/check-skill.py` | OK | skill folder shape, front matter, size; `dist/` ZIP equals the folder |

## Live checks, by feature

| Feature | How it was checked live | Result |
|---|---|---|
| Out-of-area, vague address, discount and injection, quote | Simulator, 3 turns (FIELD_NOTES #13) | Declined Lagos; asked for a landmark; refused the discount; ₦1,950 from the rate card |
| Booking, pidgin, "book am" | Simulator | Booked ZD-2RWZ9 and ZD-H01G4 |
| Reply lost by the simulator, no double booking | Simulator + D1 | One job, not two |
| Paid without saying "paid" | Owner paid with a Paystack test card | Webhook (trusted IP) marked both jobs paid within seconds |
| Cancel after payment → human | Simulator | Handover with a precise reason; on the board via Chord's webhook |
| Status without a job id, new conversation | Simulator | Found by recipient phone + sender name |
| Payment confirmation wording | Simulator, before/after skill v4 | Fixed via `message_for_customer` (FIELD_NOTES #13) |
| False apology | Simulator | Fixed in skill v4; one retest in an already-polluted chat still apologised (noted) |
| "Payment received" pushed into the chat | ZD-H01G4, owner paid, nobody typed | Right conversation found in 2 s; Chord task completed in 26 s; in Chord's record; agent then answered "Your payment is confirmed…". **Not displayed by the simulator** (see below) |
| Notice safety on real data | "Send now" for ZD-2RWZ9 | Chose the booking chat, saw a human holds it, sent nothing |
| Operator route (opt-in) | ZD-H01G4 resend | Chord reported `delivery_status: sent` and handed back cleanly; our take-over was filtered from the board's handovers. Side effect: Chord sent "connecting you with a teammate" |
| Board sign-in, filters, actions, sign-out | Browser at 320 / 375 / 414 / 768 / desktop, light and dark | All pass; Filter bug cause found and fixed (FIELD_NOTES #12) |
| Login lockout | 10 wrong tries from a test IP | 11th → 429 `Retry-After: 900`; other IPs unaffected |
| Approve reviewed payment | Local, against D1 | `paid_at` and `via: dispatcher` recorded |
| Google Sheet mirror | Production | Append, update in place, formula text kept as text, phones masked, resync |
| Paystack webhook | Production | Real `charge.success` events from Paystack IPs |
| Two states (FCT + Lagos) | Live MCP runs with real geocoders (2026-10-20 19:00) | Ikeja City Mall → Lekki Phase 1: ₦5,700, 30 km, booked and cancelled. Lagos → Abuja: `INTERSTATE_NOT_SUPPORTED`. "Shoprite" + lagos gives Lagos branches only. Mararaba, Suleja, Ota and Kano are out of area. Sandbox `FC-01-…` → Abaji, in coverage |
| Two states in the simulator (skill v6) | 3 turns, fresh chats (2026-10-20 18:45) | Ikeja → Jabi Lake Mall, Abuja: "we deliver within Abuja or within Lagos State, not between them", human offered, no quote attempted. Ikeja → Lekki Phase 1: both read back for confirmation (odd geocoder label caught). Shoprite → National Stadium: "Is this in Abuja or Lagos?" |
| Demo postcodes | Production MCP (2026-10-20 19:10) | All four resolve in any format; Paystack office → UNILAG ₦3,000 (12.7 km), → National Stadium ₦2,850 (11.3 km), → Jabi Lake Mall refused (interstate) |
| Test addresses | Production MCP, 14 landmarks | 11 clean (listed in [TEST_SCRIPT.md](TEST_SCRIPT.md)); Gwagwalada Market, Balogun Market and "Silverbird Galleria" for Abuja noted as rough spots |
| Demo postcodes in the simulator + retraction fix | 4 runs × 3 turns (2026-10-21, skill v6→v9) | Demo codes read back exactly; ₦3,000 / ₦2,850 quotes; interstate refused. False apologies and retractions in v6–v8 fixed in v9 (FIELD_NOTES #18). 1.19 credits; 5.64 left |
| Board handover console | Local browser (desktop, 375 px dark), real Chord data | Inbox listed the 2 chats waiting in Chord; transcript of the ZD-T30FJ refund chat read correctly; job linked; local Send refused by the local guard |
| Raw NIPOST postcodes | `resolve_address` over MCP with the real NIPOST API, after the fix (2026-10-20 18:30) | `FC-02-A09-DB-09` → Abuja Municipal, ask for a landmark. `+ Wuse Market` → exact. `FC-03-…` → Bwari (27.9 km), ask for a landmark. Sandbox `FC-01-A01-KP-27` → Abaji (88.8 km), out of area. `LA-01-…` → Agege, Lagos, out of area. `900211` → old code, ask for a landmark. NIPOST's validity check answers `not_found` for every code with our test key, including its own sandbox codes |

## Not tested, and why

| What | Why not | What to do before go-live |
|---|---|---|
| **WhatsApp itself** | No WhatsApp number is connected to this workspace (Chord's rental pool was empty) | Connect a number ([GO_LIVE.md](GO_LIVE.md) §1) and run the script in §3 |
| "Payment received" reaching a WhatsApp customer | Needs the number above. The default route uses Chord's WhatsApp connector; the simulator cannot show pushed messages | First paid test job after connecting |
| Customer sees the pushed message in the simulator | Simulator limitation: it shows only replies to the customer's own messages | Nothing to fix on our side |
| A bank transfer actually landing | Paystack test mode gives a test account but no way for us to send money into it; transfer details, reuse and expiry are covered | One real transfer in live mode, with the owner |
| Refunds, disputes, reversals from Paystack | Can't be triggered on demand in test mode; event shapes are unit-tested | Watch the first real one on the board ("needs review") |
| Load beyond a few concurrent requests | Out of scope for a take-home; compare-and-set and once-only claims are unit-tested | Workers paid plan ($5/month) removes the 10 ms CPU risk (FIELD_NOTES #2) |
| Card entry by the agent's operator (me) | I may not type card numbers into the live checkout, even test cards. The owner paid both test jobs | n/a |

## How to re-run everything

```bash
npm test && npm run typecheck
npx wrangler dev --port 8787 --ip 127.0.0.1      # in another terminal
scripts/mcp-smoke.sh && python3 scripts/e2e.py
scripts/mcp-smoke.sh https://zuma-dispatch.obimz123.workers.dev
python3 scripts/e2e.py https://zuma-dispatch.obimz123.workers.dev
```

Local runs never write to the Google Sheet and never post into Chord chats, even with production keys in
`.env` (`SHEET_MIRROR_ALLOW_LOCAL`, `CHORD_NOTICES_ALLOW_LOCAL`).
