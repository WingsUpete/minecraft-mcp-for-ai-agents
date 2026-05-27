import type { McpServer } from "@modelcontextprotocol/server";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { Bot } from "../bot/bot.js";
import { log } from "../util/logger.js";

/** MCP resource URI for the bot's incoming Minecraft chat buffer. */
export const INCOMING_MESSAGES_URI = "minecraft://incoming-messages";

let incomingMessagesSubscribed = false;

function readIncomingMessages(bot: Bot, uri: URL) {
  const pending = bot.incomingMessages.splice(0);
  log(`[READ_MSG] ${pending.length} messages read`, "debug");
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(pending),
      },
    ],
  };
}

function assertIncomingMessagesUri(uri: string): void {
  if (uri !== INCOMING_MESSAGES_URI) {
    throw new ProtocolError(
      ProtocolErrorCode.ResourceNotFound,
      `Resource ${uri} not found`,
    );
  }
}

function setupSubscriptionHandlers(server: McpServer): void {
  server.server.setRequestHandler("resources/subscribe", async (request) => {
    assertIncomingMessagesUri(request.params.uri);
    incomingMessagesSubscribed = true;
    return {};
  });

  server.server.setRequestHandler("resources/unsubscribe", async (request) => {
    assertIncomingMessagesUri(request.params.uri);
    incomingMessagesSubscribed = false;
    return {};
  });
}

function notifySubscribers(server: McpServer): void {
  if (!incomingMessagesSubscribed || !server.isConnected()) {
    return;
  }
  void server.server
    .sendResourceUpdated({ uri: INCOMING_MESSAGES_URI })
    .catch(() => {
      // Client may have disconnected; ignore notification failures.
    });
}

/**
 * Exposes pending Minecraft chat as an MCP resource. Each successful read
 * returns all buffered messages and clears the buffer; the client should retain history.
 */
export function registerIncomingMessagesResource(
  server: McpServer,
  bot: Bot,
): void {
  setupSubscriptionHandlers(server);

  server.registerResource(
    "incoming-messages",
    INCOMING_MESSAGES_URI,
    {
      title: "Incoming messages from Minecraft chat",
      description:
        "Pending chat and whisper messages not yet read. Returns them as JSON and clears the server buffer. Subscribe for notifications/resources/updated when new messages arrive, then read to drain. The client is responsible for long-term message history.",
      mimeType: "application/json",
    },
    async (uri) => readIncomingMessages(bot, uri),
  );

  bot.onIncomingMessage = () => {
    notifySubscribers(server);
  };
}
