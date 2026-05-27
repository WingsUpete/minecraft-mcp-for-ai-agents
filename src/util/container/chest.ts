import type { Bot as MineflayerBot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Chest } from "mineflayer";
import {
  normalizeBlockName,
  resolveInteractableBlock,
  type BlockCoords,
  type ResolveInteractableBlockResult,
} from "../block.js";
import {
  summarizeItemStacks,
  totalInventoryCount,
  type InventoryLine,
} from "../inventory.js";
import { withTimeout } from "../common.js";
import { resolveRegistryItem } from "../recipe.js";

export const CHEST_BLOCK_NAMES = new Set([
  "barrel",
  "chest",
  "ender_chest",
  "trapped_chest",
]);

export const CHEST_OPEN_TIMEOUT_MS = 5_000;
export const CHEST_OPERATION_TIMEOUT_MS = 8_000;

export const CHEST_COORDS_PARTIAL_ERROR =
  "x, y, and z must all be provided together or omitted for nearest-chest search.";

export type ChestOnError = "skip" | "stop";

export type ChestOperationType = "deposit" | "withdraw";

export type ChestOperation = {
  op_type: ChestOperationType;
  item_name: string;
  count: number;
};

export type ChestOperationResult = {
  index: number;
  op_type: ChestOperationType;
  item_name: string;
  count: number;
  ok: boolean;
  message: string;
};

export class ChestOpenTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms opening the chest. The bot may be too far away, the window did not open, or something is blocking interaction. Use move_to_interactable_block and retry.`,
    );
    this.name = "ChestOpenTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class ChestOperationTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly operation: ChestOperation;

  constructor(timeoutMs: number, operation: ChestOperation) {
    super(
      `Timed out after ${timeoutMs}ms during ${operation.op_type} of ${operation.count} '${operation.item_name}'.`,
    );
    this.name = "ChestOperationTimeoutError";
    this.timeoutMs = timeoutMs;
    this.operation = operation;
  }
}

export function isChestBlockName(name: string): boolean {
  return CHEST_BLOCK_NAMES.has(name);
}

export type ResolveChestBlockResult = ResolveInteractableBlockResult;

function chestAllowedNames(
  blockName?: string,
): { ok: true; names: ReadonlySet<string> } | { ok: false; error: string } {
  if (blockName === undefined) {
    return { ok: true, names: CHEST_BLOCK_NAMES };
  }
  const normalized = normalizeBlockName(blockName);
  if (!CHEST_BLOCK_NAMES.has(normalized)) {
    return {
      ok: false,
      error: `Unsupported chest block_name '${blockName}' (supported: ${[...CHEST_BLOCK_NAMES].join(", ")}).`,
    };
  }
  return { ok: true, names: new Set([normalized]) };
}

export function resolveChestBlock(
  client: MineflayerBot,
  coords?: BlockCoords,
  blockName?: string,
): ResolveChestBlockResult {
  const allowed = chestAllowedNames(blockName);
  if (!allowed.ok) {
    return allowed;
  }

  return resolveInteractableBlock(client, {
    ...(coords !== undefined ? { coords } : {}),
    allowedNames: allowed.names,
    label: blockName !== undefined ? `${blockName} (chest)` : "chest",
    checkReach: true,
  });
}

/** Empty slots in the container section (not the bot inventory rows in the GUI). */
export function countChestEmptySlots(chest: Chest): number {
  return chest.inventoryStart - chest.containerItems().length;
}

export function summarizeChestContents(chest: Chest): InventoryLine[] {
  return summarizeItemStacks(chest.containerItems());
}

export function formatChestContentsSummary(
  lines: InventoryLine[],
  emptySlots: number,
  coords: BlockCoords,
  blockName: string,
): string {
  const capacityLine =
    emptySlots === 0
      ? "0 empty chest slots left (chest is full)."
      : `${emptySlots} empty chest ${emptySlots === 1 ? "slot" : "slots"} left.`;
  const header = `${blockName} (chest) at (${coords.x}, ${coords.y}, ${coords.z})`;
  if (lines.length === 0) {
    return `${header} is empty.\n${capacityLine}`;
  }
  const total = lines.reduce((n, line) => n + line.count, 0);
  const body = lines.map((line) => `- ${line.name} x${line.count}`).join("\n");
  return [
    `${header} (${lines.length} item type(s), ${total} item instance(s)):`,
    body,
    capacityLine,
  ].join("\n");
}

function closeOtherWindow(client: MineflayerBot): void {
  const current = client.currentWindow;
  if (current !== null && current !== client.inventory) {
    client.closeWindow(current);
  }
}

export async function openChestWindow(
  client: MineflayerBot,
  block: Block,
): Promise<Chest> {
  closeOtherWindow(client);
  return withTimeout(
    client.openContainer(block),
    CHEST_OPEN_TIMEOUT_MS,
    () => new ChestOpenTimeoutError(CHEST_OPEN_TIMEOUT_MS),
  );
}

export function closeChestWindow(chest: Chest): void {
  chest.close();
}

function validateDeposit(
  client: MineflayerBot,
  itemName: string,
  count: number,
):
  | { ok: true; itemId: number; displayName: string }
  | { ok: false; error: string } {
  const item = resolveRegistryItem(client.registry, itemName);
  if (item === null) {
    return { ok: false, error: `Unknown item: '${itemName}'.` };
  }
  const available = totalInventoryCount(client, item.name);
  if (available < count) {
    return {
      ok: false,
      error: `Not enough '${item.name}' in inventory (have ${available}, need ${count}).`,
    };
  }
  return { ok: true, itemId: item.id, displayName: item.name };
}

function validateWithdraw(
  chest: Chest,
  client: MineflayerBot,
  itemName: string,
  count: number,
):
  | { ok: true; itemId: number; displayName: string }
  | { ok: false; error: string } {
  const item = resolveRegistryItem(client.registry, itemName);
  if (item === null) {
    return { ok: false, error: `Unknown item: '${itemName}'.` };
  }
  const available = chest.containerCount(item.id, null);
  if (available < count) {
    return {
      ok: false,
      error: `Not enough '${item.name}' in chest (have ${available}, need ${count}).`,
    };
  }
  return { ok: true, itemId: item.id, displayName: item.name };
}

const VERIFY_CHEST_STATE_HINT =
  "Use check_inventory and check_chest_contents to verify current state.";

type ItemLocationCounts = {
  inInventory: number;
  inChest: number;
};

function itemLocationCounts(
  chest: Chest,
  client: MineflayerBot,
  itemId: number,
  itemName: string,
): ItemLocationCounts {
  return {
    inInventory: totalInventoryCount(client, itemName),
    inChest: chest.containerCount(itemId, null),
  };
}

/** Net items moved for this operation (inventory + chest deltas; merge-safe). */
function netMovedForOperation(
  before: ItemLocationCounts,
  after: ItemLocationCounts,
  opType: ChestOperationType,
): number {
  if (opType === "deposit") {
    const toChest = after.inChest - before.inChest;
    const fromInv = before.inInventory - after.inInventory;
    return Math.max(0, toChest, fromInv);
  }
  const fromChest = before.inChest - after.inChest;
  const toInv = after.inInventory - before.inInventory;
  return Math.max(0, fromChest, toInv);
}

/**
 * Put cursor-held stacks back into the bot inventory (deposit) or chest container
 * (withdraw). Keeps the chest window open; only extra GUI clicks.
 */
async function clearChestWindowCursor(
  client: MineflayerBot,
  chest: Chest,
  opType: ChestOperationType,
): Promise<void> {
  if (chest.selectedItem === null) {
    return;
  }
  if (opType === "deposit") {
    await client.putSelectedItemRange(
      chest.inventoryStart,
      chest.inventoryEnd,
      chest,
      null,
    );
  } else {
    await client.putSelectedItemRange(0, chest.inventoryStart, chest, null);
  }
}

function transferFailureMessage(error: unknown): string | null {
  const msg = String(error);
  if (msg.includes("inventory is full")) {
    return "Bot inventory is full; cannot withdraw.";
  }
  if (msg.includes("destination full")) {
    return "Chest is full; cannot deposit.";
  }
  if (msg.includes("Can't find")) {
    return msg;
  }
  if (error instanceof ChestOperationTimeoutError) {
    return error.message;
  }
  return null;
}

function buildOperationOutcome(
  before: ItemLocationCounts,
  after: ItemLocationCounts,
  operation: ChestOperation,
  displayName: string,
  transferError: unknown | null,
): { ok: true; message: string } | { ok: false; message: string } {
  const moved = netMovedForOperation(before, after, operation.op_type);
  const verb = operation.op_type === "deposit" ? "Deposited" : "Withdrew";

  if (moved >= operation.count) {
    return {
      ok: true,
      message: `${verb} ${operation.count} ${displayName}.`,
    };
  }
  if (moved > 0) {
    return {
      ok: true,
      message: `${verb} ${moved} of ${operation.count} ${displayName}. ${VERIFY_CHEST_STATE_HINT}`,
    };
  }

  const base =
    transferError !== null ? transferFailureMessage(transferError) : null;
  if (base !== null) {
    return { ok: false, message: `${base} ${VERIFY_CHEST_STATE_HINT}` };
  }
  return {
    ok: false,
    message: `No ${displayName} moved for ${operation.op_type} x${operation.count}. ${VERIFY_CHEST_STATE_HINT}`,
  };
}

async function runSingleOperation(
  client: MineflayerBot,
  chest: Chest,
  operation: ChestOperation,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const check =
    operation.op_type === "deposit"
      ? validateDeposit(client, operation.item_name, operation.count)
      : validateWithdraw(chest, client, operation.item_name, operation.count);
  if (!check.ok) {
    return { ok: false, message: check.error };
  }

  const before = itemLocationCounts(
    chest,
    client,
    check.itemId,
    check.displayName,
  );

  let transferError: unknown | null = null;

  try {
    const transfer =
      operation.op_type === "deposit"
        ? () => chest.deposit(check.itemId, null, operation.count)
        : () => chest.withdraw(check.itemId, null, operation.count);
    await withTimeout(
      transfer(),
      CHEST_OPERATION_TIMEOUT_MS,
      () =>
        new ChestOperationTimeoutError(CHEST_OPERATION_TIMEOUT_MS, operation),
    );
  } catch (error) {
    const base = transferFailureMessage(error);
    if (base === null) {
      throw error;
    }
    transferError = error;
  } finally {
    await clearChestWindowCursor(client, chest, operation.op_type);
  }

  const after = itemLocationCounts(
    chest,
    client,
    check.itemId,
    check.displayName,
  );
  return buildOperationOutcome(
    before,
    after,
    operation,
    check.displayName,
    transferError,
  );
}

export async function runChestOperations(
  client: MineflayerBot,
  chest: Chest,
  operations: ChestOperation[],
  onError: ChestOnError,
): Promise<ChestOperationResult[]> {
  const results: ChestOperationResult[] = [];

  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]!;
    try {
      const outcome = await runSingleOperation(client, chest, operation);
      results.push({
        index,
        op_type: operation.op_type,
        item_name: operation.item_name,
        count: operation.count,
        ok: outcome.ok,
        message: outcome.message,
      });
      if (!outcome.ok && onError === "stop") {
        break;
      }
    } catch (error) {
      try {
        await clearChestWindowCursor(client, chest, operation.op_type);
      } catch {
        // Best-effort; original error is more important.
      }
      const message =
        error instanceof ChestOperationTimeoutError
          ? error.message
          : String(error);
      results.push({
        index,
        op_type: operation.op_type,
        item_name: operation.item_name,
        count: operation.count,
        ok: false,
        message,
      });
      if (onError === "stop") {
        break;
      }
    }
  }

  return results;
}

export function formatChestOperationReport(
  results: ChestOperationResult[],
  onError: ChestOnError,
  /** Planned operation count; used to detect stop-on-error early exit. */
  totalOperations: number,
): string {
  const lines: string[] = [];
  if (results.length === 0) {
    lines.push("No chest operations were run.");
    return lines.join("\n");
  }

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const stoppedEarly =
    onError === "stop" && failed.length > 0 && results.length < totalOperations;

  lines.push(`Operations (${results.length}):`);
  for (const result of results) {
    const status = result.ok ? "ok" : "failed";
    lines.push(
      `- [${result.index + 1}] ${result.op_type} ${result.item_name} x${result.count}: ${status} — ${result.message}`,
    );
  }

  lines.push(
    `Summary: ${succeeded.length} succeeded, ${failed.length} failed (on_error=${onError}).`,
  );
  if (stoppedEarly) {
    lines.push("Stopped remaining operations after the first failure.");
  }
  return lines.join("\n");
}

export async function withChestSession<T>(
  client: MineflayerBot,
  block: Block,
  fn: (chest: Chest) => Promise<T>,
): Promise<T> {
  const chest = await openChestWindow(client, block);
  try {
    return await fn(chest);
  } finally {
    closeChestWindow(chest);
  }
}
