# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Dispatcher** (primary): works at a desk on a laptop, or on a phone while out. Checks what is
  waiting, replies to customers that Zuma handed over, moves jobs from paid to dispatched to
  delivered, and approves or cancels payments that need review.
- **Business owner** (secondary): checks how the day is going and whether payments and integrations
  are healthy. Also reads the Google Sheet copy.
- **WhatsApp customer** (one page only, `/pay/return`): sees a payment result for a few seconds,
  then goes back to the chat.

## Product Purpose
Zuma Dispatch is a made-up same-day courier for a TSG Labs take-home. Customers book on WhatsApp
through Zuma, a Chord AI teammate that calls this Worker's MCP tools. Zuma quotes, books and takes
Paystack payment. The dispatcher board is the staff side: every booking, its payment trail, the
chats handed to a person, and the health of the integrations.
Success: the dispatcher sees within seconds what needs them and can act on it in one or two clicks.

## Positioning
The board is the only place where the AI's bookings, Paystack's payment evidence and Chord's
handovers meet. Every figure comes from real D1 rows or live Chord data. Nothing is a mock-up.

## Operating Context
- Coverage is within Abuja (FCT) or within Lagos State, never between states. Times are WAT (UTC+1).
- Payments run on Paystack test keys (test mode).
- Chats in the TSG simulator never show operator messages. The board's conversation view does.
- A person's reply from the board costs no AI credits.

## Capabilities and Constraints
- Cloudflare Worker with D1, server-rendered HTML.
- The CSP forbids all scripts, so every control is a link or a form and works with JavaScript off.
- Access is a sign-in page backed by the `BOARD_TOKEN` password, with D1 sessions, CSRF checks and
  a failed-login lockout. HTTP Basic is accepted for scripts.
- Board actions:
  - Mark dispatched or delivered.
  - Approve or cancel a reviewed payment.
  - Send the "Payment received" chat notice again.
  - Resync the Google Sheet.
  - Reply, take over, hand back or resume a chat.

## Brand Commitments
- Name: Zuma Dispatch. The AI is "Zuma".
- Tone: calm and precise, real numbers only, no marketing copy.
- The board's visual system is recorded in `design.md` (Cobalt, modern-minimal). The user chose on
  2026-10-21 to keep this look and rebuild the structure.

## Evidence on Hand
- Live D1 data: jobs, payments, Paystack events, chat notices, tool calls.
- Chord threads and turns through the API.
- No customer testimonials, logos or business metrics exist. Never invent them.

## Product Principles
1. Show what needs a person first; everything else is one tab away.
2. One task per page, with no single long scroll of everything.
3. Every number says what it counts and over which period.
4. Nothing breaks without JavaScript, on a 320 px phone, or in either theme.

## Accessibility & Inclusion
- WCAG 2.2 AA contrast in light and dark.
- Visible focus.
- 44 px touch targets.
- Status always shown as text, not colour alone.
