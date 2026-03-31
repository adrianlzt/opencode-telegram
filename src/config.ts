import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { homedir } from "node:os";
import { parse as parseJsonc } from "jsonc-parser";

loadDotenv({ path: resolve(process.cwd(), ".env") });

export interface Config {
  botToken: string;
  recipientChatId: string;
  enabled: boolean;
}

interface ConfigFile {
  bot_token?: string;
  recipient_chat_id?: string;
  enabled?: boolean;
}

function loadConfigFile(): ConfigFile {
  const configPath = resolve(
    homedir(),
    ".config",
    "opencode",
    "notification-telegram.jsonc",
  );
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf8");
    const errors: import("jsonc-parser").ParseError[] = [];
    const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      throw new Error(errors.map((e) => `line ${e.offset}: ${JSON.stringify(e)}`).join("; "));
    }
    return parsed as ConfigFile;
  } catch (error) {
    throw new Error(
      `Failed to parse config file ${configPath}: ${(error as Error).message}`,
    );
  }
}

export function loadConfig(): Config {
  const file = loadConfigFile();

  const botToken = process.env.TELEGRAM_BOT_TOKEN || file.bot_token;
  const recipientChatId =
    process.env.TELEGRAM_RECIPIENT_CHAT_ID || file.recipient_chat_id;

  if (!botToken) {
    throw new Error(
      "Missing required config: TELEGRAM_BOT_TOKEN\n" +
        'Set it in ~/.config/opencode/notification-telegram.jsonc as "bot_token" or as env var\n' +
        "Get one at https://t.me/BotFather",
    );
  }

  if (!recipientChatId) {
    throw new Error(
      "Missing required config: TELEGRAM_RECIPIENT_CHAT_ID\n" +
        'Set it in ~/.config/opencode/notification-telegram.jsonc as "recipient_chat_id" or as env var',
    );
  }

  const envEnabled = process.env.TELEGRAM_ENABLED;
  const enabled = envEnabled !== undefined
    ? envEnabled === "true" || envEnabled === "1"
    : file.enabled !== false;

  return { botToken, recipientChatId, enabled };
}
