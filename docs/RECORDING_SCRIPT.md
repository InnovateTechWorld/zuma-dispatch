# 3-minute recording script

One conversation, start to finish, in the TSG simulator, with the board shown at the end. Rehearse it once
first: the whole run is about 8 AI turns, which is roughly 1 credit.

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
- Paystack's test page: choose **Success**, or use test card `4084 0840 8408 4081`, CVV `408`, PIN `0000`,
  OTP `123456`.

## The run

The brief asks you to "show the moment your tool does its job". Here that is 1:15–1:45: Paystack
confirms the money, our server marks the job paid and assigns a rider, and Zuma's reply carries the
result. Say so out loud, and keep the board tab ready to show it.

| Time | Type or do | Say (short) | You should see |
|---|---|---|---|
| 0:00 | Show the simulator | "Zuma books same-day deliveries for a courier in Abuja and Lagos, on WhatsApp. This is TSG's simulator." | Empty chat |
| 0:10 | `Send a phone charger from LA-11-ZDM-PS-01 to LA-19-ZDM-UL-01` | "These are demo postcodes. NIPOST's test key can't locate a building, so we added four clearly marked ones. Real postcodes and landmarks also work." | One message: Paystack office → UNILAG, small, **₦3,000**, Quote ref, "If yes, just reply YES" |
| 0:35 | `yes` | "The price comes from the server's rate card, never from the model." | Asks for your name, the recipient's name and their phone |
| 0:45 | `I'm Ada, sending to Anthony 0803 518 274` (one digit short, on purpose) | "Phone numbers are checked." | "looks incomplete: I got 10 digits…" |
| 0:55 | `sorry 08035182746` | | "reserved as ZD-…", number read back, "How would you like to pay…" |
| 1:05 | `card` | | A Paystack link |
| 1:15 | Open the link and choose **Success** | "Paystack's test mode. Paid means Paystack confirms it, not the customer saying so." | Paystack success page |
| 1:35 | `paid` | "**This is the moment the tool does its job:** `verify_payment` asks Paystack, marks the job paid and assigns a rider." | **Payment received**, the rider by name and role (for example "Tunde (rider)") with plate and number, and a handover code to "share with Anthony (recipient)" |
| 1:55 | `where is the rider now?` | "There are no real riders in a take-home, so the position is simulated from the job's timestamps." | "about N minutes away (x km)" and a Google Maps link. Click it once |
| 2:15 | `i want a refund` | "Refunds need a person. Zuma tells the customer, then hands the chat to the team." | "I've passed this to our support team…" |
| 2:25 | Switch to the board, **Home** | "The dispatcher sees what needs them." | Two alerts: "1 chat is waiting for a person" and "1 paid job is ready to dispatch". Booked today: 1 |
| 2:35 | **Handovers** → open the chat | "The whole conversation, the reason Zuma handed over, and a reply box that sends as the team." | Transcript and "Why Zuma handed over: refund…" |
| 2:45 | **Deliveries** → the job | "The job: paid via Paystack, rider assigned, the same data the owner sees in their Google Sheet." | Paid, the rider assigned, Google Maps links for both addresses |
| 2:55 | Stop | "That's one booking, end to end, on Chord." | |

## If something goes off-script

- **"The agent didn't answer":** wait 5 seconds and press refresh in the simulator. The reply is usually
  there. Don't re-send.
- **The quote asks "Abuja or Lagos?":** you typed a landmark instead of a postcode. Answer "Lagos" and
  carry on.
- **Payment still processing:** Zuma says "still processing, I'll confirm". Wait 10 seconds and type
  `paid` again.
