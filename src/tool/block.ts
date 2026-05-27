import * as z from "zod/v4";
import { defineTool } from "./registry.js";
import { createErrorToolResponse, createToolResponse } from "./response.js";
import { log } from "../util/logger.js";
import {
  blockAtCoords,
  blockMatchesName,
  canInteractBlock,
  canPlaceAt,
  DEFAULT_BLOCK_INTERACT_DISTANCE,
  DEFAULT_MAX_ENTITY_DISTANCE,
  describeBlockInteractFailure,
  describePlacementCell,
  findNearestBlock,
  formatBlockFindResult,
  placeBlockWithSneakIfNeeded,
  referenceClickDir,
  resolvePlacement,
  type PlaceFace,
} from "../util/block.js";
import {
  equipItemInHand,
  findInventoryItem,
  findInventoryItems,
  totalInventoryCount,
} from "../util/inventory.js";
import {
  collectWithPathfinderContext,
  NoHarvestableToolError,
} from "../util/collectblock.js";
import { MovementPreemptedError } from "../util/pathfinder/manager.js";
import { goals } from "../util/pathfinder/wrapper.js";

export {
  findBlockTool,
  collectBlockTool,
  placeBlockTool,
  moveToInteractableBlockTool,
  dropBlockTool,
};

const placeFaceSchema = z
  .enum(["up", "down", "north", "south", "east", "west"])
  .describe(
    "Face of the reference block to place against. Defaults to up (place on top).",
  );

// TODO: find at most N nearest blocks
const findBlockTool = defineTool({
  name: "find_block",
  description: `
Find the nearest world block by name (case-insensitive).
Returns block name and coordinates.
Errors if no matching block is in range.
`.trim(),
  inputSchema: z.object({
    block_name: z
      .string()
      .describe("Block name to search for (e.g. oak_log, stone, furnace)."),
    max_distance: z
      .number()
      .optional()
      .describe(
        `Search radius in blocks. Defaults to ${DEFAULT_MAX_ENTITY_DISTANCE}.`,
      ),
  }),
  handler: async (bot, args) => {
    try {
      await bot.ensureReadyWithin();
      const client = bot.client;
      if (!client?.entity?.position) {
        return createErrorToolResponse("Bot has no position");
      }

      const maxDistance = args.max_distance ?? DEFAULT_MAX_ENTITY_DISTANCE;
      const found = findNearestBlock(client, {
        blockName: args.block_name,
        maxDistance,
      });

      if (found === null) {
        const errMsg = `No block '${args.block_name}' found within ${maxDistance} blocks.`;
        log(`[FIND_BLOCK] ${errMsg}`, "error");
        return createErrorToolResponse(errMsg);
      }

      const msg = formatBlockFindResult(found);
      log(`[FIND_BLOCK] ${msg.replace(/\n/g, "; ")}`, "debug");
      return createToolResponse(msg);
    } catch (error) {
      const errMsg = `Failed to find block: ${String(error)}`;
      log(`[FIND_BLOCK] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});

// TODO: very long mining will timeout bot.dig
const collectBlockTool = defineTool({
  name: "collect_block",
  description: `
Pathfind to a block, mine it, and pick up drops (uses mineflayer-collectblock).
Provide block_name to find the nearest match, or x/y/z to target a specific position.
When coordinates are given, block_name must still match that block.
Returns when collection finishes (blocking).
`.trim(),
  inputSchema: z.object({
    block_name: z
      .string()
      .describe("Block name to collect (e.g. oak_log, coal_ore)."),
    x: z
      .number()
      .int()
      .optional()
      .describe("Target block X coordinate. Omit to find the nearest match."),
    y: z.number().int().optional().describe("Target block Y coordinate."),
    z: z.number().int().optional().describe("Target block Z coordinate."),
    max_distance: z
      .number()
      .optional()
      .describe(
        `Search radius when finding by name. Defaults to ${DEFAULT_MAX_ENTITY_DISTANCE}.`,
      ),
  }),
  handler: async (bot, args) => {
    try {
      await bot.ensureReadyWithin();
      const client = bot.client;
      if (!client?.entity?.position) {
        return createErrorToolResponse("Bot has no position");
      }

      const hasCoords =
        args.x !== undefined && args.y !== undefined && args.z !== undefined;

      let targetBlock;
      if (hasCoords) {
        targetBlock = blockAtCoords(client, {
          x: args.x!,
          y: args.y!,
          z: args.z!,
        });
        if (targetBlock === null) {
          const errMsg = `No block at (${args.x}, ${args.y}, ${args.z}).`;
          log(`[COLLECT_BLOCK] ${errMsg}`, "error");
          return createErrorToolResponse(errMsg);
        }
        if (!blockMatchesName(targetBlock, args.block_name)) {
          const errMsg = `Block at (${args.x}, ${args.y}, ${args.z}) is '${targetBlock.name}', not '${args.block_name}'.`;
          log(`[COLLECT_BLOCK] ${errMsg}`, "error");
          return createErrorToolResponse(errMsg);
        }
      } else {
        const maxDistance = args.max_distance ?? DEFAULT_MAX_ENTITY_DISTANCE;
        const found = findNearestBlock(client, {
          blockName: args.block_name,
          maxDistance,
        });
        if (found === null) {
          const errMsg = `No block '${args.block_name}' found within ${maxDistance} blocks.`;
          log(`[COLLECT_BLOCK] ${errMsg}`, "error");
          return createErrorToolResponse(errMsg);
        }
        targetBlock = blockAtCoords(client, found.coords);
        if (targetBlock === null) {
          const errMsg = `Block '${args.block_name}' disappeared before collection.`;
          log(`[COLLECT_BLOCK] ${errMsg}`, "error");
          return createErrorToolResponse(errMsg);
        }
      }

      const defaultMovements = bot.pathfinderMovements;
      if (defaultMovements === null) {
        return createErrorToolResponse(
          "Pathfinder movements are not initialized (bot not spawned).",
        );
      }

      const pos = targetBlock.position;
      await bot.movement.withMovementSession(
        { holder: "collect_block" },
        async () => {
          await collectWithPathfinderContext(
            client,
            defaultMovements,
            targetBlock,
          );
        },
      );

      const msg = `Collected block '${targetBlock.name}' at (${pos.x}, ${pos.y}, ${pos.z}).`;
      log(`[COLLECT_BLOCK] ${msg}`, "debug");
      return createToolResponse(msg);
    } catch (error) {
      if (error instanceof NoHarvestableToolError) {
        const errMsg = error.message;
        log(`[COLLECT_BLOCK] ${errMsg}`, "error");
        return createErrorToolResponse(errMsg);
      }
      if (error instanceof MovementPreemptedError) {
        const client = bot.client;
        if (client?.collectBlock) {
          try {
            await client.collectBlock.cancelTask();
          } catch {
            /* ignore cancel errors */
          }
        }
        const errMsg = `Aborted: movement preempted by ${error.preemptedBy}.`;
        log(`[COLLECT_BLOCK] ${errMsg}`, "error");
        return createErrorToolResponse(errMsg);
      }
      const errMsg = `Failed to collect block: ${String(error)}`;
      log(`[COLLECT_BLOCK] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});

const placeBlockTool = defineTool({
  name: "place_block",
  description: `
Place a block item from the bot inventory against a reference block face.
Pathfinds to a reachable position (GoalPlaceBlock), equips the item, then places it.
Reference block at (x, y, z). The placement cell must be air, water/lava, or replaceable grass/fern (not flowers or torches).
Sneaks when placing against usable blocks (crafting table, furnace, chest, etc.) so they are not opened.
Defaults to placing on top (face up).
If placement times out (blockUpdate timeout), an entity may be occupying the placement cell — move aside and retry.
`.trim(),
  inputSchema: z.object({
    block_name: z
      .string()
      .describe(
        "Inventory item/block name to place (e.g. crafting_table, furnace, dirt).",
      ),
    x: z.number().int().describe("Reference block X coordinate."),
    y: z.number().int().describe("Reference block Y coordinate."),
    z: z.number().int().describe("Reference block Z coordinate."),
    face: placeFaceSchema.optional(),
  }),
  handler: async (bot, args) => {
    try {
      await bot.ensureReadyWithin();
      const client = bot.client;
      if (!client?.entity?.position) {
        return createErrorToolResponse("Bot has no position");
      }

      const face: PlaceFace = args.face ?? "up";
      const resolved = resolvePlacement(
        client,
        { x: args.x, y: args.y, z: args.z },
        face,
      );
      if ("error" in resolved) {
        log(`[PLACE_BLOCK] ${resolved.error}`, "error");
        return createErrorToolResponse(resolved.error);
      }
      const { referenceBlock, placePos } = resolved;

      const item = findInventoryItem(client, args.block_name);
      if (item === null) {
        const errMsg = `No '${args.block_name}' in inventory.`;
        log(`[PLACE_BLOCK] ${errMsg}`, "error");
        return createErrorToolResponse(errMsg);
      }

      if (!canPlaceAt(client, placePos)) {
        const at = blockAtCoords(client, {
          x: placePos.x,
          y: placePos.y,
          z: placePos.z,
        });
        const errMsg = at
          ? `Cannot place at (${placePos.x}, ${placePos.y}, ${placePos.z}): ${describePlacementCell(at)}.`
          : `Cannot place at (${placePos.x}, ${placePos.y}, ${placePos.z}): position not loaded.`;
        log(`[PLACE_BLOCK] ${errMsg}`, "error");
        return createErrorToolResponse(errMsg);
      }

      await bot.movement.withMovementSession(
        { holder: "place_block" },
        async (session) => {
          // Only restrict which adjacent face to click; range (5) and LOS (true) use pathfinder defaults.
          const goal = new goals.GoalPlaceBlock(placePos, client.world, {
            faces: [referenceClickDir(face)],
          });
          await session.goto(goal);
          await equipItemInHand(client, item);
          await placeBlockWithSneakIfNeeded(client, referenceBlock, face);
        },
      );
      const ref = referenceBlock.position;
      const msg = [
        `Placed '${item.name}' against (${ref.x}, ${ref.y}, ${ref.z}) face ${face}.`,
        `Placement position: (${placePos.x}, ${placePos.y}, ${placePos.z}).`,
      ].join("\n");
      log(`[PLACE_BLOCK] ${msg.replace(/\n/g, "; ")}`, "debug");
      return createToolResponse(msg);
    } catch (error) {
      if (error instanceof MovementPreemptedError) {
        const errMsg = `Aborted: movement preempted by ${error.preemptedBy}.`;
        log(`[PLACE_BLOCK] ${errMsg}`, "error");
        return createErrorToolResponse(errMsg);
      }
      const errMsg = `Failed to place block: ${String(error)}`;
      log(`[PLACE_BLOCK] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});

/***
 * GoalLookAtBlock is used for pathfinding
 */
const moveToInteractableBlockTool = defineTool({
  name: "move_to_interactable_block",
  description: `
Pathfind until the bot can open/use a specific world block: within interaction reach (4.5 blocks).
Use for crafting tables, furnaces, chests, etc. before craft_item or other interactions — NOT for walking to empty coordinates.

Difference from move:
- move: goes to a point (x,y,z); does not target a block or a block face.
- move_to_interactable_block: goes to an existing block at (x,y,z) for use/open (GoalLookAtBlock).

Typical flow: find_block → move_to_interactable_block (same coordinates) → craft_item / container tools.
Optional block_name verifies the block type at that position.
`.trim(),
  inputSchema: z.object({
    x: z.number().int().describe("Block X coordinate (from find_block)."),
    y: z.number().int().describe("Block Y coordinate."),
    z: z.number().int().describe("Block Z coordinate."),
    block_name: z
      .string()
      .optional()
      .describe(
        "If set, the block at (x,y,z) must match this name (e.g. crafting_table, furnace).",
      ),
  }),
  handler: async (bot, args) => {
    try {
      await bot.ensureReadyWithin();
      const client = bot.client;
      if (!client?.entity?.position) {
        return createErrorToolResponse("Bot has no position");
      }

      const block = blockAtCoords(client, {
        x: args.x,
        y: args.y,
        z: args.z,
      });
      if (block === null) {
        const errMsg = `No block at (${args.x}, ${args.y}, ${args.z}).`;
        log(`[MOVE_TO_INTERACTABLE_BLOCK] ${errMsg}`, "error");
        return createErrorToolResponse(errMsg);
      }
      if (
        args.block_name !== undefined &&
        !blockMatchesName(block, args.block_name)
      ) {
        const errMsg = `Block at (${args.x}, ${args.y}, ${args.z}) is '${block.name}', not '${args.block_name}'.`;
        log(`[MOVE_TO_INTERACTABLE_BLOCK] ${errMsg}`, "error");
        return createErrorToolResponse(errMsg);
      }

      const goal = new goals.GoalLookAtBlock(block.position, client.world, {
        reach: DEFAULT_BLOCK_INTERACT_DISTANCE,
      });

      await bot.movement.withMovementSession(
        { holder: "move_to_interactable_block" },
        async (session) => {
          await session.goto(goal);
        },
      );

      const label = args.block_name ?? block.name;
      if (!canInteractBlock(client, block)) {
        const errMsg = `${describeBlockInteractFailure(client, block, label)} Pathfinding finished but interaction may still fail.`;
        log(`[MOVE_TO_INTERACTABLE_BLOCK] ${errMsg}`, "error");
        return createErrorToolResponse(errMsg);
      }

      const msg = `Reached interaction range of ${label} at (${args.x}, ${args.y}, ${args.z}).`;
      log(`[MOVE_TO_INTERACTABLE_BLOCK] ${msg}`, "debug");
      return createToolResponse(msg);
    } catch (error) {
      if (error instanceof MovementPreemptedError) {
        const errMsg = `Aborted: movement preempted by ${error.preemptedBy}.`;
        log(`[MOVE_TO_INTERACTABLE_BLOCK] ${errMsg}`, "error");
        return createErrorToolResponse(errMsg);
      }
      const errMsg = `Failed to move to interactable block: ${String(error)}`;
      log(`[MOVE_TO_INTERACTABLE_BLOCK] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});

const dropBlockTool = defineTool({
  name: "drop_block",
  description: `
Drop items from the inventory onto the ground.
Case-insensitive item name. Drops 1 by default; can pull from multiple stacks when count > 1.
`.trim(),
  inputSchema: z.object({
    block_name: z
      .string()
      .describe("Inventory item/block name to drop (e.g. dirt, cobblestone)."),
    count: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Number of items to drop. Defaults to 1."),
  }),
  handler: async (bot, args) => {
    try {
      await bot.ensureReadyWithin();
      const client = bot.client;
      if (!client?.entity?.position) {
        return createErrorToolResponse("Bot has no position");
      }

      const stacks = findInventoryItems(client, args.block_name);
      if (stacks.length === 0) {
        const errMsg = `No '${args.block_name}' in inventory.`;
        log(`[DROP_BLOCK] ${errMsg}`, "error");
        return createErrorToolResponse(errMsg);
      }

      const itemName = stacks[0]!.name;
      const totalCount = totalInventoryCount(client, args.block_name, stacks);
      const dropCount = args.count ?? 1;
      if (dropCount > totalCount) {
        const errMsg = `Cannot drop ${dropCount} of '${itemName}': only ${totalCount} in inventory (${stacks.length} stack(s)).`;
        log(`[DROP_BLOCK] ${errMsg}`, "error");
        return createErrorToolResponse(errMsg);
      }

      // toss() walks the inventory and can pull from multiple stacks in one call.
      await client.toss(stacks[0]!.type, null, dropCount);

      const msg = `Dropped ${dropCount} x '${itemName}' (from ${stacks.length} stack(s), ${totalCount} total before drop).`;
      log(`[DROP_BLOCK] ${msg}`, "debug");
      return createToolResponse(msg);
    } catch (error) {
      const errMsg = `Failed to drop block: ${String(error)}`;
      log(`[DROP_BLOCK] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});
