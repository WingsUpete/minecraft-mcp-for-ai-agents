import * as z from "zod/v4";
import { defineTool } from "./registry.js";
import { createErrorToolResponse, createToolResponse } from "./response.js";
import { log } from "../util/logger.js";

export { chatTool, whisperTool };

/***
 * Send an open (public) chat message to the Minecraft server.
 */
const chatTool = defineTool({
  name: "chat",
  description: "Send an open (public) chat message to the Minecraft server.",
  inputSchema: z.object({
    message: z.string().describe("The message to send"),
  }),
  handler: async (bot, args) => {
    try {
      await bot.ensureReadyWithin();
      bot.client?.chat(args.message);
    } catch (error) {
      const errMsg = `Failed to send chat message: ${String(error)}`;
      log(`[CHAT] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
    log(`[CHAT] Message sent: ${args.message}`, "debug");
    return createToolResponse("Message sent successfully");
  },
});

/***
 * Send a private (whisper) message to a specific player.
 */
const whisperTool = defineTool({
  name: "whisper",
  description: "Send a private (whisper) message to a specific player.",
  inputSchema: z.object({
    player: z.string().describe("The player to send the message to"),
    message: z.string().describe("The message to send"),
  }),
  handler: async (bot, args) => {
    try {
      await bot.ensureReadyWithin();
      if (bot.client?.players[args.player] === undefined) {
        return createErrorToolResponse(`Player ${args.player} not found`);
      }
      bot.client?.whisper(args.player, args.message);
    } catch (error) {
      const errMsg = `Failed to send whisper message: ${String(error)}`;
      log(`[WHISPER] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
    log(`[WHISPER] Message sent to ${args.player}: ${args.message}`, "debug");
    return createToolResponse("Message sent successfully");
  },
});
