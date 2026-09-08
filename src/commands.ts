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
  isPidAlive,
  listArchivedSessions,
  listSessions,
  listTodos,
  resumeSession,
  setTopicClosed,
} from "./db.js";
import type { Logger } from "./logger.js";
import type { TelegramApi } from "./telegram.js";

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

export async function handleCommand(
  api: TelegramApi,
  instanceId: string,
  command: string,
  threadId: number | null,
  log: Logger,
): Promise<boolean> {
  const trimmed = command.trim();
  if (!trimmed.startsWith("/")) return false;
  const spaceIdx = trimmed.indexOf(" ");
  const cmd = (spaceIdx > 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1)).toLowerCase();
  const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : "";
  log.info("Command received", { cmd, args, threadId });
  switch (cmd) {
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
    default:
      return false;
  }
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
