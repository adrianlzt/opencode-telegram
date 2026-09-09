import { readFileSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import {
  openDb,
  closeDb,
  cleanupExpired,
  cleanupDeadInstances,
  upsertInstanceSession,
  removeInstanceSession,
  getInstanceSessions,
  getSessionByThreadId,
  getTopicBySession,
  getSharedQuestionBySession,
  getSharedPermission,
  deletePendingQuestion,
  deletePendingPermission,
  insertQuestionAnswer,
  insertPermissionResult,
  insertForwardedText,
  pollQuestionAnswers,
  pollPermissionResults,
  pollForwardedTexts,
  pollPendingCustom,
  resolveSharedButtonToken,
  insertPendingCustom,
  setTopicClosed,
  setTopicTitle,
  setTopicInstance,
  touchInstanceSession,
  getSessionById,
  isPidAlive,
} from "./db.js";
import { TelegramApi, Poller } from "./telegram.js";
import { SessionState } from "./session-state.js";
import { handleCommand } from "./commands.js";
import {
  handleSessionIdle,
  handleSessionError,
  handlePermissionAsked,
  handleQuestionAsked,
  handleQuestionAnswer,
  replyToPermission,
  APPROVE_PREFIX,
  ALWAYS_PREFIX,
  DENY_PREFIX,
  QANS_PREFIX,
  QCUSTOM_PREFIX,
  type ProjectContext,
} from "./flows.js";

const LOCK_PATH = join(tmpdir(), "opencode-telegram.lock");

function tryBecomeHost(instanceId: string): boolean {
  if (existsSync(LOCK_PATH)) {
    try {
      const raw = readFileSync(LOCK_PATH, "utf8").trim();
      const pid = parseInt(raw.split(":")[0], 10);
      if (!isNaN(pid) && isPidAlive(pid)) {
        log.info(`[${instanceId}] Host already running (pid=${pid})`);
        return false;
      }
      log.info(`[${instanceId}] Stale lock (pid=${pid}), taking over`);
    } catch {}
    try {
      unlinkSync(LOCK_PATH);
    } catch {}
  }
  try {
    writeFileSync(LOCK_PATH, `${process.pid}:${instanceId}`, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function getProjectContext(directory: string | undefined): string | null {
  if (!directory) return null;
  return directory.split("/").pop() || directory;
}

function isInstanceAlive(targetInstanceId: string): boolean {
  const rows = getInstanceSessions().filter((i: any) => i.instance_id === targetInstanceId);
  return rows.length > 0 && isPidAlive(Number(rows[0].pid));
}

function resolveLiveOwner(sessionId: string): string | null {
  cleanupDeadInstances();
  const live = getInstanceSessions().filter((i: any) => isPidAlive(i.pid));
  const active = live.find((i: any) => i.session_id === sessionId);
  if (active) return active.instance_id as string;
  const dir = toNonEmptyString(getSessionById(sessionId)?.directory);
  if (dir) {
    const match = live.find((i: any) => i.directory === dir);
    if (match) return match.instance_id as string;
  }
  return null;
}

const TelegramPlugin = async (ctx: { client: any; directory: string }) => {
  const { client, directory } = ctx;
  const instanceId = Math.random().toString(36).slice(2, 8);

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    log.error("Configuration error", { error: (error as Error).message });
    return { event: async () => {} };
  }

  log.info(`Plugin init [instance=${instanceId}]`);
  try {
    openDb();
  } catch (error) {
    log.warn(`[${instanceId}] State DB unavailable, cross-instance relay disabled`, {
      error: String(error),
    });
  }

  const state = new SessionState(config.enabled);
  const projectName = getProjectContext(directory);
  const api = new TelegramApi(config.botToken, config.chatId);
  let isHost = tryBecomeHost(instanceId);
  if (isHost) log.info(`[${instanceId}] Became host (direct polling)`);

  const flow: ProjectContext = { client, api, state, instanceId, projectName, isHost };

  upsertInstanceSession(instanceId, null, null, null, projectName, directory);

  const poller = new Poller(api, {
    onText: async (text, threadId) => {
      if (isHost && text.startsWith("/")) {
        const handled = await handleCommand(api, instanceId, text, threadId, log);
        if (handled) return;
      }
      if (threadId == null) {
        await api.sendText("This bot operates in forum topics. Open a session topic to chat.");
        return;
      }
      const topic = getSessionByThreadId(threadId);
      if (!topic) {
        await api.sendText("No opencode session is bound to this topic.", threadId);
        return;
      }
      const sessionId = topic.session_id as string;
      if (topic.closed) {
        await api.sendText("This session is archived. Use /resume <slug> to reopen it.", threadId);
        return;
      }

      const localQ = state.getPendingQuestionBySession(sessionId);
      if (localQ) {
        await answerPendingQuestion(flow, localQ, text, threadId);
        return;
      }
      const sharedQ = getSharedQuestionBySession(sessionId);
      if (sharedQ) {
        deletePendingQuestion(sharedQ.requestID);
        insertQuestionAnswer(sharedQ.instanceId, sharedQ.requestID, [[text]]);
        log.info(`[${instanceId}] Relayed text answer to [instance=${sharedQ.instanceId}]`, {
          requestID: sharedQ.requestID,
          sessionId,
        });
        return;
      }

      let targetInstanceId = topic.instance_id as string;
      if (targetInstanceId !== instanceId && !isInstanceAlive(targetInstanceId)) {
        const resolved = resolveLiveOwner(sessionId);
        if (!resolved) {
          await api.sendText(
            "No live opencode instance owns this session. Start opencode for that project and try again.",
            threadId,
          );
          return;
        }
        setTopicInstance(sessionId, resolved);
        log.info(`[${instanceId}] Rebound session ${sessionId} to [instance=${resolved}]`);
        targetInstanceId = resolved;
      }
      if (targetInstanceId === instanceId) {
        await promptSession(client, sessionId, text);
      } else {
        log.info(`[${instanceId}] Forwarding text to [instance=${targetInstanceId}]`, { sessionId });
        insertForwardedText(targetInstanceId, sessionId, text);
      }
    },
    onButton: async (buttonId, threadId) => {
      if (buttonId.startsWith(QANS_PREFIX)) {
        const token = buttonId.slice(QANS_PREFIX.length);
        const local = state.resolveButtonToken(token);
        if (local) {
          await handleQuestionAnswer(flow, local.questionIndex, [local.label], local.requestID);
        } else if (isHost) {
          const shared = resolveSharedButtonToken(token);
          if (shared) {
            insertQuestionAnswer(shared.instanceId, shared.requestID, [[shared.label]]);
            log.info(`[${instanceId}] Relayed button answer to [instance=${shared.instanceId}]`, {
              requestID: shared.requestID,
            });
          } else {
            log.warn(`[${instanceId}] Unknown button token: ${token}`);
          }
        }
        return;
      }
      if (buttonId.startsWith(QCUSTOM_PREFIX)) {
        const token = buttonId.slice(QCUSTOM_PREFIX.length);
        const local = state.resolveButtonToken(token);
        if (local) {
          state.setAwaitingCustom(true, local.requestID);
          await api.sendText("Type your answer:", threadId);
        } else if (isHost) {
          const shared = resolveSharedButtonToken(token);
          if (shared) {
            insertPendingCustom(shared.instanceId, shared.requestID);
            log.info(`[${instanceId}] Relayed custom-answer request to [instance=${shared.instanceId}]`, {
              requestID: shared.requestID,
            });
          }
        }
        return;
      }

      let permissionId: string | null = null;
      let response: string | null = null;
      if (buttonId.startsWith(APPROVE_PREFIX)) {
        permissionId = buttonId.slice(APPROVE_PREFIX.length);
        response = "once";
      } else if (buttonId.startsWith(ALWAYS_PREFIX)) {
        permissionId = buttonId.slice(ALWAYS_PREFIX.length);
        response = "always";
      } else if (buttonId.startsWith(DENY_PREFIX)) {
        permissionId = buttonId.slice(DENY_PREFIX.length);
        response = "reject";
      }
      if (!permissionId || !response) return;

      const perm = state.consumePendingPermission(permissionId);
      if (perm) {
        try {
          await replyToPermission(client, perm.sessionId, permissionId, response);
          log.info(`[${instanceId}] Permission ${permissionId} ${response}`, { sessionId: perm.sessionId });
          await api.sendText(`Permission ${response === "reject" ? "rejected" : "approved"}.`, threadId);
        } catch (error) {
          log.error(`[${instanceId}] Failed to apply permission`, { error: String(error) });
        }
      } else if (isHost) {
        const shared = getSharedPermission(permissionId);
        if (shared) {
          deletePendingPermission(permissionId);
          insertPermissionResult(shared.instanceId, permissionId, response);
          log.info(`[${instanceId}] Relayed permission ${response} to [instance=${shared.instanceId}]`, {
            permissionId,
          });
        } else {
          log.warn(`[${instanceId}] No pending permission for ID: ${permissionId}`);
        }
      } else {
        log.warn(`[${instanceId}] No pending permission for ID: ${permissionId}`);
      }
    },
    onVoice: async (threadId) => {
      if (threadId == null) return;
      const topic = getSessionByThreadId(threadId);
      if (!topic || topic.closed) return;
      const text = "The user sent a voice message but transcription was not available.";
      const sessionId = topic.session_id as string;
      let targetInstanceId = topic.instance_id as string;
      if (targetInstanceId !== instanceId && !isInstanceAlive(targetInstanceId)) {
        const resolved = resolveLiveOwner(sessionId);
        if (!resolved) {
          await api.sendText("No live opencode instance owns this session.", threadId);
          return;
        }
        setTopicInstance(sessionId, resolved);
        targetInstanceId = resolved;
      }
      if (targetInstanceId === instanceId) {
        await promptSession(client, sessionId, text);
      } else {
        insertForwardedText(targetInstanceId, sessionId, text);
      }
    },
  });

  if (isHost) poller.start();

  const cleanupInterval = setInterval(() => {
    cleanupExpired();
    cleanupDeadInstances();
  }, 60_000);

  let pollCounter = 0;
  const relayInterval = setInterval(async () => {
    pollCounter++;
    if (pollCounter % 60 === 0) touchInstanceSession(instanceId);
    if (pollCounter % 10 === 0 && !isHost) {
      try {
        const raw = readFileSync(LOCK_PATH, "utf8").trim();
        const hostPid = parseInt(raw.split(":")[0], 10);
        if (!isNaN(hostPid) && !isPidAlive(hostPid)) {
          log.info(`[${instanceId}] Host pid=${hostPid} is dead, attempting takeover`);
          if (tryBecomeHost(instanceId)) {
            isHost = true;
            flow.isHost = true;
            log.info(`[${instanceId}] Promoted to host`);
            poller.start();
          }
        }
      } catch {}
    }
    if (isHost) return;

    for (const { requestID, answers } of pollQuestionAnswers(instanceId)) {
      log.info(`[${instanceId}] Polled question answer`, { requestID, answer: answers[0] });
      const pq = state.getPendingQuestion(requestID);
      if (!pq) {
        log.warn(`[${instanceId}] No local pending question for polled answer`, { requestID });
        continue;
      }
      await handleQuestionAnswer(flow, pq.currentIndex, answers[0], requestID);
    }
    for (const { permissionId, response } of pollPermissionResults(instanceId)) {
      log.info(`[${instanceId}] Polled permission result`, { permissionId, response });
      const perm = state.consumePendingPermission(permissionId);
      if (!perm) continue;
      try {
        await replyToPermission(client, perm.sessionId, permissionId, response);
        log.info(`[${instanceId}] Permission ${permissionId} ${response}`, { sessionId: perm.sessionId });
        const topicRow = getTopicBySession(perm.sessionId);
        await api.sendText(
          `Permission ${response === "reject" ? "rejected" : "approved"}.`,
          topicRow?.thread_id ?? null,
        );
      } catch (error) {
        log.error(`[${instanceId}] Failed to process permission result`, { error: String(error) });
      }
    }
    for (const requestID of pollPendingCustom(instanceId)) {
      state.setAwaitingCustom(true, requestID);
      const pq = state.getPendingQuestion(requestID);
      if (pq) {
        const topicRow = getTopicBySession(pq.sessionId);
        await api.sendText("Type your answer:", topicRow?.thread_id ?? null);
      }
    }
    for (const { sessionId, text } of pollForwardedTexts(instanceId)) {
      log.info(`[${instanceId}] Received forwarded text`, { sessionId });
      state.setActiveSession(sessionId);
      await promptSession(client, sessionId, text);
    }
  }, 500);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(cleanupInterval);
    clearInterval(relayInterval);
    removeInstanceSession(instanceId);
    if (isHost) {
      poller.stop();
      try {
        unlinkSync(LOCK_PATH);
      } catch {}
    }
    closeDb();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return {
    "command.execute.before": async (input: { command: string }, output: { parts?: unknown[] }) => {
      if (input.command !== "telegram-pause" && input.command !== "telegram-resume") return;
      if (input.command === "telegram-pause") {
        log.info(state.pause() ? "Notifications paused via /telegram-pause" : "Already paused");
      } else {
        log.info(state.resume() ? "Notifications resumed via /telegram-resume" : "Already active");
      }
      if (output.parts) output.parts = [];
      throw new Error("Command handled by Telegram plugin");
    },
    event: async ({ event }: { event: { type: string; properties: Record<string, any> } }) => {
      const { type, properties } = event;
      switch (type) {
        case "session.updated": {
          const info = properties?.info;
          const title = info ? toNonEmptyString(info.title) : null;
          const sessionId = toNonEmptyString(info ? info.id ?? properties?.sessionID : properties?.sessionID);
          if (title && sessionId) state.setSessionTitle(sessionId, title);
          if (sessionId && info) {
            upsertInstanceSession(
              instanceId,
              sessionId,
              toNonEmptyString(info.slug),
              title,
              projectName,
              toNonEmptyString(info.directory),
            );
            const existing = getTopicBySession(sessionId);
            if (existing && existing.instance_id !== instanceId) setTopicInstance(sessionId, instanceId);
          }
          if (title && sessionId) {
            const existing = getTopicBySession(sessionId);
            if (existing && existing.instance_id === instanceId && existing.title !== title) {
              setTopicTitle(sessionId, title);
              const name = title && projectName ? `${projectName} — ${title}` : title;
              void api.renameTopic(existing.thread_id, name);
            }
          }
          break;
        }
        case "session.idle": {
          if (state.isPaused()) break;
          const sessionId = toNonEmptyString(properties?.sessionID);
          if (!sessionId) break;
          const title = state.getSessionTitle(sessionId);
          upsertInstanceSession(
            instanceId,
            sessionId,
            title ? title.toLowerCase().replace(/\s+/g, "-") : null,
            title,
            projectName,
            directory,
          );
          await handleSessionIdle(flow, sessionId);
          break;
        }
        case "session.error": {
          if (state.isPaused()) break;
          const sessionId = toNonEmptyString(properties?.sessionID);
          if (!sessionId) break;
          const error = properties?.error;
          const errorMessage =
            typeof error === "string" ? error : error ? String(error) : "Unknown error";
          upsertInstanceSession(
            instanceId,
            sessionId,
            null,
            state.getSessionTitle(sessionId),
            projectName,
            directory,
          );
          await handleSessionError(flow, sessionId, errorMessage);
          break;
        }
        case "permission.asked": {
          if (state.isPaused()) break;
          const permissionId = toNonEmptyString(properties?.id);
          const sessionId = toNonEmptyString(properties?.sessionID);
          if (!permissionId || !sessionId) break;
          upsertInstanceSession(
            instanceId,
            sessionId,
            null,
            state.getSessionTitle(sessionId),
            projectName,
            directory,
          );
          await handlePermissionAsked(flow, sessionId, permissionId, properties);
          break;
        }
        case "question.asked": {
          if (state.isPaused()) break;
          const sessionId = toNonEmptyString(properties?.sessionID);
          const requestID = toNonEmptyString(properties?.id);
          const questions = properties?.questions;
          if (!sessionId || !requestID || !Array.isArray(questions) || questions.length === 0) break;
          upsertInstanceSession(
            instanceId,
            sessionId,
            null,
            state.getSessionTitle(sessionId),
            projectName,
            directory,
          );
          await handleQuestionAsked(flow, sessionId, requestID, questions);
          break;
        }
      }
    },
    config: async (output: Record<string, any>) => {
      if (!output.command) output.command = {};
      output.command["telegram-pause"] = {
        template: "Pause Telegram notifications",
        description: "Pause all Telegram notifications",
      };
      output.command["telegram-resume"] = {
        template: "Resume Telegram notifications",
        description: "Resume all Telegram notifications",
      };
    },
  };
};

async function promptSession(
  client: { session: { prompt(args: { path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }): Promise<unknown> } },
  sessionId: string,
  text: string,
): Promise<void> {
  try {
    await client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text }] },
    });
  } catch (error) {
    log.error("Failed to prompt session", { error: String(error), sessionId });
  }
}

async function answerPendingQuestion(
  flow: ProjectContext,
  pq: NonNullable<ReturnType<SessionState["getPendingQuestionBySession"]>>,
  text: string,
  threadId: number | null,
): Promise<void> {
  const { api } = flow;
  const q = pq.questions[pq.currentIndex];
  if (pq.awaitingCustom) {
    await handleQuestionAnswer(flow, pq.currentIndex, [text], pq.requestID);
    return;
  }
  if (pq.isMultiSelect) {
    const indices = text
      .split(/[\s,]+/)
      .map((s) => parseInt(s, 10) - 1)
      .filter((n) => !isNaN(n) && n >= 0 && n < q.options.length);
    if (indices.length === 0) {
      await api.sendText('Invalid selection. Please enter numbers separated by commas, e.g. "1, 3".', threadId);
      return;
    }
    await handleQuestionAnswer(
      flow,
      pq.currentIndex,
      indices.map((i) => q.options[i].label),
      pq.requestID,
    );
    return;
  }
  const matched = q.options.find((o) => o.label.toLowerCase() === text.trim().toLowerCase());
  if (matched) {
    await handleQuestionAnswer(flow, pq.currentIndex, [matched.label], pq.requestID);
  } else if (q.custom !== false) {
    await handleQuestionAnswer(flow, pq.currentIndex, [text], pq.requestID);
  } else {
    await api.sendText("Please select one of the options using the buttons above.", threadId);
  }
}

const index_default = { id: "telegram", server: TelegramPlugin };
export { TelegramPlugin, index_default as default };
