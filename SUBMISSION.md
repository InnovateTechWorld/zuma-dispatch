# TSG Labs take-home: Zuma Dispatch

**Role:** Forward-deployed Engineering

## Problem statement

Zuma Dispatch is a made-up same-day courier in Abuja and Lagos. Like many small Nigerian dispatch
businesses, it takes bookings on WhatsApp. Today a person has to answer every chat by hand: work out
where "opposite the Shoprite" is, quote a price, chase the payment, find a rider and answer "where is my
rider?". Bookings stall after hours and whenever that person is busy.

Zuma, a Chord agent, books and takes payment for a delivery inside the WhatsApp chat in a few minutes, at
any hour, and hands refunds and complaints to a person. The business takes more bookings without paying
someone to watch WhatsApp, which is why it is worth paying for.

Left out:
- deliveries between states;
- cash on delivery;
- real riders and GPS (simulated);
- live money and a real WhatsApp number (test mode only, as the brief asks).

## The six deliverables

| # | Deliverable | Where |
|---|---|---|
| 1 | Role and problem statement | This page |
| 2 | Working agent, live on Chord | Teammate **Zuma** in the simulator: https://chat.tsglabs.dev/c/i43ZuGQReP8Za95unSjXnHmG. [What to type](docs/TEST_SCRIPT.md); the demo postcode `LA-11-ZDM-PS-01` is the Paystack office |
| 3 | Repo and README, including how AI tools were used | [README.md](README.md) |
| 4 | 3-minute recording of one conversation | In the Drive folder; [script](docs/RECORDING_SCRIPT.md) |
| 5 | **Deployment field notes** | [docs/FIELD_NOTES.md](docs/FIELD_NOTES.md): the three problems that mattered, with screenshots. The full log is in [FIELD_NOTES_FULL.md](docs/FIELD_NOTES_FULL.md), and the choices behind the build (NIPOST demo postcodes, geocoders, handover…) are in [DECISIONS.md](docs/DECISIONS.md) |
| 6 | Go-live note for a non-technical owner | [docs/GO_LIVE.md](docs/GO_LIVE.md) (half a page); the technical steps are in [GO_LIVE_CHECKLIST.md](docs/GO_LIVE_CHECKLIST.md) |

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
