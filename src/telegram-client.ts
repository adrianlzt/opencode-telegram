import { Telegraf } from "telegraf";
import type { Config } from "./config.js";
import { log } from "./logger.js";

interface TelegramHandlers {
  onButtonReply: (buttonId: string) => Promise<void>;
  onTextMessage: (text: string) => Promise<void>;
  onAudioMessage: (transcription: string | null) => Promise<void>;
}

export class TelegramService {
  private bot: Telegraf;
  private chatId: string;
  private handlers: TelegramHandlers;
  private allowedChatIds = new Set<string>();

  constructor(config: Config, handlers: TelegramHandlers) {
    this.chatId = config.recipientChatId;
    this.handlers = handlers;
    this.allowedChatIds.add(config.recipientChatId);
    this.bot = new Telegraf(config.botToken);

    this.bot.on("callback_query", async (ctx) => {
      const fromId = ctx.from?.id?.toString();
      const chatId = ctx.chat?.id?.toString();
      log.debug(`callback_query received`, { fromId, chatId, data: (ctx.callbackQuery as any)?.data });
      if (!this.isAllowed(fromId)) {
        log.warn(`callback_query from unauthorized user`, { fromId, allowedIds: [...this.allowedChatIds] });
        return;
      }
      const cbQuery = ctx.callbackQuery;
      if (!cbQuery || !("data" in cbQuery) || !cbQuery.data) return;
      log.info(`Button reply: ${cbQuery.data}`);
      await ctx.answerCbQuery();
      await this.handlers.onButtonReply(cbQuery.data);
    });

    this.bot.on("text", async (ctx) => {
      if (!this.isAllowed(ctx.chat?.id?.toString())) return;
      const text = ctx.message?.text?.trim();
      if (!text) return;
      log.info(`Text reply: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);
      await this.handlers.onTextMessage(text);
    });

    this.bot.on("voice", async (ctx) => {
      if (!this.isAllowed(ctx.chat?.id?.toString())) return;
      const voice = ctx.message?.voice;
      if (!voice) return;
      log.info(`Voice message received: file_id=${voice.file_id}`);
      log.info("Telegram API does not provide built-in voice transcription");
      await this.handlers.onAudioMessage(null);
    });
  }

  private isAllowed(chatId: string | undefined): boolean {
    if (!chatId) return false;
    return this.allowedChatIds.has(chatId);
  }

  async start(): Promise<void> {
    this.bot.use(async (ctx, next) => {
      log.debug(`Telegraf update received`, {
        updateType: ctx.updateType,
        chatId: ctx.chat?.id?.toString(),
        fromId: ctx.from?.id?.toString(),
      });
      await next();
    });
    await this.bot.launch({
      dropPendingUpdates: true,
    });
    log.info("Telegram bot started (dropPendingUpdates: true)");
  }

  stop(): void {
    this.bot.stop("SIGINT");
    log.info("Telegram bot stopped");
  }

  async sendText(text: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(this.chatId, text, {
        parse_mode: "HTML",
      });
    } catch (error) {
      log.error("sendText failed", { error: String(error) });
      throw error;
    }
  }

  async sendDocument(
    filename: string,
    content: string,
    caption?: string,
  ): Promise<void> {
    try {
      const bytes = Buffer.from(content, "utf-8");
      await this.bot.telegram.sendDocument(this.chatId, {
        source: bytes,
        filename,
      }, {
        caption,
        parse_mode: "HTML",
      });
    } catch (error) {
      log.error("sendDocument failed", { error: String(error) });
      throw error;
    }
  }

  async sendButtons(
    bodyText: string,
    buttons: Array<{ id: string; title: string }>,
  ): Promise<void> {
    try {
      const inlineKeyboard = [];
      for (const btn of buttons) {
        inlineKeyboard.push([{ text: btn.title, callback_data: btn.id }]);
      }
      await this.bot.telegram.sendMessage(this.chatId, bodyText, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    } catch (error) {
      log.error("sendButtons failed", { error: String(error) });
      throw error;
    }
  }
}
