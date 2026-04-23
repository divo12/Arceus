---
name: ceo-intervention-template
description: Structured response to board messages that require executive judgment. Acknowledge → reframe → propose → commit.
role: ceo
trigger: replying to a board message where the board has asked for a decision, expressed concern, or flagged a shift
---

# CEO Intervention Template

When the board messages you with something weighty, the instinct is to respond immediately with reassurance. That produces waffle. Use this structure instead.

## When this fires

- Board message contains a question, concern, or directive
- Board flags a shift (market, competitor, risk)
- You're about to call `board_post_message` in response to board input
- You need to make a call and communicate it upward

Not this skill when: board message is informational or acknowledgment. A "thanks, noted" is fine.

## The four-part structure

### 1. Acknowledge (1 sentence)

Mirror back what you heard. Shows you processed it; prevents the board repeating the message.

- Good: "I hear the concern on launch timing given the Q3 competitive pressure."
- Bad: "Thanks for the message!"
- Bad: "Totally agree." (agree with what?)

### 2. Reframe (1-2 sentences)

State the decision-space. What's the actual question? Often the board's message conflates several. Your job is to separate them.

- "This comes down to one choice: ship an MVP by Q3 that's thin, or ship full-featured by Q4. Both carry different risks."
- "The concern about customer churn separates into two questions: is churn caused by X, and if so, is X our priority this sprint?"

### 3. Propose (the concrete move)

Your call, with rationale. Name the option, name the tradeoff.

- "I'm choosing thin-by-Q3. Rationale: competitive pressure > feature completeness; we can expand post-launch. Tradeoff: some early users will get a sparser product."
- Not "We could do X, but Y is also valid, thoughts?" — that's asking the board to decide. If you want that, use `meeting_request_decision` instead.

### 4. Commit (the first concrete step + checkpoint)

What happens next, by when, and how the board will know.

- "Developer starts on the thin scope today (sprint 6). I'll post a checkpoint at end of week 1."
- "I'm blocking the current sprint's non-critical work until we resolve this — next update Friday."

## The decision path

Before writing the response, classify the message:

| Board message type | Your response type |
|---|---|
| Question with a clear answer | Short answer + reasoning (acknowledge + reframe + propose + commit) |
| Concern requiring action | Full 4-part structure; propose the action |
| Concern requiring investigation | 4-part, but "propose" = "investigate with this scope and report back by X" |
| Directive ("please do Y") | Acknowledge + reframe (if you disagree) + comply or escalate with reasoning |
| Ambiguous / multiple layers | Reframe into 2-3 separate questions; address each in one post or split into multiple |

## Heuristics

- **Always make a call.** Even "I need more info first" is a call with a reason.
- **Disagreement is fine, but show reasoning.** "I disagree because X, Y, Z" lands better than silent compliance or silent rebellion.
- **Commit publicly with a checkpoint.** Board trust compounds through delivery on stated commitments.
- **Short > long.** 4 tight sentences > 4 paragraphs of hedging.
- **Emotional labor is the CEO's job.** Board panic → your calm; board complacency → your urgency.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Board asks the same question twice | You didn't actually answer (waffle or deflect) | Answer the literal question with a yes/no + rationale |
| Board escalates after your reply | They needed a decision; you gave options | Next time, propose one concrete path |
| Your proposal gets immediately overruled | Didn't acknowledge + reframe enough; board thought you missed their concern | Lead with their concern, mirrored |
| Response lands badly despite good content | Tone mismatch (too casual / too defensive) | Match the board's emotional register |

## Anti-patterns

- **Excessive apology** — "I'm so sorry this came up, I should have caught it earlier." Board wants forward motion, not self-flagellation.
- **Deferring to the board on operational calls** — "What do you think we should do?" (This is your job; ask the board on strategic calls, not tactical ones.)
- **Promising things you can't deliver** — "I'll have this fixed by tomorrow" when you know it's 3 sprints. Board remembers broken promises.
- **Long responses to simple questions** — if a 1-sentence answer suffices, use it. Don't pad.
- **Responding in public when private works better** — some board messages benefit from a DM-style channel. Route via `meeting_request_decision` if the topic is sensitive.
