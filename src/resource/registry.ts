import type { McpServer } from "@modelcontextprotocol/server";
import type { Bot } from "../bot/bot.js";
import { registerIncomingMessagesResource } from "./incoming_messages.js";

export function registerResources(server: McpServer, bot: Bot): void {
  registerIncomingMessagesResource(server, bot);
}
