---
name: developer-ai-gateway
description: How to build AI features into the product WITHOUT an API key or backend. Arceus ships a pre-wired aiComplete() client at src/lib/aiComplete.ts that calls the same-origin AI Gateway — the provider key stays server-side, usage is metered against the company budget. Load this when the task asks for any LLM-powered feature (summarize, generate, classify, chat, rewrite, suggest, autocomplete).
role: developer
trigger: task mentions AI / LLM / "smart" / generate / summarize / chat / autocomplete / classify / suggest — before reaching for fetch() to any provider or asking for an API key.
---

# Building AI features — use the gateway, never an API key

The scaffold ships **`src/lib/aiComplete.ts`** already wired to the Arceus AI Gateway. The product is a frontend-only SPA, but it can still call an LLM — Arceus runs the gateway on the **same origin** (`/api/ai/complete`), holds the provider key server-side, and meters spend against the company budget.

## Rules (do NOT violate)

- **NEVER** embed an API key, `dangerouslySetInnerHTML` of model output without sanitizing, or call a provider (OpenAI/Anthropic/Azure) directly. There is no key in the bundle and there must never be one.
- **NEVER** add a server, proxy, or `.env` for the LLM call — `aiComplete()` already handles it.
- Import from the alias: `import { aiComplete, aiPrompt } from "@/lib/aiComplete";`

## Usage

One-shot prompt → text:

```ts
import { aiPrompt } from "@/lib/aiComplete";

const oneLiner = await aiPrompt(`Summarise in one sentence:\n${note.body}`);
```

Full chat control + options:

```ts
import { aiComplete, AiCompleteError } from "@/lib/aiComplete";

try {
  const { text, usage } = await aiComplete(
    [
      { role: "system", content: "You turn rough notes into 3 crisp bullet points." },
      { role: "user", content: note.body },
    ],
    { maxTokens: 300, temperature: 0.4 },
  );
  setBullets(text);
} catch (err) {
  if (err instanceof AiCompleteError && err.code === "budget_exceeded") {
    setError("AI usage limit reached for this app.");
  } else if (err instanceof AiCompleteError && err.code === "rate_limited") {
    setError("Too many requests — try again in a moment.");
  } else {
    setError("AI is temporarily unavailable.");
  }
}
```

## In React components

- Call inside an async handler / `useEffect`, never during render.
- Always render a loading state and handle `AiCompleteError` (show a friendly message; don't crash).
- Pass an `AbortController().signal` via `{ signal }` and abort on unmount or when a newer request supersedes the old one.

## Acceptance bar for an AI feature

- [ ] Uses `aiComplete`/`aiPrompt` from `@/lib/aiComplete` — no keys, no extra backend.
- [ ] Loading + error states are visible (uses the design-system primitives).
- [ ] Model output is rendered as text/markdown, not injected as raw HTML.
- [ ] `maxTokens` is set to something sane for the feature (don't request 2000 tokens for a one-line summary).
