import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig, type Config } from "./config.js";
import { TelegramService } from "./telegram-client.js";
import { SessionState } from "./session-state.js";
import { log } from "./logger.js";

const TELEGRAM_MAX_TEXT_LENGTH = 4096;
const APPROVE_PREFIX = "approve:";
const ALWAYS_PREFIX = "always:";
const DENY_PREFIX = "deny:";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

let messageCounter = 0;
function nextFilename(): string {
  messageCounter++;
  return `opencode-${Date.now()}-${messageCounter}.md`;
}

async function sendOrAttach(
  telegram: TelegramService,
  text: string,
  caption?: string,
): Promise<void> {
  if (text.length <= TELEGRAM_MAX_TEXT_LENGTH) {
    await telegram.sendText(text);
  } else {
    const summary = caption
      ? truncate(`${escapeHtml(caption)}\n\n<em>Message too long, sent as file.</em>`, TELEGRAM_MAX_TEXT_LENGTH)
      : truncate("<em>Message too long, sent as file.</em>", TELEGRAM_MAX_TEXT_LENGTH);
    await telegram.sendText(summary);
    await telegram.sendDocument(nextFilename(), text, caption);
  }
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function getProjectContext(directory: string | undefined): string {
  if (!directory) return "";
  const parts = directory.split("/");
  return parts[parts.length - 1] || directory;
}

function extractPermissionPrompt(properties: Record<string, unknown>): string {
  const lines: string[] = [];

  const permission = toNonEmptyString(properties.permission);
  if (permission) {
    lines.push(`<b>Permission:</b> ${escapeHtml(permission)}`);
  }

  const patterns = properties.patterns;
  if (Array.isArray(patterns) && patterns.length > 0) {
    lines.push(`<b>Match:</b> ${patterns.map(String).join(", ")}`);
  }

  const always = properties.always;
  if (Array.isArray(always) && always.length > 0) {
    lines.push(`<b>Always allow:</b> ${always.map(String).join(", ")}`);
  }

  const metadata = properties.metadata as Record<string, unknown> | undefined;
  if (metadata) {
    const filepath = toNonEmptyString(metadata.filepath);
    if (filepath) {
      lines.push(`<b>File:</b> ${escapeHtml(filepath)}`);
    }

    const diff = toNonEmptyString(metadata.diff);
    if (diff) {
      lines.push(`<b>Diff:</b>\n<pre>${escapeHtml(diff)}</pre>`);
    }
  }

  const prompt = toNonEmptyString(properties.prompt);
  if (prompt) {
    lines.push(escapeHtml(prompt));
  }

  const message = toNonEmptyString(properties.message);
  if (message) {
    lines.push(escapeHtml(message));
  }

  return lines.length > 0 ? lines.join("\n") : "A permission request needs your approval.";
}

type PluginInput = Parameters<Plugin>[0];

interface MessagePart {
  type: string;
  text?: string;
}

interface MessageEntry {
  info?: { role?: string };
  parts?: MessagePart[];
}

async function getLastAssistantMessage(
  client: PluginInput["client"],
  sessionId: string,
): Promise<string> {
  try {
    const result = await client.session.messages({
      path: { id: sessionId },
    });

    const messages: MessageEntry[] = (result as { data?: MessageEntry[] }).data ?? [];

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.info?.role === "assistant" && msg.parts) {
        const textParts = msg.parts
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text!);
        if (textParts.length > 0) {
          return textParts.join("\n\n");
        }
      }
    }
  } catch (error) {
    log.error("Failed to fetch session messages", { error: String(error) });
  }

  return "";
}

function formatMessageParts(parts: MessagePart[]): string {
  return parts
    .map((p) => {
      if (p.type === "text" && p.text) return p.text;
      if (p.type === "tool") {
        const tool = (p as unknown as Record<string, unknown>);
        const name = tool.tool as string | undefined;
        const input = tool.input;
        const output = tool.output;
        let s = `<b>Tool: ${escapeHtml(name || "unknown")}</b>\n`;
        if (input) s += `<b>Input:</b>\n<pre>${typeof input === "string" ? escapeHtml(input) : escapeHtml(JSON.stringify(input, null, 2))}</pre>\n`;
        if (output) {
          const outputStr = typeof output === "string" ? output : JSON.stringify(output);
          s += `<b>Output:</b>\n<pre>${escapeHtml(outputStr.slice(0, 500))}</pre>\n`;
        }
        return s;
      }
      return null;
    })
    .filter(Boolean)
    .join("\n");
}

async function getRecentAssistantContext(
  client: PluginInput["client"],
  sessionId: string,
  maxMessages: number = 3,
): Promise<string> {
  try {
    const result = await client.session.messages({
      path: { id: sessionId },
    });

    const messages: MessageEntry[] = (result as { data?: MessageEntry[] }).data ?? [];
    const assistantBlocks: string[] = [];

    for (let i = messages.length - 1; i >= 0 && assistantBlocks.length < maxMessages; i--) {
      const msg = messages[i];
      if (msg.info?.role === "assistant" && msg.parts) {
        log.debug(`Assistant message parts`, {
          parts: msg.parts.map((p) => {
            const entry: Record<string, unknown> = { type: p.type };
            if (p.type === "tool") {
              entry.keys = Object.keys((p as unknown as Record<string, unknown>));
            }
            return entry;
          }),
        });
        const formatted = formatMessageParts(msg.parts);
        if (formatted.trim()) {
          assistantBlocks.unshift(formatted);
        }
      }
    }

    return assistantBlocks.join("\n\n---\n\n");
  } catch (error) {
    log.error("Failed to fetch assistant context", { error: String(error) });
  }

  return "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function replyToPermission(
  client: any,
  sessionId: string,
  permissionId: string,
  response: "once" | "always" | "reject",
): Promise<boolean> {
  log.debug(`replyToPermission call`, { sessionId, permissionId, response });
  const result = await client.postSessionIdPermissionsPermissionId({
    path: { id: sessionId, permissionID: permissionId },
    body: { response },
  });
  log.debug(`replyToPermission result`, { result: JSON.stringify(result) });
  return result as boolean;
}

export const TelegramPlugin: Plugin = async (ctx) => {
  const { client, directory } = ctx;
  const instanceId = Math.random().toString(36).slice(2, 8);

  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    log.error("Configuration error", { error: (error as Error).message });
    return {
      event: async () => {},
    };
  }

  log.info(`Plugin initialization started [instance=${instanceId}]`);

  const state = new SessionState(config.enabled);
  const projectName = getProjectContext(directory);

  const telegram = new TelegramService(config, {
    onButtonReply: async (buttonId: string) => {
      if (buttonId.startsWith(ALWAYS_PREFIX)) {
        const permissionId = buttonId.slice(ALWAYS_PREFIX.length);
        const perm = state.consumePendingPermission(permissionId);
        if (perm) {
          try {
            await replyToPermission(client, perm.sessionId, permissionId, "always");
            log.info(`Permission ${permissionId} always approved`, { sessionId: perm.sessionId });
            await telegram.sendText("Permission approved (always).");
          } catch (error) {
            log.error("Failed to always approve permission", { error: String(error) });
          }
        } else {
          log.warn(`No pending permission found for ID: ${permissionId}`);
        }
      } else if (buttonId.startsWith(APPROVE_PREFIX)) {
        const permissionId = buttonId.slice(APPROVE_PREFIX.length);
        const perm = state.consumePendingPermission(permissionId);
        if (perm) {
          try {
            await replyToPermission(client, perm.sessionId, permissionId, "once");
            log.info(`Permission ${permissionId} approved once`, { sessionId: perm.sessionId });
            await telegram.sendText("Permission approved.");
          } catch (error) {
            log.error("Failed to approve permission", { error: String(error) });
          }
        } else {
          log.warn(`No pending permission found for ID: ${permissionId}`);
        }
      } else if (buttonId.startsWith(DENY_PREFIX)) {
        const permissionId = buttonId.slice(DENY_PREFIX.length);
        const perm = state.consumePendingPermission(permissionId);
        if (perm) {
          try {
            await replyToPermission(client, perm.sessionId, permissionId, "reject");
            log.info(`Permission ${permissionId} rejected`, { sessionId: perm.sessionId });
            await telegram.sendText("Permission rejected.");
          } catch (error) {
            log.error("Failed to reject permission", { error: String(error) });
          }
        }
      }
    },

    onTextMessage: async (text: string) => {
      const activeSession = state.getActiveSession();
      if (activeSession) {
        try {
          log.info(`Forwarding message to session ${activeSession}`);
          await client.session.prompt({
            path: { id: activeSession },
            body: {
              parts: [{ type: "text", text }],
            },
          });
        } catch (error) {
          log.error("Failed to send message to session", { error: String(error) });
        }
      } else {
        log.info("No active session to forward message to");
      }
    },

    onAudioMessage: async (transcription: string | null) => {
      const activeSession = state.getActiveSession();
      if (!activeSession) {
        log.info("No active session to forward audio message to");
        return;
      }

      const text = transcription
        ? `[Voice message transcription]: ${transcription}`
        : "The user sent a voice message but transcription was not available.";

      try {
        log.info(`Forwarding audio transcription to session ${activeSession}`);
        await client.session.prompt({
          path: { id: activeSession },
          body: {
            parts: [{ type: "text", text }],
          },
        });
      } catch (error) {
        log.error("Failed to send audio transcription to session", { error: String(error) });
      }
    },
  });

  telegram.start();

  let isShuttingDown = false;
  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    telegram.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return {
    "command.execute.before": async (input: { command: string; sessionID: string }, output: { parts?: unknown[] }) => {
      if (input.command !== "telegram-pause" && input.command !== "telegram-resume") return;

      if (input.command === "telegram-pause") {
        if (state.pause()) {
          log.info("Telegram notifications paused via /telegram-pause");
        } else {
          log.info("/telegram-pause called but already paused");
        }
      } else {
        if (state.resume()) {
          log.info("Telegram notifications resumed via /telegram-resume");
        } else {
          log.info("/telegram-resume called but already active");
        }
      }

      if (output.parts) output.parts = [];
      throw new Error("Command handled by Telegram plugin");
    },

    "chat.message": async (_input, output) => {
      return;
    },

    event: async ({ event }) => {
      const runtimeEvent = event as unknown as {
        type: string;
        properties: Record<string, unknown>;
      };

      const { type, properties } = runtimeEvent;
      log.debug(`Event received [instance=${instanceId}]`, { type, sessionID: properties?.sessionID });

      switch (type) {
        case "session.updated": {
          const info = properties?.info as Record<string, unknown> | undefined;
          const title = info ? toNonEmptyString(info.title) : null;
          const sessionId = toNonEmptyString(
            info ? (info.id ?? properties?.sessionID) : properties?.sessionID,
          );
          if (title && sessionId) {
            state.setSessionTitle(sessionId, title);
          }
          break;
        }

        case "session.idle": {
          if (state.isPaused()) break;
          const sessionId = toNonEmptyString(properties.sessionID);
          if (sessionId) {
            await handleSessionIdle(
              client,
              telegram,
              state,
              sessionId,
              projectName,
            );
          }
          break;
        }

        case "session.error": {
          if (state.isPaused()) break;
          const sessionId = toNonEmptyString(properties.sessionID);
          const error = properties.error;
          const errorMessage =
            typeof error === "string"
              ? error
              : error
                ? String(error)
                : "Unknown error";

          if (sessionId) {
            await handleSessionError(
              telegram,
              state,
              sessionId,
              errorMessage,
              projectName,
            );
          }
          break;
        }

        case "permission.asked": {
          if (state.isPaused()) break;
          const permissionId = toNonEmptyString(properties.id);
          const sessionId = toNonEmptyString(properties.sessionID);

          log.debug("permission.asked event", { properties: JSON.stringify(properties) });

          if (permissionId && sessionId) {
            await handlePermissionAsked(
              client,
              telegram,
              state,
              sessionId,
              permissionId,
              properties,
              projectName,
            );
          }
          break;
        }

        case "question.asked": {
          if (state.isPaused()) break;
          const sessionId = toNonEmptyString(properties.sessionID);
          const questions = properties.questions;

          if (sessionId && Array.isArray(questions) && questions.length > 0) {
            await handleQuestionAsked(
              telegram,
              state,
              sessionId,
              questions as Array<{ question?: string; header?: string }>,
              projectName,
            );
          }
          break;
        }
      }
    },

    config: async (output: Record<string, unknown>) => {
      if (!output.command) output.command = {};
      const cmd = output.command as Record<string, Record<string, string>>;
      cmd["telegram-pause"] = {
        template: "Pause Telegram notifications",
        description: "Pause all Telegram notifications",
      };
      cmd["telegram-resume"] = {
        template: "Resume Telegram notifications",
        description: "Resume Telegram notifications",
      };
    },
  };
};

async function handleSessionIdle(
  client: PluginInput["client"],
  telegram: TelegramService,
  state: SessionState,
  sessionId: string,
  projectName: string,
): Promise<void> {
  try {
    const title = state.getSessionTitle(sessionId) || "OpenCode Session";
    const lastMessage = await getLastAssistantMessage(client, sessionId);

    const projectPrefix = projectName ? `[${escapeHtml(projectName)}] ` : "";

    if (lastMessage) {
      const fullMessage = `${projectPrefix}<b>${escapeHtml(title)}</b>\n\n${lastMessage}\n\n<em>Reply to continue the session.</em>`;
      await sendOrAttach(telegram, fullMessage, `${projectPrefix}${title}`);
    } else {
      await telegram.sendText(
        `${projectPrefix}<b>${escapeHtml(title)}</b>\n\nSession completed.\n\n<em>Reply to continue.</em>`,
      );
    }

    state.setActiveSession(sessionId);
  } catch (error) {
    log.error("Error handling session.idle", { error: String(error) });
  }
}

async function handleSessionError(
  telegram: TelegramService,
  state: SessionState,
  sessionId: string,
  errorMessage: string,
  projectName: string,
): Promise<void> {
  try {
    const title = state.getSessionTitle(sessionId) || "OpenCode Session";
    const projectPrefix = projectName ? `[${escapeHtml(projectName)}] ` : "";

    const message = truncate(
      `${projectPrefix}<b>${escapeHtml(title)}</b>\n\n<b>Error:</b>\n${escapeHtml(errorMessage.slice(0, 500))}\n\n<em>Reply to continue the session.</em>`,
      TELEGRAM_MAX_TEXT_LENGTH,
    );

    await telegram.sendText(message);
    state.setActiveSession(sessionId);
  } catch (error) {
    log.error("Error handling session.error", { error: String(error) });
  }
}

async function handlePermissionAsked(
  client: PluginInput["client"],
  telegram: TelegramService,
  state: SessionState,
  sessionId: string,
  permissionId: string,
  properties: Record<string, unknown>,
  projectName: string,
): Promise<void> {
  try {
    const title = state.getSessionTitle(sessionId) || "OpenCode Session";
    const prompt = extractPermissionPrompt(properties);
    const projectPrefix = projectName ? `[${escapeHtml(projectName)}] ` : "";

    const context = await getRecentAssistantContext(client, sessionId);

    let body: string;
    if (context) {
      body = `${projectPrefix}<b>${escapeHtml(title)}</b>\n\n${context}\n\n<b>Permission request:</b>\n${prompt}`;
    } else {
      body = `${projectPrefix}<b>${escapeHtml(title)}</b>\n\n${prompt}`;
    }

    if (body.length <= TELEGRAM_MAX_TEXT_LENGTH - 100) {
      await telegram.sendButtons(body, [
        { id: `${APPROVE_PREFIX}${permissionId}`, title: "Allow once" },
        { id: `${ALWAYS_PREFIX}${permissionId}`, title: "Allow always" },
        { id: `${DENY_PREFIX}${permissionId}`, title: "Reject" },
      ]);
    } else {
      const buttonBody = truncate(
        `${projectPrefix}<b>${escapeHtml(title)}</b>\n\n<b>Permission request:</b>\n${prompt}\n\n<em>Full context sent as file.</em>`,
        TELEGRAM_MAX_TEXT_LENGTH - 100,
      );
      await telegram.sendButtons(buttonBody, [
        { id: `${APPROVE_PREFIX}${permissionId}`, title: "Allow once" },
        { id: `${ALWAYS_PREFIX}${permissionId}`, title: "Allow always" },
        { id: `${DENY_PREFIX}${permissionId}`, title: "Reject" },
      ]);
      await telegram.sendDocument(nextFilename(), body, `${projectPrefix}${title} - Permission context`);
    }

    state.addPendingPermission(permissionId, sessionId);
  } catch (error) {
    log.error("Error handling permission.asked", { error: String(error) });
  }
}

async function handleQuestionAsked(
  telegram: TelegramService,
  state: SessionState,
  sessionId: string,
  questions: Array<{ question?: string; header?: string }>,
  projectName: string,
): Promise<void> {
  try {
    const title = state.getSessionTitle(sessionId) || "OpenCode Session";
    const projectPrefix = projectName ? `[${escapeHtml(projectName)}] ` : "";

    const questionText = questions
      .map((q, i) => {
        const header = q.header ? `${escapeHtml(q.header)}: ` : "";
        return `${i + 1}. ${header}${escapeHtml(q.question || "(empty question)")}`;
      })
      .join("\n");

    const message = truncate(
      `${projectPrefix}<b>${escapeHtml(title)}</b>\n\n<b>Questions:</b>\n${questionText}\n\n<em>Reply to answer.</em>`,
      TELEGRAM_MAX_TEXT_LENGTH,
    );

    await telegram.sendText(message);
    state.setActiveSession(sessionId);
  } catch (error) {
    log.error("Error handling question.asked", { error: String(error) });
  }
}

export default {
  id: "telegram",
  server: TelegramPlugin,
}
