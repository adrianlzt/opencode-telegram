#!/usr/bin/env -S npx tsx
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { Telegraf } from "telegraf";
import { loadConfig } from "../src/config.js";

loadDotenv({ path: resolve(process.cwd(), ".env") });

const config = loadConfig();

const bot = new Telegraf(config.botToken);

const method = process.argv[2] || "text";
const body = process.argv[3] || "Test message from plugin dev script";

async function run() {
  console.log(`Sending via ${method}...`);
  try {
    let result;
    if (method === "text") {
      result = await bot.telegram.sendMessage(config.recipientChatId, body, {
        parse_mode: "HTML",
      });
    } else if (method === "buttons") {
      result = await bot.telegram.sendMessage(config.recipientChatId, body, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Option A", callback_data: "test:1" },
              { text: "Option B", callback_data: "test:2" },
            ],
          ],
        },
      });
    } else if (method === "document") {
      result = await bot.telegram.sendDocument(config.recipientChatId, {
        source: Buffer.from(body, "utf-8"),
        filename: "test.txt",
      }, {
        caption: body,
        parse_mode: "HTML",
      });
    } else {
      console.error(`Unknown method: ${method}. Use: text | buttons | document`);
      process.exit(1);
    }
    console.log("OK:", JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("FAILED:");
    console.error("  message:", (error as Error).message);
    console.error("  full:", error);
  }
}

run();
