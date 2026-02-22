# Nanobot Features Analysis

Reference: [HKUDS/nanobot](https://github.com/HKUDS/nanobot) — ultra-lightweight personal AI assistant (~4k LOC).

## Already in Arceus

| Feature | Arceus | Notes |
|---------|--------|-------|
| Config loader | ✅ | JSON, Pydantic schema, camelCase |
| Session manager | ✅ | JSONL, `channel:chat_id` keys |
| Heartbeat | ✅ | HEARTBEAT.md, periodic wake-up |
| Cron | ✅ | `.arceus/cron.json`, every/cron/at |
| Cronitor ping | ✅ | run/complete/fail telemetry |
| Interactive chat | ✅ | `main.py chat` |
| Channels config | ✅ | `allow_from` for console |
| MCP client code | ✅ | Wired via `tools.mcpServers` in config |

## Recommended Additions (Prioritized)

### 1. ~~Wire MCP Support~~ ✅ Done

MCP is wired: add `tools.mcpServers` to config; AgentLoop connects at run start and unregisters at end.

---

### 2. ~~Onboard Command~~ ✅ Done

`main.py onboard` creates `.arceus/config.json`, `sessions/`, `skills/workspace_skills/`, and `HEARTBEAT.md` template.

---

### 3. ~~Status Command~~ ✅ Done

`main.py status` shows config path, provider, cron job count, heartbeat default, session count.

---

### 4. ~~Rich CLI Output~~ ✅ Done

`rich` dependency added; agent responses rendered as Markdown in `main.py chat`. Use `--no-markdown` for plain text.

---

### 5. ~~Chat History~~ ✅ Done

`prompt_toolkit` + `FileHistory` for up/down arrow history in chat. History stored at `~/.arceus/history/cli_history`.

---

### 6. ~~Progress Streaming~~ ✅ Done

Nanobot v0.1.4: stream LLM tokens as they arrive.

Azure provider streams tokens when `stream_callback` is in `runtime_context`. Chat mode streams by default; use `--no-stream` to disable. Rich Live + Markdown for streaming markdown rendering.

---

### 7. Docker Support (Medium effort)

Nanobot: Dockerfile + docker-compose for one-command deploy.

**Add:** `Dockerfile`, `docker-compose.yml` for Arceus gateway.

---

### 8. Message Bus + Channels (High effort)

Nanobot: `bus/` (InboundMessage, OutboundMessage, MessageBus) + `channels/` (Telegram, Discord, Slack, etc.).

**Arceus:** Would require significant refactor to decouple agent from direct Controller calls. Channels (Telegram, Discord) each need platform-specific SDKs and config.

**Recommendation:** Defer until multi-channel demand exists. Console + session_key covers most PM use cases.

---

### 9. Provider Registry (Medium effort)

Nanobot: Single `PROVIDERS` list; adding a provider = 2 steps (registry + config schema).

**Arceus:** Only Azure today. Could add OpenRouter, Anthropic, etc. via registry pattern.

---

### 10. Subagent / Background Tasks (High effort)

Nanobot: `agent/subagent.py` — spawn background tasks.

**Arceus:** PM-focused; less critical than for general assistant.

---

## Quick Wins (Implement First)

1. **Wire MCP** — config schema + AgentLoop integration
2. **Status command** — `main.py status`
3. **Onboard command** — `main.py onboard`

## Summary

| Priority | Feature | Effort | Value |
|----------|---------|--------|-------|
| 1 | Wire MCP | Low | High |
| 2 | Status command | Low | Medium |
| 3 | Onboard command | Low | Medium |
| 4 | Rich Markdown in chat | Low | Medium |
| 5 | Chat history (prompt_toolkit) | Low | Medium |
| 6 | Progress streaming | Medium | High ✅ |
| 7 | Docker | Medium | Medium |
| 8 | Provider registry | Medium | Medium |
| 9 | Message bus + channels | High | High (if needed) |
