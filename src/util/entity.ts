import type { Bot as MineflayerBot } from "mineflayer";
import type { Entity } from "prismarine-entity";

/** Server view distance in sandbox compose (chunks). */
export const VIEW_DISTANCE_CHUNKS = 10;

export const BLOCKS_PER_CHUNK = 16;

/** Default entity search radius: view distance in blocks (10 chunks × 16). */
export const DEFAULT_MAX_ENTITY_DISTANCE =
  VIEW_DISTANCE_CHUNKS * BLOCKS_PER_CHUNK;

export type FlooredPosition = {
  x: number;
  y: number;
  z: number;
};

export function normalizeEntityTypeName(name: string): string {
  return name.trim().toLowerCase();
}

export function floorEntityPosition(entity: Entity): FlooredPosition {
  return {
    x: Math.floor(entity.position.x),
    y: Math.floor(entity.position.y),
    z: Math.floor(entity.position.z),
  };
}

/**
 * Registry-style label for an entity: mob/object `name`, or dropped item id.
 */
export function isDroppedItemEntity(entity: Entity): boolean {
  return entity.getDroppedItem?.() != null;
}

export function getEntityTypeLabel(entity: Entity): string {
  const dropped = entity.getDroppedItem?.();
  if (dropped?.name) {
    return dropped.name;
  }
  return entity.name ?? "unknown";
}

function entityDistanceSquared(client: MineflayerBot, entity: Entity): number {
  return client.entity.position.distanceSquared(entity.position);
}

function isSelf(client: MineflayerBot, entity: Entity): boolean {
  return entity === client.entity;
}

/**
 * Whether `entity` matches `entityType` (case-insensitive).
 * Mobs/objects match `entity.name`; drops match `getDroppedItem().name`.
 */
export function matchesEntityType(entity: Entity, entityType: string): boolean {
  const want = normalizeEntityTypeName(entityType);
  if (normalizeEntityTypeName(entity.name ?? "") === want) {
    return true;
  }
  const dropped = entity.getDroppedItem?.();
  if (dropped?.name && normalizeEntityTypeName(dropped.name) === want) {
    return true;
  }
  return false;
}

export type NearestEntityResult = {
  entity: Entity;
  label: string;
  distance: number;
  isDroppedItem: boolean;
};

export function findNearestEntity(
  client: MineflayerBot,
  options: {
    entityType?: string | undefined;
    maxDistance: number;
  },
): NearestEntityResult | null {
  const maxDistSq = options.maxDistance * options.maxDistance;
  let best: NearestEntityResult | null = null;
  let bestDistSq = Number.POSITIVE_INFINITY;

  for (const entity of Object.values(client.entities)) {
    if (isSelf(client, entity)) {
      continue;
    }
    if (
      options.entityType !== undefined &&
      !matchesEntityType(entity, options.entityType)
    ) {
      continue;
    }

    const distSq = entityDistanceSquared(client, entity);
    if (distSq > maxDistSq || distSq >= bestDistSq) {
      continue;
    }

    bestDistSq = distSq;
    best = {
      entity,
      label: getEntityTypeLabel(entity),
      distance: Math.sqrt(distSq),
      isDroppedItem: isDroppedItemEntity(entity),
    };
  }

  return best;
}
