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
  db.ts              # SQLite via bun:sqlite (fallback node:sqlite):
                     #   state.db  -> session_topics (session<->thread binding), relay tables, instance_sessions
                     #   opencode.db (read-only) -> sessions/todos for slash commands, archive/resume
  session-state.ts   # In-memory per-instance state: titles, pending permissions/questions, button tokens, paused flag.
  commands.ts        # /status /todos /sessions /session /archive /resume (reply in the invoking topic).
  flows.ts           # Outbound flows: session idle/error summaries, permission buttons, multi-question wizard.
```

### Routing model

- **Outbound:** any event for a session → `ensureTopic()` (creates the topic on first notification, persists `session_id → thread_id` in `session_topics`) → message sent into that thread.
- **Inbound:** message in a topic → `getSessionByThreadId()` → prompt that session directly (if this instance owns it) or insert into `forwarded_texts` for the owning instance (cross-instance relay).
- Topic renamed when `session.updated` brings a new title; `/archive` closes the topic, `/resume` reopens it.
- Messages with no `message_thread_id` (root/General) get a hint; topics with no bound session get a hint.

### Host election / multi-instance

Every opencode process loads the plugin. One becomes **host** via `/tmp/opencode-telegram.lock` (`pid:instanceId`, stale-pid takeover). The host runs the `Poller`; non-host instances poll `state.db` every 500ms for relayed answers/results (`question_answers`, `permission_results`, `pending_custom`, `forwarded_texts`) and attempt host takeover if the lock's pid dies. **All instances can send** to Telegram (HTTP is stateless); only polling is exclusive.

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
- Button IDs encode action + id via prefixes: `approve:` / `always:` / `deny:` / `qans:<token>` / `qcustom:<token>`.
- Messages use HTML parse mode; escape user-controlled content with `escapeHtml()`. Unescaped `<` breaks the whole send (Telegram rejects with "can't parse entities").
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
