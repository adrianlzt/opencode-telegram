import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export interface Config {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

function stripJsonc(src: string): string {
  let out = "";
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// mimo is an opencode fork: same config layout under ~/.config/mimocode, but we
// can only tell which app hosts this plugin via its own binary name.
const isMimo = process.execPath.includes("mimo");
const CONFIG_DIRS = isMimo ? ["mimocode", "opencode"] : ["opencode", "mimocode"];

export function loadConfig(): Config {
  let file: Record<string, unknown> = {};
  const dir = CONFIG_DIRS.find((d) =>
    existsSync(resolve(homedir(), ".config", d, "notification-telegram.jsonc")),
  );
  const path = resolve(homedir(), ".config", dir ?? CONFIG_DIRS[0], "notification-telegram.jsonc");
  if (existsSync(path)) {
    try {
      file = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
    } catch (error) {
      throw new Error(`Failed to parse ${path}: ${(error as Error).message}`);
    }
  }
  const botToken = process.env.TELEGRAM_BOT_TOKEN || (file.bot_token as string | undefined);
  const chatId =
    process.env.TELEGRAM_RECIPIENT_CHAT_ID || (file.recipient_chat_id as string | undefined);
  if (!botToken) {
    throw new Error(
      'Missing TELEGRAM_BOT_TOKEN. Set it as env var or "bot_token" in ~/.config/{mimocode,opencode}/notification-telegram.jsonc',
    );
  }
  if (!chatId) {
    throw new Error(
      'Missing TELEGRAM_RECIPIENT_CHAT_ID. Set it as env var or "recipient_chat_id" in ~/.config/{mimocode,opencode}/notification-telegram.jsonc (the forum supergroup id, e.g. -1001234567890)',
    );
  }
  const envEnabled = process.env.TELEGRAM_ENABLED;
  const enabled =
    envEnabled !== undefined ? envEnabled === "true" || envEnabled === "1" : file.enabled !== false;
  return { botToken, chatId, enabled };
}
