import "./util/mcp_stdio_guard.js";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server";
import { Bot } from "./bot/bot.js";
import { loadConfig } from "./config.js";
import { BotConfig } from "./bot/config.js";
import { log } from "./util/logger.js";
import { registerTools } from "./tool/registry.js";
import { readinessTool } from "./tool/readiness.js";
import { registerResources } from "./resource/registry.js";
import { chatTool, whisperTool } from "./tool/chat.js";
import {
  positionTool,
  moveTool,
  followTool,
  stopMovingTool,
  movementStatusTool,
} from "./tool/position.js";
import { findNearestEntityTool, pickupItemTool } from "./tool/entity.js";
import {
  findBlockTool,
  collectBlockTool,
  placeBlockTool,
  moveToInteractableBlockTool,
  dropBlockTool,
} from "./tool/block.js";
import { checkInventoryTool } from "./tool/inventory.js";
import { checkCraftingRecipeTool, craftItemTool } from "./tool/recipe.js";
import {
  checkChestContentsTool,
  interactWithChestTool,
} from "./tool/container/chest.js";
import {
  checkFurnaceTool,
  interactWithFurnaceTool,
} from "./tool/container/furnace.js";

async function main() {
  // load CLI args
  const serverConfig = loadConfig();
  // init a bot
  const botConfig = BotConfig.parse({
    name: serverConfig.botName,
    host: serverConfig.gameHost,
    port: serverConfig.gamePort,
    version: serverConfig.gameVersion,
    viewerPort: serverConfig.viewerPort,
    inventoryViewerPort: serverConfig.inventoryViewerPort,
    debug: serverConfig.debug,
  });
  const bot = new Bot(botConfig);
  await bot.reconnect();
  // create and configure mcp server
  const server = new McpServer(
    {
      name: "amas-minecraft-mcp-server",
      version: "1.0.0",
      description: "A Minecraft MCP server for the AMAS course.",
    },
    {
      capabilities: {
        resources: {
          subscribe: true,
          listChanged: true,
        },
      },
    },
  );
  registerResources(server, bot);
  registerTools(server, bot, [
    readinessTool,
    chatTool,
    whisperTool,
    positionTool,
    moveTool,
    followTool,
    stopMovingTool,
    movementStatusTool,
    findNearestEntityTool,
    pickupItemTool,
    findBlockTool,
    collectBlockTool,
    placeBlockTool,
    moveToInteractableBlockTool,
    dropBlockTool,
    checkInventoryTool,
    checkCraftingRecipeTool,
    craftItemTool,
    checkChestContentsTool,
    interactWithChestTool,
    checkFurnaceTool,
    interactWithFurnaceTool,
  ]);
  // shutdown the server and bot on interrupt or terminate signals
  let shutdownInProgress = false;
  const shutdown = async (signal: string) => {
    if (shutdownInProgress) {
      return;
    }
    shutdownInProgress = true;
    log(`[INIT] ${signal} received, shutting down...`);
    try {
      if (server.isConnected()) {
        await server.close();
      }
    } catch (error) {
      log(`[INIT] MCP server close failed: ${String(error)}`, "error");
    }
    bot.stopAutoReconnect();
    bot.stop(signal);
    process.exit(0);
  };
  // register shutdown handlers to SIGINT and SIGTERM
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  // start the mcp server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`[INIT] MCP Server for Bot ${bot.client!.username} is running...`);
  bot.startAutoReconnect();
}

main().catch((error) => {
  log(`[INIT] Failed to start: ${String(error)}`, "error");
  process.exit(1);
});
