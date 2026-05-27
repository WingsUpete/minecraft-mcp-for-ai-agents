import type { McpServer } from "@modelcontextprotocol/server";
import type { Bot } from "../bot/bot.js";
import type { z } from "zod/v4";
import type { ToolResponse } from "./response.js";

/*
 * TODO: Add optional second generic O extends z.ZodTypeAny | undefined for outputSchema.
 * - Tool<I, O>: when O is set, require outputSchema + handler returns
 *   StructuredToolResponse<z.infer<O>> (content + structuredContent); when O is undefined,
 *   omit outputSchema (text-only ToolResponse).
 * - defineTool<I, O>, registerTools passes outputSchema to server.registerTool when present.
 * - response.ts: StructuredToolResponse<O>; helpers that build content + structuredContent
 *   for MCP/CLI.
 */

export type Tool<I extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  inputSchema: I;
  handler: (bot: Bot, args: z.infer<I>) => ToolResponse | Promise<ToolResponse>;
};

export function defineTool<I extends z.ZodTypeAny>(tool: Tool<I>): Tool<I> {
  return tool;
}

export function registerTools(
  server: McpServer,
  bot: Bot,
  tools: Tool[],
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      (args) => tool.handler(bot, args),
    );
  }
}
