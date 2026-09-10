import type { TelegramApi } from "./telegram.js";
import { ensureTopic } from "./topics.js";
import { escapeHtml } from "./commands.js";
import type { CmdClient, SessionLike } from "./commands.js";
import type { Logger } from "./logger.js";

interface OpsPayload {
  sessionId?: string;
  threadId?: number | null;
}

function parsePayload(payload: unknown): OpsPayload | null {
  const p = payload as OpsPayload;
  if (!p || typeof p.sessionId !== "string") return null;
  return { sessionId: p.sessionId, threadId: typeof p.threadId === "number" ? p.threadId : null };
}

async function createdSessionReply(
  client: CmdClient,
  api: TelegramApi,
  instanceId: string,
  projectName: string | null,
  sessionId: string,
  fallbackTitle: string,
  threadId: number | null,
): Promise<void> {
  let title = fallbackTitle;
  try {
    const res = await client.session.get({ path: { id: sessionId } });
    title = res.data?.title ?? title;
  } catch {}
  const thread = await ensureTopic(api, { sessionId, title, projectName, instanceId });
  const text = `New session: <b>${escapeHtml(title)}</b> <code>${escapeHtml(sessionId)}</code>${
    thread ? "\nChat with it in this new topic." : ""
  }`;
  await api.sendText(text, thread ?? threadId);
}

export async function applyForkAction(
  client: CmdClient,
  api: TelegramApi,
  instanceId: string,
  projectName: string | null,
  payload: unknown,
  log: Logger,
): Promise<void> {
  const p = parsePayload(payload);
  if (!p) {
    log.warn("Invalid fork payload", { payload: JSON.stringify(payload) });
    return;
  }
  const sessionId = p.sessionId ?? "";
  const threadId = p.threadId ?? null;
  try {
    const res = await client.session.fork({ path: { id: sessionId }, body: {} });
    const s: SessionLike | undefined = res.data;
    if (!s?.id) throw new Error("fork returned no session");
    log.info("Relayed fork applied", { sessionId, forkedTo: s.id });
    await createdSessionReply(client, api, instanceId, projectName, s.id, "Forked session", threadId);
  } catch (error) {
    log.error("Relayed fork failed", { error: String(error), sessionId });
    await api.sendText(`❌ Fork failed: ${escapeHtml(String(error))}`, threadId);
  }
}

async function lastUserMessageId(client: CmdClient, sessionId: string): Promise<string | null> {
  const res = await client.session.messages({ path: { id: sessionId } });
  const msgs = res.data ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (msg?.info?.role === "user" && typeof msg.info?.id === "string") return msg.info.id;
  }
  return null;
}

export async function applyUndoAction(
  client: CmdClient,
  api: TelegramApi,
  payload: unknown,
  log: Logger,
): Promise<void> {
  const p = parsePayload(payload);
  if (!p) {
    log.warn("Invalid undo payload", { payload: JSON.stringify(payload) });
    return;
  }
  try {
    const messageID = await lastUserMessageId(client, p.sessionId!);
    if (!messageID) {
      await api.sendText("Nothing to undo — no user messages in this session.", p.threadId);
      return;
    }
    await client.session.revert({ path: { id: p.sessionId! }, body: { messageID } });
    log.info("Relayed undo applied", { sessionId: p.sessionId, messageID });
    await api.sendText("↩️ Last exchange reverted.", p.threadId);
  } catch (error) {
    log.error("Relayed undo failed", { error: String(error), sessionId: p.sessionId });
    await api.sendText(`❌ Undo failed: ${escapeHtml(String(error))}`, p.threadId);
  }
}

export async function applyCompactAction(
  client: CmdClient,
  api: TelegramApi,
  payload: unknown,
  log: Logger,
): Promise<void> {
  const p = parsePayload(payload);
  if (!p) {
    log.warn("Invalid compact payload", { payload: JSON.stringify(payload) });
    return;
  }
  try {
    const res = (await client._client.post({
      url: `/api/session/${p.sessionId}/compact`,
      body: {},
      headers: { "Content-Type": "application/json" },
    })) as { response?: { ok?: boolean; status?: number; text?: () => Promise<string> } } | undefined;
    const response = res?.response;
    if (response && response.ok === false) {
      let detail = `HTTP ${response.status ?? "?"}`;
      try {
        if (response.text) detail = (await response.text()).slice(0, 300);
      } catch {}
      throw new Error(detail);
    }
    log.info("Relayed compact applied", { sessionId: p.sessionId });
    await api.sendText("🧹 Compaction requested for this session.", p.threadId);
  } catch (error) {
    log.error("Relayed compact failed", { error: String(error), sessionId: p.sessionId });
    await api.sendText(`❌ Compact failed: ${escapeHtml(String(error))}`, p.threadId);
  }
}
