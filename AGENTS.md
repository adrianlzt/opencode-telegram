# AGENTS.md

## Project

opencode-telegram: an OpenCode plugin that bridges OpenCode sessions to a Telegram **forum supergroup** — each session gets its own topic, so multiple sessions can be chatted with in parallel. Zero runtime dependencies.

## Deploy (build + copy to opencode)

The plugin lives in this repo as TypeScript under `src/`. OpenCode does **not** run TypeScript directly — it loads the compiled bundle from `~/.config/opencode/plugins/telegram.js`. The deploy step is: build with tsup, copy the bundle over.

```bash
npm run install-plugin   # = tsup && cp dist/index.js ~/.config/opencode/plugins/telegram.js
```

Or manually:

```bash
npm run build            # tsup -> dist/index.js (ESM, ~2k lines)
cp dist/index.js ~/.config/opencode/plugins/telegram.js
```

**After deploying, restart ALL running opencode processes.** Each process loads the plugin at startup and keeps it in memory. Only the "host" instance polls Telegram (elected via a lock file); a stale process running old code can win the host election and silently break button replies — this bit us once. Restart everything, or verify with `cat /tmp/opencode-telegram.lock` (host pid) and `ps -p <pid> -o lstart=` (must be newer than the deploy).

Other commands:

```bash
npm run dev              # tsup --watch (rebuild on change; still needs the copy step)
npm run typecheck        # tsc --noEmit
```

There are no tests, no linter, and no formatter configured.

## Architecture

```
src/
  index.ts           # Plugin entry. Host election (lock file), Telegram->session routing by topic,
                     # event wiring (session.updated/idle/error, permission.asked, question.asked),
                     # non-host relay poller, pause/resume command hooks.
  config.ts          # Loads ~/.config/opencode/notification-telegram.jsonc (own JSONC stripper) + env vars.
  logger.ts          # File logger -> ~/.local/share/opencode-telegram/plugin.log, auto-trims at 3MB.
  telegram.ts        # TelegramApi: raw fetch() calls to api.telegram.org (no SDK).
                     # Poller: getUpdates long-poll loop, dispatches text/buttons/voice.
  topics.ts          # ensureTopic(): lazily create a forum topic per session, name it "<project> — <title>".
  flows.ts           # Outbound flows: session idle/error summaries, permission buttons, multi-question wizard.
  db.ts              # SQLite via bun:sqlite (fallback node:sqlite):
                     #   state.db  -> session_topics (session<->thread binding), relay tables, instance_sessions
                     #   opencode.db (read-only) -> sessions/todos for slash commands, archive/resume
  session-state.ts   # In-memory per-instance state: titles, pending permissions/questions, button tokens, paused flag.
  commands.ts        # /status /todos /sessions /session /peek /archive /resume
                     # /new /fork /compact /undo /agents /mcps /skills (host-only).
  menus.ts           # /model + interactive model picker buttons (mt: tokens), provider list via opencode API.
  ops.ts             # Relay appliers for session-mutating commands: fork, undo, compact.
```

### Routing model

- **Outbound:** any event for a session → `ensureTopic()` (creates the topic on first notification, persists `session_id → thread_id` in `session_topics`) → message sent into that thread.
- **Inbound:** message in a topic → `getSessionByThreadId()` → prompt that session directly (if this instance owns it) or insert into `forwarded_texts` for the owning instance (cross-instance relay). If the topic's `instance_id` is a dead instance, resolve the live owner first (active-session match, then project-directory match) and rebind; if none owns it, tell the user instead of dropping the message.
- Topic renamed when `session.updated` brings a new title; `/archive` closes the topic, `/resume` reopens it.
- Messages with no `message_thread_id` (root/General) get a hint; topics with no bound session get a hint.

### Host election / multi-instance

Every opencode process loads the plugin. One becomes **host** via `/tmp/opencode-telegram.lock` (`pid:instanceId`, stale-pid takeover). The host runs the `Poller`; non-host instances poll `state.db` every 500ms for relayed answers/results (`question_answers`, `permission_results`, `pending_custom`, `forwarded_texts`, `relay_actions`) and attempt host takeover if the lock's pid dies. **All instances can send** to Telegram (HTTP is stateless); only polling is exclusive.

## Implementing commands

Registration and structure:

- Commands are **host-only**: `onText` in index.ts routes `/cmd` text to `handleCommand()` in commands.ts. Add a `case` to that switch — an unregistered `/foo` falls through and is forwarded to the session as a user prompt.
- `handleCommand` receives the opencode `client` for commands that need the SDK. Keep command functions self-contained (`cmdXxx(...)` in commands.ts); commands with interactive button flows get their own module (see `menus.ts` for `/model`).

Reading session data (queries, status):

- Prefer **opencode.db** (global, read-only via `withOpencodeDb` in db.ts) over plugin state for anything cross-instance: the host sees every instance's sessions.
- Schema shapes: `message.data` JSON has `role`; `part.data` JSON has `type` (`reasoning`/`tool`/`text`/...). Tool parts nest the payload under `state.input` and `state.output` (output also mirrored in `state.metadata.output`).
- Parts stream live but flush with a few seconds of lag — a mid-stream message can have **zero part rows**. When reading "latest assistant activity", fall back to the previous assistant message(s) (see `getLatestActivity()` in db.ts).
- Verify data shapes against the live DB before coding: `bun -e '...'` with `new Database(path, { readonly: true })` on `~/.local/share/opencode/opencode.db`.

opencode client API (untyped — extend a minimal typed interface like `FlowClient`/`ModelClient`):

- `client.session.messages()` fetches history; `client.provider.list()` returns `{ all: [{id, models}], default, connected }` (drives `/model` menus).
- For untyped routes use `client._client.post({ url, body, headers })`. Session-scoped routes carry an `/api` prefix — e.g. model switch is `POST /api/session/:id/model` with `{ model: { providerID, id } }` (matches what the SDK itself calls).
- The raw client resolves to a `{ response?: Response }`-like shape: check `response.ok === false` and read `response.text()` for the reason; a resolved promise does not imply success.
- The client only talks to the local server of its own opencode process. Anything that must mutate another instance's session (prompt, permission reply, model switch) must be **relayed**: resolve the live owner (`isInstanceAlive()` / `resolveLiveOwner()`), rebind a stale `session_topics.instance_id` (`setTopicInstance()` — bindings go stale whenever the owning process restarts; also healed in `ensureTopic`, `session.updated` and inbound routing), then insert a row into `relay_actions` and handle it in the owning instance's poller (pattern: `applySwitchModelAction`).

Button-driven menus (pattern from `/model`):

- Encode button ids as `prefix + token`, tokens registered in an in-memory map with a TTL (`mt:` tokens, 15 min); on miss, tell the user to re-run the command.
- Use `api.sendButtonRows()` for multi-row keyboards; paginate long model lists (page stored inside the token payload).

## Code Style

### Imports

- Separate `type` imports: `import type { X } from "..."` or `import { type X } from "..."`
- Node builtins use `node:` prefix: `import { join } from "node:path"`
- Local imports use `.js` extension: `import { X } from "./config.js"`

### Formatting

- No formatter configured. Follow the existing style: 2-space indent.
- Keep lines under 100 characters where practical.
- No comments unless they explain non-obvious "why" (never "what").

### Types

- Strict TypeScript. `tsconfig.json` has `strict: true`.
- Use `unknown` over `any`; `any` only for opencode SDK / Telegram API shapes that are untyped.
- `FlowClient` in `flows.ts` is the minimal typed surface of the opencode client used by the flows.

### Naming

- Classes: `PascalCase` (`TelegramApi`, `Poller`, `SessionState`)
- Functions: `camelCase` (`loadConfig`, `ensureTopic`)
- Constants: `UPPER_SNAKE_CASE` (`APPROVE_PREFIX`, `LOCK_PATH`)
- Files: `kebab-case` (single words so far: `db.ts`, `flows.ts`, ...)

### Error Handling

- Wrap external calls in try/catch; log via the `log` object from `./logger.js` (never `console.*`).
- Structured extras: `log.error("...", { error: String(error) })`.
- On fatal config errors during init, return a no-op plugin: `{ event: async () => {} }`.
- Telegram topic mutations (`renameTopic`, `closeTopic`, `reopenTopic`) tolerate failure by design — log warn, never throw.

### Plugin-Specific Patterns

- Export shape (replicates what OpenCode resolves): `export const TelegramPlugin` + `export default { id: "telegram", server: TelegramPlugin }`.
- Event data is untyped — extract with `toNonEmptyString()`.
- Button IDs encode action + id via prefixes: `approve:` / `always:` / `deny:` / `qans:<token>` / `qcustom:<token>` / `mt:<token>`.
- Messages use HTML parse mode; escape user-controlled content with `escapeHtml()`. Unescaped `<` breaks the whole send (Telegram rejects with "can't parse entities") — this bit us with permission patterns containing shell code; `TelegramApi` now retries once without `parse_mode` as a last-resort fallback, but never rely on it.
- Messages > 4096 chars: send a short summary + the full text as a `.md` attachment (`sendDocument` with `FormData`/`Blob`).
- Voice messages have no transcription (Bot API limitation); a placeholder text is forwarded to the session.

## Configuration

Config is loaded from (env vars win):

1. `~/.config/opencode/notification-telegram.jsonc` (JSONC — supports comments)
2. Environment variables

| Config key | Env var | Required | Description |
|---|---|---|---|
| `bot_token` | `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `recipient_chat_id` | `TELEGRAM_RECIPIENT_CHAT_ID` | Yes | **Forum supergroup** id (negative, `-100...`). Bot must be admin with *Manage Topics* rights (that also bypasses privacy mode). |
| `enabled` | `TELEGRAM_ENABLED` | No | Start paused if `false` (default `true`) |

Note: `.env` loading was dropped in the rewrite (dotenv removed). Config comes from the jsonc file or real env vars only.

Group chat id discovery: if the host is already polling, `getUpdates` returns empty — grep the plugin log instead:
`rg "Telegraf update|update received" ~/.local/share/opencode-telegram/plugin.log` (old bundle) or check `getChat?chat_id=<id>` via curl to confirm `is_forum: true`.

## Dependencies

- **Runtime: none.** Bot API calls are raw `fetch()`; JSONC parsing is a local stripper in `config.ts`.
- Dev only: `tsup` (bundler), `typescript`, `@types/node`.

## Gotchas

- **Old processes keep running old code** — after deploy, restart every opencode process or the host election may pick a stale one (buttons stop working, no polls received).
- `bun:sqlite` vs `node:sqlite`: opencode runs on Bun; the fallback keeps the module importable under plain Node for testing.
- `session_topics` is the single source of truth for session↔topic binding. If topic creation fails mid-flight, the DB row may be missing while the topic exists in Telegram — delete the orphan topic manually and retry.
- The DB schema is `CREATE TABLE IF NOT EXISTS` only — no migrations. Changing column shapes requires manual `ALTER TABLE` on `~/.local/share/opencode-telegram/state.db`.
- The opencode **TUI does not refresh its model badge** when the model is switched from outside the TUI (the server still emits `session.next.model.switched` + `session.updated`) — cosmetic only; the session row and next prompts use the new model.
- A model listed by `provider.list()` may not actually serve: the stream opens and exits instantly with **zero parts and no error** in the opencode log. A "✅ Model set" reply only means the switch was applied, not that the model works.
