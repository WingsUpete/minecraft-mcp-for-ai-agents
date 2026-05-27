import * as z from "zod/v4";
import { defineTool } from "../registry.js";
import { createErrorToolResponse, createToolResponse } from "../response.js";
import { log } from "../../util/logger.js";
import { coordsFromBlock, parseOptionalBlockCoords } from "../../util/block.js";
import {
  FURNACE_COORDS_PARTIAL_ERROR,
  FurnaceOpenTimeoutError,
  FurnaceOperationTimeoutError,
  buildFurnaceSummaryFromWindow,
  formatFurnaceOperationReport,
  resolveFurnaceBlock,
  runFurnaceOperations,
  withFurnaceSession,
  type FurnaceOnError,
  type FurnaceOperation,
} from "../../util/container/furnace.js";
import {
  formatInventorySummary,
  summarizeInventory,
} from "../../util/inventory.js";

export { checkFurnaceTool, interactWithFurnaceTool };

const furnaceCoordsSchema = {
  x: z
    .number()
    .int()
    .optional()
    .describe(
      "Furnace X. Provide x, y, and z together, or omit all three to use the nearest furnace in range.",
    ),
  y: z.number().int().optional().describe("Furnace Y."),
  z: z.number().int().optional().describe("Furnace Z."),
  block_name: z
    .string()
    .optional()
    .describe(
      "Block type: at coordinates, must match; without coordinates, nearest block of this type (e.g. furnace, blast_furnace, smoker).",
    ),
};

const furnaceOperationSchema = z
  .object({
    op_type: z
      .enum([
        "put_item",
        "put_fuel",
        "take_item",
        "take_fuel",
        "take_result",
      ])
      .describe(
        "Operation type (supported operations: put_item/put_fuel: inventory → furnace slot; take_item/take_fuel_take_result: furnace slot → inventory.).",
      ),
    item_name: z
      .string()
      .optional()
      .describe(
        "The item to be smelted. Required for put_item and put_fuel. Optional for take ops (validates slot contents). Case-insensitive.",
      ),
    count: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "The number of items to be smelted. Required for put_item and put_fuel. Optional for take ops (default: entire slot stack).",
      ),
  })
  .superRefine((operation, ctx) => {
    if (
      operation.op_type === "put_item" ||
      operation.op_type === "put_fuel"
    ) {
      if (operation.item_name === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `${operation.op_type} requires item_name.`,
          path: ["item_name"],
        });
      }
      if (operation.count === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `${operation.op_type} requires count.`,
          path: ["count"],
        });
      }
    }
  });

const onErrorSchema = z
  .enum(["skip", "stop"])
  .optional()
  .describe(
    "When an operation fails: skip = continue with remaining operations; stop = abort the rest. Defaults to skip.",
  );

function toFurnaceOperations(
  operations: z.infer<typeof furnaceOperationSchema>[],
): FurnaceOperation[] {
  return operations.map((operation) => {
    const mapped: FurnaceOperation = { op_type: operation.op_type };
    if (operation.item_name !== undefined) {
      mapped.item_name = operation.item_name;
    }
    if (operation.count !== undefined) {
      mapped.count = operation.count;
    }
    return mapped;
  });
}

const checkFurnaceTool = defineTool({
  name: "check_furnace",
  description: `
Read furnace state: input, fuel, and output slots plus smelting/fuel progress (as shown in the GUI).
Coordinates (x, y, z) are optional: omit them to use the nearest supported furnace within interaction range (4.5 blocks).
Does not move the bot; use move_to_interactable_block first when out of range.
Typical flow: find_block → move_to_interactable_block → check_furnace → interact_with_furnace.
`.trim(),
  inputSchema: z.object(furnaceCoordsSchema),
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
        FURNACE_COORDS_PARTIAL_ERROR,
      );
      if (!parsed.ok) {
        log(`[CHECK_FURNACE] ${parsed.error}`, "error");
        return createErrorToolResponse(parsed.error);
      }

      const blockResult = resolveFurnaceBlock(
        client,
        parsed.coords,
        args.block_name,
      );
      if (!blockResult.ok) {
        log(`[CHECK_FURNACE] ${blockResult.error}`, "error");
        return createErrorToolResponse(blockResult.error);
      }

      const displayCoords = coordsFromBlock(blockResult.block);
      const msg = await withFurnaceSession(
        client,
        blockResult.block,
        async (furnace) =>
          buildFurnaceSummaryFromWindow(
            furnace,
            displayCoords,
            blockResult.block.name,
          ),
      );

      log(`[CHECK_FURNACE] ${msg.replace(/\n/g, "; ")}`, "debug");
      return createToolResponse(msg);
    } catch (error) {
      const errMsg =
        error instanceof FurnaceOpenTimeoutError
          ? error.message
          : `Failed to check furnace: ${String(error)}`;
      log(`[CHECK_FURNACE] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});

const interactWithFurnaceTool = defineTool({
  name: "interact_with_furnace",
  description: `
Run one or more furnace operations in a single open session (put/take items, put/take fuel, or take results).
Coordinates (x, y, z) are optional: omit them to use the nearest supported furnace in range.
Operations run in array order. Does not move the bot — use move_to_interactable_block first when out of range.
Use check_furnace to read smelting progress and decide when to take_result.
on_error: skip (default) continues after a failed step; stop aborts remaining operations but still closes the furnace.
Typical flow: find_block → move_to_interactable_block → interact_with_furnace → check_inventory.
`.trim(),
  inputSchema: z.object({
    ...furnaceCoordsSchema,
    operations: z
      .array(furnaceOperationSchema)
      .min(1)
      .describe("Sequential furnace operations while the window stays open."),
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
        FURNACE_COORDS_PARTIAL_ERROR,
      );
      if (!parsed.ok) {
        log(`[INTERACT_WITH_FURNACE] ${parsed.error}`, "error");
        return createErrorToolResponse(parsed.error);
      }

      const onError: FurnaceOnError = args.on_error ?? "skip";

      const blockResult = resolveFurnaceBlock(
        client,
        parsed.coords,
        args.block_name,
      );
      if (!blockResult.ok) {
        log(`[INTERACT_WITH_FURNACE] ${blockResult.error}`, "error");
        return createErrorToolResponse(blockResult.error);
      }

      const displayCoords = coordsFromBlock(blockResult.block);

      const { results, furnaceSummary } = await withFurnaceSession(
        client,
        blockResult.block,
        async (furnace) => {
          const opResults = await runFurnaceOperations(
            client,
            furnace,
            toFurnaceOperations(args.operations),
            onError,
          );
          const summary = await buildFurnaceSummaryFromWindow(
            furnace,
            displayCoords,
            blockResult.block.name,
          );
          return { results: opResults, furnaceSummary: summary };
        },
      );

      const report = formatFurnaceOperationReport(
        results,
        onError,
        args.operations.length,
      );
      const invLines = summarizeInventory(client);
      const invEmpty = client.inventory.emptySlotCount();
      const msg = [
        report,
        "",
        "Furnace after operations:",
        furnaceSummary,
        "",
        "Bot inventory after operations:",
        formatInventorySummary(invLines, invEmpty),
      ].join("\n");

      const allFailed = results.length > 0 && results.every((r) => !r.ok);
      const stopWithFailure = onError === "stop" && results.some((r) => !r.ok);

      log(`[INTERACT_WITH_FURNACE] ${report.replace(/\n/g, "; ")}`, "debug");

      if (allFailed || stopWithFailure) {
        return createErrorToolResponse(msg);
      }
      return createToolResponse(msg);
    } catch (error) {
      const errMsg =
        error instanceof FurnaceOpenTimeoutError ||
        error instanceof FurnaceOperationTimeoutError
          ? error.message
          : `Failed to interact with furnace: ${String(error)}`;
      log(`[INTERACT_WITH_FURNACE] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});
