# Deployment field notes

Three problems that cost the most time getting Zuma to work on Chord. Each covers what happened, how I
found the cause, the fix or workaround, and what I'd change in Chord, its docs or its API. All runs were
in the TSG WhatsApp simulator, 20–22 Oct 2026, with times in WAT.

Supporting material:
- [FIELD_NOTES_FULL.md](FIELD_NOTES_FULL.md): the full build log, 25 entries including Cloudflare,
  Paystack, NIPOST and Google.
- [DECISIONS.md](DECISIONS.md): the choices these problems led to.

---

## 1. Only the text after a turn's last tool call reaches the customer, and the built-in handover sends none

**What happened.**
- **Payment confirmation swallowed (ZD-0H5SF, 22 Oct 11:14).** The customer wrote "i have paid".
  `verify_payment` returned `paid`, with a ready-made message naming the rider, their number and the
  handover code. Zuma then saved a memory note, as the skill told it to. The only text delivered was
  *"I've saved the payment on your account too, so it's all in one place."*
  ([screenshot 09](screenshots/09-memory-remark-swallowed-confirmation.png))
- **Refund request met with silence (21 Oct 17:11).** "i want a refund" got no reply in the simulator
  ([04](screenshots/04-refund-no-visible-reply.png)). Yet Chord's record shows two messages were sent:
  "One moment — connecting you with a teammate." and our acknowledgement
  ([05](screenshots/05-board-shows-the-hidden-handover-lines.png)).

**How I found the cause.**
- **Handovers:** I read the turns of all six handovers in the workspace (`GET /v1/threads/{id}/turns`).
  Every time, the customer's message is followed directly by Chord's system line, with no AI turn. So
  whatever Zuma wrote alongside the built-in handover call was dropped.
- **The payment case** has the same shape: confirmation, then a tool call, then the remark, and only
  the remark arrived. So a turn delivers only the text written after its last tool call.
- **The simulator** never shows system or operator turns, which is why the refund looked like silence
  even though both lines were sent.

**Fix or workaround.**
- **Skill:** call every tool first, reply last, once. A one-line note on every tool result repeats the
  rule, since that is what the model reads at the moment it decides.
- **Our own handover tool:** `hand_to_team` returns the line Zuma sends ("I've passed this to our
  support team…"), so the customer sees a normal AI turn. Once that reply is posted, the server takes the
  chat over through the operator API. It waits at most 20 s. Both fixes are working in
  [12](screenshots/12-working-payment-and-handover.png).

**What I'd change in Chord, its docs or its API.**
- **Chord:** deliver all of a turn's text, or at least warn when text before a tool call is about to be
  dropped.
- **Docs:** state plainly that only text after the last tool call is sent. That sentence alone would
  have saved a day.
- **API:** let the built-in handover carry a customer-facing message.
- **Simulator:** show system and operator messages, as WhatsApp does.

---

## 2. The model can't see earlier tool results, so it "corrects" answers that were right

**What happened.** Zuma kept retracting things it had just got right:
- *"The job ID ZD-JP2QG and handover code 9151 I gave you earlier were not real, so please ignore them."*
  It was a real job, and Zuma then offered to book a duplicate.
- *"My earlier message did match the tool results, so ignore my last correction."* This was said right
  after "yes", and there had been no correction ([01](screenshots/01-phantom-correction-after-yes.png)).
- *"Correction to what I said above…"* ([06](screenshots/06-paid-but-no-confirmation.png)) and
  *"Sorry for the confusion in my last message…"* ([10](screenshots/10-sorry-for-the-confusion.png)).

**How I found the cause.**
- Our tool-call log showed `resolve_address` called again on every turn, every call succeeding. Chord's
  transcript had no hidden message.
- So the model sees only the *text* of earlier turns. When a new tool result arrives, it decides its own
  earlier text was unverified and retracts it.
- Rewording the skill didn't hold:

| Skill | Change | Same three turns |
|---|---|---|
| v6 | "Never take back an earlier answer" | "Sorry about the mix-up earlier." |
| v7 | + "never open with sorry" | "That quote isn't valid, so please ignore it." |
| v8 | + a note in each tool result | It quoted the note to the customer |
| v9 | Note marked "context only, never mention it" | Clean |

**Fix or workaround** (mostly server-side, so it doesn't rely on the model):
- A duplicate-booking guard returns the existing job when the same booking is tried again.
- The same address text gives the same place ids for 6 hours.
- Ids are written into the visible text ("Quote ref Q-VXJ42KRD"), because the model trusts its own text.
- A hidden note on each result says that earlier answers came from tools and are correct.
- The model is Chord-managed (`400 MODEL_OVERRIDE_RETIRED`), so these are the only levers. One turn
  costs about 0.1 credit.

**What I'd change in Chord, its docs or its API.**
- **Chord:** include a one-line summary of earlier tool calls (names and key ids) in the model's context.
- **Docs:** say that tool results do not carry over between turns. Any agent that works across turns
  hits this.

---

## 3. Tools don't know which chat they're in, and messages pushed into a chat are hidden in the simulator but read by the AI

**What happened.**
- I wanted "Payment received" sent the moment Paystack confirmed, without the customer typing "paid".
- In a live run (ZD-XSE4F, 22 Oct), the webhook marked the job paid at 10:05:59, and our notice was
  posted into the chat at 10:06:20.
- The simulator didn't show it. The customer wrote "paid" at 10:06:36 and got only *"Is there anything
  else I can help you with, Ada?"* ([06](screenshots/06-paid-but-no-confirmation.png)).
- Later Zuma referred to *"the earlier rider details and handover code"*, which the customer had never
  seen ([07](screenshots/07-invisible-notice-referenced.png)).

**How I found the cause.**
- **No conversation id:** I logged everything Chord sends with a tool call. There's no `params._meta` and
  no identifying header, only standard headers from `Java-http-client`.
- **Finding the chat instead:** the job id is always in Zuma's booking message, so the server searches
  recent threads for it. The API key form has no Threads row, and a key without it was refused with
  `403 Missing required permission: thread:read`. Only "Full access" works.
- **Hidden but read:** Chord marked the notice delivered, but the simulator shows only customer and AI
  turns, while the AI reads a pushed message as its own. It wasn't hallucinating: only Chord and the AI
  could see that message.

**Fix or workaround.**
- The notice finds the chat by the job id, is sent once, and never when the match is unclear, a person
  holds the chat, or the chat is outside WhatsApp's 24-hour window.
- On a channel that can't display it (the simulator), the notice is skipped and Zuma confirms in its
  own reply. On WhatsApp the notice is sent.
- I asked TSG about the simulator hiding these messages.

**What I'd change in Chord, its docs or its API.**
- **API:** pass the thread id and customer identity to MCP tools, for example in `params._meta`. That
  removes the search, the full-access key and the guessing.
- **Chord:** add a Threads permission to the API key form. Mark pushed and operator messages as not
  written by the AI in the model's context.
- **Simulator:** show them.

---

## Also hit, briefly

- **Sign-up email in spam.**
  - **What happened:** Chord's code email landed in Gmail Spam ("similar to messages that were
    identified as spam in the past"), and the code expires in 10 minutes. The code screen already said
    to check the spam folder, which is how I found it.
  - **What the headers show:** "Show original" on a Chord code email shows SPF, DKIM and DMARC all
    passing. So it isn't an authentication fault. Sender reputation or the one-line body are possible
    causes, but I couldn't prove either.
  - **Two codes:** one sign-in produced two different codes in the same minute, and nothing said which
    one counted.
  - **Ask:** send one code per request (or say the newest replaces the old), give the email a fuller
    body, and add a resend button with a countdown.
- **"The agent didn't answer. Try sending again."**
  ([02](screenshots/02-simulator-agent-didnt-answer.png)): Chord's transcript had the reply. The model
  was slow on a long skill (about 26 s), so I cut the skill from 12.8 KB to under 8 KB. Ask: document the
  simulator's timeout.
- **A new teammate is "Suggest, I approve" and paused by default.** Every reply would have waited for
  approval, and "We couldn't confirm activation access" appeared for the owner. I switched it to Act
  independently, then Settings → Lifecycle → Resume. Ask: warn when a customer-facing teammate will wait
  for approval.
