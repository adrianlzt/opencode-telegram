import type { TelegramApi, InlineButton } from "./telegram.js";
import { ensureTopic } from "./topics.js";
import { escapeHtml } from "./commands.js";
import type { SessionState } from "./session-state.js";
import { getTopicBySession, insertPendingPermission, insertPendingQuestion, storeButtonToken } from "./db.js";
import { log } from "./logger.js";

const MAX_LEN = 4096;

const APPROVE_PREFIX = "approve:";
const ALWAYS_PREFIX = "always:";
const DENY_PREFIX = "deny:";
const QANS_PREFIX = "qans:";
const QCUSTOM_PREFIX = "qcustom:";

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength - 3) + "...";
}

let messageCounter = 0;
function nextFilename(): string {
  messageCounter++;
  return `opencode-${Date.now()}-${messageCounter}.md`;
}

export interface FlowClient {
  session: {
    messages(args: { path: { id: string } }): Promise<{ data?: any[] }>;
    prompt(args: { path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }): Promise<unknown>;
  };
  postSessionIdPermissionsPermissionId(args: {
    path: { id: string; permissionID: string };
    body: { response: string };
  }): Promise<unknown>;
  _client: {
    post(args: { url: string; body: unknown; headers: Record<string, string>; path: Record<string, string> }): Promise<unknown>;
  };
}

export interface ProjectContext {
  client: FlowClient;
  api: TelegramApi;
  state: SessionState;
  instanceId: string;
  projectName: string | null;
  isHost: boolean;
}

export async function getLastAssistantMessage(client: FlowClient, sessionId: string): Promise<string> {
  try {
    const result = await client.session.messages({ path: { id: sessionId } });
    const messages = result.data ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.info?.role === "assistant" && msg.parts) {
        const texts = msg.parts
          .filter((p: any) => p.type === "text" && p.text)
          .map((p: any) => p.text);
        if (texts.length > 0) return texts.join("\n\n");
      }
    }
  } catch (error) {
    log.error("Failed to fetch session messages", { error: String(error) });
  }
  return "";
}

function formatMessageParts(parts: any[]): string {
  return parts
    .map((p) => {
      if (p.type === "text" && p.text) return escapeHtml(p.text);
      if (p.type === "tool") {
        const name = p.tool ?? "unknown";
        let s = `<b>Tool: ${escapeHtml(name)}</b>\n`;
        if (p.input) {
          const input = typeof p.input === "string" ? p.input : JSON.stringify(p.input, null, 2);
          s += `<b>Input:</b>\n<pre>${escapeHtml(input)}</pre>\n`;
        }
        if (p.output) {
          const output = typeof p.output === "string" ? p.output : JSON.stringify(p.output);
          s += `<b>Output:</b>\n<pre>${escapeHtml(output.slice(0, 500))}</pre>\n`;
        }
        return s;
      }
      return null;
    })
    .filter(Boolean)
    .join("\n");
}

async function getRecentAssistantContext(client: FlowClient, sessionId: string, maxMessages = 3): Promise<string> {
  try {
    const result = await client.session.messages({ path: { id: sessionId } });
    const messages = result.data ?? [];
    const blocks: string[] = [];
    for (let i = messages.length - 1; i >= 0 && blocks.length < maxMessages; i--) {
      const msg = messages[i];
      if (msg?.info?.role === "assistant" && msg.parts) {
        const formatted = formatMessageParts(msg.parts);
        if (formatted.trim()) blocks.unshift(formatted);
      }
    }
    return blocks.join("\n\n---\n\n");
  } catch (error) {
    log.error("Failed to fetch assistant context", { error: String(error) });
  }
  return "";
}

async function replyToPermission(
  client: FlowClient,
  sessionId: string,
  permissionId: string,
  response: string,
): Promise<unknown> {
  return client.postSessionIdPermissionsPermissionId({
    path: { id: sessionId, permissionID: permissionId },
    body: { response },
  });
}

async function sendOrAttach(
  api: TelegramApi,
  text: string,
  sessionId: string,
  caption: string | undefined,
  threadId: number | null,
): Promise<void> {
  if (text.length <= MAX_LEN) {
    await api.sendText(text, threadId);
    return;
  }
  const summary = caption
    ? truncate(`${escapeHtml(caption)}\n\n<em>Message too long, sent as file.</em>`, MAX_LEN)
    : "<em>Message too long, sent as file.</em>";
  await api.sendText(summary, threadId);
  await api.sendDocument(nextFilename(), text, caption, threadId);
}

export function extractPermissionPrompt(properties: Record<string, any>): string {
  const lines: string[] = [];
  if (properties.permission) {
    lines.push(`<b>Permission:</b> ${escapeHtml(String(properties.permission))}`);
  }
  if (Array.isArray(properties.patterns) && properties.patterns.length > 0) {
    lines.push(`<b>Match:</b> ${properties.patterns.map(String).join(", ")}`);
  }
  if (Array.isArray(properties.always) && properties.always.length > 0) {
    lines.push(`<b>Always allow:</b> ${properties.always.map(String).join(", ")}`);
  }
  if (properties.metadata) {
    if (properties.metadata.filepath) {
      lines.push(`<b>File:</b> ${escapeHtml(String(properties.metadata.filepath))}`);
    }
    if (properties.metadata.diff) {
      lines.push(`<b>Diff:</b>\n<pre>${escapeHtml(String(properties.metadata.diff))}</pre>`);
    }
  }
  if (properties.prompt) lines.push(escapeHtml(String(properties.prompt)));
  if (properties.message) lines.push(escapeHtml(String(properties.message)));
  return lines.length > 0 ? lines.join("\n") : "A permission request needs your approval.";
}

export async function handleSessionIdle(ctx: ProjectContext, sessionId: string): Promise<void> {
  try {
    const { client, api, state, instanceId, projectName } = ctx;
    const title = state.getSessionTitle(sessionId) || "OpenCode Session";
    const threadId = await ensureTopic(api, { sessionId, title, projectName, instanceId });
    const lastMessage = await getLastAssistantMessage(client, sessionId);
    const prefix = projectName ? `[${escapeHtml(projectName)}] ` : "";
    if (lastMessage) {
      const full = `${prefix}<b>${escapeHtml(title)}</b>\n\n${lastMessage}\n\n<em>Reply to continue the session.</em>`;
      await sendOrAttach(api, full, sessionId, `${prefix}${title}`, threadId);
    } else {
      await api.sendText(
        `${prefix}<b>${escapeHtml(title)}</b>\n\nSession completed.\n\n<em>Reply to continue.</em>`,
        threadId,
      );
    }
    state.setActiveSession(sessionId);
  } catch (error) {
    log.error("Error handling session.idle", { error: String(error) });
  }
}

export async function handleSessionError(
  ctx: ProjectContext,
  sessionId: string,
  errorMessage: string,
): Promise<void> {
  try {
    const { api, state, instanceId, projectName } = ctx;
    const title = state.getSessionTitle(sessionId) || "OpenCode Session";
    const threadId = await ensureTopic(api, { sessionId, title, projectName, instanceId });
    const prefix = projectName ? `[${escapeHtml(projectName)}] ` : "";
    const message = truncate(
      `${prefix}<b>${escapeHtml(title)}</b>\n\n<b>Error:</b>\n${escapeHtml(errorMessage.slice(0, 500))}\n\n<em>Reply to continue the session.</em>`,
      MAX_LEN,
    );
    await api.sendText(message, threadId);
    state.setActiveSession(sessionId);
  } catch (error) {
    log.error("Error handling session.error", { error: String(error) });
  }
}

const PERMISSION_BUTTONS = (permissionId: string): InlineButton[] => [
  { id: `${APPROVE_PREFIX}${permissionId}`, title: "Allow once" },
  { id: `${ALWAYS_PREFIX}${permissionId}`, title: "Allow always" },
  { id: `${DENY_PREFIX}${permissionId}`, title: "Reject" },
];

export async function handlePermissionAsked(
  ctx: ProjectContext,
  sessionId: string,
  permissionId: string,
  properties: Record<string, any>,
): Promise<void> {
  try {
    const { client, api, state, instanceId, projectName, isHost } = ctx;
    const title = state.getSessionTitle(sessionId) || "OpenCode Session";
    const threadId = await ensureTopic(api, { sessionId, title, projectName, instanceId });
    const prompt = extractPermissionPrompt(properties);
    const prefix = projectName ? `[${escapeHtml(projectName)}] ` : "";
    const context = await getRecentAssistantContext(client, sessionId);
    const body = context
      ? `${prefix}<b>${escapeHtml(title)}</b>\n\n${context}\n\n<b>Permission request:</b>\n${prompt}`
      : `${prefix}<b>${escapeHtml(title)}</b>\n\n${prompt}`;
    if (body.length <= MAX_LEN - 100) {
      await api.sendButtons(body, PERMISSION_BUTTONS(permissionId), threadId);
    } else {
      const buttonBody = truncate(
        `${prefix}<b>${escapeHtml(title)}</b>\n\n<b>Permission request:</b>\n${prompt}\n\n<em>Full context sent as file.</em>`,
        MAX_LEN - 100,
      );
      await api.sendButtons(buttonBody, PERMISSION_BUTTONS(permissionId), threadId);
      await api.sendDocument(
        nextFilename(),
        body,
        `${prefix}${title} - Permission context`,
        threadId,
      );
    }
    state.addPendingPermission(permissionId, sessionId);
    if (!isHost) insertPendingPermission(instanceId, permissionId, sessionId);
  } catch (error) {
    log.error("Error handling permission.asked", { error: String(error) });
  }
}

export interface AskQuestion {
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiple?: boolean;
  custom?: boolean;
}

export async function handleQuestionAsked(
  ctx: ProjectContext,
  sessionId: string,
  requestID: string,
  questions: AskQuestion[],
): Promise<void> {
  try {
    const { api, state, instanceId, projectName, isHost } = ctx;
    state.setActiveSession(sessionId);
    state.addPendingQuestion(requestID, sessionId, questions);
    const title = state.getSessionTitle(sessionId) || "OpenCode Session";
    await ensureTopic(api, { sessionId, title, projectName, instanceId });
    await sendNextQuestion(ctx, requestID);
    if (!isHost) insertPendingQuestion(instanceId, requestID, sessionId, questions);
  } catch (error) {
    log.error("Error handling question.asked", { error: String(error) });
  }
}

async function sendNextQuestion(ctx: ProjectContext, requestID?: string): Promise<void> {
  const { api, state, instanceId, projectName, isHost } = ctx;
  const pq = state.getPendingQuestion(requestID);
  if (!pq) return;
  const topicRow = getTopicBySession(pq.sessionId);
  const threadId = topicRow?.thread_id ?? null;
  const q = pq.questions[pq.currentIndex];
  const title = state.getSessionTitle(pq.sessionId) || "OpenCode Session";
  const prefix = projectName ? `[${escapeHtml(projectName)}] ` : "";
  const progress =
    pq.questions.length > 1 ? `<em>Question ${pq.currentIndex + 1} of ${pq.questions.length}</em>\n\n` : "";
  const header = q.header ? `<b>${escapeHtml(q.header)}</b>\n` : "";

  if (q.options.length > 0 && q.multiple) {
    state.setIsMultiSelect(true, pq.requestID);
    const optionList = q.options
      .map((o, i) => `${i + 1}. <b>${escapeHtml(o.label)}</b> — ${escapeHtml(o.description ?? "")}`)
      .join("\n");
    const msg = truncate(
      `${prefix}<b>${escapeHtml(title)}</b>\n\n${progress}${header}${escapeHtml(q.question)}\n\n${optionList}\n\nReply with numbers separated by commas (e.g. "1, 3")${q.custom !== false ? ", or type a custom answer" : ""}.`,
      MAX_LEN,
    );
    await api.sendText(msg, threadId);
  } else if (q.options.length > 0) {
    const optionList = q.options
      .map((o, i) =>
        o.description
          ? `${i + 1}. <b>${escapeHtml(o.label)}</b>\n    ${escapeHtml(o.description)}`
          : `${i + 1}. <b>${escapeHtml(o.label)}</b>`,
      )
      .join("\n");
    const buttons = q.options.map((o) => {
      const token = state.registerButtonToken(pq.requestID, pq.currentIndex, o.label);
      if (!isHost) storeButtonToken(instanceId, token, pq.requestID, pq.currentIndex, o.label);
      return { id: `${QANS_PREFIX}${token}`, title: truncate(o.label, 64) };
    });
    if (q.custom !== false) {
      const token = state.registerButtonToken(pq.requestID, pq.currentIndex, "");
      if (!isHost) storeButtonToken(instanceId, token, pq.requestID, pq.currentIndex, "");
      buttons.push({ id: `${QCUSTOM_PREFIX}${token}`, title: "Type your answer..." });
    }
    const body = truncate(
      `${prefix}<b>${escapeHtml(title)}</b>\n\n${progress}${header}${escapeHtml(q.question)}\n\n${optionList}`,
      MAX_LEN - 100,
    );
    await api.sendButtons(body, buttons, threadId);
  } else {
    const msg = truncate(
      `${prefix}<b>${escapeHtml(title)}</b>\n\n${progress}${header}${escapeHtml(q.question)}\n\n<em>Reply to answer.</em>`,
      MAX_LEN,
    );
    await api.sendText(msg, threadId);
  }
}

export async function handleQuestionAnswer(
  ctx: ProjectContext,
  questionIndex: number,
  answer: string[],
  requestID: string,
): Promise<void> {
  const { client, api, state, instanceId } = ctx;
  const pq = state.getPendingQuestion(requestID);
  if (!pq) {
    log.warn("No pending question found for requestID", { requestID });
    return;
  }
  state.recordAnswer(answer, requestID);
  log.info("Question answer recorded", { questionIndex, answer, requestID: pq.requestID });
  if (state.advanceQuestion(requestID)) {
    await sendNextQuestion(ctx, requestID);
    return;
  }
  const result = state.consumePendingQuestion(requestID);
  if (!result) return;
  try {
    await client._client.post({
      url: `/question/${result.requestID}/reply`,
      body: { answers: result.answers },
      headers: { "Content-Type": "application/json" },
      path: { requestID: result.requestID },
    });
    log.info("Question answers submitted", { sessionId: result.sessionId, answers: result.answers });
    const topicRow = getTopicBySession(result.sessionId);
    await api.sendText("Answers submitted.", topicRow?.thread_id ?? null);
  } catch (error) {
    log.error("Failed to submit question answers", { error: String(error) });
  }
}

export {
  replyToPermission,
  APPROVE_PREFIX,
  ALWAYS_PREFIX,
  DENY_PREFIX,
  QANS_PREFIX,
  QCUSTOM_PREFIX,
};
