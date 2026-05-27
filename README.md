# Minecraft MCP Server for AI Agents

This repository is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server.
It exposes Minecraft bot actions as MCP tools.
Treat the server as the agent's **body**: it performs actions in the game.
An MCP client that connects to it is usually part of a larger AI agent.
That agent runs the loop and acts as the agent's **brain**, deciding which tools to call and when.

The architectural design (e.g., config template, tool registry) is inspired by the [minecraft-mcp-server](https://github.com/yuniko-software/minecraft-mcp-server) project.
This repo redesigns the tools and adds several optimizations on top of Mineflayer.

## Purpose

This project is for agent developers who test agents in a Minecraft sandbox.
The server provides many separate tools, not one bundled workflow.
Each tool names a player-familiar activity, such as chat, movement, collecting a block, or crafting.
A tool may chain several game steps when players treat them as one action.
For example, `collect_block` pathfinds, mines, and picks up drops in a single call.
Simpler tools such as `chat` and `position` do only one thing.

The server stops at player-sized actions.
It is the client's responsibility to pick a subset of tools and group them into **agent skills** for different tasks.

## Implemented tools

Categories match the handler modules under `src/tool/` (and `src/tool/container/`).

| Category  | Tool name                    | Description                                                                             |
| --------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| readiness | `check_readiness`            | Wait for bot connection/spawn; reconnect if needed (use when client misbehaves).        |
| chat      | `chat`                       | Send a public chat message.                                                             |
| chat      | `whisper`                    | Send a private message to a player by exact username.                                   |
| position  | `position`                   | Read bot block coordinates (x, y, z).                                                   |
| position  | `move`                       | Pathfind to (x,y,z) or (x,z); `range` 0 = exact block (requires `y`); **blocking**.     |
| position  | `follow`                     | Follow a player at `range` (non-blocking).                                              |
| position  | `stop_moving`                | Cancel pathfinding / follow.                                                            |
| position  | `movement_status`            | Read active goal, movement owner, and walking state (read-only).                        |
| entity    | `find_nearest_entity`        | Nearest entity or dropped item (optional type filter).                                  |
| entity    | `pickup_item`                | Pathfind to nearby drops and collect (blocking).                                        |
| block     | `find_block`                 | Nearest world block by name.                                                            |
| block     | `collect_block`              | Pathfind, mine, pickup (blocking); by name or coordinates.                              |
| block     | `place_block`                | Pathfind and place inventory block against a reference face (blocking).                 |
| block     | `move_to_interactable_block` | Pathfind to use/open a block (table, furnace, chest); **blocking**.                     |
| block     | `drop_block`                 | Drop inventory items onto the ground (default count 1).                                 |
| inventory | `check_inventory`            | List items in inventory (stacks combined).                                              |
| recipe    | `check_crafting_recipe`      | List recipe variants and scaled ingredients.                                            |
| recipe    | `craft_item`                 | Craft from inventory / crafting table (`recipe_index`, `use_crafting_table`).           |
| chest     | `check_chest_contents`       | List chest/barrel contents (optional coords; nearest in range).                         |
| chest     | `interact_with_chest`        | Batch deposit/withdraw in one chest session (`on_error`: skip/stop).                    |
| furnace   | `check_furnace`              | Read furnace slots and smelting/fuel progress (optional coords).                        |
| furnace   | `interact_with_furnace`      | Batch put/take items, fuel, and results in one furnace session (`on_error`: skip/stop). |

## Implemented resources

Besides tools (actions), the server exposes **resources** for read-only state that can change without a client poll. Handlers live under `src/resource/`.

| Resource name       | URI                             | Description                                                                     |
| ------------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `incoming-messages` | `minecraft://incoming-messages` | Pending Minecraft **chat** and **whisper** messages not yet read by the client. |

**`incoming-messages`** — Mineflayer appends each `chat` / `whisper` event to an in-memory buffer on the bot. The client **subscribes** to `minecraft://incoming-messages`; when a new message arrives, the server sends `notifications/resources/updated` for that URI. The client then **reads** the resource: the response is a JSON array of `{ type, sender, content }` objects, and the read **clears** the server buffer. The client should keep its own history (see the agent README). Subscribe before relying on notifications; messages that arrive before subscribe are only available on the first read.

## Repo layout (this package)

- `src/` — MCP server entry and tool handlers (build with `npm run build`).
- `dist/` — compiled output (run with `npm start` or your MCP client’s configured command).
- `package.json` — scripts and dependencies (`@modelcontextprotocol/server`, etc.).

## Build and run

```bash
# setup dependencies
npm install
# build the project
npm run build
# execute the project build
npm start -- --bot-name Steve --game-host 127.0.0.1 --game-port 25565 --game-version 1.21.4 --viewer-port 3000 --inventoryViewerPort 4000 --debug true
# (very optional) inspect MCP server with a web interface
# This inspector is currently a bit broken. Use with caution.
npm run inspect -- --bot-name Steve --game-host 127.0.0.1 --game-port 25565 --game-version 1.21.4 --viewer-port 3000 --inventoryViewerPort 4000 --debug true
```

Use `npm run inspect` if you need the MCP inspector against the built server.

## Test with an Existing Coding Agent (e.g., Cursor, Claude Code)

Remember to build the project first.

Append the following configurations to your MCP settings.

```json
{
  "mcpServers": {
    "amas-minecraft-mcp-server": {
      "command": "node",
      "args": [
        "/your/mcp/folder/dist/index.js",
        "--botName",
        "Steve",
        "--gameHost",
        "127.0.0.1",
        "--gamePort",
        "25565",
        "--gameVersion",
        "1.21.4",
        "--viewerPort",
        "3000",
        "--inventoryViewerPort",
        "4000",
        "--debug",
        "false"
      ]
    }
  }
}
```

## Useful Auxilliary Web Services

We support [Prismarine Viewer](https://github.com/PrismarineJS/prismarine-viewer) and [Mineflayer Web Inventory](https://github.com/imharvol/mineflayer-web-inventory) from two ports (default to `3000` and `4000`).

## Note

Below records several usage suggestions and modifications that might be helpful for debugging the bot's behavior.

### Minecraft Data

Currently, it appears difficult to [check smelting recipes with Mineflayer](https://github.com/PrismarineJS/minecraft-data/issues/290). Therefore, we only support checking crafting recipes. Please handle the smelting recipes from the client side (e.g., web-based search tool to access [Minecraft Wiki](https://minecraft.wiki/), local RAG-based search tool with pre-extracted knowledge base from [Odyssey](https://github.com/zju-vipa/Odyssey/blob/260303c8c0c5afd86d8b50edffb5ffac0de01d4f/MC-Crawler/crawler_data/Smelting/Smelting.md)).

### Prismarine Viewer

As [Prismarine Viewer](https://github.com/PrismarineJS/prismarine-viewer/issues/473) is currently experiencing rendering issues in higher Minecraft game versions, it is highly recommended to set the game version to <=`1.21.4`, if you intend to utilize the web viewer for the agent.

### Mineflayer Pathfinder

We removed pathfinding's thinking timeout so all blocking movement tools will execute without internal timeout. Please handle it from the client side if necessary.

We also introduced movement sessions to ensure only one movement-related tool call can retain pathfinder movement control.

Last but not least, we added patches to handle bot wedges (i.e., bot getting stuck in a position for too long). When the bot is stuck for a while, it automatically attempts to escape from all previously stuck positions. This fix ensures the bot is always approaching its movement goal robustly.

### Collect Block Plugin

Formerly, the plugin could lead to heap memory leak issues when the bot does not have any proper tool to collect the target block, which exited the entire program. To fix, we added pre-condition checks to ensure a tool is available before block collection.

Also, the bot can still get stuck as it is not integrated with our wedge handling fix. Therefore, we recommend adding timeout for the collect-block tool for now. In the near future, we will find a way to fix it.

There is also currently a bug causing the plugin to properly collect flowers. We will fix it soon.
