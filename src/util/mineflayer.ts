import type { Bot as MineflayerBot } from "mineflayer";

const PLAYER_ENTITY_POLL_MS = 200;

// TODO: Functions in this file can be moved to other files

/** Max time to wait for a nearby player's entity after connect (tab list can precede spawn packets). */
export const DEFAULT_PLAYER_ENTITY_WAIT_MS = 15_000;

/**
 * Resolve a player's in-world entity, including when tab-list `player.entity` is not linked yet.
 */
export function findPlayerEntity(
  client: MineflayerBot,
  username: string,
): NonNullable<MineflayerBot["players"][string]>["entity"] | null {
  const linked = client.players[username]?.entity;
  if (linked) {
    return linked;
  }
  return (
    Object.values(client.entities).find(
      (entity) => entity.type === "player" && entity.username === username,
    ) ?? null
  );
}

/**
 * Wait until a player is loaded in the world (entity present). Rejects if the player
 * is not on the server or does not become visible within `timeoutMs`.
 */
export async function waitForPlayerEntity(
  client: MineflayerBot,
  username: string,
  timeoutMs = DEFAULT_PLAYER_ENTITY_WAIT_MS,
): Promise<NonNullable<ReturnType<typeof findPlayerEntity>>> {
  const immediate = findPlayerEntity(client, username);
  if (immediate) {
    return immediate;
  }
  if (client.players[username] === undefined) {
    throw new Error(`Player ${username} not found in the world`);
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      client.removeListener("entitySpawn", onEntitySpawn);
      fn();
    };

    const tryResolve = () => {
      const entity = findPlayerEntity(client, username);
      if (entity) {
        finish(() => resolve(entity));
      }
    };

    const onEntitySpawn = () => tryResolve();
    client.on("entitySpawn", onEntitySpawn);
    const poll = setInterval(tryResolve, PLAYER_ENTITY_POLL_MS);

    const timer = setTimeout(() => {
      if (client.players[username] === undefined) {
        finish(() =>
          reject(new Error(`Player ${username} not found in the world`)),
        );
      } else {
        finish(() =>
          reject(
            new Error(`Player ${username} is not visible (no entity yet)`),
          ),
        );
      }
    }, timeoutMs);
  });
}

/**
 * Disconnect/kick `reason` from minecraft-protocol is often JSON chat (object), not a string.
 * Mineflayer types it as `string`; stringify objects for logs/errors.
 */
export function formatDisconnectReason(reason: unknown): string {
  if (typeof reason === "string") {
    return reason;
  }
  if (reason !== null && typeof reason === "object") {
    try {
      return JSON.stringify(reason);
    } catch {
      return "[unserializable disconnect reason]";
    }
  }
  return String(reason);
}
