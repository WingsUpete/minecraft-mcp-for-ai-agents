import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import { Movements } from "./pathfinder/wrapper.js";
import { withPathfinderThinkTimeout } from "./pathfinder/pathfinder.js";

export type CollectTarget = Block | Entity;

type MovementsInstance = InstanceType<typeof Movements>;

const EQUIP_FOR_BLOCK_OPTIONS = {
  requireHarvest: true,
  getFromChest: false,
} as const;

/** Thrown when inventory has no tool that can harvest the target block. */
export class NoHarvestableToolError extends Error {
  readonly blockName: string;

  constructor(blockName: string) {
    super(
      `No harvestable tool in inventory to mine '${blockName}' (e.g. pickaxe for ore or stone).`,
    );
    this.name = "NoHarvestableToolError";
    this.blockName = blockName;
  }
}

function isBlockTarget(target: CollectTarget): target is Block {
  return !("kind" in target);
}

function blockTargets(target: CollectTarget | CollectTarget[]): Block[] {
  const list = Array.isArray(target) ? target : [target];
  return list.filter(isBlockTarget);
}

/**
 * Equip the best in-inventory tool for the block. Fails fast without chest lookup
 * (collectblock's default getFromChest: true can recurse when chests are unset).
 */
export async function ensureHarvestToolForBlock(
  client: Bot,
  block: Block,
): Promise<void> {
  if (client.tool == null) {
    throw new Error("mineflayer-tool plugin is not loaded");
  }

  try {
    await client.tool.equipForBlock(block, EQUIP_FOR_BLOCK_OPTIONS);
  } catch (error) {
    if (error instanceof Error && error.name === "NoItem") {
      throw new NoHarvestableToolError(block.name);
    }
    throw error;
  }
}

/** Flags collectblock enables on each collect (see mineflayer-collectblock CollectBlock.js). */
const COLLECT_FLAGS = {
  dontMineUnderFallingBlock: false,
  dontCreateFlow: false,
} as const;

/**
 * One Movements instance for pathfinder and collectblock.
 * Call once per spawn / reconnect.
 */
export function initializePathfinderMovements(client: Bot): MovementsInstance {
  if (client.collectBlock == null) {
    throw new Error("mineflayer-collectblock plugin is not loaded");
  }
  if (client.tool == null) {
    throw new Error("mineflayer-tool plugin is not loaded");
  }

  const movements = new Movements(client);
  client.pathfinder.setMovements(movements);
  client.collectBlock.movements = movements;
  return movements;
}

/**
 * Collect with unlimited path planning time. Temporarily relaxes mining safety
 * flags, then restores them (collectblock does not restore them itself).
 */
export async function collectWithPathfinderContext(
  client: Bot,
  movements: MovementsInstance,
  target: CollectTarget | CollectTarget[],
): Promise<void> {
  if (client.collectBlock == null) {
    throw new Error("mineflayer-collectblock plugin is not loaded");
  }

  for (const block of blockTargets(target)) {
    await ensureHarvestToolForBlock(client, block);
  }

  const saved = {
    dontMineUnderFallingBlock: movements.dontMineUnderFallingBlock,
    dontCreateFlow: movements.dontCreateFlow,
  };

  await withPathfinderThinkTimeout(client, async () => {
    try {
      movements.dontMineUnderFallingBlock = COLLECT_FLAGS.dontMineUnderFallingBlock;
      movements.dontCreateFlow = COLLECT_FLAGS.dontCreateFlow;
      await client.collectBlock.collect(target);
    } finally {
      movements.dontMineUnderFallingBlock = saved.dontMineUnderFallingBlock;
      movements.dontCreateFlow = saved.dontCreateFlow;
      client.pathfinder.setMovements(movements);
    }
  });
}
