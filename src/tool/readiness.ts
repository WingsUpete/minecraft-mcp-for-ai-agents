import * as z from "zod/v4";
import { createErrorToolResponse, createToolResponse } from "./response.js";
import { defineTool } from "./registry.js";
import { log } from "../util/logger.js";
import { DEFAULT_ENSURE_READY_TIMEOUT_MS } from "../bot/bot.js";

export { readinessTool };

/**
 * Check if the bot client (i.e., the agent body) is ready to interact with the Minecraft server.
 * Waits up to {@linkcode DEFAULT_ENSURE_READY_TIMEOUT_MS}ms and attempts reconnect if disconnected.
 */
const readinessTool = defineTool({
  name: "check_readiness",
  description: `
Check if the bot client (i.e., the agent body) is ready to interact with the Minecraft server.
Waits up to ${DEFAULT_ENSURE_READY_TIMEOUT_MS}ms and attempts reconnect if disconnected.
Use only when the bot client is not behaving as expected.
`.trim(),
  inputSchema: z.object({}),
  handler: async (bot) => {
    log(`[READINESS] Checking readiness...`, "debug");
    try {
      if (bot.client && bot.isReady) {
        log(`[READINESS] Bot client is ready`, "debug");
        return createToolResponse(
          "The bot client (i.e., the agent body) is ready to interact with the Minecraft server.",
        );
      }
      await bot.ensureReadyWithin();
      log(`[READINESS] Bot client is ready after reconnecting`, "debug");
      return createToolResponse(
        "The bot client (i.e., the agent body) is ready to interact with the Minecraft server after reconnecting.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errMsg = `Not ready: ${message}`;
      log(`[READINESS] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});
