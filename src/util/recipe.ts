import { createRequire } from "node:module";
import type { Bot as MineflayerBot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Recipe } from "prismarine-recipe";
import { resolveInteractableBlock, type BlockCoords } from "./block.js";
import { normalizeItemName } from "./item.js";

const require = createRequire(import.meta.url);

type RecipeLoader = (registry: MineflayerBot["registry"]) => {
  Recipe: typeof Recipe;
};

const recipeLoader = require("prismarine-recipe") as RecipeLoader;

/**
 * Cap for bot.craft (mainly catches windowOpen hangs). Successful crafts usually finish sooner.
 * Base covers first open + one operation; extra time scales for multi-craft batches.
 */
export const CRAFT_BASE_TIMEOUT_MS = 8_000;
export const CRAFT_TIMEOUT_PER_OPERATION_MS = 1_500;
export const CRAFT_TIMEOUT_MAX_MS = 25_000;

export class CraftTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Crafting timed out after ${timeoutMs}ms. The bot may be too far from the crafting table, the window did not open, or something is blocking interaction. Use move_to_interactable_block or move closer and retry.`,
    );
    this.name = "CraftTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function craftTimeoutMs(craftOperations: number): number {
  return Math.min(
    CRAFT_TIMEOUT_MAX_MS,
    CRAFT_BASE_TIMEOUT_MS +
      Math.max(0, craftOperations - 1) * CRAFT_TIMEOUT_PER_OPERATION_MS,
  );
}

export async function craftWithTimeout(
  client: MineflayerBot,
  recipe: Recipe,
  craftOperations: number,
  craftingTable?: Block,
): Promise<void> {
  const timeoutMs = craftTimeoutMs(craftOperations);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new CraftTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    await Promise.race([
      client.craft(recipe, craftOperations, craftingTable),
      deadline,
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export type ScaledRecipeLine = {
  name: string;
  count: number;
};

export type ScaledRecipeParts = {
  crafts: number;
  inputs: ScaledRecipeLine[];
  outputs: ScaledRecipeLine[];
};

/** Resolve a case-insensitive item name via the bot registry. */
export function resolveRegistryItem(
  registry: MineflayerBot["registry"],
  itemName: string,
): { id: number; name: string } | null {
  const normalized = normalizeItemName(itemName);
  const direct = registry.itemsByName[normalized];
  if (direct) {
    return { id: direct.id, name: direct.name };
  }

  for (const item of Object.values(registry.itemsByName)) {
    if (item && normalizeItemName(item.name) === normalized) {
      return { id: item.id, name: item.name };
    }
  }

  return null;
}

function itemIdToName(
  registry: MineflayerBot["registry"],
  id: number,
  metadata: number | null,
): string {
  const item = registry.items[id];
  if (!item) {
    return metadata != null ? `item_${id}:${metadata}` : `item_${id}`;
  }
  if (metadata != null && item.variations) {
    const variant = item.variations.find((v) => v.metadata === metadata);
    if (variant?.name) {
      return variant.name;
    }
  }
  return item.name;
}

function deltaKey(id: number, metadata: number | null): string {
  return `${id}:${metadata ?? ""}`;
}

/**
 * Scale per-craft {@linkcode Recipe.delta} to produce `targetCount` of the result item.
 * Inputs are negative, outputs are positive.
 */
export function scaleRecipeDelta(
  recipe: Recipe,
  targetCount: number,
  registry: MineflayerBot["registry"],
): ScaledRecipeParts {
  const crafts = Math.ceil(targetCount / recipe.result.count);
  const inputs = new Map<string, ScaledRecipeLine>();
  const outputs = new Map<string, ScaledRecipeLine>();

  for (const entry of recipe.delta) {
    const key = deltaKey(entry.id, entry.metadata);
    const name = itemIdToName(registry, entry.id, entry.metadata);

    if (entry.count < 0) {
      const scaled = Math.abs(entry.count) * crafts;
      if (scaled === 0) {
        continue;
      }
      const existing = inputs.get(key);
      if (existing) {
        existing.count += scaled;
      } else {
        inputs.set(key, { name, count: scaled });
      }
      continue;
    }

    if (entry.count > 0) {
      const scaled = entry.count * crafts;
      if (scaled === 0) {
        continue;
      }
      const existing = outputs.get(key);
      if (existing) {
        existing.count += scaled;
      } else {
        outputs.set(key, { name, count: scaled });
      }
    }
  }

  const byName = (a: ScaledRecipeLine, b: ScaledRecipeLine) =>
    a.name.localeCompare(b.name);

  return {
    crafts,
    inputs: [...inputs.values()].sort(byName),
    outputs: [...outputs.values()].sort(byName),
  };
}

/** Stable key for matching recipe variants (no recipe ids in minecraft-data). */
export function recipeSignature(recipe: Recipe): string {
  const inputParts: string[] = [];
  for (const entry of recipe.delta) {
    if (entry.count < 0) {
      inputParts.push(
        `${entry.id}:${entry.metadata ?? ""}:${Math.abs(entry.count)}`,
      );
    }
  }
  inputParts.sort();
  const result = recipe.result;
  return [
    recipe.requiresTable ? "1" : "0",
    `${result.id}:${result.metadata ?? ""}:${result.count}`,
    ...inputParts,
  ].join("|");
}

export function recipesMatch(a: Recipe, b: Recipe): boolean {
  return recipeSignature(a) === recipeSignature(b);
}

function compareCraftingRecipes(a: Recipe, b: Recipe): number {
  if (a.requiresTable !== b.requiresTable) {
    return a.requiresTable ? 1 : -1;
  }
  return recipeSignature(a).localeCompare(recipeSignature(b));
}

export function sortCraftingRecipes(recipes: Recipe[]): Recipe[] {
  return [...recipes].sort(compareCraftingRecipes);
}

/** All crafting variants for an item, in canonical order (shared by check and craft tools). */
export function findCraftingRecipes(
  registry: MineflayerBot["registry"],
  itemId: number,
  metadata: number | null = null,
): Recipe[] {
  const { Recipe } = recipeLoader(registry);
  return sortCraftingRecipes(Recipe.find(itemId, metadata));
}

export function craftOperationsForTargetCount(
  recipe: Recipe,
  targetCount: number,
): number {
  return Math.ceil(targetCount / recipe.result.count);
}

export function isRecipeCraftable(
  client: MineflayerBot,
  itemId: number,
  recipe: Recipe,
  targetCount: number,
  craftingTable: Block | null,
): boolean {
  const craftable = client.recipesFor(itemId, null, targetCount, craftingTable);
  return craftable.some((candidate) => recipesMatch(candidate, recipe));
}

export type ResolveCraftingTableResult =
  | { ok: true; block: Block | null }
  | { ok: false; error: string };

export function resolveCraftingTableBlock(
  client: MineflayerBot,
  useCraftingTable: boolean,
  coords?: BlockCoords,
): ResolveCraftingTableResult {
  if (!useCraftingTable) {
    return { ok: true, block: null };
  }

  const resolved = resolveInteractableBlock(client, {
    ...(coords !== undefined ? { coords } : {}),
    allowedNames: new Set(["crafting_table"]),
    label: "crafting table",
    checkReach: true,
    reachHint: "Move beside it before crafting.",
  });

  if (!resolved.ok) {
    return resolved;
  }
  return { ok: true, block: resolved.block };
}

export type ResolveCraftRecipeResult =
  | {
      ok: true;
      recipe: Recipe;
      /** 1-based index matching check_crafting_recipe labels (Recipe 1 = 1). */
      recipeIndex: number;
      crafts: number;
      autoSelected: boolean;
    }
  | { ok: false; error: string };

export function resolveRecipeForCraft(
  client: MineflayerBot,
  itemId: number,
  options: {
    targetCount: number;
    useCraftingTable: boolean;
    /** 1-based index matching check_crafting_recipe labels (Recipe 1 = 1). */
    recipeIndex?: number | null;
    craftingTable: Block | null;
  },
): ResolveCraftRecipeResult {
  const ordered = findCraftingRecipes(client.registry, itemId, null);
  if (ordered.length === 0) {
    return {
      ok: false,
      error:
        "No crafting recipe found for this item. It may require smelting or another process.",
    };
  }

  const hasTableOnlyVariant = ordered.some((recipe) => recipe.requiresTable);

  if (options.recipeIndex != null) {
    const recipeIndex = options.recipeIndex;
    if (recipeIndex < 1 || recipeIndex > ordered.length) {
      return {
        ok: false,
        error: `recipe_index ${recipeIndex} is out of range (1 to ${ordered.length}). Use check_crafting_recipe to list variants.`,
      };
    }
    const recipe = ordered[recipeIndex - 1]!;
    if (recipe.requiresTable && !options.useCraftingTable) {
      return {
        ok: false,
        error: `Recipe ${recipeIndex}/${ordered.length} requires a crafting table. Set use_crafting_table to true.`,
      };
    }
    if (
      !isRecipeCraftable(
        client,
        itemId,
        recipe,
        options.targetCount,
        options.craftingTable,
      )
    ) {
      return {
        ok: false,
        error: buildNotCraftableMessage(
          ordered,
          options.useCraftingTable,
          hasTableOnlyVariant,
          `Recipe ${recipeIndex}/${ordered.length} is not craftable with the current inventory and settings.`,
        ),
      };
    }
    return {
      ok: true,
      recipe,
      recipeIndex,
      crafts: craftOperationsForTargetCount(recipe, options.targetCount),
      autoSelected: false,
    };
  }

  const candidates = ordered.filter(
    (recipe) => options.useCraftingTable || !recipe.requiresTable,
  );

  for (const recipe of candidates) {
    const orderedIndex = ordered.findIndex((entry) =>
      recipesMatch(entry, recipe),
    );
    if (orderedIndex < 0) {
      // should not happen
      throw new Error(`Recipe ${recipe.result.id} not found in ordered list.`);
    }
    if (
      isRecipeCraftable(
        client,
        itemId,
        recipe,
        options.targetCount,
        options.craftingTable,
      )
    ) {
      return {
        ok: true,
        recipe,
        recipeIndex: orderedIndex + 1,
        crafts: craftOperationsForTargetCount(recipe, options.targetCount),
        autoSelected: true,
      };
    }
  }

  return {
    ok: false,
    error: buildNotCraftableMessage(
      ordered,
      options.useCraftingTable,
      hasTableOnlyVariant,
      "No craftable recipe variant matched the current settings.",
    ),
  };
}

function buildNotCraftableMessage(
  ordered: Recipe[],
  useCraftingTable: boolean,
  hasTableOnlyVariant: boolean,
  prefix: string,
): string {
  const hints: string[] = [prefix, "Check ingredients with check_inventory."];
  if (!useCraftingTable && hasTableOnlyVariant) {
    hints.push(
      "Some variants require a 3x3 crafting table; try use_crafting_table: true and place/find a crafting_table.",
    );
  } else {
    hints.push(
      "Failures are usually missing materials or the wrong recipe_index. See check_crafting_recipe for variants.",
    );
  }
  const tableOnlyCount = ordered.filter(
    (recipe) => recipe.requiresTable,
  ).length;
  if (!useCraftingTable && tableOnlyCount === ordered.length) {
    hints.push(
      `All ${ordered.length} variant(s) for this item require a crafting table.`,
    );
  }
  return hints.join(" ");
}

function formatItemLines(lines: ScaledRecipeLine[]): string {
  if (lines.length === 0) {
    return "  (none)";
  }
  return lines.map((line) => `  - ${line.name} x ${line.count}`).join("\n");
}

export function formatCraftingRecipeReport(
  itemName: string,
  targetCount: number,
  recipes: Recipe[],
  registry: MineflayerBot["registry"],
): string {
  if (recipes.length === 0) {
    return [
      `No crafting recipe found for ${itemName}.`,
      "This item may be obtained by smelting or other means (not covered by crafting recipes).",
    ].join("\n");
  }

  const header = `Crafting recipes for at least ${targetCount} ${itemName} (${recipes.length} variant(s)):`;
  const blocks: string[] = [header];

  recipes.forEach((recipe, index) => {
    const { crafts, inputs, outputs } = scaleRecipeDelta(
      recipe,
      targetCount,
      registry,
    );
    const variantLabel =
      recipes.length > 1 ? `Recipe ${index + 1}/${recipes.length}:` : "Recipe:";
    const tableLine = recipe.requiresTable
      ? "Requires crafting table: yes"
      : "Requires crafting table: no (2x2 inventory crafting)";

    blocks.push(
      [
        variantLabel,
        tableLine,
        `Number of Craft operations to perform: ${crafts} (minimum target: ${targetCount} of ${itemName}; see Outputs for actual totals)`,
        "Inputs:",
        formatItemLines(inputs),
        "Outputs:",
        formatItemLines(outputs),
      ].join("\n"),
    );
  });

  return blocks.join("\n\n");
}
