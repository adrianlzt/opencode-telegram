# AGENTS.md

## Project

opencode-telegram: an OpenCode plugin that bridges OpenCode sessions to Telegram via the Telegram Bot API.

## Build & Development

```bash
npm run build        # tsup - bundles to dist/index.js (ESM)
npm run dev          # tsup --watch
npm run typecheck    # tsc --noEmit (type-check only, no emit)
```

There are no tests, no linter, and no formatter configured.

## Architecture

```
src/
  index.ts            # Plugin entry point. Creates services, wires event handlers, exports TelegramPlugin.
  config.ts           # Loads config from ~/.config/opencode/notification-telegram.jsonc, .env, and env vars.
  logger.ts           # File-based logger. Writes to ~/.local/share/opencode-telegram/plugin.log. Auto-trims at 3MB.
  telegram-client.ts  # Telegram Bot API wrapper via Telegraf. sendText(), sendButtons(), sendDocument(). Handles inbound text, voice, and callback_query updates.
  session-state.ts    # In-memory state: session titles, pending permissions, active session ID, paused flag.
```

**Data flow:** OpenCode events → plugin handlers → Telegram messages out. Telegraf long-polling → inbound updates → forwarded to OpenCode session.

## Code Style

### Imports

- Separate `type` imports: `import type { X } from "..."` or `import { type X } from "..."`
- Node builtins use `node:` prefix: `import { resolve } from "node:path"`
- Local imports use `.js` extension: `import { X } from "./config.js"`
- External packages first, then local modules

### Formatting

- No formatter configured. Follow the existing style: 2-space indent, no trailing commas in single-line items.
- Keep lines under 100 characters where practical.
- No comments unless they explain non-obvious "why" (never "what").

### Types

- Strict TypeScript. `tsconfig.json` has `strict: true`.
- Prefer `interface` for object shapes, `type` for unions/aliases.
- Use `unknown` over `any`. Only use `any` when the opencode SDK types are incomplete (with an eslint-disable comment).
- Define local interfaces for external API shapes you work with (e.g. `MessageEntry`).

### Naming

- Classes: `PascalCase` (e.g. `TelegramService`, `SessionState`)
- Functions/methods: `camelCase` (e.g. `loadConfig`, `escapeHtml`)
- Constants: `UPPER_SNAKE_CASE` (e.g. `APPROVE_PREFIX`, `TELEGRAM_MAX_TEXT_LENGTH`)
- Type aliases: `PascalCase` (e.g. `Config`, `TelegramHandlers`)
- File names: `kebab-case` (e.g. `telegram-client.ts`, `session-state.ts`)

### Error Handling

- Wrap external calls in try/catch. Always log errors via the `log` object from `./logger.js`.
- Never use `console.log/warn/error`. All logging goes to `~/.local/share/opencode-telegram/plugin.log`.
- Log levels: `debug`, `info`, `warn`, `error`. Use `debug` for flow tracing, `info` for normal operations, `warn` for unexpected-but-recoverable, `error` for failures.
- Include structured `extra` data in log calls: `log.error("message", { error: String(error) })`.
- On fatal config errors during init, return a no-op plugin: `{ event: async () => {} }`.

### Async

- Use `async/await`, never raw `.then()`.
- Fire-and-forget with `void` operator: `void this.poll()`.

### Plugin-Specific Patterns

- The plugin receives OpenCode events via the `event` hook. Event data is untyped, so cast immediately: `event as unknown as { type: string; properties: Record<string, unknown> }`.
- Use `toNonEmptyString()` to safely extract strings from unknown event properties.
- Permission button IDs use prefixes (`approve:`, `always:`, `deny:`) to encode the action + permission ID.
- Telegraf handles inbound updates via long-polling — no custom poller needed. Only messages from the configured `recipientChatId` are processed.
- Messages are formatted with HTML parse mode (`<b>`, `<em>`, `<pre>`). Use `escapeHtml()` for user-controlled content.
- For long messages (>4096 chars), use `sendOrAttach()` which falls back to uploading a `.md` file via `sendDocument()`. Permission buttons always stay as text; the context is sent as a separate attachment.
- Voice messages are received via Telegraf's `voice` handler. Telegram does not provide built-in transcription, so `null` is passed to `onAudioMessage`.
- The `chat.message` hook intercepts `/telegram-pause` and `/telegram-resume` commands typed in the TUI. It clears `output.parts` to prevent them from reaching the LLM. The `SessionState` class tracks paused state, initialized from `config.enabled`.

## Configuration

Config is loaded from (in order of precedence, later overrides earlier):

1. `~/.config/opencode/notification-telegram.jsonc` (JSONC — supports comments, snake_case keys)
2. `.env` file in CWD
3. Environment variables (UPPER_SNAKE_CASE)

| Config key | Env var | Required | Default | Description |
|---|---|---|---|---|
| `bot_token` | `TELEGRAM_BOT_TOKEN` | Yes | - | Telegram bot token from @BotFather |
| `recipient_chat_id` | `TELEGRAM_RECIPIENT_CHAT_ID` | Yes | - | Telegram chat ID to send to |
| `enabled` | `TELEGRAM_ENABLED` | No | true | Start with notifications paused if false |

## Key Dependencies

- `telegraf` - Telegram Bot framework (bundled, not external)
- `@opencode-ai/plugin` - OpenCode plugin types (dev only, for `Plugin` type)
- `dotenv` - Load `.env` from CWD
- `jsonc-parser` - Parse JSONC config files
