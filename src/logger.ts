import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".local", "share", "opencode-telegram");
const LOG_FILE = join(LOG_DIR, "plugin.log");
const MAX_SIZE = 3 * 1024 * 1024;
const KEEP_SIZE = 1024 * 1024;

function ensureDir() {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

function trimIfNeeded() {
  try {
    if (statSync(LOG_FILE).size > MAX_SIZE) {
      const tail = readFileSync(LOG_FILE, "utf8").slice(-KEEP_SIZE);
      const nl = tail.indexOf("\n");
      writeFileSync(LOG_FILE, nl >= 0 ? tail.slice(nl + 1) : tail);
    }
  } catch {}
}

function write(level: string, message: string, extra?: Record<string, unknown>) {
  ensureDir();
  trimIfNeeded();
  let line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  if (extra) line += " " + JSON.stringify(extra);
  appendFileSync(LOG_FILE, line + "\n");
}

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export const log: Logger = {
  debug: (message, extra) => write("debug", message, extra),
  info: (message, extra) => write("info", message, extra),
  warn: (message, extra) => write("warn", message, extra),
  error: (message, extra) => write("error", message, extra),
};
