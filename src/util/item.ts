import type { Bot as MineflayerBot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import { goals } from "./pathfinder/pathfinder.js";
import {
  MovementPreemptedError,
  type MovementSession,
} from "./pathfinder/manager.js";
import {
  DEFAULT_MAX_ENTITY_DISTANCE,
  isDroppedItemEntity,
  normalizeEntityTypeName,
} from "./entity.js";

export { DEFAULT_MAX_ENTITY_DISTANCE };

/** Case-insensitive Minecraft item id (same normalization as entity/drop names). */
export const normalizeItemName = normalizeEntityTypeName;

export function itemMatchesName(item: Item, itemName: string): boolean {
  return normalizeItemName(item.name) === normalizeItemName(itemName);
}

/** Max ground drop entities to visit per call (pathfinding safety cap). */
export const DEFAULT_MAX_PICKUP_DROPS = 32;

export const DEFAULT_PER_ITEM_PICKUP_TIMEOUT_MS = 20_000;

/** Brief wait when the drop entity vanished but playerCollect has not fired yet. */
const PICKUP_GONE_GRACE_MS = 300;

export type DroppedItemSnapshot = {
  id: number;
  itemName: string;
  count: number;
  position: { x: number; y: number; z: number };
  distance: number;
};

export function getDroppedItemTypeName(entity: Entity): string | null {
  const item = entity.getDroppedItem?.();
  return item?.name ?? null;
}

type NearbyDroppedItemOptions = {
  entityType?: string | undefined;
  maxDistance: number;
};

function droppedItemDistance(client: MineflayerBot, entity: Entity): number {
  return Math.sqrt(client.entity.position.distanceSquared(entity.position));
}

function wantDroppedItemType(
  entityType: string | undefined,
): string | undefined {
  return entityType !== undefined
    ? normalizeEntityTypeName(entityType)
    : undefined;
}

function snapshotDroppedItemEntity(
  client: MineflayerBot,
  entity: Entity,
): DroppedItemSnapshot | null {
  if (!isDroppedItemEntity(entity)) {
    return null;
  }
  const item = entity.getDroppedItem();
  if (!item) {
    return null;
  }
  const distance = droppedItemDistance(client, entity);
  return {
    id: entity.id,
    itemName: item.name ?? "unknown",
    count: item.count ?? 1,
    position: {
      x: entity.position.x,
      y: entity.position.y,
      z: entity.position.z,
    },
    distance,
  };
}

/** Nearest matching drop in range, or null if none. */
export function findNearestDroppedItem(
  client: MineflayerBot,
  options: NearbyDroppedItemOptions,
): DroppedItemSnapshot | null {
  const maxDist = options.maxDistance;
  const wantType = wantDroppedItemType(options.entityType);
  let nearest: DroppedItemSnapshot | null = null;

  for (const entity of Object.values(client.entities)) {
    const snap = snapshotDroppedItemEntity(client, entity);
    if (snap === null || snap.distance > maxDist) {
      continue;
    }
    if (
      wantType !== undefined &&
      normalizeEntityTypeName(snap.itemName) !== wantType
    ) {
      continue;
    }
    if (nearest === null || snap.distance < nearest.distance) {
      nearest = snap;
    }
  }

  return nearest;
}

export function snapshotNearbyDroppedItems(
  client: MineflayerBot,
  options: NearbyDroppedItemOptions,
): DroppedItemSnapshot[] {
  const maxDist = options.maxDistance;
  const wantType = wantDroppedItemType(options.entityType);
  const snapshots: DroppedItemSnapshot[] = [];

  for (const entity of Object.values(client.entities)) {
    const snap = snapshotDroppedItemEntity(client, entity);
    if (snap === null || snap.distance > maxDist) {
      continue;
    }
    if (
      wantType !== undefined &&
      normalizeEntityTypeName(snap.itemName) !== wantType
    ) {
      continue;
    }
    snapshots.push(snap);
  }

  snapshots.sort((a, b) => a.distance - b.distance);
  return snapshots;
}

export type PickupOutcome = "collected" | "gone" | "timeout" | "cancelled";

export type DroppedItemPickupWatch = {
  outcome: Promise<PickupOutcome>;
  /** Start the wait timer (call after pathfinding). No-op if already settled. */
  armTimeout: (timeoutMs: number) => void;
  cancel: () => void;
};

/**
 * Listen for pickup of a specific drop entity. Attach before pathfinding so
 * early collections are detected; arm the timeout only after the bot arrives.
 */
export function watchDroppedItemPickup(
  client: MineflayerBot,
  entityId: number,
): DroppedItemPickupWatch {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let goneGraceTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveOutcome!: (outcome: PickupOutcome) => void;

  const outcome = new Promise<PickupOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  const clearTimers = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (goneGraceTimer !== undefined) {
      clearTimeout(goneGraceTimer);
      goneGraceTimer = undefined;
    }
  };

  const finish = (pickupOutcome: PickupOutcome) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimers();
    client.removeListener("playerCollect", onCollect);
    resolveOutcome(pickupOutcome);
  };

  const onCollect = (collector: Entity, collected: Entity) => {
    if (collector === client.entity && collected.id === entityId) {
      finish("collected");
    }
  };

  client.on("playerCollect", onCollect);

  const armTimeout = (timeoutMs: number) => {
    if (settled) {
      return;
    }
    clearTimers();

    if (client.entities[entityId] === undefined) {
      goneGraceTimer = setTimeout(() => {
        if (!settled) {
          finish("gone");
        }
      }, PICKUP_GONE_GRACE_MS);
      return;
    }

    timer = setTimeout(() => {
      finish(client.entities[entityId] === undefined ? "gone" : "timeout");
    }, timeoutMs);
  };

  return {
    outcome,
    armTimeout,
    cancel: () => finish("cancelled"),
  };
}

export type PickupSummaryLine = {
  itemName: string;
  count: number;
};

export type PickupNearbyResult = {
  picked: PickupSummaryLine[];
  skipped: { itemName: string; reason: string }[];
  stoppedBecause?: "target_count" | "max_drops" | "no_more_drops";
};

function confirmedInstanceCount(
  picked: PickupSummaryLine[],
  entityType?: string,
): number {
  if (entityType === undefined) {
    return picked.reduce((n, p) => n + p.count, 0);
  }
  const want = normalizeEntityTypeName(entityType);
  return picked
    .filter((p) => normalizeEntityTypeName(p.itemName) === want)
    .reduce((n, p) => n + p.count, 0);
}

export async function pickupNearbyDroppedItems(
  session: MovementSession,
  client: MineflayerBot,
  options: {
    entityType?: string | undefined;
    maxDistance: number;
    maxDrops: number;
    targetCount?: number | undefined;
    perItemTimeoutMs: number;
    /** Pre-computed nearest drop from the caller; used for the first target only. */
    initialNearest?: DroppedItemSnapshot | undefined;
  },
): Promise<PickupNearbyResult> {
  const picked: PickupSummaryLine[] = [];
  const skipped: { itemName: string; reason: string }[] = [];
  let dropsVisited = 0;
  let stoppedBecause: PickupNearbyResult["stoppedBecause"];
  let nextNearest: DroppedItemSnapshot | null | undefined =
    options.initialNearest;

  session.cancelMovement();

  const reachedTargetCount = () =>
    options.targetCount !== undefined &&
    confirmedInstanceCount(picked, options.entityType) >= options.targetCount;

  const searchOptions = {
    entityType: options.entityType,
    maxDistance: options.maxDistance,
  };

  while (true) {
    if (dropsVisited >= options.maxDrops) {
      stoppedBecause = "max_drops";
      break;
    }
    if (reachedTargetCount()) {
      stoppedBecause = "target_count";
      break;
    }

    const target =
      nextNearest !== undefined
        ? nextNearest
        : findNearestDroppedItem(client, searchOptions);
    nextNearest = undefined;

    if (target === null) {
      stoppedBecause = "no_more_drops";
      break;
    }
    const pos = target.position;
    const pickupWatch = watchDroppedItemPickup(client, target.id);
    void pickupWatch.outcome.then((o) => {
      if (o === "collected") {
        session.cancelMovement();
      }
    });
    let outcome: PickupOutcome;
    try {
      await session.goto(new goals.GoalBlock(pos.x, pos.y, pos.z));
      pickupWatch.armTimeout(options.perItemTimeoutMs);
      outcome = await pickupWatch.outcome;
    } catch (error) {
      pickupWatch.cancel();
      if (error instanceof MovementPreemptedError) {
        const partial: PickupNearbyResult = {
          picked,
          skipped,
          ...(stoppedBecause !== undefined ? { stoppedBecause } : {}),
        };
        throw new MovementPreemptedError(error.preemptedBy, partial);
      }
      outcome = await pickupWatch.outcome;
      if (outcome !== "collected") {
        skipped.push({
          itemName: target.itemName,
          reason: `pathfinding failed: ${String(error)}`,
        });
        continue;
      }
    } finally {
      dropsVisited += 1;
    }

    if (outcome === "collected") {
      picked.push({ itemName: target.itemName, count: target.count });
    } else if (outcome === "gone") {
      skipped.push({
        itemName: target.itemName,
        reason:
          "drop disappeared before pickup was confirmed (may be collected, taken by another player, or despawned)",
      });
    } else if (outcome === "cancelled") {
      skipped.push({
        itemName: target.itemName,
        reason: "pickup cancelled",
      });
    } else {
      skipped.push({
        itemName: target.itemName,
        reason: "pickup timed out (drop still present)",
      });
    }
  }

  if (stoppedBecause === undefined) {
    stoppedBecause = reachedTargetCount() ? "target_count" : "no_more_drops";
  }

  return { picked, skipped, stoppedBecause };
}

export function formatPickupSummary(
  result: PickupNearbyResult,
  options?: {
    targetCount?: number | undefined;
    entityType?: string | undefined;
  },
): string {
  const lines: string[] = [];
  const totalInstances = result.picked.reduce((n, p) => n + p.count, 0);
  if (result.picked.length === 0) {
    lines.push("Picked up 0 item instance(s) from 0 drop(s).");
  } else {
    lines.push(
      `Picked up ${totalInstances} item instance(s) from ${result.picked.length} drop(s):`,
    );
    for (const entry of result.picked) {
      lines.push(`- ${entry.itemName} x${entry.count}`);
    }
  }
  if (options?.targetCount !== undefined) {
    const scope =
      options.entityType !== undefined
        ? `for ${options.entityType}`
        : "across all nearby drop types";
    lines.push(
      `Target count: ${options.targetCount} ${scope} (confirmed instances: ${totalInstances}).`,
    );
  }
  if (result.stoppedBecause === "target_count") {
    lines.push("Stopped: target instance count reached.");
  } else if (result.stoppedBecause === "max_drops") {
    lines.push("Stopped: max_drops visit limit reached.");
  } else if (result.stoppedBecause === "no_more_drops") {
    if (options?.targetCount !== undefined) {
      lines.push(
        "Stopped: no more matching drops in range; target instance count not reached.",
      );
    } else {
      lines.push("Stopped: no more matching drops in range.");
    }
  }
  if (result.skipped.length > 0) {
    lines.push("Skipped:");
    for (const entry of result.skipped) {
      lines.push(`- ${entry.itemName}: ${entry.reason}`);
    }
  }
  return lines.join("\n");
}
