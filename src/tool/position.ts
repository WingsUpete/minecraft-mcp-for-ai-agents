import * as z from "zod/v4";
import { defineTool } from "./registry.js";
import { createErrorToolResponse, createToolResponse } from "./response.js";
import { log } from "../util/logger.js";
import { waitForPlayerEntity } from "../util/mineflayer.js";
import { MovementPreemptedError } from "../util/pathfinder/manager.js";
import { describeGoal, goals } from "../util/pathfinder/pathfinder.js";

export {
  positionTool,
  moveTool,
  followTool,
  stopMovingTool,
  movementStatusTool,
};

/**
 * Get the current position of the bot.
 */
const positionTool = defineTool({
  name: "position",
  description: "Get the current position of the bot.",
  inputSchema: z.object({}),
  handler: async (bot) => {
    try {
      await bot.ensureReadyWithin();
      const position = bot.client?.entity.position;
      if (position) {
        const x = Math.floor(position.x);
        const y = Math.floor(position.y);
        const z = Math.floor(position.z);
        const msg = `Bot is at position: (${x}, ${y}, ${z})`;
        log(`[POSITION] ${msg}`, "debug");
        return createToolResponse(msg);
      }
      return createErrorToolResponse("Bot has no position");
    } catch (error) {
      const errMsg = `Failed to get bot position: ${String(error)}`;
      log(`[POSITION] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});

/**
 * Pathfind to coordinates and wait until the bot arrives or pathfinding fails.
 * range 0 requires y (GoalBlock). range > 0 can omit y (GoalNearXZ) or specify y (GoalNear).
 */
const moveTool = defineTool({
  name: "move",
  description: `
Stop previous moving behavior and pathfind to a point (blocking).
Default range 0: exact block at (x, y, z) — y is required. Without y, use range > 0 (pathfinder picks a reachable height at that X/Z).
For opening/using a block (crafting table, furnace, chest), use move_to_interactable_block instead — move does not target a block face.
`.trim(),
  inputSchema: z.object({
    x: z.number().describe("Target X block coordinate"),
    y: z
      .number()
      .optional()
      .describe(
        "Optional target Y block coordinate. Omit to pathfind by X/Z only (any height).",
      ),
    z: z.number().describe("Target Z block coordinate"),
    range: z
      .number()
      .describe(
        "Setting to 0 means exact block at (x, y, z), which requires y. Without y, must be > 0 (horizontal radius at any reachable Y). Default 0.",
      )
      .default(0),
  }),
  handler: async (bot, args) => {
    if (args.range === 0 && args.y === undefined) {
      const errMsg =
        "range 0 requires y for an exact block. Pass y, or use range > 0 for X/Z-only movement.";
      log(`[MOVE] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
    try {
      await bot.ensureReadyWithin();
      const goal =
        args.y !== undefined
          ? args.range === 0
            ? new goals.GoalBlock(args.x, args.y, args.z)
            : new goals.GoalNear(args.x, args.y, args.z, args.range)
          : new goals.GoalNearXZ(args.x, args.z, args.range);
      await bot.movement.withMovementSession(
        { holder: "move" },
        async (session) => {
          await session.goto(goal);
        },
      );
    } catch (error) {
      if (error instanceof MovementPreemptedError) {
        const errMsg = `Aborted: movement preempted by ${error.preemptedBy}.`;
        log(`[MOVE] ${errMsg}`, "error");
        return createErrorToolResponse(errMsg);
      }
      const errMsg = `Failed to move: ${String(error)}`;
      log(`[MOVE] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
    const target =
      args.y !== undefined
        ? `(${args.x}, ${args.y}, ${args.z})`
        : `(${args.x}, ?, ${args.z})`;
    const resMsg =
      args.range === 0
        ? `Reached ${target}.`
        : `Reached ${target} within ${args.range} block(s).`;
    log(`[MOVE] ${resMsg}`, "debug");
    return createToolResponse(resMsg);
  },
});

/**
 * Follow a player at a given range until stop_moving or move is called.
 * Uses GoalFollow with dynamic goal updates (setGoal(..., true)).
 */
const followTool = defineTool({
  name: "follow",
  description: `
Stop previous moving behavior immediately and follow a player, staying within range blocks.
Player name must match exactly (case-sensitive).
Waits briefly for the target to load if they are nearby but not yet visible to the bot.
Returns immediately once follow starts; does not wait for arrival.
`.trim(),
  inputSchema: z.object({
    player: z
      .string()
      .describe("Exact Minecraft username of the player to follow"),
    range: z
      .number()
      .describe(
        "Distance in blocks to maintain from the player. Defaults to 3.",
      )
      .default(3),
  }),
  handler: async (bot, args) => {
    try {
      await bot.ensureReadyWithin();
      const entity = await waitForPlayerEntity(bot.client!, args.player);
      await bot.movement.withMovementSession(
        { holder: "follow", releaseOnComplete: false },
        async (session) => {
          session.setGoal(new goals.GoalFollow(entity, args.range), true);
        },
      );
    } catch (error) {
      const errMsg = `Failed to set follow goal: ${String(error)}`;
      log(`[FOLLOW] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
    const resMsg = `Following ${args.player} with range ${args.range}`;
    log(`[FOLLOW] ${resMsg}`, "debug");
    return createToolResponse(resMsg);
  },
});

/**
 * Clear the pathfinder goal and stop active pathfinding (move or follow).
 */
const stopMovingTool = defineTool({
  name: "stop_moving",
  description: `
Stop previous moving behavior immediately and clear the active pathfinder goal (move, follow, etc.).
Returns immediately.
`.trim(),
  inputSchema: z.object({}),
  handler: async (bot) => {
    try {
      await bot.ensureReadyWithin();
      await bot.movement.withMovementSession(
        { holder: "stop_moving" },
        async (session) => {
          session.cancelMovement();
        },
      );
    } catch (error) {
      const errMsg = `Failed to stop movement: ${String(error)}`;
      log(`[STOP_MOVING] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
    const resMsg = "Stopped moving";
    log(`[STOP_MOVING] ${resMsg}`, "debug");
    return createToolResponse(resMsg);
  },
});

/**
 * Report current pathfinder goal and whether the bot is actively walking.
 */
const movementStatusTool = defineTool({
  name: "movement_status",
  description: `
Get current movement status: active goal (follow, etc.), movement owner, whether the bot is walking a path, and whether the goal is satisfied.
Useful during follow (non-blocking).
Read-only; does not change movement.
`.trim(),
  inputSchema: z.object({}),
  handler: async (bot) => {
    try {
      await bot.ensureReadyWithin();
      const client = bot.client;
      if (!client?.entity?.position) {
        return createErrorToolResponse("Bot has no position");
      }
      const pathfinder = client.pathfinder;
      const goal = pathfinder.goal;
      const walking = pathfinder.isMoving();
      const mining = pathfinder.isMining();
      const building = pathfinder.isBuilding();

      const lines: string[] = [];
      const movementHolder = bot.movement.currentHolder;
      if (movementHolder) {
        lines.push(`Movement owner: ${movementHolder}`);
      }
      if (!goal) {
        lines.push("Goal: none (idle)");
      } else {
        lines.push(`Goal: ${describeGoal(goal)}`);
        const p = client.entity.position;
        const atGoal = goal.isEnd({
          x: Math.floor(p.x),
          y: Math.floor(p.y),
          z: Math.floor(p.z),
        } as Parameters<typeof goal.isEnd>[0]);
        lines.push(`At goal: ${atGoal ? "yes" : "no"}`);
      }
      lines.push(`Walking along the path: ${walking ? "yes" : "no"}`);
      if (mining) {
        lines.push("Mining: yes");
      }
      if (building) {
        lines.push("Placing block: yes");
      }

      const msg = lines.join("\n");
      log(`[MOVEMENT_STATUS] ${msg.replace(/\n/g, "; ")}`, "debug");
      return createToolResponse(msg);
    } catch (error) {
      const errMsg = `Failed to get movement status: ${String(error)}`;
      log(`[MOVEMENT_STATUS] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});
