import type { Bot as MineflayerBot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Furnace } from "mineflayer";
import type { Item } from "prismarine-item";
import {
  normalizeBlockName,
  resolveInteractableBlock,
  type BlockCoords,
  type ResolveInteractableBlockResult,
} from "../block.js";
import { totalInventoryCount } from "../inventory.js";
import { withTimeout } from "../common.js";
import { resolveRegistryItem } from "../recipe.js";
import { itemMatchesName } from "../item.js";

export const FURNACE_BLOCK_NAMES = new Set([
  "furnace",
  "blast_furnace",
  "smoker",
]);

export const FURNACE_OPEN_TIMEOUT_MS = 5_000;
export const FURNACE_OPERATION_TIMEOUT_MS = 8_000;
/**
 * Brief wait after opening a furnace before reading smelt/fuel progress bars.
 *
 * Mineflayer fills progress fields from `craft_progress_bar` packets that arrive
 * after the window opens. Totals (properties 1/3) can arrive before current
 * values (0/2), so we always wait the full window — never snapshot immediately
 * when only totals are present.
 */
export const FURNACE_PROGRESS_SETTLE_MS = 500;

export const FURNACE_COORDS_PARTIAL_ERROR =
  "x, y, and z must all be provided together or omitted for nearest-furnace search.";

const INPUT_SLOT = 0;
const FUEL_SLOT = 1;
const OUTPUT_SLOT = 2;

export type FurnaceOnError = "skip" | "stop";

export type FurnaceOperationType =
  | "put_item"
  | "put_fuel"
  | "take_item"
  | "take_fuel"
  | "take_result";

export type FurnaceOperation = {
  op_type: FurnaceOperationType;
  item_name?: string;
  count?: number;
};

export type FurnaceOperationResult = {
  index: number;
  op_type: FurnaceOperationType;
  item_name: string;
  count: number;
  ok: boolean;
  message: string;
};

export type FurnaceSlotSummary = {
  name: string;
  count: number;
  stackSize: number;
} | null;

/** Smelting and fuel-burn bars from Mineflayer (mirrors the furnace GUI arrows). */
export type FurnaceProgressSummary = {
  /** Smelt progress (0–1). Null if the server has not sent bar data yet, or when idle. */
  progressRatio: number | null;
  /** Seconds until the current input item finishes smelting. */
  progressSecondsRemaining: number | null;
  /** Duration of one smelt cycle for the current recipe (seconds). */
  totalProgressSeconds: number | null;
  /** Current fuel piece burn progress (0–1). Null if bar data not received yet, or when not burning. */
  fuelRatio: number | null;
  /** Seconds left on the fuel unit currently burning (not the whole fuel stack). */
  fuelSecondsRemaining: number | null;
  /** Burn time for one unit of the current fuel type (seconds). */
  totalFuelSeconds: number | null;
  /**
   * Set by {@link waitForFurnaceProgressSettle} after opening the furnace window.
   * True only when, after waiting up to {@link FURNACE_PROGRESS_SETTLE_MS}, Mineflayer
   * still has not received any `craft_progress_bar` packets (`totalProgress` and
   * `totalFuel` remain null). Used to print bar lines as "pending" vs "unknown".
   * Not the same as individual ratio fields being null while idle (that is "unknown").
   */
  progressPending: boolean;
};

/** Mineflayer attaches extra fields at runtime beyond the published Furnace type. */
export type FurnaceWindow = Furnace & {
  fuel: number | null;
  fuelSeconds: number | null;
  totalFuel: number | null;
  totalFuelSeconds: number | null;
  progress: number | null;
  progressSeconds: number | null;
  totalProgress: number | null;
  totalProgressSeconds: number | null;
  inputItem: () => Item | null;
  fuelItem: () => Item | null;
  outputItem: () => Item | null;
  putInput: (
    itemType: number,
    metadata: number | null,
    count: number,
  ) => Promise<void>;
  putFuel: (
    itemType: number,
    metadata: number | null,
    count: number,
  ) => Promise<void>;
  takeInput: () => Promise<Item>;
  takeFuel: () => Promise<Item>;
  takeOutput: () => Promise<Item>;
};

export class FurnaceOpenTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms opening the furnace. The bot may be too far away, the window did not open, or something is blocking interaction. Use move_to_interactable_block and retry.`,
    );
    this.name = "FurnaceOpenTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class FurnaceOperationTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly operation: FurnaceOperation;

  constructor(timeoutMs: number, operation: FurnaceOperation) {
    const itemLabel = operation.item_name ?? "item";
    const countLabel = operation.count ?? "?";
    super(
      `Timed out after ${timeoutMs}ms during ${operation.op_type} of ${countLabel} '${itemLabel}'.`,
    );
    this.name = "FurnaceOperationTimeoutError";
    this.timeoutMs = timeoutMs;
    this.operation = operation;
  }
}

export type ResolveFurnaceBlockResult = ResolveInteractableBlockResult;

function furnaceAllowedNames(
  blockName?: string,
): { ok: true; names: ReadonlySet<string> } | { ok: false; error: string } {
  if (blockName === undefined) {
    return { ok: true, names: FURNACE_BLOCK_NAMES };
  }
  const normalized = normalizeBlockName(blockName);
  if (!FURNACE_BLOCK_NAMES.has(normalized)) {
    return {
      ok: false,
      error: `Unsupported furnace block_name '${blockName}' (supported: ${[...FURNACE_BLOCK_NAMES].join(", ")}).`,
    };
  }
  return { ok: true, names: new Set([normalized]) };
}

export function resolveFurnaceBlock(
  client: MineflayerBot,
  coords?: BlockCoords,
  blockName?: string,
): ResolveFurnaceBlockResult {
  const allowed = furnaceAllowedNames(blockName);
  if (!allowed.ok) {
    return allowed;
  }

  return resolveInteractableBlock(client, {
    ...(coords !== undefined ? { coords } : {}),
    allowedNames: allowed.names,
    label: blockName !== undefined ? `${blockName} (furnace)` : "furnace",
    checkReach: true,
  });
}

function summarizeSlot(item: Item | null): FurnaceSlotSummary {
  if (item === null) {
    return null;
  }
  return {
    name: item.name,
    count: item.count,
    stackSize: item.stackSize,
  };
}

function formatSlotLine(label: string, slot: FurnaceSlotSummary): string {
  if (slot === null) {
    return `${label}: empty`;
  }
  return `${label}: ${slot.name} x${slot.count} (max stack ${slot.stackSize})`;
}

function normalizeProgressNumber(
  value: number | null | undefined,
): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatRatioLine(
  label: string,
  ratio: number | null | undefined,
  secondsRemaining: number | null | undefined,
  totalSeconds: number | null | undefined,
  pending: boolean,
): string {
  const normalizedRatio = normalizeProgressNumber(ratio);
  const normalizedSecondsRemaining = normalizeProgressNumber(secondsRemaining);
  const normalizedTotalSeconds = normalizeProgressNumber(totalSeconds);

  if (normalizedRatio === null && normalizedTotalSeconds === null) {
    return `${label}: ${pending ? "pending" : "unknown"}`;
  }
  const parts: string[] = [];
  if (normalizedRatio !== null) {
    parts.push(`${Math.round(normalizedRatio * 100)}%`);
  }
  if (normalizedSecondsRemaining !== null) {
    parts.push(`~${normalizedSecondsRemaining.toFixed(1)}s remaining`);
  }
  if (normalizedTotalSeconds !== null) {
    parts.push(`${normalizedTotalSeconds.toFixed(1)}s total`);
  }
  return `${label}: ${parts.join(", ")}`;
}

function deriveFurnaceStatus(
  input: FurnaceSlotSummary,
  fuel: FurnaceSlotSummary,
  output: FurnaceSlotSummary,
  progress: FurnaceProgressSummary,
): string {
  if (output !== null && output.count >= output.stackSize) {
    return "output full";
  }
  if (input === null) {
    return "idle";
  }
  if (
    fuel === null &&
    (progress.fuelRatio === null || progress.fuelRatio === 0) &&
    (progress.progressRatio === null || progress.progressRatio === 0)
  ) {
    return "no fuel";
  }
  if (
    progress.progressRatio !== null &&
    progress.progressRatio > 0 &&
    progress.progressRatio < 1
  ) {
    return "smelting";
  }
  // Input and fuel are loaded, output has room, and the smelt arrow is not mid-cycle
  // (progress 0 or idle between items). Smelting may start on the next tick.
  if (input !== null && fuel !== null) {
    return "ready";
  }
  return "idle";
}

export function readFurnaceProgress(
  furnace: FurnaceWindow,
  progressPending: boolean,
): FurnaceProgressSummary {
  return {
    progressRatio: normalizeProgressNumber(furnace.progress),
    progressSecondsRemaining: normalizeProgressNumber(furnace.progressSeconds),
    totalProgressSeconds: normalizeProgressNumber(furnace.totalProgressSeconds),
    fuelRatio: normalizeProgressNumber(furnace.fuel),
    fuelSecondsRemaining: normalizeProgressNumber(furnace.fuelSeconds),
    totalFuelSeconds: normalizeProgressNumber(furnace.totalFuelSeconds),
    progressPending,
  };
}

/**
 * Wait for progress-bar packets after open, then snapshot.
 * Returns true only when no bar totals arrived (idle furnace — show "unknown").
 */
export async function waitForFurnaceProgressSettle(
  furnace: FurnaceWindow,
): Promise<boolean> {
  let sawBarTotals = furnace.totalProgress != null || furnace.totalFuel != null;

  await new Promise<void>((resolve) => {
    const onUpdate = () => {
      if (furnace.totalProgress != null || furnace.totalFuel != null) {
        sawBarTotals = true;
      }
    };

    const timer = setTimeout(() => {
      furnace.removeListener("update", onUpdate);
      resolve();
    }, FURNACE_PROGRESS_SETTLE_MS);

    furnace.on("update", onUpdate);
  });

  return !sawBarTotals;
}

export function formatFurnaceSummary(
  input: FurnaceSlotSummary,
  fuel: FurnaceSlotSummary,
  output: FurnaceSlotSummary,
  progress: FurnaceProgressSummary,
  coords: BlockCoords,
  blockName: string,
): string {
  const header = `${blockName} (furnace) at (${coords.x}, ${coords.y}, ${coords.z})`;
  const status = deriveFurnaceStatus(input, fuel, output, progress);
  return [
    header,
    formatSlotLine("Input", input),
    formatSlotLine("Fuel", fuel),
    formatSlotLine("Output", output),
    formatRatioLine(
      "Smelting progress",
      progress.progressRatio,
      progress.progressSecondsRemaining,
      progress.totalProgressSeconds,
      progress.progressPending,
    ),
    formatRatioLine(
      "Fuel burn",
      progress.fuelRatio,
      progress.fuelSecondsRemaining,
      progress.totalFuelSeconds,
      progress.progressPending,
    ),
    `Status: ${status}`,
  ].join("\n");
}

function closeOtherWindow(client: MineflayerBot): void {
  const current = client.currentWindow;
  if (current !== null && current !== client.inventory) {
    client.closeWindow(current);
  }
}

export async function openFurnaceWindow(
  client: MineflayerBot,
  block: Block,
): Promise<FurnaceWindow> {
  closeOtherWindow(client);
  return withTimeout(
    client.openFurnace(block) as Promise<FurnaceWindow>,
    FURNACE_OPEN_TIMEOUT_MS,
    () => new FurnaceOpenTimeoutError(FURNACE_OPEN_TIMEOUT_MS),
  );
}

export function closeFurnaceWindow(furnace: FurnaceWindow): void {
  furnace.close();
}

function registryStackSize(client: MineflayerBot, itemId: number): number {
  return client.registry.items[itemId]?.stackSize ?? 64;
}

function canAcceptInSlot(
  slotItem: Item | null,
  itemId: number,
  count: number,
  stackSize: number,
): boolean {
  if (slotItem === null) {
    return count <= stackSize;
  }
  if (slotItem.type !== itemId) {
    return false;
  }
  return slotItem.count + count <= slotItem.stackSize;
}

function outputBlocksPutItem(outputItem: Item | null): string | null {
  if (outputItem === null) {
    return null;
  }
  if (outputItem.count >= outputItem.stackSize) {
    return `Output slot full (${outputItem.name} x${outputItem.count}) — take_result first.`;
  }
  return null;
}

const VERIFY_FURNACE_STATE_HINT =
  "Use check_inventory and check_furnace to verify current state.";

type ResolvedPut = {
  kind: "put";
  itemId: number;
  displayName: string;
  count: number;
  slot: typeof INPUT_SLOT | typeof FUEL_SLOT;
};

type ResolvedTake = {
  kind: "take";
  itemId: number;
  displayName: string;
  count: number;
  slot: typeof INPUT_SLOT | typeof FUEL_SLOT | typeof OUTPUT_SLOT;
};

type ResolveOperationResult =
  | { ok: true; resolved: ResolvedPut | ResolvedTake }
  | { ok: false; error: string };

function resolvePutOperation(
  client: MineflayerBot,
  furnace: FurnaceWindow,
  operation: FurnaceOperation,
  slot: typeof INPUT_SLOT | typeof FUEL_SLOT,
): ResolveOperationResult {
  if (operation.item_name === undefined || operation.count === undefined) {
    return {
      ok: false,
      error: `${operation.op_type} requires item_name and count.`,
    };
  }

  const item = resolveRegistryItem(client.registry, operation.item_name);
  if (item === null) {
    return { ok: false, error: `Unknown item: '${operation.item_name}'.` };
  }

  const available = totalInventoryCount(client, item.name);
  if (available < operation.count) {
    return {
      ok: false,
      error: `Not enough '${item.name}' in inventory (have ${available}, need ${operation.count}).`,
    };
  }

  const stackSize = registryStackSize(client, item.id);
  const slotItem =
    slot === INPUT_SLOT ? furnace.inputItem() : furnace.fuelItem();

  if (!canAcceptInSlot(slotItem, item.id, operation.count, stackSize)) {
    const slotLabel = slot === INPUT_SLOT ? "Input" : "Fuel";
    if (slotItem === null) {
      // no existing item inside, but still fail -> maybe client tries to put more than the stack size
      return {
        ok: false,
        error: `Cannot put ${operation.count} '${item.name}' in ${slotLabel.toLowerCase()} slot (max stack ${stackSize}).`,
      };
    }
    if (slotItem.type !== item.id) {
      return {
        ok: false,
        error: `${slotLabel} slot occupied by ${slotItem.name} x${slotItem.count} — take it first or use the same item type.`,
      };
    }
    return {
      ok: false,
      error: `${slotLabel} slot cannot fit ${operation.count} more '${item.name}' (${slotItem.count}/${slotItem.stackSize}).`,
    };
  }

  if (slot === INPUT_SLOT) {
    const outputError = outputBlocksPutItem(furnace.outputItem());
    if (outputError !== null) {
      return { ok: false, error: outputError };
    }
  }

  return {
    ok: true,
    resolved: {
      kind: "put",
      itemId: item.id,
      displayName: item.name,
      count: operation.count,
      slot,
    },
  };
}

function resolveTakeOperation(
  client: MineflayerBot,
  furnace: FurnaceWindow,
  operation: FurnaceOperation,
  slot: typeof INPUT_SLOT | typeof FUEL_SLOT | typeof OUTPUT_SLOT,
  slotLabel: string,
  getSlotItem: () => Item | null,
): ResolveOperationResult {
  const slotItem = getSlotItem();
  if (slotItem === null) {
    return { ok: false, error: `${slotLabel} slot is empty.` };
  }

  if (operation.item_name !== undefined) {
    const item = resolveRegistryItem(client.registry, operation.item_name);
    if (item === null) {
      return { ok: false, error: `Unknown item: '${operation.item_name}'.` };
    }
    if (!itemMatchesName(slotItem, item.name)) {
      return {
        ok: false,
        error: `${slotLabel} slot has '${slotItem.name}', not '${item.name}'.`,
      };
    }
  }

  const count = operation.count ?? slotItem.count;
  if (count > slotItem.count) {
    return {
      ok: false,
      error: `Not enough in ${slotLabel.toLowerCase()} slot (have ${slotItem.count}, need ${count}).`,
    };
  }

  return {
    ok: true,
    resolved: {
      kind: "take",
      itemId: slotItem.type,
      displayName: slotItem.name,
      count,
      slot,
    },
  };
}

function resolveOperation(
  client: MineflayerBot,
  furnace: FurnaceWindow,
  operation: FurnaceOperation,
): ResolveOperationResult {
  switch (operation.op_type) {
    case "put_item":
      return resolvePutOperation(client, furnace, operation, INPUT_SLOT);
    case "put_fuel":
      return resolvePutOperation(client, furnace, operation, FUEL_SLOT);
    case "take_item":
      return resolveTakeOperation(
        client,
        furnace,
        operation,
        INPUT_SLOT,
        "Input",
        () => furnace.inputItem(),
      );
    case "take_fuel":
      return resolveTakeOperation(
        client,
        furnace,
        operation,
        FUEL_SLOT,
        "Fuel",
        () => furnace.fuelItem(),
      );
    case "take_result":
      return resolveTakeOperation(
        client,
        furnace,
        operation,
        OUTPUT_SLOT,
        "Output",
        () => furnace.outputItem(),
      );
  }
}

type ItemLocationCounts = {
  inInventory: number;
  inSlot: number;
};

function itemLocationCounts(
  client: MineflayerBot,
  furnace: FurnaceWindow,
  itemId: number,
  itemName: string,
  slot: number,
): ItemLocationCounts {
  const slotItem = furnace.slots[slot] ?? null;
  const inSlot =
    slotItem !== null && slotItem.type === itemId ? slotItem.count : 0;
  return {
    inInventory: totalInventoryCount(client, itemName),
    inSlot,
  };
}

function netMovedForOperation(
  before: ItemLocationCounts,
  after: ItemLocationCounts,
  kind: "put" | "take",
): number {
  if (kind === "put") {
    const toSlot = after.inSlot - before.inSlot;
    const fromInv = before.inInventory - after.inInventory;
    return Math.max(0, toSlot, fromInv);
  }
  const fromSlot = before.inSlot - after.inSlot;
  const toInv = after.inInventory - before.inInventory;
  return Math.max(0, fromSlot, toInv);
}

/**
 * Put cursor-held stacks back into bot inventory (put) or furnace slots (take).
 * Keeps the furnace window open; only extra GUI clicks.
 */
async function clearFurnaceWindowCursor(
  client: MineflayerBot,
  furnace: FurnaceWindow,
  kind: "put" | "take",
): Promise<void> {
  if (furnace.selectedItem === null) {
    return;
  }
  if (kind === "put") {
    await client.putSelectedItemRange(
      furnace.inventoryStart,
      furnace.inventoryEnd,
      furnace,
      null,
    );
  } else {
    await client.putSelectedItemRange(0, furnace.inventoryStart, furnace, null);
  }
}

function operationKind(operation: FurnaceOperation): "put" | "take" {
  return operation.op_type === "put_item" || operation.op_type === "put_fuel"
    ? "put"
    : "take";
}

function transferFailureMessage(error: unknown): string | null {
  const msg = String(error);
  if (msg.includes("inventory is full")) {
    return "Bot inventory is full; cannot take from furnace.";
  }
  if (msg.includes("destination full")) {
    return "Furnace slot is full; cannot put item.";
  }
  if (msg.includes("Can't find")) {
    return msg;
  }
  if (error instanceof FurnaceOperationTimeoutError) {
    return error.message;
  }
  return null;
}

function buildOperationOutcome(
  before: ItemLocationCounts,
  after: ItemLocationCounts,
  kind: "put" | "take",
  opType: FurnaceOperationType,
  displayName: string,
  requestedCount: number,
  transferError: unknown | null,
): { ok: true; message: string } | { ok: false; message: string } {
  const moved = netMovedForOperation(before, after, kind);
  const verb =
    kind === "put"
      ? opType === "put_fuel"
        ? "Put fuel"
        : "Put"
      : opType === "take_result"
        ? "Took result"
        : "Took";

  if (moved >= requestedCount) {
    return {
      ok: true,
      message: `${verb} ${requestedCount} ${displayName}.`,
    };
  }
  if (moved > 0) {
    return {
      ok: true,
      message: `${verb} ${moved} of ${requestedCount} ${displayName}. ${VERIFY_FURNACE_STATE_HINT}`,
    };
  }

  const base =
    transferError !== null ? transferFailureMessage(transferError) : null;
  if (base !== null) {
    return { ok: false, message: `${base} ${VERIFY_FURNACE_STATE_HINT}` };
  }
  return {
    ok: false,
    message: `No ${displayName} moved for ${opType} x${requestedCount}. ${VERIFY_FURNACE_STATE_HINT}`,
  };
}

async function executePut(
  client: MineflayerBot,
  furnace: FurnaceWindow,
  resolved: ResolvedPut,
): Promise<void> {
  const put =
    resolved.slot === INPUT_SLOT
      ? () => furnace.putInput(resolved.itemId, null, resolved.count)
      : () => furnace.putFuel(resolved.itemId, null, resolved.count);
  await put();
}

async function executeTake(
  client: MineflayerBot,
  furnace: FurnaceWindow,
  resolved: ResolvedTake,
): Promise<void> {
  if (client.inventory.emptySlotCount() === 0) {
    const slotItem = furnace.slots[resolved.slot] ?? null;
    const canMerge =
      slotItem !== null &&
      client.inventory
        .items()
        .some(
          (item) => item.type === slotItem.type && item.count < item.stackSize,
        );
    if (!canMerge) {
      throw new Error("Unable to take, Bot inventory is full.");
    }
  }

  await client.transfer({
    window: furnace,
    itemType: resolved.itemId,
    metadata: null,
    count: resolved.count,
    sourceStart: resolved.slot,
    sourceEnd: resolved.slot + 1,
    destStart: furnace.inventoryStart,
    destEnd: furnace.inventoryEnd,
  });
}

async function runSingleOperation(
  client: MineflayerBot,
  furnace: FurnaceWindow,
  operation: FurnaceOperation,
): Promise<{
  outcome: { ok: true; message: string } | { ok: false; message: string };
  item_name: string;
  count: number;
}> {
  const resolvedOp = resolveOperation(client, furnace, operation);
  if (!resolvedOp.ok) {
    return {
      outcome: { ok: false, message: resolvedOp.error },
      item_name: operation.item_name ?? "-",
      count: operation.count ?? 0,
    };
  }

  const { resolved } = resolvedOp;
  const before = itemLocationCounts(
    client,
    furnace,
    resolved.itemId,
    resolved.displayName,
    resolved.slot,
  );

  let transferError: unknown | null = null;

  try {
    await withTimeout(
      resolved.kind === "put"
        ? executePut(client, furnace, resolved)
        : executeTake(client, furnace, resolved),
      FURNACE_OPERATION_TIMEOUT_MS,
      () =>
        new FurnaceOperationTimeoutError(
          FURNACE_OPERATION_TIMEOUT_MS,
          operation,
        ),
    );
  } catch (error) {
    const base = transferFailureMessage(error);
    if (base === null) {
      throw error;
    }
    transferError = error;
  } finally {
    await clearFurnaceWindowCursor(client, furnace, resolved.kind);
  }

  const after = itemLocationCounts(
    client,
    furnace,
    resolved.itemId,
    resolved.displayName,
    resolved.slot,
  );

  return {
    outcome: buildOperationOutcome(
      before,
      after,
      resolved.kind,
      operation.op_type,
      resolved.displayName,
      resolved.count,
      transferError,
    ),
    item_name: resolved.displayName,
    count: resolved.count,
  };
}

export async function runFurnaceOperations(
  client: MineflayerBot,
  furnace: FurnaceWindow,
  operations: FurnaceOperation[],
  onError: FurnaceOnError,
): Promise<FurnaceOperationResult[]> {
  const results: FurnaceOperationResult[] = [];

  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]!;
    try {
      const { outcome, item_name, count } = await runSingleOperation(
        client,
        furnace,
        operation,
      );
      results.push({
        index,
        op_type: operation.op_type,
        item_name,
        count,
        ok: outcome.ok,
        message: outcome.message,
      });
      if (!outcome.ok && onError === "stop") {
        break;
      }
    } catch (error) {
      try {
        await clearFurnaceWindowCursor(
          client,
          furnace,
          operationKind(operation),
        );
      } catch {
        // Best-effort; original error is more important.
      }
      const message =
        error instanceof FurnaceOperationTimeoutError
          ? error.message
          : String(error);
      results.push({
        index,
        op_type: operation.op_type,
        item_name: operation.item_name ?? "-",
        count: operation.count ?? 0,
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

export function formatFurnaceOperationReport(
  results: FurnaceOperationResult[],
  onError: FurnaceOnError,
  totalOperations: number,
): string {
  const lines: string[] = [];
  if (results.length === 0) {
    lines.push("No furnace operations were run.");
    return lines.join("\n");
  }

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const stoppedEarly =
    onError === "stop" && failed.length > 0 && results.length < totalOperations;

  lines.push(`Operations (${results.length}):`);
  for (const result of results) {
    const status = result.ok ? "ok" : "failed";
    const countLabel = result.count > 0 ? ` x${result.count}` : "";
    lines.push(
      `- [${result.index + 1}] ${result.op_type} ${result.item_name}${countLabel}: ${status} — ${result.message}`,
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

export async function withFurnaceSession<T>(
  client: MineflayerBot,
  block: Block,
  fn: (furnace: FurnaceWindow) => Promise<T>,
): Promise<T> {
  const furnace = await openFurnaceWindow(client, block);
  try {
    return await fn(furnace);
  } finally {
    closeFurnaceWindow(furnace);
  }
}

export async function buildFurnaceSummaryFromWindow(
  furnace: FurnaceWindow,
  coords: BlockCoords,
  blockName: string,
): Promise<string> {
  const progressPending = await waitForFurnaceProgressSettle(furnace);
  const input = summarizeSlot(furnace.inputItem());
  const fuel = summarizeSlot(furnace.fuelItem());
  const output = summarizeSlot(furnace.outputItem());
  const progress = readFurnaceProgress(furnace, progressPending);
  return formatFurnaceSummary(input, fuel, output, progress, coords, blockName);
}
