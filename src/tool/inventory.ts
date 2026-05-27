import * as z from "zod/v4";
import { defineTool } from "./registry.js";
import { createErrorToolResponse, createToolResponse } from "./response.js";
import { log } from "../util/logger.js";
import {
  formatInventorySummary,
  summarizeInventory,
} from "../util/inventory.js";

export { checkInventoryTool };

const checkInventoryTool = defineTool({
  name: "check_inventory",
  description: `
List all items in the bot inventory with counts.
Stacks of the same item are combined. Case-insensitive grouping by item id.
`.trim(),
  inputSchema: z.object({}),
  handler: async (bot) => {
    try {
      await bot.ensureReadyWithin();
      const client = bot.client;
      if (!client) {
        return createErrorToolResponse("Bot is not connected");
      }

      const lines = summarizeInventory(client);
      const emptySlots = client.inventory.emptySlotCount();
      const msg = formatInventorySummary(lines, emptySlots);
      log(`[CHECK_INVENTORY] ${msg.replace(/\n/g, "; ")}`, "debug");
      return createToolResponse(msg);
    } catch (error) {
      const errMsg = `Failed to check inventory: ${String(error)}`;
      log(`[CHECK_INVENTORY] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});
