# Deployment field notes

The three problems that cost the most time getting Zuma to work on Chord, plus short notes on smaller ones.
Each says what happened, how we found the cause, what we did about it, and what we'd change in Chord.
All runs took place in the TSG WhatsApp simulator between 2026-10-20 and 2026-10-22. Times are WAT.

The full log of 23 entries, including Cloudflare, Paystack, NIPOST and Google issues, is in
[FIELD_NOTES_FULL.md](FIELD_NOTES_FULL.md). The design choices these problems led to are in
[DECISIONS.md](DECISIONS.md).

---

## 1. Only the text after the last tool call reaches the customer, and the built-in handover sends none

**What happened.**
- **Paid, but the customer got a remark instead of a confirmation (ZD-0H5SF, 2026-10-22 11:14).**
  - The customer wrote "i have paid". Our `tool_calls` table shows that `verify_payment` returned `paid`,
    with a ready-made `message_for_customer` naming the rider, their number and the handover code.
  - Zuma then saved a memory note, which the skill told it to do at that point.
  - The only text that reached the customer was *"I've saved the payment on your account too, so it's all
    in one place."* ([screenshot 09](screenshots/09-memory-remark-swallowed-confirmation.png))
- **"i want a refund" got no reply at all (ZD-QFJ5F, 2026-10-21 17:11).**
  - The simulator showed only the customer's message ([04](screenshots/04-refund-no-visible-reply.png)).
  - Our board, which reads Chord's thread record, shows that two messages *were* sent
    ([05](screenshots/05-board-shows-the-hidden-handover-lines.png)): Chord's own "One moment — connecting
    you with a teammate." and our operator acknowledgement.

**How we found the cause.**
- We read the turns of every handover in the workspace with `GET /v1/threads/{id}/turns` (six in total).
  In every one, the customer's message is followed directly by Chord's system line. There is no AI turn,
  so whatever Zuma wrote alongside the built-in handover call was dropped.
- The payment case has the same shape. Zuma wrote the confirmation, then called the memory tool, then
  wrote the remark, and only the remark arrived.
- So a turn delivers only the text written after its last tool call. The simulator also never shows system
  or operator turns, which is why the refund looked like silence there even though both lines were sent.

**What we did.**
- **The skill:** run every tool first and write the reply last, once. Memory is saved only at booking and
  is never mentioned. A short note added to every tool result repeats the rule, because that is the text
  the model reads at the moment it decides.
- **The tools:** `verify_payment`'s paid result says "Do not call any more tools after this one. Reply with
  message_for_customer word for word as your whole reply."
- **Handover:** we built our own tool, `hand_to_team`, and stopped using Chord's built-in one.
  - It returns the line Zuma sends ("I've passed this to our support team…"), so the customer sees a
    normal AI turn.
  - After that reply is posted, the server takes the chat over through the operator API. It waits at most
    20 s, so the customer is never left with the AI after asking for a person.
  - [Screenshot 12](screenshots/12-working-payment-and-handover.png) shows both fixes working: the full
    paid confirmation, then a visible handover reply.

**What we'd change in Chord.**
- Deliver all of a turn's assistant text, or document clearly that only the text after the last tool call
  is sent. The documentation alone would have saved a day.
- Let the built-in handover carry a customer-facing message, or keep the agent's text when it hands over.
- Show system and operator messages in the simulator, as WhatsApp does.

---

## 2. The model can't see earlier tool results, so it "corrects" answers that were right

**What happened.** Zuma kept retracting things it had just got right from a tool:
- *"The job ID ZD-JP2QG and handover code 9151 I gave you earlier were not real, so please ignore them."*
  This was a real job in our database, and it then offered to book a duplicate (2026-10-20 14:31).
- *"My earlier message did match the tool results, so ignore my last correction."*
  This came straight after the customer said "yes", and there had been no correction
  ([01](screenshots/01-phantom-correction-after-yes.png)).
- *"Correction to what I said above: your delivery was already booked as ZD-XSE4F…"*
  ([06](screenshots/06-paid-but-no-confirmation.png)) and *"Sorry for the confusion in my last message…"*
  ([10](screenshots/10-sorry-for-the-confusion.png)).

**How we found the cause.**
- Our `tool_calls` table showed `resolve_address` called again on every turn. The model was re-deriving
  everything because it couldn't see the earlier results.
- Every one of those calls succeeded. Chord's transcript had no hidden message, and the customer memories
  were neutral.
- So the model sees only the *text* of earlier turns. When a fresh tool result appears, it decides its
  earlier text was unverified and retracts it.
- Rewording the skill did not fix it, as the table below shows:

| Skill | What changed | Result on the same 3 turns |
|---|---|---|
| v6 | "Never apologise for or take back an earlier answer" | "Sorry about the mix-up earlier." |
| v7 | + "Never open with sorry" | "That quote isn't valid, so please ignore it." (It was valid) |
| v8 | + a note in every tool result saying earlier answers came from tools | "The tool notes say my earlier messages did come from real lookups…" It narrated the note |
| v9 | Note marked "context only, never mention it"; skill: never talk about tools or earlier messages | Clean |

**What we did** (mostly on the server, so it doesn't depend on the model behaving):
- **Bookings can't be duplicated.** The same sender, recipient phone, size and route returns the existing
  unpaid job, even under a new quote id. A quote that already has a job is never reused.
- **Answers are stable.** The same address text gives the same place ids for 6 hours, so re-running a tool
  gives the same answer and nothing looks contradictory.
- **Ids are written into the visible text** ("Quote ref Q-VXJ42KRD", "reserved as ZD-…"), because the model
  trusts what it can read in its own earlier messages.
- **Hidden context.** The note in every tool result says that earlier messages came from tools and are
  correct, and that the model should not comment on them. Replies the model often mangled, such as the
  "already booked" answer, now come with neutral, ready-made wording.
- **Cost.** Each AI turn costs about 0.09–0.11 credits. Chord's managed model can't be changed (`400
  MODEL_OVERRIDE_RETIRED`), so the skill and the tool results are the only levers.

**What we'd change in Chord.** Give the model at least a one-line summary of the tool calls on earlier
turns (name and key ids). Otherwise, document that tool results don't carry over. Any Chord agent that
works across turns will hit this, and instructions in the skill alone did not hold.

---

## 3. Tools don't know which conversation they're in, and messages we push in are invisible in the simulator but read by the AI

**What happened.**
- We wanted "Payment received" to reach the customer the moment Paystack's webhook arrived, without the
  customer having to type "paid".
- Then, in a live run (ZD-XSE4F, 2026-10-22), the webhook marked the job paid at 10:05:59, and our server
  posted the notice into the chat at 10:06:20.
- The simulator didn't show it. The customer wrote "paid" at 10:06:36 and got only *"Is there anything else
  I can help you with, Ada?"* ([06](screenshots/06-paid-but-no-confirmation.png)).
- Three minutes later the AI referred to *"the earlier rider details and handover code"*, which the
  customer had never seen ([07](screenshots/07-invisible-notice-referenced.png)).

**How we found the cause.**
- **No conversation id.** We logged everything Chord sends with a tool call. There is no `params._meta`
  and no identifying header, only standard headers from `Java-http-client`. So our server can't tell
  which chat a payment belongs to.
- **The search route, and a missing permission.** The job id is always in Zuma's booking message, so we
  search recent threads (`GET /v1/threads`, then `/turns`) for the AI turn that contains it. But the
  API key form has no Threads row. A key with Teammates Read and Update was refused with
  `403 Missing required permission: thread:read`. Only "Full access" works.
- **Invisible, but read.** Chord's record showed the notice as delivered. The simulator, however, shows
  only customer and AI turns, while the AI reads a pushed message as something it said itself. So it
  "remembered" a confirmation the customer never saw. It was not hallucinating; only Chord and the AI
  could see that message.

**What we did.**
- The notice finds the chat by the job id the AI sent. It is sent once per job, and never when the match
  is uncertain, a person holds the chat, or the chat is outside WhatsApp's 24-hour window.
- On a channel that can't display it (the simulator), the server now skips the notice
  (`channel_cannot_show`) and Zuma confirms in its own reply. On WhatsApp the notice goes out, and Zuma
  doesn't repeat it.
- `hand_to_team` (note 1) finds the chat the same way, by matching the customer's latest message against
  chats from the last 3 minutes. It never guesses between two matches.

**What we'd change in Chord.**
- Pass the thread id and customer identity to MCP tools (for example in `params._meta`). This one change
  would remove the search, the full-access key and the guessing.
- Add a Threads permission to the API key form.
- In the model's context, mark operator and pushed messages as not written by the AI.
- Make the simulator show them.

---

## Smaller problems, one line each

| Problem | Evidence | Workaround | What we'd change in Chord |
|---|---|---|---|
| The sign-up verification email landed in Gmail Spam ("similar to messages that were identified as spam in the past"), and the code expires in 10 minutes | Show original on a Chord code email: SPF, DKIM (chordhq.xyz and amazonses.com) and DMARC all **pass**. So it isn't authentication; sender reputation or the one-line body are likely but unproven. One sign-in produced two different codes in the same minute | Took the code from Spam, marked it "Not spam" and added a filter | A "check your spam folder" hint on the code screen, a resend button with a countdown, and one code per request |
| "The agent didn't answer. Try sending again." | [02](screenshots/02-simulator-agent-didnt-answer.png). In one case (ZD-2RWZ9) Chord's transcript had the full reply and our tools had answered within a second; the slow part was the model working through a long skill (about 26 s) | Cut the skill from 12.8 KB to under 8 KB, and had Zuma reuse ids from the chat instead of re-running tools | Document the simulator's timeout; don't report "didn't answer" when the transcript has a reply |
| A new teammate defaults to "Suggest, I approve" and is created paused ("We couldn't confirm activation access", for the workspace owner) | Review screen | Chose Act independently; Settings → Lifecycle → Resume | Make autonomous the default for customer-facing teammates, or warn that replies will wait for approval |
| A ZIP with a top-level folder breaks skill reference paths | Chord stored `zuma-dispatch/SKILL.md` | Zip the folder's contents, not the folder | Strip a single top folder, or warn |
| Chrome autofilled the Add MCP server form with the Chord login (email in URL, **password in the auth token field**) | Reproduced twice | Cleared both fields by hand | `autocomplete="new-password"` on the token field, and require the URL to start with `https://` |
| Settings → Tools lists Chord's own connectors, not the MCP server | The first tool call proved the server was reachable | None needed | List the assigned MCP servers and their tools there |
