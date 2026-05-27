import * as mineflayer from "mineflayer";
import type { Bot as MineflayerBot } from "mineflayer";
import { mineflayer as mineflayerViewer } from "prismarine-viewer";
import { MovementManager } from "../util/pathfinder/manager.js";
import { plugin as collectBlock } from "mineflayer-collectblock";
import { plugin as toolPlugin } from "mineflayer-tool";
import inventoryViewer from "mineflayer-web-inventory";
import type { WebInventoryService } from "./types.js";
import { initializePathfinderMovements } from "../util/collectblock.js";
import { pathfinder } from "../util/pathfinder/wrapper.js";
import type { Movements } from "../util/pathfinder/wrapper.js";
import { formatDisconnectReason } from "../util/mineflayer.js";
import { log } from "../util/logger.js";
import { BotConfig } from "./config.js";
import { Message } from "./message.js";

const BOT_STARTUP_TIMEOUT_MS = 100_000;

/** Default cap for {@linkcode Bot.ensureReadyWithin} (tool-level wait for reconnect). */
export const DEFAULT_ENSURE_READY_TIMEOUT_MS = 30_000;

/** Consecutive failed auto-reconnect ticks before the process exits. */
export const MAX_N_RECONN = 3;

const DEFAULT_AUTO_RECONNECT_INTERVAL_MS = 15_000;

export class Bot {
  public config: BotConfig;
  public client: MineflayerBot | null = null;
  // there should be only one viewer service for the bot
  private viewerService: any = null;
  private inventoryViewerService: WebInventoryService | null = null;
  // bot is ready to use (only after spawn the bot stats are ready to be used)
  public isReady: boolean = false;
  // message buffer is used to store new messages from minecraft chat
  public incomingMessages: Message[];

  // auto-reconnect when the bot is disconnected
  private ensureReadyInflight: Promise<void> | null = null;
  // set true by {@linkcode stopAutoReconnect} (e.g. process shutdown)
  private autoReconnectStopped = false;
  // timer for the auto-reconnect loop
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  // number of consecutive auto-reconnect failures
  private consecutiveAutoReconnectFailures = 0;
  /** Set by MCP resource registration; fired when a new chat/whisper is buffered. */
  public onIncomingMessage?: () => void;
  public readonly movement: MovementManager;
  /** Default pathfinder movements; restored after collect_block. */
  public pathfinderMovements: InstanceType<typeof Movements> | null = null;

  constructor(config: BotConfig) {
    this.config = config;
    this.incomingMessages = [];
    this.movement = new MovementManager(() => this.client);
  }

  public async connect(): Promise<MineflayerBot> {
    if (this.client) {
      throw new Error(
        "Bot already connected; call stop() before reconnecting.",
      );
    }

    log(
      `[CONN] Connecting bot ${this.config.name} to ${this.config.host}:${this.config.port}...`,
    );

    const client = mineflayer.createBot({
      username: this.config.name,
      host: this.config.host,
      port: this.config.port,
      version: this.config.version,
    });
    this.client = client;

    // === plugins (tool before collectblock: collect depends on bot.tool) ===
    client.loadPlugin(pathfinder);
    client.loadPlugin(toolPlugin); // mineflayer-tool
    client.loadPlugin(collectBlock);

    // === events ===
    try {
      await this.waitUntilReady(client, BOT_STARTUP_TIMEOUT_MS);
    } catch (error) {
      this.stop("connect failed");
      throw error;
    }

    this.attachRuntimeClientListeners(client);
    this.consecutiveAutoReconnectFailures = 0;

    log(`[CONN] Bot ${client.username} connected and ready.`);

    return client;
  }

  private attachRuntimeClientListeners(client: MineflayerBot): void {
    client.on("error", (error) => {
      log(`[MINEFLAYER] ${String(error)}`, "error");
    });

    client.on("end", () => {
      this.onSessionLost(client, "end");
    });

    client.on("kicked", (reason, loggedIn) => {
      const text = formatDisconnectReason(reason);
      this.onSessionLost(client, `kicked (loggedIn=${loggedIn}): ${text}`);
    });

    client.on("chat", (username, message) => {
      const chatMsg = {
        type: "chat",
        sender: username,
        content: message,
      } as Message;
      log(`[CHAT] ${chatMsg.sender}: ${chatMsg.content}`);
      this.incomingMessages.push(chatMsg);
      this.onIncomingMessage?.();
    });

    client.on("whisper", (username, message) => {
      const whisperMsg = {
        type: "whisper",
        sender: username,
        content: message,
      } as Message;
      log(`[WHISPER] ${whisperMsg.sender}: ${whisperMsg.content}`);
      this.incomingMessages.push(whisperMsg);
      this.onIncomingMessage?.();
    });

    client.on("death", () => {
      this.onBotDeath(client);
    });
  }

  private onBotDeath(client: MineflayerBot): void {
    if (this.client !== client) {
      return;
    }
    this.movement.onDeath();
    log(
      `[DEATH] ${client.username ?? this.config.name} died; pathfinder goal and movement session cleared`,
      "debug",
    );
  }

  private onSessionLost(client: MineflayerBot, reason: string): void {
    if (this.client !== client) {
      return;
    }
    this.isReady = false;
    if (this.viewerService) {
      try {
        this.viewerService.close();
      } catch (error) {
        log(
          `[VIEWER] Viewer close after disconnect: ${String(error)}`,
          "error",
        );
      }
      this.viewerService = null;
    }
    void this.closeInventoryViewer(client);
    this.client = null;
    this.pathfinderMovements = null;
    this.movement.onDisconnect();
    log(`[CONN] Session lost: ${reason}`);
  }

  /**
   * Disconnects the client, closes the viewer, and clears bot state.
   * Safe to call multiple times or when nothing is connected.
   */
  public stop(reason = "stopped"): void {
    if (this.viewerService) {
      try {
        this.viewerService.close();
      } catch (error) {
        log(`[VIEWER] Viewer close failed: ${String(error)}`, "error");
      }
      this.viewerService = null;
    }

    const client = this.client;
    void this.closeInventoryViewer(client);
    if (client) {
      try {
        client.end(reason);
      } catch (error) {
        log(`[STOP] Client end failed: ${String(error)}`, "error");
      }
      this.client = null;
    }

    this.isReady = false;
    this.pathfinderMovements = null;
    this.movement.onDisconnect();
  }

  /**
   * Stops any existing session, then runs a single {@linkcode connect}.
   * For startup or burst retries, loop in the caller; periodic auto-reconnect counts failures separately.
   */
  public async reconnect(): Promise<MineflayerBot> {
    this.stop("reconnect");
    return await this.connect();
  }

  /**
   * Resolves after first spawn, viewer attach, and post-spawn delay.
   * Rejects on connection/login errors, kick, or timeout.
   */
  private waitUntilReady(
    client: MineflayerBot,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.removeListener("error", onError);
        client.removeListener("kicked", onKicked);
        client.removeListener("spawn", onSpawn);
        fn();
      };

      const onError = (error: Error) => {
        finish(() => reject(error));
      };

      const onKicked = (reason: unknown, loggedIn: boolean) => {
        const text = formatDisconnectReason(reason);
        finish(() =>
          reject(
            new Error(
              `Kicked from Minecraft server (loggedIn=${loggedIn}): ${text}`,
            ),
          ),
        );
      };

      const onSpawn = async () => {
        try {
          // viewer
          if (this.viewerService) {
            this.viewerService.close();
          }
          mineflayerViewer(client, {
            port: this.config.viewerPort,
            firstPerson: true,
          });
          this.viewerService = client.viewer;
          log(
            `[VIEWER] ${client.username} can now be viewed at port ${this.config.viewerPort}.`,
          );
          await this.attachInventoryViewer(client);
          // pathfinder + collectblock movements (pre-cached per spawn)
          this.pathfinderMovements = initializePathfinderMovements(client);
          // set ready
          this.isReady = true;
          finish(() => resolve());
        } catch (error) {
          finish(() => reject(error));
        }
      };

      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for bot to spawn on ${this.config.host}:${this.config.port}`,
            ),
          ),
        );
      }, timeoutMs);

      client.once("error", onError);
      client.once("kicked", onKicked);
      client.once("spawn", onSpawn);
    });
  }

  /**
   * Attach or restart the web inventory viewer ([mineflayer-web-inventory](https://github.com/ImHarvol/mineflayer-web-inventory)).
   * The plugin is registered once per client; later spawns only restart the HTTP server if needed.
   */
  private async attachInventoryViewer(client: MineflayerBot): Promise<void> {
    const port = this.config.inventoryViewerPort;

    if (client.webInventory) {
      if (!client.webInventory.isRunning) {
        await client.webInventory.start();
        log(
          `[INVENTORY_VIEWER] ${client.username} inventory can be viewed at port ${port}`,
        );
      }
      this.inventoryViewerService = client.webInventory;
      return;
    }

    inventoryViewer(client, { port });
    this.inventoryViewerService = client.webInventory ?? null;
    log(
      `[INVENTORY_VIEWER] ${client.username} inventory can be viewed at port ${port}`,
    );
  }

  private async closeInventoryViewer(
    client: MineflayerBot | null = this.client,
  ): Promise<void> {
    const service = client?.webInventory ?? this.inventoryViewerService;
    this.inventoryViewerService = null;
    if (!service?.isRunning) {
      return;
    }
    try {
      await service.stop();
    } catch (error) {
      log(`[INVENTORY_VIEWER] Stop failed: ${String(error)}`, "error");
    }
  }

  /**
   * Ensures the bot is ready to use (spawned and viewer attached).
   * When disconnected, waits for a single shared reconnect (dedupes concurrent callers).
   * Throws if auto-reconnect was stopped (shutdown) or the single reconnect attempt fails.
   */
  public async ensureReady(): Promise<void> {
    if (this.autoReconnectStopped) {
      throw new Error(
        "Bot is stopped (auto-reconnect disabled or shutting down).",
      );
    }
    if (this.isReady && this.client) {
      return;
    }

    if (!this.ensureReadyInflight) {
      this.ensureReadyInflight = this.reconnect()
        .then(() => {})
        .finally(() => {
          this.ensureReadyInflight = null;
        });
    }

    await this.ensureReadyInflight;

    if (this.autoReconnectStopped) {
      throw new Error(
        "Bot is stopped (auto-reconnect disabled or shutting down).",
      );
    }
    if (!this.isReady || !this.client) {
      throw new Error("Bot not ready after reconnect.");
    }
  }

  /**
   * Like {@linkcode ensureReady}, but rejects if the bot does not become ready within
   * `timeoutMs` (so MCP tools do not hang indefinitely).
   */
  public async ensureReadyWithin(
    timeoutMs = DEFAULT_ENSURE_READY_TIMEOUT_MS,
  ): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for the Minecraft bot to become ready.`,
          ),
        );
      }, timeoutMs);
    });

    try {
      await Promise.race([this.ensureReady(), deadline]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Periodically tries {@linkcode ensureReady} while the bot is down.
   * Call {@linkcode stopAutoReconnect} on shutdown.
   */
  public startAutoReconnect(
    intervalMs = DEFAULT_AUTO_RECONNECT_INTERVAL_MS,
  ): void {
    if (this.reconnectTimer !== null) {
      return;
    }
    this.autoReconnectStopped = false;
    this.reconnectTimer = setInterval(() => {
      void this.runAutoReconnectTick();
    }, intervalMs);
  }

  /** Stops the periodic reconnect loop (idempotent). */
  public stopAutoReconnect(): void {
    this.autoReconnectStopped = true;
    if (this.reconnectTimer !== null) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async runAutoReconnectTick(): Promise<void> {
    if (this.autoReconnectStopped) {
      return;
    }
    if (this.isReady && this.client) {
      if (this.config.debug) {
        log(
          `[CONN] Bot ${this.client.username} is already ready, skipping auto-reconnect tick.`,
          "debug",
        );
      }
      return;
    }
    if (this.ensureReadyInflight) {
      return;
    }
    try {
      log(
        `[CONN] Auto-reconnect tick: attempting to reconnect to ${this.config.host}:${this.config.port}...`,
      );
      await this.ensureReady();
      this.consecutiveAutoReconnectFailures = 0;
    } catch (error) {
      log(`[CONN] Auto-reconnect tick failed: ${String(error)}`, "error");
      this.consecutiveAutoReconnectFailures += 1;
      if (this.consecutiveAutoReconnectFailures >= MAX_N_RECONN) {
        log(
          `[CONN] Auto-reconnect failed ${MAX_N_RECONN} ticks in a row; exiting process.`,
          "error",
        );
        this.stopAutoReconnect();
        this.stop("auto-reconnect fatal");
        process.exit(1);
      }
    }
  }
}
