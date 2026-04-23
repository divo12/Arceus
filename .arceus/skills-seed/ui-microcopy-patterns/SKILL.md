---
name: ui-microcopy-patterns
description: Writing user-facing text — buttons, errors, empty states — that's short, actionable, and human. Anti-patterns named.
role: ui
trigger: designing a screen that includes any user-facing text (buttons, errors, empty states, form help, loading states)
---

# Microcopy Patterns

Every word the user reads is design. Microcopy — buttons, errors, labels, empty states — is where the product talks to the user. Bad microcopy = confusion + friction. Good microcopy = clarity.

## When this fires

- Writing button labels, form field text, error messages
- Designing empty states, loading states, success confirmations
- Reviewing existing UI for copy quality

Not this skill when: body content / marketing copy (that's `mkt-messaging-variants`) or longer help / documentation text.

## The patterns (by surface)

### 1. Buttons — verb, concrete, specific

- Bad: "Submit," "OK," "Continue"
- Good: "Save Changes," "Create Account," "Delete Order"

Rules:
- Start with a verb (action)
- Say what the button DOES
- Match the user's mental model, not the backend's

Pair: button labels should answer "if I click this, what happens?"

### 2. Errors — diagnose + fix

Every error answers three questions:
1. What went wrong? (specific, not "error occurred")
2. Why? (if discoverable)
3. How do I fix it?

| Bad | Good |
|---|---|
| "Error" | "Email required" |
| "Invalid input" | "Password must include a number" |
| "Something went wrong" | "We couldn't save your changes. Your connection dropped — try again" |
| "500 Internal Server Error" | "Our servers had trouble. We've been notified. Try again in a moment." |

Tone: concerned but not panicked. No blame.

### 3. Empty states — onboard + suggest

Empty states are onboarding moments. Don't just say "no results" — show the user what to do.

- Bad: "No orders"
- Good: "You haven't placed any orders yet. [Browse products]"

Rules:
- Explain the empty state (why is it empty?)
- Suggest the next action
- Optional: reassure if the emptiness is expected ("No security alerts — that's a good sign")

### 4. Loading states — honest

- "Loading…" is fine for < 3s operations
- For longer: tell the user what's happening — "Uploading 25 files…"
- For operations > 10s: progress indicator + cancellation
- Never promise speed ("almost done!") unless you actually know

### 5. Success confirmations — quiet by default

Don't celebrate what the user expected. Most successes are mundane.

- Bad: "🎉 SUCCESS! Your settings have been saved!!! 🎉"
- Good: "Saved" (toast, 2-3 seconds, no emoji)

Celebrate only for milestones: first order, account created, payment sent to recipient.

### 6. Labels — explain the field in 2-3 words

- "Email" not "Email Address"
- "Phone" not "Contact Phone Number"
- If context is clear, short wins
- Help text (below) for anything needing explanation — not in the label

### 7. Placeholder text — example, not instruction

- Bad placeholder: "Enter your email here"
- Good placeholder: "name@example.com"

Placeholders disappear when user types — never put required info there (like "must include @").

## The voice

Across all microcopy, maintain:

- **Concise.** Cut every unnecessary word. "In order to" → "To". "Please click" → "Click".
- **Human.** Write like you'd say it out loud. No "Please be advised that…"
- **Confident, not cocky.** "Your order is confirmed" not "Super excited your order went through!"
- **Consistent.** Same term for the same thing. "Log in" OR "Sign in" — pick one, not both.
- **No jargon.** Unless target user speaks it. "API key" fine for devs; not fine on consumer landing page.

## The loop

```
1. List every text element on the screen (button, error, empty state, etc.)
2. For each, apply the matching pattern above
3. Walk the voice check: concise, human, confident, consistent, jargon-free
4. Test: read aloud. Does it sound like something a human would say?
5. Include microcopy in the design spec (don't leave for dev to fill in)
6. Handoff via design-to-dev-handoff with all copy specified
```

## Heuristics

- **Every word is a design decision.** If "Cancel" vs "Go back" matters, pick on purpose.
- **Shorter is almost always better.** Cut 30% from your first draft.
- **Read aloud to catch awkwardness.** If you trip over it, users will.
- **Consistency beats cleverness.** One "Sign in" everywhere > three variations of the same action.
- **Internationalization hint: tight English = tight in other languages.** Don't use idioms ("out of the park," "ballpark figure") — they don't translate.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Users hit "Submit" and don't know what happened | Non-specific button + generic success | Name the button's effect; give specific confirmation |
| Support tickets say "I got an error" | Error messages too vague | Include what + why + how-to-fix |
| Users abandon empty states | Didn't guide next step | Add CTA in every empty state |
| Term drift across the product | No consistent vocab | Maintain a copy glossary; review in design reviews |

## Anti-patterns

- **"Oops!" / "Whoops!" as error prefix.** Cutesy; not helpful.
- **Exclamation marks everywhere.** Excitement loses meaning when universal.
- **"Please" before every action.** Formal and adds noise. Drop.
- **"We're sorry for the inconvenience" boilerplate.** If you're sorry, fix the problem; don't just apologize.
- **Labels like "Username / Email / Phone." Pick one — users can't figure out what to type.
- **Error that blames the user** ("you entered the wrong password"). Neutral framing: "Password doesn't match."
