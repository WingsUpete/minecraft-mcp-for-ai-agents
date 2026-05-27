import * as z from "zod/v4";
import { defineTool } from "./registry.js";
import { createErrorToolResponse, createToolResponse } from "./response.js";
import { log } from "../util/logger.js";
import { parseOptionalBlockCoords } from "../util/block.js";
import {
  CraftTimeoutError,
  craftWithTimeout,
  findCraftingRecipes,
  formatCraftingRecipeReport,
  resolveCraftingTableBlock,
  resolveRecipeForCraft,
  resolveRegistryItem,
  scaleRecipeDelta,
} from "../util/recipe.js";

export { checkCraftingRecipeTool, craftItemTool };

const itemNameSchema = z
  .string()
  .describe(
    "Item to craft (e.g. bread, crafting_table, oak_planks). Case-insensitive.",
  );

const targetCountSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Target number of the item to obtain. Defaults to 1.");

const checkCraftingRecipeTool = defineTool({
  name: "check_crafting_recipe",
  description: `
Look up crafting recipes for an item.
Returns all recipe variants in a stable order (Recipe 1, Recipe 2, …). Use recipe_index 1 for Recipe 1 when calling craft_item.
Scaled inputs and outputs show what is needed for at least the requested item count.
`.trim(),
  inputSchema: z.object({
    item_name: itemNameSchema,
    count: targetCountSchema,
  }),
  handler: async (bot, args) => {
    try {
      await bot.ensureReadyWithin();
      const client = bot.client;
      if (!client) {
        return createErrorToolResponse("Bot is not connected");
      }

      const targetCount = args.count ?? 1;
      const item = resolveRegistryItem(client.registry, args.item_name);
      if (item === null) {
        const errMsg = `Unknown item: '${args.item_name}'.`;
        log(`[CHECK_CRAFTING_RECIPE] ${errMsg}`, "error");
        return createErrorToolResponse(errMsg);
      }

      const recipes = findCraftingRecipes(client.registry, item.id, null);
      const msg = formatCraftingRecipeReport(
        item.name,
        targetCount,
        recipes,
        client.registry,
      );
      log(`[CHECK_CRAFTING_RECIPE] ${msg.replace(/\n/g, "; ")}`, "debug");
      return createToolResponse(msg);
    } catch (error) {
      const errMsg = `Failed to check crafting recipe: ${String(error)}`;
      log(`[CHECK_CRAFTING_RECIPE] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});

const craftItemTool = defineTool({
  name: "craft_item",
  description: `
Craft an item using ingredients in the bot inventory.
Recipe variants and numbering match check_crafting_recipe (recipe_index 1 = Recipe 1).
count is the target number of items to obtain (same as check_crafting_recipe).
When recipe_index is omitted, picks the first sorted variant that fits use_crafting_table (inventory-only when false; any variant when true).
use_crafting_table defaults to false. When true, uses table_x/y/z or the nearest crafting_table within interaction range (4.5 blocks).
Does not move the bot. Use find_block → move_to_interactable_block at the table coordinates (or move nearby) before crafting when use_crafting_table is true.
Recipes with requiresTable false can still be crafted when use_crafting_table is true.
`.trim(),
  inputSchema: z.object({
    item_name: itemNameSchema,
    count: targetCountSchema,
    recipe_index: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Index matching check_crafting_recipe labels (Recipe 1 = 1). Auto-selects when omitted.",
      ),
    use_crafting_table: z
      .boolean()
      .optional()
      .describe(
        "Use a 3x3 crafting table block. Defaults to false. When true, 2x2-capable recipes may still be chosen and crafted at the table.",
      ),
    table_x: z
      .number()
      .int()
      .optional()
      .describe("Crafting table X. Requires table_y and table_z when set."),
    table_y: z.number().int().optional().describe("Crafting table Y."),
    table_z: z.number().int().optional().describe("Crafting table Z."),
  }),
  handler: async (bot, args) => {
    try {
      await bot.ensureReadyWithin();
      const client = bot.client;
      if (!client) {
        return createErrorToolResponse("Bot is not connected");
      }

      const targetCount = args.count ?? 1;
      const useCraftingTable = args.use_crafting_table ?? false;
      const tableCoordsParsed = parseOptionalBlockCoords(
        args.table_x,
        args.table_y,
        args.table_z,
        "table_x, table_y, and table_z must all be provided together.",
      );
      if (!tableCoordsParsed.ok) {
        log(`[CRAFT_ITEM] ${tableCoordsParsed.error}`, "error");
        return createErrorToolResponse(tableCoordsParsed.error);
      }

      const item = resolveRegistryItem(client.registry, args.item_name);
      if (item === null) {
        const errMsg = `Unknown item: '${args.item_name}'.`;
        log(`[CRAFT_ITEM] ${errMsg}`, "error");
        return createErrorToolResponse(errMsg);
      }

      const tableCoords = tableCoordsParsed.coords;

      const tableResult = resolveCraftingTableBlock(
        client,
        useCraftingTable,
        tableCoords,
      );
      if (!tableResult.ok) {
        log(`[CRAFT_ITEM] ${tableResult.error}`, "error");
        return createErrorToolResponse(tableResult.error);
      }

      const craftingTableForRecipe = useCraftingTable
        ? tableResult.block
        : null;

      const recipeResult = resolveRecipeForCraft(client, item.id, {
        targetCount,
        useCraftingTable,
        ...(args.recipe_index !== undefined
          ? { recipeIndex: args.recipe_index }
          : {}),
        craftingTable: craftingTableForRecipe,
      });
      if (!recipeResult.ok) {
        log(`[CRAFT_ITEM] ${recipeResult.error}`, "error");
        return createErrorToolResponse(recipeResult.error);
      }

      const { recipe, recipeIndex, crafts, autoSelected } = recipeResult;
      const craftTableArg = useCraftingTable
        ? (tableResult.block ?? undefined)
        : undefined;

      await craftWithTimeout(client, recipe, crafts, craftTableArg);

      const scaled = scaleRecipeDelta(recipe, targetCount, client.registry);
      const variantLabel = `Recipe ${recipeIndex}`;
      const selectionLine = autoSelected
        ? `Auto-selected ${variantLabel}.`
        : `Used ${variantLabel}.`;
      const msg = [
        `Crafted ${item.name} (requested at least ${targetCount}; ${crafts} craft operation(s)).`,
        selectionLine,
        `Outputs: ${scaled.outputs.map((line) => `${line.name} x ${line.count}`).join(", ") || "(none)"}`,
      ].join("\n");
      log(`[CRAFT_ITEM] ${msg.replace(/\n/g, "; ")}`, "debug");
      return createToolResponse(msg);
    } catch (error) {
      const errMsg =
        error instanceof CraftTimeoutError
          ? error.message
          : `Failed to craft item: ${String(error)}`;
      log(`[CRAFT_ITEM] ${errMsg}`, "error");
      return createErrorToolResponse(errMsg);
    }
  },
});
