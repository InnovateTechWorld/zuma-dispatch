# Zuma Dispatch: before you go live

**What it does.** Zuma answers your WhatsApp day and night and books same-day deliveries within Abuja
or within Lagos. It checks both addresses with the customer, quotes from your price list, and takes
payment through Paystack (card link or bank transfer). It then assigns a rider, sends the rider's name,
number and a handover code, and answers "where is my rider?". Refunds and complaints go to your team on
the dispatcher board, and every job is copied to your Google Sheet.

**What it doesn't do.** No deliveries between states, no cash on delivery, no discounts and no refunds (a
person refunds in Paystack). The riders, their numbers and the live map are pretend: put your real riders
on the roster, and a rider app replaces the map.

**Before the first real customer:**
1. **Live keys.** The system refuses live keys on purpose, so your developer switches each one.
   - **Paystack:** decide who pays its fee (1.5% + ₦100, capped at ₦2,000).
   - **NIPOST:** needs business verification before a postcode can give an exact address. Until then a
     postcode gives only the area, and the four demo postcodes must be switched off.
   - **Google Maps:** on your own billed Google account. 5,000 address searches a month are free, then
     about $32 per 1,000. It is capped at 150 a day.
2. **A WhatsApp Business number** for the business only, connected to Zuma in Chord, on a phone that
   stays charged and online.
3. **Failed payments.** Nothing is dispatched until Paystack confirms. A failed card can try again;
   transfer accounts expire after 30 minutes; a wrong amount goes to Payments → needs review.
4. **Who gets alerted.** The board lists waiting chats, payments to review and broken connections but
   texts nobody. Name one person per city to watch it from 7am to 8pm, and turn on Chord's escalation
   email.
5. **A test day:** one real job per city, booked, paid and delivered ([checklist](GO_LIVE_CHECKLIST.md)).
