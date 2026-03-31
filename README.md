# opencode-telegram

OpenCode plugin to interact with the AI agent via Telegram.

## What it does

The plugin listens to OpenCode events and forwards them to your Telegram:

| Event | Behavior |
|---|---|
| `permission.asked` | Sends the permission details with context (diff, file, tool info) and three inline buttons: Allow once, Allow always, Reject. |
| `session.idle` | Sends the last assistant message. Reply to continue the session. |
| `session.error` | Sends the error message. Reply to continue the session. |
| `question.asked` | Sends the questions. Reply to provide answers. |

Only messages from the configured `recipientChatId` are processed.

### Long messages

If a message exceeds Telegram's text limit (4096 characters), the full content is sent as a `.md` file attachment instead. A summary text message is sent alongside it.

### Voice messages

You can send voice notes to the bot. Telegram does not provide built-in transcription, so the agent receives a fallback message indicating a voice message was sent but could not be transcribed.

## Prerequisites

- [OpenCode](https://opencode.ai/) installed
- A Telegram bot (create one via [@BotFather](https://t.me/BotFather))
- Your bot token and the chat ID to send notifications to

## Installation

### Option 1: npm (recommended)

1. Install dependencies and build:

```bash
cd opencode-telegram
npm install
npm run build
```

2. Add to your OpenCode config (`opencode.json` or `~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["opencode-telegram"]
}
```

### Option 2: Local file

1. Build the plugin:

```bash
cd opencode-telegram
npm install
npm run build
```

2. Copy the built file to your plugin directory:

```bash
cp dist/index.js ~/.config/opencode/plugins/telegram.js
```

3. Create `~/.config/opencode/package.json` with the required dependency:

```json
{
  "dependencies": {
    "telegraf": "^4.16.3"
  }
}
```

OpenCode will load plugins from `~/.config/opencode/plugins/` automatically.

## Configuration

Configuration can be set via a JSON config file, environment variables, or a `.env` file. Environment variables take precedence over the config file.

### Config file (recommended)

Create `~/.config/opencode/notification-telegram.jsonc`:

```jsonc
{
  "bot_token": "your_bot_token",
  "recipient_chat_id": "145264105",
  // "enabled": true
}
```

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | - | Telegram bot token from @BotFather |
| `TELEGRAM_RECIPIENT_CHAT_ID` | Yes | - | Telegram chat ID to send notifications to |
| `TELEGRAM_ENABLED` | No | `true` | Set to `false` to start with notifications paused |

### .env file

Alternatively, create a `.env` file in your project root:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_RECIPIENT_CHAT_ID=145264105
# TELEGRAM_ENABLED=true
```

### Finding your chat ID

Send any message to your bot on Telegram, then visit:
```
https://api.telegram.org/bot<TOKEN>/getUpdates
```
Your chat ID is the `chat.id` field in the response.

## Pausing / Resuming

The plugin can be toggled at runtime without restarting OpenCode.

### Config default

Set `"enabled": false` in `notification-telegram.jsonc` (or `TELEGRAM_ENABLED=false` as env var) to start with notifications paused.

### Runtime toggle

Type these commands in the OpenCode TUI:

- `/telegram-pause` — suppress all Telegram notifications
- `/telegram-resume` — re-enable Telegram notifications

These commands are intercepted by the plugin and never reach the LLM.

## How It Works

The plugin uses Telegraf's long-polling to receive inbound messages. No public URL or webhook setup needed.

```
OpenCode Agent
    |
    |-- session.idle --> Send last message to Telegram
    |-- session.error --> Send error to Telegram
    |-- permission.asked --> Send context + buttons to Telegram
    |-- question.asked --> Send questions to Telegram
    |
    v
Your Telegram (chat with the bot)
    |
    |-- Send text --> Forwarded as new prompt to active session
    |-- Send voice note --> Fallback message sent to agent
    |-- Click "Allow once" --> Approve permission for this request
    |-- Click "Allow always" --> Approve permission for this session
    |-- Click "Reject" --> Deny the permission
    |
    v
OpenCode Agent continues
```

## Logs

The plugin writes logs to `~/.local/share/opencode-telegram/plugin.log`. Check there for debugging.

## Troubleshooting

### Plugin doesn't load

- Check that your config file or env vars are set correctly
- Check the log file for configuration error messages
- Ensure `telegraf` is installed

### Messages not received

- Check the log file for error messages
- Verify your bot token is correct: `https://api.telegram.org/bot<TOKEN>/getMe`
- Ensure the recipient chat ID matches your chat with the bot
- Only messages from the configured `recipientChatId` are processed

### Permission buttons don't work

- Check the log file for "No pending permission found" warnings
- This can happen if the permission expired before you clicked the button
- Permissions have a timeout; if the agent moved on, the button is stale

## License

MIT
