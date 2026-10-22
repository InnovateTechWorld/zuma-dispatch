# 3-minute recording script

One conversation, start to finish, in the TSG simulator, with the board shown at the end. Rehearse it once
first: the whole run is about 9 AI turns, which is roughly 1 credit.

## Before you press record

- **Record between 7am and 8pm WAT, Monday to Saturday.** Those are rider hours. Outside them, Zuma
  says pickup is from 7am, there is no live position to show, and the handover reply says the team is
  closed.
- **The board starts empty** (test data was cleared on 22 Oct), so everything on it during the video
  comes from this one conversation. Don't run `scripts/e2e.py` just before recording: it cleans up after
  itself, but its jobs show while it runs.

- **Tab 1:** the simulator, https://chat.tsglabs.dev/c/i43ZuGQReP8Za95unSjXnHmG. Start a **new
  conversation**.
- **Tab 2:** the board, https://zuma-dispatch.obimz123.workers.dev/board, already signed in, on **Home**.
- **Tab 3** (optional): the Google Sheet.
- Use screen recording at 1080p, with browser zoom at 110% so the chat text is readable.
- **Paystack's test page** offers three buttons: **Success**, **Bank Authentication** and **Declined**.
  The run uses Declined first, then "Retry with test details" and **Success** on the same page. This
  was checked on 22 Oct: Paystack keeps the same payment, and our server still catches the retry.

## Timing: plan for the waits

The table assumes about 10 seconds per step, but each of Zuma's replies takes several seconds, sometimes
over 20. With 10 customer messages, the Paystack steps and the board, an unedited take will probably run
**4–5 minutes**.
- **Record it in one take, then cut out the waiting** (the gaps while Zuma is typing) when you edit.
  Trimming dead time is normal and still shows one full conversation.
- **Keep talking during the waits.** The spoken lines are written to cover the time Zuma takes to reply.
  Cut whatever silence is left.
- **If the edit is still over 3:00, cut in this order:**
  1. The optional ₦50–80 billion line at 0:10.
  2. The short-phone-number step (0:40–0:50): type the correct number straight away. The declined card
     already shows error handling, and it's the error the scoring table names.
  3. The **Deliveries → Timeline** step at 2:45: end on Handovers.
- **Don't cut:** the quote, the declined card and its reply, the retry, and the paid confirmation (the
  moment the tool does its job), or the handover reply.
- **The numbers you say** (95%, fake alerts, ₦50–80 billion) are the same ones as in the problem
  statement and its sources in [SUBMISSION.md](../SUBMISSION.md). Don't add others.

## The run

The brief asks you to "show the moment your tool does its job". Here that is 1:40–2:00: Paystack confirms
the money, our server marks the job paid and assigns a rider, and Zuma's reply carries the result. Just
before it, the declined card shows the scoring's "errors such as a failed payment … are handled rather
than ignored". Say both out loud.

| Time | Type or do | Say (short) | You should see |
|---|---|---|---|
| 0:00 | Show the simulator | "Small Nigerian couriers take bookings on WhatsApp, which about 95% of Nigerians online use, and they lose money on bad addresses and fake transfer alerts. Zuma books the delivery for them in the chat. This is TSG's simulator." | Empty chat |
| 0:10 | `Send a phone charger from LA-11-ZDM-PS-01 to LA-19-ZDM-UL-01` | "These are demo postcodes. NIPOST's test key can't locate a building, so we added four clearly marked ones; real postcodes and landmarks also work. *(Optional:)* Bad addresses are blamed for ₦50–80 billion a year in failed deliveries in Nigeria, so every address is confirmed before booking." | One message: Paystack office → UNILAG, small, **₦3,000**, Quote ref, "If yes, just reply YES" |
| 0:30 | `yes` | "The price comes from the server's rate card, never from the model." | Asks for your name, the recipient's name and their phone |
| 0:40 | `I'm Ada, sending to Anthony 0803 518 274` (one digit short, on purpose) | "Phone numbers are checked." | "looks incomplete: I got 10 digits…" |
| 0:50 | `sorry 08035182746` | | "reserved as ZD-…", number read back, "How would you like to pay…" |
| 1:00 | `card` | | A Paystack link |
| 1:05 | Open the link, choose **Declined**, then **Pay** | "First, a card that gets declined." | Paystack: "Declined", with "Retry with test details" |
| 1:15 | Back in the chat: `it was declined` | "Zuma only believes Paystack, never a screenshot. That's what stops fake transfer alerts. And the failure is handled, not ignored." | "Your ₦3,000 payment for ZD-… didn't go through (the bank said: Declined). No money was taken." Then the offer of a new link or a bank transfer |
| 1:30 | On the Paystack tab: **Retry with test details** → **Success** → **Pay** | "Paystack lets you retry on the same page. The server re-checks a declined payment, so the retry still counts." | "Payment received for ZD-…" on our return page |
| 1:40 | Back in the chat: `paid` | "**This is the moment the tool does its job:** `verify_payment` asks Paystack, marks the job paid and assigns a rider." | **Payment received**, the rider by name and role (for example "Tunde (rider)") with plate and number, and a handover code to "share with Anthony (recipient)" |
| 2:00 | `where is the rider now?` | "There are no real riders in a take-home, so the position is simulated from the job's timestamps." | "about N minutes away (x km)" and a Google Maps link |
| 2:15 | `i want a refund` | "Refunds need a person. Zuma tells the customer, then hands the chat to the team." | "I've passed this to our support team…" |
| 2:25 | Switch to the board, **Home** | "The dispatcher sees what needs them." | Two alerts: "1 chat is waiting for a person" and "1 paid job is ready to dispatch". Booked today: 1 |
| 2:35 | **Handovers** → open the chat | "The whole conversation, the reason Zuma handed over, and a reply box that sends as the team." | Transcript and "Why Zuma handed over: refund…" |
| 2:45 | **Deliveries** → the job → **Timeline** | "Every step is recorded: the declined card, the retry, the payment and the rider." | "awaiting payment → payment failed", then "payment failed → paid" |
| 2:55 | Stop | "That's one booking, end to end, on Chord." | |

## If something goes off-script

- **Zuma sends a new link straight away instead of asking** after the decline: open the new link and pay
  with **Success**. That's also correct.
- **You paid before typing `it was declined`** (the retry already succeeded): Zuma confirms the payment
  instead. Carry on from 1:40.

- **"The agent didn't answer":** wait 5 seconds and press refresh in the simulator. The reply is usually
  there. Don't re-send.
- **The quote asks "Abuja or Lagos?":** you typed a landmark instead of a postcode. Answer "Lagos" and
  carry on.
- **Payment still processing:** Zuma says "still processing, I'll confirm". Wait 10 seconds and type
  `paid` again.
