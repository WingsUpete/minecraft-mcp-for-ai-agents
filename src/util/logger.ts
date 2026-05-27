// TODO: potentially mergeable with common.ts

export function log(message: string, level: string = "info") {
  const timestamp = new Date().toISOString();
  // log to stderr so mcp via stdio is not messed up
  console.error(`<MCP-Server> ${timestamp} [${level.toUpperCase()}] ${message}`);
}
