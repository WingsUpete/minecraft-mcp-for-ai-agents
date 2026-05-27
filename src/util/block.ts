import { createRequire } from "node:module";
import type { Bot as MineflayerBot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import { wait } from "./common.js";
import {
  holdSneakWhile,
  SNEAK_HOLD_AFTER_MS,
  SNEAK_SETTLE_MS,
} from "./control.js";
import { DEFAULT_MAX_ENTITY_DISTANCE } from "./entity.js";

const BLOCK_PLACED_TIMEOUT_MS = 6_000;

const require = createRequire(import.meta.url);
const INTERACTABLE_BLOCKS = new Set<string>(
  require("mineflayer-pathfinder/lib/interactable.json") as string[],
);

export { DEFAULT_MAX_ENTITY_DISTANCE };

/**
 * Max distance (blocks) to use/open a block (crafting table, chest, etc.).
 * Aligns with mineflayer-pathfinder GoalLookAtBlock default reach (survival 4.5).
 */
export const DEFAULT_BLOCK_INTERACT_DISTANCE = 4.5;

export type BlockCoords = {
  x: number;
  y: number;
  z: number;
};

export type ParseOptionalBlockCoordsResult =
  | { ok: true; coords: BlockCoords | undefined }
  | { ok: false; error: string };

/** All three coordinates, or none. Rejects partial x/y/z. */
export function parseOptionalBlockCoords(
  x: number | undefined,
  y: number | undefined,
  z: number | undefined,
  partialErrorMessage: string,
): ParseOptionalBlockCoordsResult {
  const fields = [x, y, z];
  const count = fields.filter((value) => value !== undefined).length;
  if (count === 0) {
    return { ok: true, coords: undefined };
  }
  if (count !== 3) {
    return { ok: false, error: partialErrorMessage };
  }
  return { ok: true, coords: { x: x!, y: y!, z: z! } };
}

export type BlockFindResult = {
  name: string;
  coords: BlockCoords;
  distance: number;
};

export type PlaceFace = "up" | "down" | "north" | "south" | "east" | "west";

const FACE_VECTORS: Record<PlaceFace, Vec3> = {
  up: new Vec3(0, 1, 0),
  down: new Vec3(0, -1, 0),
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0),
  west: new Vec3(-1, 0, 0),
};

export function normalizeBlockName(name: string): string {
  return name.trim().toLowerCase();
}

export function blockMatchesName(block: Block, blockName: string): boolean {
  return normalizeBlockName(block.name) === normalizeBlockName(blockName);
}

export function faceVector(face: PlaceFace): Vec3 {
  return FACE_VECTORS[face];
}

/** Air cell where the new block will be placed. */
export function placementPosition(
  referenceBlock: Block,
  face: PlaceFace,
): Vec3 {
  return referenceBlock.position.plus(faceVector(face));
}

/** Direction from placement cell to the reference block (GoalPlaceBlock `faces`). */
export function referenceClickDir(face: PlaceFace): Vec3 {
  return faceVector(face).scaled(-1);
}

const AIR_BLOCKS = new Set(["air", "cave_air", "void_air"]);

/** Since 1.13, still/source fluid is just `water` / `lava` (no separate flowing_* blocks). */
const FLUID_BLOCK_NAMES = new Set(["water", "lava"]);

/**
 * Members of `#minecraft:replaceable` (grasses, ferns, etc.) — cleared when a block is placed in the cell.
 * Flowers and torches are not in this tag.
 */
const REPLACEABLE_VEGETATION = new Set([
  "short_grass",
  "tall_grass",
  "fern",
  "large_fern",
  "dead_bush",
  "vine",
  "glow_lichen",
  "hanging_roots",
  "seagrass",
  "tall_seagrass",
]);

export function isAirBlock(block: Block): boolean {
  return AIR_BLOCKS.has(block.name);
}

/** Fluids can be replaced by placing a block into the cell. */
export function isPlaceableFluid(block: Block): boolean {
  if (FLUID_BLOCK_NAMES.has(block.name)) {
    return true;
  }
  const material = block.material ?? "";
  return material.includes("water") || material.includes("lava");
}

/** Grasses/ferns in the replaceable tag — placement is allowed and removes them. */
export function isReplaceableVegetation(block: Block): boolean {
  return REPLACEABLE_VEGETATION.has(block.name);
}

function isTorchBlock(block: Block): boolean {
  return block.name.includes("torch");
}

/**
 * Flowers, torches, etc. — empty cell occupiers that are not replaceable by placement.
 */
export function isNonPlaceableDecoration(block: Block): boolean {
  if (
    isAirBlock(block) ||
    isPlaceableFluid(block) ||
    isReplaceableVegetation(block)
  ) {
    return false;
  }
  return block.boundingBox === "empty";
}

export function requiresSneakToPlace(block: Block): boolean {
  return INTERACTABLE_BLOCKS.has(block.name);
}

/** Air, fluids, or replaceable vegetation (grass/fern) are valid placement destinations. */
export function canPlaceAt(client: MineflayerBot, pos: Vec3): boolean {
  const block = client.blockAt(pos);
  if (block === null) {
    return false;
  }
  return (
    isAirBlock(block) ||
    isPlaceableFluid(block) ||
    isReplaceableVegetation(block)
  );
}

export function describePlacementCell(block: Block): string {
  if (isNonPlaceableDecoration(block)) {
    if (isTorchBlock(block)) {
      return `cell has '${block.name}' (torches cannot be covered — break or remove it first)`;
    }
    return `cell has '${block.name}' (flowers cannot be covered — break or remove it first)`;
  }
  if (isReplaceableVegetation(block)) {
    return `cell has '${block.name}' (will be replaced when placing)`;
  }
  if (isPlaceableFluid(block)) {
    return `cell has fluid '${block.name}'`;
  }
  return `cell is '${block.name}'`;
}

export type ResolvedPlacement = {
  referenceBlock: Block;
  placePos: Vec3;
};

/** Reference block at coords and the cell where the new block would go. */
export function resolvePlacement(
  client: MineflayerBot,
  coords: BlockCoords,
  face: PlaceFace,
): ResolvedPlacement | { error: string } {
  const referenceBlock = blockAtCoords(client, coords);
  if (referenceBlock === null) {
    return {
      error: `No reference block at (${coords.x}, ${coords.y}, ${coords.z}).`,
    };
  }
  if (isAirBlock(referenceBlock)) {
    return {
      error: `Reference block at (${coords.x}, ${coords.y}, ${coords.z}) is '${referenceBlock.name}' — cannot place against air; use a solid adjacent block.`,
    };
  }

  const placePos = placementPosition(referenceBlock, face);
  return { referenceBlock, placePos };
}

function waitForBlockPlacedAt(
  client: MineflayerBot,
  placePos: Vec3,
  timeoutMs: number,
): { promise: Promise<void>; cancel: () => void } {
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  let onPlaced!: (_oldBlock: Block | null, newBlock: Block | null) => void;

  const cleanup = () => {
    clearTimeout(timer);
    client.removeListener("blockPlaced" as never, onPlaced as never);
  };

  const promise = new Promise<void>((resolve, reject) => {
    onPlaced = (_oldBlock, newBlock) => {
      if (settled) {
        return;
      }
      if (newBlock?.position.equals(placePos)) {
        settled = true;
        cleanup();
        resolve();
      }
    };

    client.on("blockPlaced" as never, onPlaced as never);
    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(
        new Error(
          `blockPlaced did not fire for (${placePos.x}, ${placePos.y}, ${placePos.z}) within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });

  const cancel = () => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
  };

  return { promise, cancel };
}

/***
 * Place a block with or without sneak depending on the reference block.
 * Some blocks are interactable and require sneak to place when they are reference blocks.
 * Check {@linkcode holdSneakWhile} for how it is implemented.
 */
export async function placeBlockWithSneakIfNeeded(
  client: MineflayerBot,
  referenceBlock: Block,
  face: PlaceFace,
): Promise<void> {
  const needsSneak = requiresSneakToPlace(referenceBlock);
  const placePos = placementPosition(referenceBlock, face);

  const place = async () => {
    if (needsSneak) {
      await wait(SNEAK_SETTLE_MS);
    }

    const { promise: placed, cancel } = waitForBlockPlacedAt(
      client,
      placePos,
      BLOCK_PLACED_TIMEOUT_MS,
    );

    try {
      await Promise.all([
        client.placeBlock(referenceBlock, faceVector(face)),
        placed,
      ]);
      if (needsSneak) {
        await wait(SNEAK_HOLD_AFTER_MS);
      }
    } catch (error) {
      cancel();
      throw error;
    }
  };

  if (needsSneak) {
    await holdSneakWhile(client, place);
  } else {
    await place();
  }
}

export function blockAtCoords(
  client: MineflayerBot,
  coords: BlockCoords,
): Block | null {
  return client.blockAt(new Vec3(coords.x, coords.y, coords.z));
}

export function coordsFromBlock(block: Block): BlockCoords {
  const p = block.position;
  return { x: p.x, y: p.y, z: p.z };
}

export type ResolveInteractableBlockResult =
  | { ok: true; block: Block }
  | { ok: false; error: string };

export type ResolveInteractableBlockOptions = {
  /** Block position. When omitted, searches for the nearest matching block in range. */
  coords?: BlockCoords;
  /** Allowed block names at coords or for nearest search (e.g. crafting_table, chest). */
  allowedNames: ReadonlySet<string>;
  /** Label for error messages (e.g. "chest", "crafting table"). */
  label: string;
  /** Whether to check if the block is reachable (default false). */
  checkReach?: boolean;
  /** Hint for reach check failure messages (e.g. "Move beside it before crafting"). */
  reachHint?: string;
  /** Max distance to search for a block (default 4.5 blocks). */
  maxDistance?: number;
};

/** Within interaction reach; returns a failure message when not reachable. */
export function assertBlockReachable(
  client: MineflayerBot,
  block: Block,
  label: string,
  reachHint?: string,
): ResolveInteractableBlockResult {
  if (!canInteractBlock(client, block)) {
    const msg = describeBlockInteractFailure(client, block, label);
    return {
      ok: false,
      error: reachHint !== undefined ? `${msg} ${reachHint}` : msg,
    };
  }
  return { ok: true, block };
}

function blockMatchesAllowedNames(
  block: Block,
  allowedNames: ReadonlySet<string>,
): boolean {
  return allowedNames.has(block.name);
}

/** Nearest reachable block whose name is in allowedNames. */
export function findNearestInteractableBlockFromNames(
  client: MineflayerBot,
  options: {
    allowedNames: ReadonlySet<string>;
    maxDistance: number;
  },
): BlockFindResult | null {
  if (!client.entity) {
    return null;
  }

  const positions = client.findBlocks({
    point: client.entity.position,
    matching: (b) => blockMatchesAllowedNames(b, options.allowedNames),
    maxDistance: options.maxDistance,
    count: 32,
  });

  let nearest: BlockFindResult | null = null;
  for (const pos of positions) {
    const block = client.blockAt(pos);
    if (
      block === null ||
      !canInteractBlock(client, block, options.maxDistance)
    ) {
      continue;
    }
    const distance = distanceToBlock(client, block);
    if (nearest === null || distance < nearest.distance) {
      nearest = {
        name: block.name,
        coords: { x: pos.x, y: pos.y, z: pos.z },
        distance,
      };
    }
  }

  return nearest;
}

export function resolveInteractableBlock(
  client: MineflayerBot,
  options: ResolveInteractableBlockOptions,
): ResolveInteractableBlockResult {
  const maxDistance = options.maxDistance ?? DEFAULT_BLOCK_INTERACT_DISTANCE;
  const { allowedNames, label, checkReach = false, reachHint } = options;
  const supportedList = [...allowedNames].join(", ");

  let block: Block | null = null;

  if (options.coords !== undefined) {
    const coords = options.coords;
    block = blockAtCoords(client, coords);
    if (block === null) {
      return {
        ok: false,
        error: `No block at (${coords.x}, ${coords.y}, ${coords.z}).`,
      };
    }

    if (!blockMatchesAllowedNames(block, allowedNames)) {
      return {
        ok: false,
        error: `Block at (${coords.x}, ${coords.y}, ${coords.z}) is '${block.name}', not a supported ${label} (${supportedList}).`,
      };
    }
  } else {
    const found = findNearestInteractableBlockFromNames(client, {
      allowedNames,
      maxDistance,
    });
    if (found === null) {
      return {
        ok: false,
        error: `No ${label} within ${maxDistance} blocks (supported: ${supportedList}). Move closer or use find_block with coordinates.`,
      };
    }
    block = blockAtCoords(client, found.coords);
    if (block === null) {
      return {
        ok: false,
        error: `${label} at (${found.coords.x}, ${found.coords.y}, ${found.coords.z}) is not loaded.`,
      };
    }
  }

  if (checkReach) {
    return assertBlockReachable(client, block, label, reachHint);
  }

  return { ok: true, block };
}

/** Distance from the bot to the center of a block (for reach checks). */
export function distanceToBlock(client: MineflayerBot, block: Block): number {
  const center = block.position.offset(0.5, 0.5, 0.5);
  return Math.sqrt(client.entity.position.distanceSquared(center));
}

export function isWithinBlockInteractDistance(
  client: MineflayerBot,
  block: Block,
  maxDistance = DEFAULT_BLOCK_INTERACT_DISTANCE,
): boolean {
  return distanceToBlock(client, block) <= maxDistance;
}

/** Within interaction reach (survival default 4.5 blocks). LOS not checked — mineflayer faces the block on use. */
export function canInteractBlock(
  client: MineflayerBot,
  block: Block,
  maxDistance = DEFAULT_BLOCK_INTERACT_DISTANCE,
): boolean {
  if (!client.entity) {
    return false;
  }
  return isWithinBlockInteractDistance(client, block, maxDistance);
}

export function describeBlockInteractFailure(
  client: MineflayerBot,
  block: Block,
  blockLabel: string,
  maxDistance = DEFAULT_BLOCK_INTERACT_DISTANCE,
): string {
  const { x, y, z } = block.position;
  const dist = distanceToBlock(client, block);
  if (dist > maxDistance) {
    return `${blockLabel} at (${x}, ${y}, ${z}) is ${dist.toFixed(1)} blocks away (max ${maxDistance}). Move the bot closer.`;
  }
  return `${blockLabel} at (${x}, ${y}, ${z}) cannot be interacted with from the current position.`;
}

/** Nearest matching block within interaction range. */
export function findNearestInteractableBlock(
  client: MineflayerBot,
  options: {
    blockName: string;
    maxDistance: number;
  },
): BlockFindResult | null {
  if (!client.entity) {
    return null;
  }

  const positions = client.findBlocks({
    point: client.entity.position,
    matching: (b) => blockMatchesName(b, options.blockName),
    maxDistance: options.maxDistance,
    count: 32,
  });

  for (const pos of positions) {
    const block = client.blockAt(pos);
    if (
      block === null ||
      !canInteractBlock(client, block, options.maxDistance)
    ) {
      continue;
    }
    return {
      name: block.name,
      coords: { x: pos.x, y: pos.y, z: pos.z },
      distance: distanceToBlock(client, block),
    };
  }

  return null;
}

export function findNearestBlock(
  client: MineflayerBot,
  options: {
    blockName: string;
    maxDistance: number;
  },
): BlockFindResult | null {
  const block = client.findBlock({
    point: client.entity.position,
    matching: (b) => blockMatchesName(b, options.blockName),
    maxDistance: options.maxDistance,
  });
  if (block === null) {
    return null;
  }

  const { x, y, z } = block.position;
  return {
    name: block.name,
    coords: { x, y, z },
    distance: Math.sqrt(client.entity.position.distanceSquared(block.position)),
  };
}

export function formatBlockFindResult(result: BlockFindResult): string {
  return [
    `Block: ${result.name}`,
    `Coordinates: (${result.coords.x}, ${result.coords.y}, ${result.coords.z})`,
    `Distance: ${result.distance.toFixed(1)} blocks`,
  ].join("\n");
}
