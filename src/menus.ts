import {
  getSessionByThreadId,
  insertRelayAction,
  isInstanceAlive,
  resolveLiveOwner,
  setTopicInstance,
} from "./db.js";
import { escapeHtml } from "./commands.js";
import type { Logger } from "./logger.js";
import type { InlineButton, TelegramApi } from "./telegram.js";

export const MENU_PREFIX = "mt:";

const MODELS_PER_PAGE = 12;
const MAX_PROVIDERS = 30;
const TOKEN_TTL_MS = 15 * 60_000;

export interface ModelClient {
  session: {
    get(args: { path: { id: string } }): Promise<{
      data?: { model?: { providerID?: string; id?: string } | null } | null;
    }>;
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
  _client: {
    post(args: { url: string; body: unknown; headers: Record<string, string> }): Promise<unknown>;
  };
}

interface TopicRow {
  session_id: string;
  instance_id: string;
  thread_id: number;
  title?: string | null;
  closed?: number;
}

type MenuPayload =
  | { k: "p"; provider: string }
  | { k: "m"; provider: string; model: string }
  | { k: "pg"; provider: string; page: number }
  | { k: "back" };

interface ProviderEntry {
  id: string;
  modelIds: string[];
  connected: boolean;
}

interface SwitchModelPayload {
  sessionId: string;
  providerID: string;
  id: string;
  threadId: number | null;
}

const menuTokens = new Map<string, { payload: MenuPayload; at: number }>();
let tokenCounter = 0;

function registerMenuToken(payload: MenuPayload): string {
  const now = Date.now();
  for (const [token, entry] of menuTokens) {
    if (now - entry.at > TOKEN_TTL_MS) menuTokens.delete(token);
  }
  tokenCounter = (tokenCounter + 1) % 1679616;
  const token = tokenCounter.toString(36);
  menuTokens.set(token, { payload, at: now });
  return token;
}

function parseModelRef(args: string): { provider: string; model: string } | null {
  const slash = args.indexOf("/");
  if (slash <= 0) return null;
  const provider = args.slice(0, slash);
  const model = args.slice(slash + 1);
  if (!provider || !model) return null;
  return { provider, model };
}

async function currentModel(client: ModelClient, sessionId: string): Promise<string | null> {
  try {
    const res = await client.session.get({ path: { id: sessionId } });
    const m = res.data?.model;
    return m?.providerID && m?.id ? `${m.providerID}/${m.id}` : null;
  } catch {
    return null;
  }
}

async function fetchProviderData(
  client: ModelClient,
): Promise<{ providers: ProviderEntry[]; defaults: Record<string, string> }> {
  const res = await client.provider.list();
  const data = res.data;
  const providers: ProviderEntry[] = (data?.all ?? []).map((p) => ({
    id: p.id,
    modelIds: Object.keys(p.models ?? {}),
    connected: data?.connected?.includes(p.id) ?? false,
  }));
  providers.sort((a, b) => Number(b.connected) - Number(a.connected) || a.id.localeCompare(b.id));
  return { providers, defaults: data?.default ?? {} };
}

async function sendProviderMenu(
  client: ModelClient,
  api: TelegramApi,
  sessionId: string,
  threadId: number,
): Promise<void> {
  const { providers } = await fetchProviderData(client);
  if (providers.length === 0) {
    await api.sendText("No providers/models available.", threadId);
    return;
  }
  const current = await currentModel(client, sessionId);
  let text = `<b>Model</b> — current: <code>${escapeHtml(current ?? "unknown")}</code>\n\nTap a provider:`;
  if (providers.length > MAX_PROVIDERS) {
    text += `\n<em>Showing first ${MAX_PROVIDERS} of ${providers.length}. Use <code>/model provider/model</code> for others.</em>`;
  }
  const buttons: InlineButton[] = providers.slice(0, MAX_PROVIDERS).map((p) => ({
    id: MENU_PREFIX + registerMenuToken({ k: "p", provider: p.id }),
    title: `${p.connected ? "●" : "○"} ${p.id} (${p.modelIds.length})`,
  }));
  await api.sendButtons(text, buttons, threadId);
}

async function sendModelMenu(
  client: ModelClient,
  api: TelegramApi,
  sessionId: string,
  provider: string,
  page: number,
  threadId: number,
): Promise<void> {
  const { providers, defaults } = await fetchProviderData(client);
  const entry = providers.find((p) => p.id === provider);
  if (!entry) {
    await api.sendText(`Unknown provider: ${escapeHtml(provider)}. Run /model to pick from the list.`, threadId);
    return;
  }
  const defaultModel = defaults[provider];
  const ordered = [...entry.modelIds].sort((a, b) => {
    if (a === defaultModel) return -1;
    if (b === defaultModel) return 1;
    return a.localeCompare(b);
  });
  if (ordered.length === 0) {
    await api.sendText(`Provider ${escapeHtml(provider)} has no models.`, threadId);
    return;
  }
  const pageCount = Math.ceil(ordered.length / MODELS_PER_PAGE);
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);
  const slice = ordered.slice(safePage * MODELS_PER_PAGE, (safePage + 1) * MODELS_PER_PAGE);
  const current = await currentModel(client, sessionId);
  let text = `<b>Model</b> — current: <code>${escapeHtml(current ?? "unknown")}</code>\n`;
  text += `Provider: <code>${escapeHtml(provider)}</code> — page ${safePage + 1}/${pageCount}`;
  const rows: InlineButton[][] = [];
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(
      slice.slice(i, i + 2).map((model) => ({
        id: MENU_PREFIX + registerMenuToken({ k: "m", provider, model }),
        title: (model === defaultModel ? "★ " : "") + model,
      })),
    );
  }
  const nav: InlineButton[] = [];
  if (safePage > 0) {
    nav.push({ id: MENU_PREFIX + registerMenuToken({ k: "pg", provider, page: safePage - 1 }), title: "◀" });
  }
  if (pageCount > 1) {
    nav.push({ id: MENU_PREFIX + registerMenuToken({ k: "pg", provider, page: safePage }), title: `${safePage + 1}/${pageCount}` });
  }
  if (safePage < pageCount - 1) {
    nav.push({ id: MENU_PREFIX + registerMenuToken({ k: "pg", provider, page: safePage + 1 }), title: "▶" });
  }
  if (nav.length > 0) rows.push(nav);
  rows.push([{ id: MENU_PREFIX + registerMenuToken({ k: "back" }), title: "← Providers" }]);
  await api.sendButtonRows(text, rows, threadId);
}

async function switchSessionModel(
  client: ModelClient,
  sessionId: string,
  providerID: string,
  id: string,
): Promise<void> {
  const res = (await client._client.post({
    url: `/api/session/${sessionId}/model`,
    body: { model: { providerID, id } },
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
}

function resolveTopicOwner(topic: TopicRow, instanceId: string): string | null {
  const owner = topic.instance_id;
  if (owner === instanceId) return owner;
  if (isInstanceAlive(owner)) return owner;
  const resolved = resolveLiveOwner(topic.session_id);
  if (!resolved) return null;
  setTopicInstance(topic.session_id, resolved);
  return resolved;
}

async function applyModelChoice(
  client: ModelClient,
  api: TelegramApi,
  instanceId: string,
  topic: TopicRow,
  provider: string,
  model: string,
  log: Logger,
): Promise<void> {
  const sessionId = topic.session_id;
  const threadId = (topic.thread_id as number) ?? null;
  const owner = resolveTopicOwner(topic, instanceId);
  if (!owner) {
    await api.sendText("No live opencode instance owns this session.", threadId);
    return;
  }
  const label = `<b>${escapeHtml(provider)}/${escapeHtml(model)}</b>`;
  if (owner === instanceId) {
    try {
      await switchSessionModel(client, sessionId, provider, model);
      await api.sendText(`✅ Model set to ${label}.`, threadId);
      log.info("Model switched", { sessionId, provider, model });
    } catch (error) {
      log.error("Model switch failed", { error: String(error), sessionId, provider, model });
      await api.sendText(`❌ Model switch failed: ${escapeHtml(String(error))}`, threadId);
    }
    return;
  }
  insertRelayAction(owner, "switch_model", { sessionId, providerID: provider, id: model, threadId });
  await api.sendText(`⏳ Model switch ${label} relayed to the owning instance.`, threadId);
  log.info("Model switch relayed", { sessionId, owner, provider, model });
}

async function applyValidatedModel(
  client: ModelClient,
  api: TelegramApi,
  instanceId: string,
  topic: TopicRow,
  provider: string,
  model: string,
  threadId: number | null,
  log: Logger,
): Promise<void> {
  const { providers } = await fetchProviderData(client);
  const entry = providers.find((p) => p.id === provider);
  if (!entry) {
    await api.sendText(`Unknown provider: ${escapeHtml(provider)}. Run /model to pick from the list.`, threadId);
    return;
  }
  if (!entry.modelIds.includes(model)) {
    await api.sendText(
      `Provider ${escapeHtml(provider)} has no model <code>${escapeHtml(model)}</code>. Run /model to pick from the list.`,
      threadId,
    );
    return;
  }
  await applyModelChoice(client, api, instanceId, topic, provider, model, log);
}

export async function cmdModel(
  client: ModelClient,
  api: TelegramApi,
  instanceId: string,
  args: string,
  threadId: number | null,
  log: Logger,
): Promise<void> {
  if (threadId == null) {
    await api.sendText("This bot operates in forum topics. Send /model inside a session topic.", threadId);
    return;
  }
  const topic = getSessionByThreadId(threadId) as TopicRow | null;
  if (!topic) {
    await api.sendText("No opencode session is bound to this topic.", threadId);
    return;
  }
  if (args) {
    const ref = parseModelRef(args);
    if (!ref) {
      await api.sendText(
        "Usage: /model [provider/model]\nExample: <code>/model openai/gpt-5-pro</code>",
        threadId,
      );
      return;
    }
    try {
      await applyValidatedModel(client, api, instanceId, topic, ref.provider, ref.model, threadId, log);
    } catch (error) {
      log.error("Model switch failed", { error: String(error), threadId });
      await api.sendText(`❌ Model switch failed: ${escapeHtml(String(error))}`, threadId);
    }
    return;
  }
  try {
    await sendProviderMenu(client, api, topic.session_id, threadId);
  } catch (error) {
    log.error("Failed to build model menu", { error: String(error), threadId });
    await api.sendText(`❌ Could not list models: ${escapeHtml(String(error))}`, threadId);
  }
}

export async function handleMenuButton(
  client: ModelClient,
  api: TelegramApi,
  instanceId: string,
  buttonId: string,
  threadId: number | null,
  log: Logger,
): Promise<void> {
  const token = buttonId.slice(MENU_PREFIX.length);
  const entry = menuTokens.get(token);
  if (!entry) {
    log.warn("Unknown or expired menu token", { token });
    await api.sendText("This menu has expired. Run /model again.", threadId);
    return;
  }
  if (threadId == null) return;
  const topic = getSessionByThreadId(threadId) as TopicRow | null;
  if (!topic) {
    await api.sendText("No opencode session is bound to this topic.", threadId);
    return;
  }
  const payload = entry.payload;
  try {
    if (payload.k === "p") {
      await sendModelMenu(client, api, topic.session_id, payload.provider, 0, threadId);
    } else if (payload.k === "pg") {
      await sendModelMenu(client, api, topic.session_id, payload.provider, payload.page, threadId);
    } else if (payload.k === "back") {
      await sendProviderMenu(client, api, topic.session_id, threadId);
    } else {
      await applyValidatedModel(client, api, instanceId, topic, payload.provider, payload.model, threadId, log);
    }
  } catch (error) {
    log.error("Menu action failed", { error: String(error), buttonId, threadId });
    await api.sendText(`❌ Menu action failed: ${escapeHtml(String(error))}`, threadId);
  }
}

export async function applySwitchModelAction(
  client: ModelClient,
  api: TelegramApi,
  payload: unknown,
  log: Logger,
): Promise<void> {
  const p = payload as SwitchModelPayload;
  if (!p || typeof p.sessionId !== "string" || typeof p.providerID !== "string" || typeof p.id !== "string") {
    log.warn("Invalid switch_model payload", { payload: JSON.stringify(payload) });
    return;
  }
  try {
    await switchSessionModel(client, p.sessionId, p.providerID, p.id);
    log.info("Relayed model switch applied", { sessionId: p.sessionId, model: `${p.providerID}/${p.id}` });
    await api.sendText(`✅ Model set to <b>${escapeHtml(p.providerID)}/${escapeHtml(p.id)}</b>.`, p.threadId);
  } catch (error) {
    log.error("Relayed model switch failed", { error: String(error), sessionId: p.sessionId });
    await api.sendText(`❌ Model switch failed: ${escapeHtml(String(error))}`, p.threadId);
  }
}
