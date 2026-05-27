import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// when more config is introduced, use & combine all config types
export type ServerConfig = {
  // bot config
  botName: string;
  gameHost: string;
  gamePort: number;
  gameVersion: string;
  viewerPort: number;
  inventoryViewerPort: number;
  debug: boolean;
};

// load config from CLI arguments
export function loadConfig(): ServerConfig {
  return yargs(hideBin(process.argv))
    .option("botName", {
      type: "string",
      description: "Name of the bot in game",
      default: "Steve",
    })
    .option("gameHost", {
      type: "string",
      description: "Host name/IP of the Minecraft server",
      default: "127.0.0.1",
    })
    .option("gamePort", {
      type: "number",
      description: "Port of the Minecraft server",
      default: 25565,
    })
    .option("gameVersion", {
      type: "string",
      description: "Version of the Minecraft server",
      default: "1.21.4",
    })
    .option("viewerPort", {
      type: "number",
      description: "Port for the Minecraft viewer",
      default: 3000,
    })
    .option("inventoryViewerPort", {
      type: "number",
      description: "Port for the Minecraft inventory viewer",
      default: 4000,
    })
    .option("debug", {
      type: "boolean",
      description: "Enable verbose logging",
      default: false,
    })
    .help()
    .alias("h", "help")
    .parseSync();
}
