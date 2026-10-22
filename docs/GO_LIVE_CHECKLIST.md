# Go-live checklist (technical)

The step-by-step version of the owner's half-page [GO_LIVE.md](GO_LIVE.md). Everything below was read
from Chord's dashboard and docs on 2026-10-20. Nothing has been connected yet.

## 1. How WhatsApp connects in Chord

> **Not part of the assessment.** The brief asks for a conversation "in the WhatsApp simulator" and an
> agent left live "so we can talk to it in the simulator", and says *"Don't connect … anyone's personal
> number."* A connected number is a go-live prerequisite, so it belongs in this note. It is not something
> to do for the submission.

WhatsApp is a **channel** in Chord, set up in the dashboard, not in our code:
**Admin → Channels & Tools → WhatsApp Business → Add number.** There are two ways.

| Option | What happens | Today |
|---|---|---|
| **Use my own number** | Enter the number (E.164, e.g. `+2348012345678`) and an optional label. Chord provisions a provider session for it; you then **pair the number by scanning a QR code** in the provider dashboard, like linking a device | Available |
| **Rent a number** | Take an already-connected number from Chord's pool. It "goes live instantly, no QR pairing" | "No numbers are available to rent right now" |

- Each number is a **session** and can be assigned to a different teammate.
- Assign it to **Zuma**.
- Credentials sit under **Connections** (tenant level, attachable to several workspaces).
- After pairing, the WhatsApp Business channel shows **Connected**, and customers who message that number
  talk to Zuma.

**What does not change on our side.**
- Zuma's skill, the MCP tool server, the board, Paystack and the sheet are channel-agnostic: Chord calls
  the same tools whether the customer is on WhatsApp or in the simulator.
- Conversations will appear with `channel_id: whatsapp`. The customer's phone becomes the channel identity,
  so the same customer is recognised across conversations. In the simulator each new chat looked like a
  new person.

**What starts working only on WhatsApp.**
- **"Payment received" reaches the customer.** Our default notice route (`CHORD_NOTICE_ROUTE=auto`) sends
  through Chord's WhatsApp connector when the chat is on WhatsApp, with no take-over. On the simulator it
  can only land in Chord's record.
- **Chord's memory across conversations** keyed to the phone number.

**Caution.**
- WhatsApp only lets a business send free text within 24 hours of the customer's last message. Our notices
  check this, and every payment happens minutes after a chat.
- A QR-paired number behaves like a linked device on that phone. Keep the phone online and the WhatsApp
  account in good standing, and use a dedicated business number, not a personal one.

## 2. Switch to live money (in this order)

1. **Paystack live keys.** The server refuses non-test keys on purpose (`loadConfig`). Going live is a code
   change: drop that guard, and keep a `PAYSTACK_MODE` var so it can be flipped back.
2. Set the **live webhook URL** in Paystack (Settings → API Keys & Webhooks → Live): `/hooks/paystack`.
3. Decide **who absorbs Paystack's fees** (1.5% + ₦100, waived under ₦2,500, capped at ₦2,000) and update
   the rate card.
4. **Cloudflare Workers paid plan** ($5/month): removes the 10 ms CPU ceiling (FIELD_NOTES_FULL #2).
5. **Rotate** `MCP_BEARER_TOKEN`, `BOARD_TOKEN` and the Chord API key. Rotating `BOARD_TOKEN` signs every
   dispatcher out.
6. Point the sheet mirror at the owner's real sheet (a separate one from testing).
7. Revoke the unused narrow Chord key ("zuma-dispatch server: payment notices").

## 3. First-day test script on WhatsApp (about 15 minutes)

From a second phone, message the business number:

1. "I want to send documents from Jabi Lake Mall to Wuse Market": a quote comes back.
2. "yes", then the names and recipient phone: a job id arrives, then a Paystack link or transfer details.
   No handover code yet: it comes only after payment.
3. Pay **without replying**. Within about a minute, **"Payment received: ₦… for ZD-…"** should arrive,
   with the rider's name, number and the handover code.
   - The board's job page should say *Chord reports it delivered*.
   - If it says `record_only` or `failed`, read the reason there.
4. Ask "where is my package?" in a **new** chat: it is found by your phone, without the job id.
5. Ask for a refund: Zuma says it has passed this to the team, and the chat appears on the board under
   **Handovers**.
6. On the board, mark the job dispatched → delivered, and ask again: the agent reports it.
7. **Lagos:** "send a phone from Ikeja City Mall to Lekki Phase 1". It should quote and book, and appear
   under **Lagos** on the board.
8. **Interstate:** "from Ikeja to Jabi Lake Mall, Abuja". It should be refused politely, with a human
   offered.

**Two cities, one number.** One WhatsApp number can serve both cities: the agent asks "Abuja or Lagos?"
when it isn't clear. Riders and dispatch offices (Wuse 2, Abuja; Yaba, Lagos) must exist in both before
go-live.

## 4. Known limits that stay

- Deliveries between states (and to neighbouring-state suburbs like Mararaba or Ota) are not offered.
  A human dispatcher handles those requests.

- Notices cover "payment received" (which includes the rider) only, not "delivered". Same mechanism; not built.
- Riders, their numbers (0800 000 0101–0106) and tracking are simulated. A rider app with GPS replaces them.
- The handover code is shown but not checked at delivery (no rider app).
- No per-customer rate limit on our MCP endpoint beyond Cloudflare and the bearer token.
- What we'd ask Chord for (FIELD_NOTES_FULL #9, #10, #14):
  - The conversation id in MCP tool calls.
  - A `thread:read` toggle in the key form.
  - Operator messages without the "connecting you with a teammate" system message.
  - Pushed messages shown in the simulator.
