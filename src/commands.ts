import {
  archiveSession,
  cleanupDeadInstances,
  countMessages,
  getLatestActivity,
  getTodoCounts,
  getInstanceSessions,
  getSessionBySlug,
  getSessionById,
  getSessionByThreadId,
  getTopicBySession,
  insertRelayAction,
  isInstanceAlive,
  isPidAlive,
  listArchivedSessions,
  listSessions,
  listTodos,
  resolveLiveOwner,
  resumeSession,
  setTopicClosed,
  setTopicInstance,
} from "./db.js";
import { ensureTopic } from "./topics.js";
import type { Logger } from "./logger.js";
import type { TelegramApi } from "./telegram.js";
import { cmdModel, type ModelClient } from "./menus.js";
import { applyCompactAction, applyForkAction, applyUndoAction } from "./ops.js";

const MAX_LEN = 4096;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength - 3) + "...";
}

function timeAgo(epochMs: number): string {
  const seconds = Math.floor((Date.now() - epochMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatModel(raw: string | null): string {
  if (!raw) return "unknown";
  try {
    const parsed = JSON.parse(raw);
    return parsed?.id?.split("/").slice(-2).join("/") ?? raw;
  } catch {
    return raw;
  }
}

function dirToProject(dir: string): string {
  return dir.split("/").pop() || dir;
}

function sessionLine(s: any): string {
  const project = dirToProject(s.directory ?? "");
  const model = formatModel(s.model);
  const updated = timeAgo(Number(s.time_updated));
  const title = truncate(s.title ?? "", 50);
  return `<code>${escapeHtml(s.slug)}</code>  <b>${escapeHtml(title)}</b>
    ${escapeHtml(project)} · ${escapeHtml(model)} · ${updated} ago`;
}

function todoLine(t: any): string {
  const icon = t.status === "in_progress" ? "🔄" : "⬜";
  return `${icon} ${escapeHtml(t.content)} [${escapeHtml(t.priority)}]`;
}

export interface SessionLike {
  id: string;
  title?: string | null;
}

export interface CmdClient {
  session: {
    get(args: { path: { id: string } }): Promise<{
      data?: { title?: string | null; model?: { providerID?: string; id?: string } | null } | null;
    }>;
    messages(args: { path: { id: string } }): Promise<{ data?: any[] }>;
    create(args: { body?: Record<string, unknown> }): Promise<{ data?: SessionLike }>;
    fork(args: { path: { id: string }; body?: { messageID?: string } }): Promise<{ data?: SessionLike }>;
    revert(args: { path: { id: string }; body: { messageID: string } }): Promise<{ data?: SessionLike }>;
  };
  provider: {
    list(): Promise<{
      data?: {
        all?: Array<{ id: string; name?: string; models?: Record<string, unknown> }>;
        default?: Record<string, string>;
        connected?: string[];
      } | null;
    }>;
  };
  app: {
    agents(): Promise<{
      data?: Array<{ id?: string; name?: string; mode?: string; description?: string; hidden?: boolean }> | null;
    }>;
  };
  mcp: {
    status(): Promise<{ data?: Record<string, { status?: string; error?: string }> | null }>;
  };
  _client: {
    post(args: { url: string; body: unknown; headers: Record<string, string> }): Promise<unknown>;
    get(args: { url: string }): Promise<unknown>;
  };
}

function resolveOwner(topic: any, instanceId: string): string | null {
  const owner = topic.instance_id as string;
  if (owner === instanceId) return owner;
  if (isInstanceAlive(owner)) return owner;
  const resolved = resolveLiveOwner(topic.session_id as string);
  if (!resolved) return null;
  setTopicInstance(topic.session_id as string, resolved);
  return resolved;
}

function requireSessionTopic(api: TelegramApi, threadId: number | null, hint: string): any | null {
  if (threadId == null) {
    void api.sendText(hint, null);
    return null;
  }
  const topic = getSessionByThreadId(threadId);
  if (!topic) {
    void api.sendText("No opencode session is bound to this topic.", threadId);
    return null;
  }
  return topic;
}

export async function handleCommand(
  api: TelegramApi,
  instanceId: string,
  command: string,
  threadId: number | null,
  log: Logger,
  client: CmdClient,
  projectName: string | null = null,
): Promise<boolean> {
  const trimmed = command.trim();
  if (!trimmed.startsWith("/")) return false;
  const spaceIdx = trimmed.indexOf(" ");
  const cmd = (spaceIdx > 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1)).toLowerCase();
  const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : "";
  log.info("Command received", { cmd, args, threadId });
  switch (cmd) {
    case "help":
      await cmdHelp(api, threadId);
      return true;
    case "status":
      await cmdStatus(api, instanceId, threadId);
      return true;
    case "todos":
      await cmdTodos(api, args, threadId);
      return true;
    case "sessions":
      await cmdSessions(api, args, threadId);
      return true;
    case "session":
      await cmdSession(api, args, threadId);
      return true;
    case "peek":
      await cmdPeek(api, args, threadId);
      return true;
    case "archive":
      await cmdArchive(api, args, threadId);
      return true;
    case "resume":
      await cmdResume(api, args, threadId);
      return true;
    case "model":
    case "models":
      await cmdModel(client, api, instanceId, args, threadId, log);
      return true;
    case "new":
      await cmdNew(client, api, instanceId, projectName, threadId, log);
      return true;
    case "fork":
      await cmdFork(client, api, instanceId, projectName, threadId, log);
      return true;
    case "compact":
      await cmdCompact(client, api, instanceId, threadId, log);
      return true;
    case "undo":
      await cmdUndo(client, api, instanceId, threadId, log);
      return true;
    case "agents":
      await cmdAgents(client, api, threadId, log);
      return true;
    case "mcps":
      await cmdMcps(client, api, threadId, log);
      return true;
    case "skills":
      await cmdSkills(client, api, threadId, log);
      return true;
    default:
      return false;
  }
}

const HELP_LINES: Array<[string, string]> = [
  ["/help", "show this command list"],
  ["/status", "connected instances, todo and session counts"],
  ["/todos [filter] [--all]", "pending todos (all sessions)"],
  ["/sessions [--project p] [--limit n]", "recent sessions"],
  ["/session <slug>", "session details"],
  ["/peek [slug]", "live status: thoughts, running tool, output"],
  ["/model [provider/model]", "list or switch the session model"],
  ["/new", "start a new session for this project"],
  ["/fork", "fork the current session"],
  ["/undo", "revert the last exchange"],
  ["/compact", "compact the session context"],
  ["/agents", "list available agents"],
  ["/mcps", "list MCP servers and their status"],
  ["/skills", "list available skills"],
  ["/archive <slug> | --list", "archive a session (closes its topic)"],
  ["/resume <slug>", "reopen an archived session"],
];

async function cmdHelp(api: TelegramApi, threadId: number | null) {
  let msg = "<b>Commands</b>\n";
  for (const [cmd, desc] of HELP_LINES) {
    const line = `\n${escapeHtml(cmd)} — ${escapeHtml(desc)}`;
    if (msg.length + line.length >= MAX_LEN - 100) {
      msg += "\n<em>...</em>";
      break;
    }
    msg += line;
  }
  msg += "\n\n<em>Any other message is sent to the session as a prompt. Unarchived topics map 1:1 to opencode sessions.</em>";
  await api.sendText(msg, threadId);
}

async function cmdStatus(api: TelegramApi, instanceId: string, threadId: number | null) {
  cleanupDeadInstances();
  const live = getInstanceSessions().filter((i: any) => isPidAlive(i.pid));
  const counts = getTodoCounts();
  const sessionCount = listSessions({ limit: 10000 }).length;
  let msg = "<b>OpenCode Status</b>\n\n";
  if (live.length === 0) {
    msg += "<b>Instances:</b> 0 connected\n";
  } else {
    msg += `<b>Instances (${live.length}):</b>\n`;
    for (const inst of live as any[]) {
      const hostLabel = inst.instance_id === instanceId ? " [HOST]" : "";
      const sessionInfo = inst.session_slug
        ? ` → <code>${escapeHtml(inst.session_slug)}</code> ${inst.session_title ? truncate(escapeHtml(inst.session_title), 40) : ""}`
        : " → idle";
      msg += `  pid=${inst.pid} ${inst.instance_id}${hostLabel}${sessionInfo}\n`;
    }
  }
  msg += `\n<b>Todos:</b> ${counts.total} total · ${counts.pending} pending · ${counts.in_progress} in progress · ${counts.completed} completed · ${counts.cancelled} cancelled`;
  msg += `\n<b>Sessions:</b> ${sessionCount} active`;
  await api.sendText(msg, threadId);
}

async function cmdTodos(api: TelegramApi, args: string, threadId: number | null) {
  let showAll = false;
  let filter = "";
  for (const a of args.split(/\s+/).filter(Boolean)) {
    if (a === "--all") showAll = true;
    else filter = a;
  }
  const statuses = showAll
    ? ["pending", "in_progress", "completed", "cancelled"]
    : ["pending", "in_progress"];
  const todos = listTodos({ statuses, filter: filter || undefined, limit: 30 });
  const counts = getTodoCounts();
  if (todos.length === 0) {
    const scope = filter ? `filter "${filter}"` : "all sessions";
    await api.sendText(`No ${showAll ? "" : "pending "}todos found (${scope}).`, threadId);
    return;
  }
  let msg = `<b>Todos</b> · ${counts.pending} pending · ${counts.in_progress} in progress`;
  if (filter) msg += ` · filter: ${escapeHtml(filter)}`;
  if (showAll) msg += ` · showing all`;
  msg += "\n";
  const grouped = new Map<string, any[]>();
  for (const t of todos as any[]) {
    if (!grouped.has(t.session_slug)) grouped.set(t.session_slug, []);
    grouped.get(t.session_slug)!.push(t);
  }
  let truncatedOut = false;
  for (const [slug, items] of grouped) {
    const first = items[0];
    const header = `\n<b>${escapeHtml(first.session_title)}</b> <code>${escapeHtml(slug)}</code> [${escapeHtml(first.project_name ?? "")}]`;
    if ((msg + header).length >= MAX_LEN - 100) {
      msg += "\n\n<em>... and more. Use /session &lt;slug&gt; for details.</em>";
      truncatedOut = true;
      break;
    }
    msg += header;
    for (const t of items) {
      const line = "\n  " + todoLine(t);
      if ((msg + line).length >= MAX_LEN - 100) {
        msg += `\n  <em>... and ${items.length - items.indexOf(t)} more</em>`;
        truncatedOut = true;
        break;
      }
      msg += line;
    }
    if (truncatedOut) break;
  }
  if ((todos as any[]).length === 30 && !truncatedOut) {
    msg += "\n\n<em>Showing first 30. Use /todos &lt;filter&gt; to narrow.</em>";
  }
  await api.sendText(msg, threadId);
}

async function cmdSessions(api: TelegramApi, args: string, threadId: number | null) {
  let projectName = "";
  let limit = 10;
  const parts = args.split(/\s+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "--project" && parts[i + 1]) {
      projectName = parts[i + 1];
      i++;
    } else if (parts[i] === "--limit" && parts[i + 1]) {
      limit = parseInt(parts[i + 1], 10) || 10;
      i++;
    }
  }
  const sessions = listSessions({ limit, projectName: projectName || undefined });
  const allSessions = listSessions({ limit: 10000, projectName: projectName || undefined });
  if (sessions.length === 0) {
    await api.sendText("No sessions found.", threadId);
    return;
  }
  let msg = `<b>Sessions</b> · ${allSessions.length} total`;
  if (projectName) msg += ` · project: ${escapeHtml(projectName)}`;
  msg += "\n";
  for (const s of sessions) {
    const line = "\n" + sessionLine(s);
    if ((msg + line).length >= MAX_LEN - 100) {
      msg += "\n\n<em>... and more. Use /sessions --limit 20 or --project to narrow.</em>";
      break;
    }
    msg += line;
  }
  await api.sendText(msg, threadId);
}

async function cmdSession(api: TelegramApi, args: string, threadId: number | null) {
  const slug = args.split(/\s+/)[0];
  if (!slug) {
    await api.sendText("Usage: /session &lt;slug&gt;", threadId);
    return;
  }
  const s = getSessionBySlug(slug) ?? getSessionById(slug);
  if (!s) {
    await api.sendText(`Session not found: ${escapeHtml(slug)}`, threadId);
    return;
  }
  const model = formatModel(s.model);
  const created = new Date(Number(s.time_created)).toISOString().replace("T", " ").slice(0, 19);
  const updated = new Date(Number(s.time_updated)).toISOString().replace("T", " ").slice(0, 19);
  const msgCount = countMessages(s.id);
  const project = dirToProject(s.directory ?? "");
  let msg = `<b>${escapeHtml(s.title)}</b>\n`;
  msg += `<code>${escapeHtml(s.slug)}</code>\n\n`;
  msg += `<b>Project:</b> ${escapeHtml(project)}\n`;
  msg += `<b>Directory:</b> ${escapeHtml(s.directory)}\n`;
  msg += `<b>Model:</b> ${escapeHtml(model)}\n`;
  msg += `<b>Messages:</b> ${msgCount}\n`;
  msg += `<b>Created:</b> ${created}\n`;
  msg += `<b>Updated:</b> ${updated}`;
  if (s.summary_additions || s.summary_deletions || s.summary_files) {
    msg += `\n\n<b>Changes:</b> +${s.summary_additions}/-${s.summary_deletions} lines · ${s.summary_files} files`;
  }
  const todos = listTodos({ sessionId: s.id, limit: 10 });
  if (todos.length > 0) {
    msg += "\n\n<b>Todos:</b>";
    for (const t of todos) {
      const line = "\n  " + todoLine(t);
      if ((msg + line).length >= MAX_LEN - 100) {
        msg += "\n  <em>... and more</em>";
        break;
      }
      msg += line;
    }
  }
  if (s.time_archived) {
    msg += `\n\n<b>Archived:</b> ${new Date(Number(s.time_archived)).toISOString().replace("T", " ").slice(0, 19)}`;
  }
  await api.sendText(msg, threadId);
}

async function cmdPeek(api: TelegramApi, args: string, threadId: number | null) {
  let sessionId: string;
  let title: string;
  let project: string;
  const slug = args.split(/\s+/)[0];
  if (slug) {
    const s = getSessionBySlug(slug) ?? getSessionById(slug);
    if (!s) {
      await api.sendText(`Session not found: ${escapeHtml(slug)}`, threadId);
      return;
    }
    sessionId = s.id;
    title = s.title;
    project = dirToProject(s.directory ?? "");
  } else {
    const topic = threadId == null ? null : getSessionByThreadId(threadId);
    if (!topic) {
      await api.sendText(
        "No opencode session is bound to this topic. Use /peek &lt;slug&gt;.",
        threadId,
      );
      return;
    }
    sessionId = topic.session_id as string;
    title = topic.title || "OpenCode Session";
    const s = getSessionById(sessionId);
    project = s ? dirToProject(s.directory ?? "") : "";
  }
  const activity = getLatestActivity(sessionId);
  if (!activity) {
    await api.sendText("No assistant activity found in this session yet.", threadId);
    return;
  }
  let msg = `${project ? `[${escapeHtml(project)}] ` : ""}<b>${escapeHtml(title)}</b>\n`;
  msg += activity.lastActivityAt
    ? `⏱ last activity ${timeAgo(activity.lastActivityAt)} ago\n`
    : "\n";
  if (activity.thoughts) {
    msg += `\n💭 <i>${escapeHtml(truncate(activity.thoughts.trim(), 600))}</i>\n`;
  }
  if (activity.tool) {
    const input = truncate(activity.tool.input.replace(/\s+/g, " ").trim(), 200);
    msg += `\n🔧 <b>Tool:</b> ${escapeHtml(activity.tool.name)} <em>(${escapeHtml(activity.tool.status)})</em>`;
    if (input) msg += `\n<code>${escapeHtml(input)}</code>`;
    const output = activity.tool.output.trim();
    if (output) {
      const tail = output.length > 500 ? "…" + output.slice(-499) : output;
      msg += `\n📤 <pre>${escapeHtml(tail)}</pre>`;
    }
    msg += "\n";
  }
  if (activity.text) {
    msg += `\n📝 ${escapeHtml(truncate(activity.text.trim(), 600))}`;
  }
  await api.sendText(truncate(msg, MAX_LEN), threadId);
}

async function cmdArchive(api: TelegramApi, args: string, threadId: number | null) {
  if (args === "--list") {
    const archived = listArchivedSessions(20);
    if (archived.length === 0) {
      await api.sendText("No archived sessions.", threadId);
      return;
    }
    let msg = `<b>Archived Sessions</b> (${archived.length})\n`;
    for (const s of archived) {
      const line = "\n" + sessionLine(s);
      if ((msg + line).length >= MAX_LEN - 100) {
        msg += "\n\n<em>... and more</em>";
        break;
      }
      msg += line;
    }
    await api.sendText(msg, threadId);
    return;
  }
  const slug = args.split(/\s+/)[0];
  if (!slug) {
    await api.sendText("Usage: /archive &lt;slug&gt; or /archive --list", threadId);
    return;
  }
  const s = getSessionBySlug(slug);
  if (!s) {
    await api.sendText(`Session not found: ${escapeHtml(slug)}`, threadId);
    return;
  }
  if (s.time_archived) {
    await api.sendText(`Already archived: ${escapeHtml(s.slug)}`, threadId);
    return;
  }
  if (archiveSession(slug)) {
    const topic = getTopicBySession(s.id);
    if (topic && !topic.closed) {
      setTopicClosed(s.id, true);
      void api.closeTopic(topic.thread_id);
    }
    await api.sendText(
      `Archived: <b>${escapeHtml(s.title)}</b> <code>${escapeHtml(s.slug)}</code>`,
      threadId,
    );
  } else {
    await api.sendText(`Failed to archive: ${escapeHtml(slug)}`, threadId);
  }
}

async function cmdResume(api: TelegramApi, args: string, threadId: number | null) {
  const slug = args.split(/\s+/)[0];
  if (!slug) {
    await api.sendText("Usage: /resume &lt;slug&gt;", threadId);
    return;
  }
  const s = getSessionBySlug(slug);
  if (!s) {
    await api.sendText(`Session not found: ${escapeHtml(slug)}`, threadId);
    return;
  }
  if (!s.time_archived) {
    await api.sendText(`Not archived: ${escapeHtml(s.slug)}`, threadId);
    return;
  }
  if (resumeSession(slug)) {
    const topic = getTopicBySession(s.id);
    if (topic && topic.closed) {
      setTopicClosed(s.id, false);
      void api.reopenTopic(topic.thread_id);
    }
    await api.sendText(
      `Resumed: <b>${escapeHtml(s.title)}</b> <code>${escapeHtml(s.slug)}</code>`,
      threadId,
    );
  } else {
    await api.sendText(`Failed to resume: ${escapeHtml(slug)}`, threadId);
  }
}

async function cmdNew(
  client: CmdClient,
  api: TelegramApi,
  instanceId: string,
  projectName: string | null,
  threadId: number | null,
  log: Logger,
): Promise<void> {
  try {
    const res = await client.session.create({ body: {} });
    const s = res.data;
    if (!s?.id) throw new Error("session create returned no session");
    const thread = await ensureTopic(api, {
      sessionId: s.id,
      title: s.title ?? null,
      projectName,
      instanceId,
    });
    log.info("Session created", { sessionId: s.id, threadId: thread });
    await api.sendText(
      `✅ New session: <b>${escapeHtml(s.title ?? "untitled")}</b> <code>${escapeHtml(s.id)}</code>${
        thread ? "\nChat with it in this new topic." : ""
      }`,
      thread ?? threadId,
    );
  } catch (error) {
    log.error("Failed to create session", { error: String(error), threadId });
    await api.sendText(`❌ Failed to create session: ${escapeHtml(String(error))}`, threadId);
  }
}

async function cmdFork(
  client: CmdClient,
  api: TelegramApi,
  instanceId: string,
  projectName: string | null,
  threadId: number | null,
  log: Logger,
): Promise<void> {
  const topic = requireSessionTopic(
    api,
    threadId,
    "This bot operates in forum topics. Send /fork inside a session topic.",
  );
  if (!topic) return;
  const sessionId = topic.session_id as string;
  const owner = resolveOwner(topic, instanceId);
  if (!owner) {
    await api.sendText("No live opencode instance owns this session.", threadId);
    return;
  }
  if (owner !== instanceId) {
    insertRelayAction(owner, "fork", { sessionId, threadId });
    await api.sendText("⏳ Fork relayed to the owning instance.", threadId);
    return;
  }
  try {
    const res = await client.session.fork({ path: { id: sessionId }, body: {} });
    const s = res.data;
    if (!s?.id) throw new Error("fork returned no session");
    const thread = await ensureTopic(api, {
      sessionId: s.id,
      title: s.title ?? null,
      projectName,
      instanceId,
    });
    log.info("Session forked", { sessionId, forkedTo: s.id, threadId: thread });
    await api.sendText(
      `✅ Forked to new session: <b>${escapeHtml(s.title ?? "forked session")}</b> <code>${escapeHtml(s.id)}</code>${
        thread ? "\nChat with it in this new topic." : ""
      }`,
      thread ?? threadId,
    );
  } catch (error) {
    log.error("Failed to fork session", { error: String(error), sessionId });
    await api.sendText(`❌ Fork failed: ${escapeHtml(String(error))}`, threadId);
  }
}

async function cmdCompact(
  client: CmdClient,
  api: TelegramApi,
  instanceId: string,
  threadId: number | null,
  log: Logger,
): Promise<void> {
  const topic = requireSessionTopic(
    api,
    threadId,
    "This bot operates in forum topics. Send /compact inside a session topic.",
  );
  if (!topic) return;
  const sessionId = topic.session_id as string;
  const owner = resolveOwner(topic, instanceId);
  if (!owner) {
    await api.sendText("No live opencode instance owns this session.", threadId);
    return;
  }
  if (owner !== instanceId) {
    insertRelayAction(owner, "compact", { sessionId, threadId });
    await api.sendText("⏳ Compact relayed to the owning instance.", threadId);
    return;
  }
  await applyCompactAction(client, api, { sessionId, threadId }, log);
}

async function cmdUndo(
  client: CmdClient,
  api: TelegramApi,
  instanceId: string,
  threadId: number | null,
  log: Logger,
): Promise<void> {
  const topic = requireSessionTopic(
    api,
    threadId,
    "This bot operates in forum topics. Send /undo inside a session topic.",
  );
  if (!topic) return;
  const sessionId = topic.session_id as string;
  const owner = resolveOwner(topic, instanceId);
  if (!owner) {
    await api.sendText("No live opencode instance owns this session.", threadId);
    return;
  }
  if (owner !== instanceId) {
    insertRelayAction(owner, "undo", { sessionId, threadId });
    await api.sendText("⏳ Undo relayed to the owning instance.", threadId);
    return;
  }
  await applyUndoAction(client, api, { sessionId, threadId }, log);
}

async function cmdAgents(
  client: CmdClient,
  api: TelegramApi,
  threadId: number | null,
  log: Logger,
): Promise<void> {
  try {
    const res = await client.app.agents();
    const agents = (res.data ?? []).filter((a) => !a.hidden);
    if (agents.length === 0) {
      await api.sendText("No agents configured.", threadId);
      return;
    }
    const rank: Record<string, number> = { primary: 0, all: 1, subagent: 2 };
    agents.sort((a, b) => (rank[a.mode ?? ""] ?? 3) - (rank[b.mode ?? ""] ?? 3) || (a.name ?? a.id ?? "").localeCompare(b.name ?? b.id ?? ""));
    let msg = "<b>Agents</b>\n";
    for (const a of agents) {
      const name = a.name ?? a.id ?? "?";
      const line = `\n<b>${escapeHtml(name)}</b> <em>(${escapeHtml(a.mode ?? "?")})</em>${a.description ? `\n  ${escapeHtml(truncate(a.description, 120))}` : ""}`;
      if ((msg + line).length >= MAX_LEN - 100) {
        msg += "\n\n<em>... and more</em>";
        break;
      }
      msg += line;
    }
    await api.sendText(msg, threadId);
  } catch (error) {
    log.error("Failed to list agents", { error: String(error), threadId });
    await api.sendText(`❌ Could not list agents: ${escapeHtml(String(error))}`, threadId);
  }
}

async function cmdMcps(
  client: CmdClient,
  api: TelegramApi,
  threadId: number | null,
  log: Logger,
): Promise<void> {
  try {
    const res = await client.mcp.status();
    const data = res.data ?? {};
    const names = Object.keys(data).sort();
    if (names.length === 0) {
      await api.sendText("No MCP servers configured.", threadId);
      return;
    }
    const icons: Record<string, string> = {
      connected: "✅",
      disabled: "⏸",
      failed: "❌",
      needs_auth: "🔑",
      needs_client_registration: "🔑",
    };
    let msg = "<b>MCP Servers</b>\n";
    for (const name of names) {
      const st = data[name] ?? {};
      const status = st.status ?? "unknown";
      const icon = icons[status] ?? "•";
      const line = `\n${icon} <b>${escapeHtml(name)}</b> <em>(${escapeHtml(status)})</em>${st.error ? `\n  ${escapeHtml(truncate(st.error, 150))}` : ""}`;
      if ((msg + line).length >= MAX_LEN - 100) {
        msg += "\n\n<em>... and more</em>";
        break;
      }
      msg += line;
    }
    await api.sendText(msg, threadId);
  } catch (error) {
    log.error("Failed to list MCP servers", { error: String(error), threadId });
    await api.sendText(`❌ Could not list MCP servers: ${escapeHtml(String(error))}`, threadId);
  }
}

async function cmdSkills(
  client: CmdClient,
  api: TelegramApi,
  threadId: number | null,
  log: Logger,
): Promise<void> {
  try {
    const res = await client._client.get({ url: "/api/skill" });
    const data = (res as { data?: Array<{ name: string; description?: string; location?: string }> } | undefined)?.data;
    if (!Array.isArray(data) || data.length === 0) {
      await api.sendText("No skills available.", threadId);
      return;
    }
    const sorted = [...data].sort((a, b) => a.name.localeCompare(b.name));
    let msg = `<b>Skills</b> · ${sorted.length}\n`;
    for (const s of sorted) {
      const line = `\n<b>${escapeHtml(s.name)}</b>${s.description ? `\n  ${escapeHtml(truncate(s.description, 120))}` : ""}`;
      if ((msg + line).length >= MAX_LEN - 100) {
        msg += "\n\n<em>... and more</em>";
        break;
      }
      msg += line;
    }
    await api.sendText(msg, threadId);
  } catch (error) {
    log.error("Failed to list skills", { error: String(error), threadId });
    await api.sendText(`❌ Could not list skills: ${escapeHtml(String(error))}`, threadId);
  }
}
