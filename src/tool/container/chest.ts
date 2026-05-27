import * as z from "zod/v4";
import { defineTool } from "../registry.js";
import { createErrorToolResponse, createToolResponse } from "../response.js";
import { log } from "../../util/logger.js";
import { coordsFromBlock, parseOptionalBlockCoords } from "../../util/block.js";
import {
  CHEST_COORDS_PARTIAL_ERROR,
  ChestOpenTimeoutError,
  ChestOperationTimeoutError,
  formatChestContentsSummary,
  formatChestOperationReport,
  resolveChestBlock,
  runChestOperations,
  summarizeChestContents,
  countChestEmptySlots,
  withChestSession,
  type ChestOnError,
} from "../../util/container/chest.js";
import {
  formatInventorySummary,
  summarizeInventory,
} from "../../util/inventory.js";

export { checkChestContentsTool, interactWithChestTool };

const chestCoordsSchema = {
  x: z
    .number()
    .int()
    .optional()
    .describe(
      "Chest X. Provide x, y, and z together, or omit all three to use the nearest chest in range.",
    ),
  y: z.number().int().optional().describe("Chest Y."),
  z: z.number().int().optional().describe("Chest Z."),
  block_name: z
    .string()
    .optional()
    .describe(
      "Block type: at coordinates, must match; without coordinates, nearest block of this type (e.g. chest, barrel).",
    ),
};

const chestOperationSchema = z.object({
  op_type: z
    .enum(["deposit", "withdraw"])
    .describe(
      "deposit: bot inventory → chest; withdraw: chest → bot inventory.",
    ),
  item_name: z
    .string()
    .describe("Item name (e.g. wheat, bread). Case-insensitive."),
  count: z
    .number()
    .int()
    .positive()
    .describe("Number of items to move for this operation."),
});

const onErrorSchema = z
  .enum(["skip", "stop"])
  .optional()
  .describe(
    "When an operation fails: skip = continue with remaining operations; stop = abort the rest. Defaults to skip.",
  );

const checkChestContentsTool = defineTool({
  name: "check_chest_contents",
  description: `
List all items in a chest (or barrel, trapped chest, ender chest).
Coordinates (x, y, z) are optional: omit them to use the nearest supported chest within interaction range (4.5 blocks).
Does not move the bot; use move_to_interactable_block first when out of range.
Typical flow: find_block → move_to_interactable_block → check_chest_contents.
`.trim(),
  inputSchema: z.object(chestCoordsSchema),
  handler: async (bot, args) => {
    try {
      await bot.ensureReadyWithin();
      const client = bot.client;
      if (!client) {
        return createErrorToolResponse("Bot is not connected");
      }

      const parsed = parseOptionalBlockCoords(
        args.x,
        args.y,
        args.z,
        CHEST_COORDS_PARTIAL_ERROR,
      );
      if (!parsed.ok) {
        log(`[CHECK_CHEST_CONTENTS] ${parsed.error}`, "error");
        return createErrorToolResponse(parsed.error);
      }

      const blockResult = resolveChestBlock(
        client,
        parsed.coords,
        args.block_name,
      );
      if (!blockResult.ok) {
        log(`[CHECK_CHEST_CONTENTS] ${blockResult.error}`, "error");
        return createErrorToolResponse(blockResult.error);
      }

      const displayCoords = coordsFromBlock(blockResult.block);
      const msg = await withChestSession(
        client,
        blockResult.block,
        async (chest) => {
          const lines = summarizeChestContents(chest);
          const emptySlots = countChestEmptySlots(chest);
          return formatChestContentsSummary(
            lines,
            emptySlots,
            displayCoords,
            blockResult.block.name,
          );
        },
      );

      log(`[CHECK_CHEST_CONTENTS] ${msg.replace(/\n/g, "; ")}`, "debug");
      return createToolResponse(msg);
    } catch (error) {
      const errMsg =
        error instanceof ChestOpenTimeoutError
          ? error.message
          : `Failed to check chest contents: ${String(error)}`;
      log(`[CHECK_CHEST_CONTENTS] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});

const interactWithChestTool = defineTool({
  name: "interact_with_chest",
  description: `
Run one or more deposit/withdraw operations on a chest in a single open session.
Coordinates (x, y, z) are optional: omit them to use the nearest supported chest in range.
Operations run in array order. Does not move the bot — use move_to_interactable_block first when out of range.
on_error: skip (default) continues after a failed step; stop aborts remaining operations but still closes the chest.
Typical flow: find_block → move_to_interactable_block → interact_with_chest → check_inventory.
`.trim(),
  inputSchema: z.object({
    ...chestCoordsSchema,
    operations: z
      .array(chestOperationSchema)
      .min(1)
      .describe("Sequential chest operations while the window stays open."),
    on_error: onErrorSchema,
  }),
  handler: async (bot, args) => {
    try {
      await bot.ensureReadyWithin();
      const client = bot.client;
      if (!client) {
        return createErrorToolResponse("Bot is not connected");
      }

      const parsed = parseOptionalBlockCoords(
        args.x,
        args.y,
        args.z,
        CHEST_COORDS_PARTIAL_ERROR,
      );
      if (!parsed.ok) {
        log(`[INTERACT_WITH_CHEST] ${parsed.error}`, "error");
        return createErrorToolResponse(parsed.error);
      }

      const onError: ChestOnError = args.on_error ?? "skip";

      const blockResult = resolveChestBlock(
        client,
        parsed.coords,
        args.block_name,
      );
      if (!blockResult.ok) {
        log(`[INTERACT_WITH_CHEST] ${blockResult.error}`, "error");
        return createErrorToolResponse(blockResult.error);
      }

      const displayCoords = coordsFromBlock(blockResult.block);

      const { results, chestSummary } = await withChestSession(
        client,
        blockResult.block,
        async (chest) => {
          const opResults = await runChestOperations(
            client,
            chest,
            args.operations,
            onError,
          );
          const lines = summarizeChestContents(chest);
          const emptySlots = countChestEmptySlots(chest);
          const summary = formatChestContentsSummary(
            lines,
            emptySlots,
            displayCoords,
            blockResult.block.name,
          );
          return { results: opResults, chestSummary: summary };
        },
      );

      const report = formatChestOperationReport(
        results,
        onError,
        args.operations.length,
      );
      const invLines = summarizeInventory(client);
      const invEmpty = client.inventory.emptySlotCount();
      const msg = [
        report,
        "",
        "Chest after operations:",
        chestSummary,
        "",
        "Bot inventory after operations:",
        formatInventorySummary(invLines, invEmpty),
      ].join("\n");

      const allFailed = results.length > 0 && results.every((r) => !r.ok);
      const stopWithFailure = onError === "stop" && results.some((r) => !r.ok);

      log(`[INTERACT_WITH_CHEST] ${report.replace(/\n/g, "; ")}`, "debug");

      if (allFailed || stopWithFailure) {
        return createErrorToolResponse(msg);
      }
      return createToolResponse(msg);
    } catch (error) {
      const errMsg =
        error instanceof ChestOpenTimeoutError ||
        error instanceof ChestOperationTimeoutError
          ? error.message
          : `Failed to interact with chest: ${String(error)}`;
      log(`[INTERACT_WITH_CHEST] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});
