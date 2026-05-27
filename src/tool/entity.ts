import * as z from "zod/v4";
import { defineTool } from "./registry.js";
import { createErrorToolResponse, createToolResponse } from "./response.js";
import { log } from "../util/logger.js";
import {
  DEFAULT_MAX_ENTITY_DISTANCE,
  findNearestEntity,
  floorEntityPosition,
} from "../util/entity.js";
import {
  DEFAULT_MAX_PICKUP_DROPS,
  DEFAULT_PER_ITEM_PICKUP_TIMEOUT_MS,
  formatPickupSummary,
  findNearestDroppedItem,
  pickupNearbyDroppedItems,
  type PickupNearbyResult,
} from "../util/item.js";
import { MovementPreemptedError } from "../util/pathfinder/manager.js";

export { findNearestEntityTool, pickupItemTool };

// TODO: find at most N nearest entities
const findNearestEntityTool = defineTool({
  name: "find_nearest_entity",
  description: `
Find the nearest entity by type name (e.g. cow, player) or dropped item id (e.g. wheat).
Omit entity_type to return the closest entity of any kind.
Returns block coordinates and entity type. Case-insensitive.
Errors if a specific entity_type was requested but none is in range.
`.trim(),
  inputSchema: z.object({
    entity_type: z
      .string()
      .optional()
      .describe(
        "Entity or dropped-item type name (e.g. cow, wheat). Omit to find the nearest entity of any type.",
      ),
    max_distance: z
      .number()
      .optional()
      .describe(
        `Search radius in blocks. Defaults to ${DEFAULT_MAX_ENTITY_DISTANCE} (server view distance: 10 chunks).`,
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
      const nearest = findNearestEntity(client, {
        entityType: args.entity_type,
        maxDistance,
      });

      if (!nearest) {
        if (args.entity_type !== undefined) {
          const errMsg = `No entity of type '${args.entity_type}' found within ${maxDistance} blocks.`;
          log(`[FIND_NEAREST_ENTITY] ${errMsg}`, "error");
          return createErrorToolResponse(errMsg);
        }
        const errMsg = `No entities found within ${maxDistance} blocks.`;
        log(`[FIND_NEAREST_ENTITY] ${errMsg}`, "error");
        return createErrorToolResponse(errMsg);
      }

      const { x, y, z } = floorEntityPosition(nearest.entity);
      const kind = nearest.isDroppedItem
        ? "dropped item (use pickup_item to collect)"
        : "entity (mob or object)";
      const msg = [
        `Nearest ${nearest.label} at (${x}, ${y}, ${z})`,
        `Distance: ${nearest.distance.toFixed(1)} blocks`,
        `Entity type: ${nearest.label}`,
        `Kind: ${kind}`,
      ].join("\n");
      log(`[FIND_NEAREST_ENTITY] ${msg.replace(/\n/g, "; ")}`, "debug");
      return createToolResponse(msg);
    } catch (error) {
      const errMsg = `Failed to find nearest entity: ${String(error)}`;
      log(`[FIND_NEAREST_ENTITY] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});

const pickupItemTool = defineTool({
  name: "pickup_item",
  description: `
Stop previous moving behavior immediately, then pathfind to collect nearby drops.
Re-scans after each drop; always visits the nearest remaining drop.
Each drop is picked up as a full stack.
Omit entity_type to pick up all nearby drop types.
Use target_count to stop after N confirmed item instances.
Use max_drops to cap how many ground drops to visit.
Returns when finished (blocking).
Errors if entity_type is set but no matching drops are in range.
`.trim(),
  inputSchema: z.object({
    entity_type: z
      .string()
      .optional()
      .describe(
        "Dropped item id to pick up (e.g. wheat). Omit to pick up all nearby dropped items.",
      ),
    max_distance: z
      .number()
      .optional()
      .describe(
        `Search radius in blocks. Defaults to ${DEFAULT_MAX_ENTITY_DISTANCE}.`,
      ),
    max_drops: z
      .number()
      .optional()
      .describe(
        `Maximum number of ground drop entities to walk to per call. Defaults to ${DEFAULT_MAX_PICKUP_DROPS}.`,
      ),
    target_count: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Stop after this many confirmed item instances are collected. With entity_type: that item only (e.g. 10 wheat). Without entity_type: any nearby drops, nearest first (e.g. 10 items to fill inventory). May exceed the target if a single drop stack is larger than the remainder.",
      ),
    per_item_timeout_ms: z
      .number()
      .optional()
      .describe(
        `Max wait per drop after reaching it. Defaults to ${DEFAULT_PER_ITEM_PICKUP_TIMEOUT_MS} ms.`,
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
      const maxDrops = args.max_drops ?? DEFAULT_MAX_PICKUP_DROPS;
      const perItemTimeoutMs =
        args.per_item_timeout_ms ?? DEFAULT_PER_ITEM_PICKUP_TIMEOUT_MS;

      const nearest = findNearestDroppedItem(client, {
        entityType: args.entity_type,
        maxDistance,
      });

      if (nearest === null) {
        if (args.entity_type !== undefined) {
          const errMsg = `No dropped items of type '${args.entity_type}' within ${maxDistance} blocks.`;
          log(`[PICKUP_ITEM] ${errMsg}`, "error");
          return createErrorToolResponse(errMsg);
        }
        const msg = `No dropped items within ${maxDistance} blocks.`;
        log(`[PICKUP_ITEM] ${msg}`, "debug");
        return createToolResponse(msg);
      }

      const result = await bot.movement.withMovementSession(
        { holder: "pickup_item" },
        async (session) =>
          pickupNearbyDroppedItems(session, client, {
            entityType: args.entity_type,
            maxDistance,
            maxDrops,
            targetCount: args.target_count,
            perItemTimeoutMs,
            initialNearest: nearest,
          }),
      );

      const msg = formatPickupSummary(result, {
        targetCount: args.target_count,
        entityType: args.entity_type,
      });
      log(`[PICKUP_ITEM] ${msg.replace(/\n/g, "; ")}`, "debug");
      return createToolResponse(msg);
    } catch (error) {
      if (error instanceof MovementPreemptedError) {
        const partial = error.detail as PickupNearbyResult | undefined;
        const summary = partial
          ? formatPickupSummary(partial, {
              targetCount: args.target_count,
              entityType: args.entity_type,
            })
          : "";
        const errMsg = `Aborted: movement preempted by ${error.preemptedBy}.${summary ? `\n\n${summary}` : ""}`;
        log(`[PICKUP_ITEM] ${errMsg.replace(/\n/g, "; ")}`, "error");
        return createErrorToolResponse(errMsg);
      }
      const errMsg = `Failed to pick up items: ${String(error)}`;
      log(`[PICKUP_ITEM] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});
