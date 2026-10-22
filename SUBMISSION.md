# TSG Labs take-home: Zuma Dispatch

**Role:** Forward-deployed Engineering

## Problem statement

Zuma Dispatch is a made-up same-day courier in Abuja and Lagos that, like many small Nigerian dispatch
businesses, takes its bookings on WhatsApp, where a person must work out where "opposite the Shoprite"
is, quote, chase payment, find a rider and answer "where is my rider?" for every chat. Bookings stall
after hours and whenever that person is busy. Zuma, a Chord agent, books and takes payment for a delivery
inside the chat in a few minutes at any hour, and hands refunds and complaints to a person, so the
business takes more bookings without paying someone to watch WhatsApp. Left out: deliveries between
states, cash on delivery, real riders and GPS (simulated), and live money or a real WhatsApp number (test
mode only, as the brief asks).

## The six deliverables

| # | Deliverable | Where |
|---|---|---|
| 1 | Role and problem statement | This page |
| 2 | Working agent, live on Chord | Teammate **Zuma** in the simulator: https://chat.tsglabs.dev/c/i43ZuGQReP8Za95unSjXnHmG. [What to type](docs/TEST_SCRIPT.md); the demo postcode `LA-11-ZDM-PS-01` is the Paystack office |
| 3 | Repo and README, including how AI tools were used | [README.md](README.md) |
| 4 | 3-minute recording of one conversation | In the Drive folder; [script](docs/RECORDING_SCRIPT.md) |
| 5 | **Deployment field notes** | [docs/FIELD_NOTES.md](docs/FIELD_NOTES.md): the three problems that mattered, with screenshots. The full log is in [FIELD_NOTES_FULL.md](docs/FIELD_NOTES_FULL.md), and the choices behind the build (NIPOST demo postcodes, geocoders, handover…) are in [DECISIONS.md](docs/DECISIONS.md) |
| 6 | Go-live note for a non-technical owner | [docs/GO_LIVE.md](docs/GO_LIVE.md) (half a page); the technical steps are in [GO_LIVE_CHECKLIST.md](docs/GO_LIVE_CHECKLIST.md) |

## Uses of Chord worth a look

1. **A handover the customer actually sees.** Chord's built-in handover ends the AI's turn with no reply,
   and the simulator hides Chord's own "connecting you" line. So `hand_to_team` returns Zuma's reply
   first, and the server takes the chat over through the threads API only once that reply has been
   posted ([handover.ts](src/chord/handover.ts), field note 1).
2. **"Payment received" without the customer writing first.** Tool calls carry no conversation id, so
   the server finds the chat by the job id Zuma sent and posts through Chord's scheduled messages. It
   skips channels that can't show the message, so the AI never "remembers" something the customer didn't
   see ([notices.ts](src/chord/notices.ts), field note 3).
3. **The dispatcher board is an operator console on Chord's threads API.** It reads the whole chat,
   takes it over, replies as the team (signed, so the AI doesn't mistake the reply for its own), and
   hands it back. A person's reply costs no credits ([handovers.ts](src/web/handovers.ts)).
4. **Steering a model we can't choose.** Chord's model is fixed, and it never sees earlier tool results.
   So every tool result carries a ready-made `message_for_customer` and a hidden context note, and the
   facts live on the server, not in the prompt ([tooling.ts](src/mcp/tooling.ts), field note 2).

## In one line each: the field notes

1. **Only the text after a turn's last tool call reaches the customer, and Chord's built-in handover sends
   none.** A paid confirmation was replaced by a memory remark, and a refund request got silence. Fixed
   with "reply last" and our own `hand_to_team` tool.
2. **The model can't see earlier tool results,** so it "corrected" true answers ("ignore my last
   correction") and nearly re-booked a job. Fixed on the server: duplicate guard, stable answers, ids in
   the visible text and a hidden note.
3. **Tools get no conversation id, and pushed messages are hidden in the simulator but read by the AI.**
   The AI "remembered" a payment confirmation the customer never saw. We find the chat by job id, and
   skip pushes the channel can't show.

## What stopped me, what I tried, and what I'd build next

| Stopped by | What I tried | Where it landed |
|---|---|---|
| NIPOST test keys locate nothing. The docs' "always resolve" sandbox codes return `not_found`, and level 2 and up is `403 level_not_granted` | Every code format; NIPOST's own sandbox codes; the reference endpoints | Real postcodes give the state and LGA. Four clearly marked demo codes stand in for exact places ([DECISIONS §2](docs/DECISIONS.md#2-nipost-postcodes-and-our-four-demo-codes)) |
| The simulator never shows operator or pushed messages | Chord's scheduled MESSAGE, then take-over → message → hand-back; asked TSG | Zuma confirms payments and handovers in its own replies. Pushed notices are kept for WhatsApp, where they do show |
| No WhatsApp number to connect (the brief rules out personal numbers) | Chord's rent-a-number pool was empty | Everything runs in the simulator; the WhatsApp steps are in [GO_LIVE_CHECKLIST.md](docs/GO_LIVE_CHECKLIST.md) |
| Paystack test mode can't simulate money arriving at an API-issued transfer account | Proved the transfer path through checkout's "I've sent the money" button instead | Transfer details work in the chat; confirmation is proven through checkout |

**With more time or resources:**
1. A real WhatsApp number.
2. A rider side: a second teammate that checks the handover code at drop-off and shares real positions.
3. "Picked up" and "Delivered" messages.
4. Refunds approved from the board.
5. Live NIPOST lookups at level 5.
6. Delivery to the suburbs just across the state line.

The ordered plan, and the full rider design, are in
[DECISIONS §14–15](docs/DECISIONS.md#14-the-rider-side-designed-not-built).
