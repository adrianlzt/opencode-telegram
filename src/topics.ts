import type { TelegramApi } from "./telegram.js";
import { getTopicBySession, setTopicInstance, upsertSessionTopic } from "./db.js";
import { log } from "./logger.js";

export function buildTopicName(title: string | null | undefined, projectName: string | null | undefined): string {
  const t = (title ?? "").trim() || "OpenCode Session";
  if (projectName) return `${projectName} — ${truncate(t, 100)}`;
  return truncate(t, 120);
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength - 3) + "...";
}

export async function ensureTopic(
  api: TelegramApi,
  opts: {
    sessionId: string;
    title: string | null;
    projectName: string | null;
    instanceId: string;
  },
): Promise<number | null> {
  const existing = getTopicBySession(opts.sessionId);
  if (existing) {
    if (existing.instance_id !== opts.instanceId) {
      setTopicInstance(opts.sessionId, opts.instanceId);
      log.info(
        `Rebound topic ${existing.thread_id} for session ${opts.sessionId}: [instance=${existing.instance_id}] -> [instance=${opts.instanceId}]`,
      );
    }
    return existing.thread_id;
  }
  const name = buildTopicName(opts.title, opts.projectName);
  try {
    const result = await api.createTopic(name);
    upsertSessionTopic(opts.sessionId, opts.instanceId, result.message_thread_id, opts.title, opts.projectName);
    log.info(`Created topic ${result.message_thread_id} for session ${opts.sessionId}: "${name}"`);
    return result.message_thread_id;
  } catch (error) {
    log.error("Failed to create topic", { error: String(error), sessionId: opts.sessionId });
    return null;
  }
}
