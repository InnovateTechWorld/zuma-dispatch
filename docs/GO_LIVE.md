# Zuma Dispatch: before you go live

**What it does.** Zuma answers your WhatsApp day and night and books same-day deliveries within Abuja or
within Lagos. For each booking it:
- checks both addresses with the customer;
- quotes from your price list;
- takes payment through Paystack, by card link or bank transfer;
- assigns a rider and sends the rider's name, number and a handover code;
- answers "where is my rider?".

Refunds, complaints and anything unusual go to your team on the dispatcher board. Every job is copied to
your Google Sheet.

**What it doesn't do.** No deliveries between states, no cash on delivery, no discounts and no refunds (a
person refunds in Paystack). The riders, their numbers and the live location are pretend for now; a rider
app must replace them.

**Before the first real customer:**
1. **A WhatsApp Business number** for the business only, connected to Zuma in Chord, on a phone that stays
   charged and online.
2. **Paystack live keys** instead of the test keys. Decide who pays Paystack's fee (1.5% + ₦100, capped at
   ₦2,000).
3. **Failed payments.** Nothing is dispatched until Paystack confirms the money.
   - A failed card can simply try again.
   - A transfer account expires after 30 minutes, and the bank returns a wrong amount.
   - A "success" with the wrong amount waits under **Payments → needs review**, to be approved or
     cancelled the same day.
4. **Who gets alerted.** The board shows chats waiting for a person, payments to review and jobs to
   dispatch, but it doesn't text anyone. Name one person per city to watch it from 7am to 8pm, and turn on
   Chord's escalation email as a backup.
5. **Real riders** with their real numbers on the roster, in both cities.
6. **One test day:** book, pay and deliver one real job per city from a second phone
   ([GO_LIVE_CHECKLIST.md](GO_LIVE_CHECKLIST.md)).
