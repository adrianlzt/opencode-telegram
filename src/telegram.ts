import { log } from "./logger.js";

export interface TgUser {
  id: number;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
  is_forum?: boolean;
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  text?: string;
  chat: TgChat;
  from?: TgUser;
  reply_to_message?: { message_id: number };
  voice?: unknown;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: {
    id: string;
    data?: string;
    message?: TgMessage;
    from?: TgUser;
  };
}

export interface InlineButton {
  id: string;
  title: string;
}

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
  ) {}

  private async call<T = any>(method: string, params: Record<string, unknown> = {}, retries = 2): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
        });
        const body = (await res.json()) as { ok: boolean; result?: T; error_code?: number; description?: string };
        if (!body.ok) throw new Error(`${method} failed: ${body.error_code} ${body.description}`);
        return body.result as T;
      } catch (error) {
        lastError = error;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private thread(params: Record<string, unknown>, threadId?: number | null): Record<string, unknown> {
    return threadId != null ? { ...params, message_thread_id: threadId } : params;
  }

  sendText(text: string, threadId?: number | null) {
    return this.call("sendMessage", this.thread({ chat_id: this.chatId, text, parse_mode: "HTML" }, threadId));
  }

  async sendDocument(filename: string, content: string, caption?: string, threadId?: number | null) {
    const form = new FormData();
    form.append("chat_id", String(this.chatId));
    if (threadId != null) form.append("message_thread_id", String(threadId));
    if (caption) form.append("caption", caption);
    form.append("parse_mode", "HTML");
    form.append("document", new Blob([content], { type: "text/markdown" }), filename);
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const body = (await res.json()) as { ok: boolean; result?: any; description?: string };
    if (!body.ok) throw new Error(`sendDocument failed: ${body.description}`);
    return body.result;
  }

  sendButtons(text: string, buttons: InlineButton[], threadId?: number | null) {
    return this.call(
      "sendMessage",
      this.thread(
        {
          chat_id: this.chatId,
          text,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: buttons.map((b) => [{ text: b.title, callback_data: b.id }]),
          },
        },
        threadId,
      ),
    );
  }

  createTopic(name: string, iconColor?: number) {
    return this.call<{ message_thread_id: number }>("createForumTopic", {
      chat_id: this.chatId,
      name,
      ...(iconColor ? { icon_color: iconColor } : {}),
    });
  }

  async renameTopic(threadId: number, name: string) {
    try {
      await this.call("editForumTopic", { chat_id: this.chatId, message_thread_id: threadId, name });
    } catch (error) {
      log.warn("renameTopic failed", { error: String(error), threadId, name });
    }
  }

  async closeTopic(threadId: number) {
    try {
      await this.call("closeForumTopic", { chat_id: this.chatId, message_thread_id: threadId });
    } catch (error) {
      log.warn("closeTopic failed", { error: String(error), threadId });
    }
  }

  async reopenTopic(threadId: number) {
    try {
      await this.call("reopenForumTopic", { chat_id: this.chatId, message_thread_id: threadId });
    } catch (error) {
      log.warn("reopenTopic failed", { error: String(error), threadId });
    }
  }

  answerCallbackQuery(id: string) {
    return this.call("answerCallbackQuery", { callback_query_id: id }, 0).catch(() => {});
  }

  async poll(offset: number, timeoutSec: number, signal: AbortSignal): Promise<TgUpdate[]> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }),
      signal,
    });
    const body = (await res.json()) as { ok: boolean; result?: TgUpdate[]; description?: string };
    if (!body.ok) throw new Error(`getUpdates failed: ${body.description}`);
    return body.result ?? [];
  }
}

export interface UpdateHandlers {
  onText(text: string, threadId: number | null, replyToMessageId: number | undefined): Promise<void>;
  onButton(buttonId: string, threadId: number | null): Promise<void>;
  onVoice(threadId: number | null): Promise<void>;
}

export class Poller {
  private controller: AbortController | null = null;
  private running = false;

  constructor(
    private readonly api: TelegramApi,
    private readonly handlers: UpdateHandlers,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.controller?.abort();
  }

  private async dropBacklog(): Promise<number> {
    const first = await this.api.poll(-1, 0, new AbortController().signal);
    if (first.length === 0) return 0;
    const lastId = first[first.length - 1].update_id;
    await this.api.poll(lastId + 1, 0, new AbortController().signal);
    return lastId + 1;
  }

  private async loop(): Promise<void> {
    let offset = 0;
    try {
      offset = await this.dropBacklog();
    } catch (error) {
      log.warn("Failed to drop pending updates", { error: String(error) });
    }
    log.info("Telegram polling started");
    while (this.running) {
      this.controller = new AbortController();
      try {
        const updates = await this.api.poll(offset, 25, this.controller.signal);
        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await this.dispatch(update);
          } catch (error) {
            log.error("Update dispatch failed", { error: String(error) });
          }
        }
      } catch (error) {
        if (!this.running) break;
        log.warn("Poll error, retrying in 3s", { error: String(error) });
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    log.info("Telegram polling stopped");
  }

  private async dispatch(update: TgUpdate): Promise<void> {
    if (update.callback_query) {
      const cb = update.callback_query;
      const threadId = cb.message?.message_thread_id ?? null;
      log.info(`Button press: ${cb.data}`, { threadId });
      if (cb.data) await this.handlers.onButton(cb.data, threadId);
      void this.api.answerCallbackQuery(cb.id);
      return;
    }
    const message = update.message;
    if (!message) return;
    const threadId = message.message_thread_id ?? null;
    if (message.voice) {
      log.info(`Voice message in topic ${threadId} (no transcription available)`);
      await this.handlers.onVoice(threadId);
      return;
    }
    const text = message.text?.trim();
    if (!text) return;
    log.info(`Text in topic ${threadId}: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);
    await this.handlers.onText(text, threadId, message.reply_to_message?.message_id);
  }
}
