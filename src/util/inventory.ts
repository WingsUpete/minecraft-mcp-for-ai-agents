import type { Bot as MineflayerBot } from "mineflayer";
import type { Item } from "prismarine-item";
import { wait } from "./common.js";
import { itemMatchesName, normalizeItemName } from "./item.js";

const EQUIP_HELD_TIMEOUT_MS = 2_000;
/** Brief settle after held item updates (≈1–2 ticks). */
const EQUIP_SETTLE_MS = 100;

function heldMatchesItem(held: Item | null, item: Item): boolean {
  return held !== null && held.type === item.type;
}

export function findInventoryItems(
  client: MineflayerBot,
  itemName: string,
): Item[] {
  return client.inventory
    .items()
    .filter((item) => itemMatchesName(item, itemName));
}

/** First matching stack (e.g. for equip). */
export function findInventoryItem(
  client: MineflayerBot,
  itemName: string,
): Item | null {
  return findInventoryItems(client, itemName)[0] ?? null;
}

/**
 * Equip to main hand and wait until {@linkcode Bot.heldItem} matches.
 * Quick-bar-only equips can return before the server applies the slot change.
 */
export async function equipItemInHand(
  client: MineflayerBot,
  item: Item,
): Promise<void> {
  if (heldMatchesItem(client.heldItem, item)) {
    await wait(EQUIP_SETTLE_MS);
    return;
  }

  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  let onHeldChange!: (held: Item | null) => void;

  const cleanup = () => {
    clearTimeout(timer);
    client.removeListener("heldItemChanged" as never, onHeldChange as never);
  };

  const heldReady = new Promise<void>((resolve, reject) => {
    onHeldChange = (held) => {
      if (heldMatchesItem(held, item)) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    client.on("heldItemChanged" as never, onHeldChange as never);
    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(
        new Error(
          `Timed out after ${EQUIP_HELD_TIMEOUT_MS}ms waiting to hold '${item.name}' in hand`,
        ),
      );
    }, EQUIP_HELD_TIMEOUT_MS);
  });

  await client.equip(item, "hand");
  await heldReady;
  await wait(EQUIP_SETTLE_MS);
}

export function totalInventoryCount(
  client: MineflayerBot,
  itemName: string,
  stacks?: Item[],
): number {
  const items = stacks ?? findInventoryItems(client, itemName);
  return items.reduce((n, item) => n + item.count, 0);
}

export type InventoryLine = {
  name: string;
  count: number;
};

/** Aggregate stacks by item name (case-insensitive key, first-seen display name). */
export function summarizeItemStacks(items: Item[]): InventoryLine[] {
  const totals = new Map<string, { displayName: string; count: number }>();

  for (const item of items) {
    const key = normalizeItemName(item.name);
    const existing = totals.get(key);
    if (existing) {
      existing.count += item.count;
    } else {
      totals.set(key, { displayName: item.name, count: item.count });
    }
  }

  return [...totals.values()]
    .map(({ displayName, count }) => ({ name: displayName, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function summarizeInventory(client: MineflayerBot): InventoryLine[] {
  return summarizeItemStacks(client.inventory.items());
}

function formatEmptySlotsLine(emptySlots: number): string {
  if (emptySlots === 0) {
    return "0 empty inventory slots left (inventory is full).";
  }
  const slotWord = emptySlots === 1 ? "slot" : "slots";
  return `${emptySlots} empty inventory ${slotWord} left.`;
}

export function formatInventorySummary(
  lines: InventoryLine[],
  emptySlots: number,
): string {
  const capacityLine = formatEmptySlotsLine(emptySlots);
  if (lines.length === 0) {
    return `Inventory is empty.\n${capacityLine}`;
  }
  const total = lines.reduce((n, line) => n + line.count, 0);
  const body = lines.map((line) => `- ${line.name} x${line.count}`).join("\n");
  return [
    `Inventory (${lines.length} item type(s), ${total} item instance(s)):`,
    body,
    capacityLine,
  ].join("\n");
}
