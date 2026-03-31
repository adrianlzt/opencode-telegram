import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_DIR = join(homedir(), ".local", "share", "opencode-telegram");
const LOG_FILE = join(LOG_DIR, "plugin.log");
const MAX_SIZE = 3 * 1024 * 1024;
const KEEP_SIZE = 1024 * 1024;

function ensureDir(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // already exists
  }
}

function trimIfNeeded(): void {
  try {
    const stats = statSync(LOG_FILE);
    if (stats.size > MAX_SIZE) {
      const content = readFileSync(LOG_FILE, "utf8");
      const trimmed = content.slice(-KEEP_SIZE);
      const firstNewline = trimmed.indexOf("\n");
      writeFileSync(
        LOG_FILE,
        firstNewline >= 0 ? trimmed.slice(firstNewline + 1) : trimmed,
      );
    }
  } catch {
    // file may not exist yet
  }
}

function write(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
  ensureDir();
  trimIfNeeded();

  const timestamp = new Date().toISOString();
  let line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (extra) {
    line += " " + JSON.stringify(extra);
  }
  appendFileSync(LOG_FILE, line + "\n");
}

export const log = {
  debug(message: string, extra?: Record<string, unknown>): void {
    write("debug", message, extra);
  },
  info(message: string, extra?: Record<string, unknown>): void {
    write("info", message, extra);
  },
  warn(message: string, extra?: Record<string, unknown>): void {
    write("warn", message, extra);
  },
  error(message: string, extra?: Record<string, unknown>): void {
    write("error", message, extra);
  },
};
