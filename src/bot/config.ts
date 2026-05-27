import * as z from "zod/v4";

export const BotConfig = z
  .object({
    name: z.string().describe("Name of the bot in game").default("Steve"),
    host: z
      .string()
      .describe("Host name/IP of the Minecraft server")
      .default("127.0.0.1"),
    port: z.number().describe("Port of the Minecraft server").default(25565),
    version: z
      .string()
      .describe("Version of the Minecraft server")
      .default("1.21.4"),
    viewerPort: z
      .number()
      .describe("Port for the Minecraft viewer")
      .default(3000),
    inventoryViewerPort: z
      .number()
      .describe("Port for the Minecraft inventory viewer")
      .default(4000),
    debug: z.boolean().describe("Enable verbose logging").default(false),
  })
  .describe("Configuration for the Minecraft bot");

export type BotConfig = z.infer<typeof BotConfig>;
