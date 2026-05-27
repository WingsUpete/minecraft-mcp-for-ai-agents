import type { Bot as MineflayerBot } from "mineflayer";

/** Let sneak register with the server before the place packet (≈1–2 ticks). */
export const SNEAK_SETTLE_MS = 100;
/** Hold sneak briefly after placement so the server does not treat release as opening the block. */
export const SNEAK_HOLD_AFTER_MS = 150;
/** Mineflayer physics tick; 1.21.6+ needs held shift via player_input each tick. */
const SNEAK_PACKET_INTERVAL_MS = 50;

/**
 * Mineflayer maps sneak to player_input when newPlayerInputPacket is set (1.21.3+),
 * but the server only accepts that from 1.21.6+. On 1.21.3–1.21.5 sneak is still entity_action.
 */
function sneakUsesPlayerInput(client: MineflayerBot): boolean {
  return client.supportFeature("entityActionUsesStringMapper");
}

function writeSneakPacket(client: MineflayerBot, state: boolean): void {
  if (sneakUsesPlayerInput(client)) {
    client._client.write("player_input", {
      inputs: { shift: state },
    });
    return;
  }
  client._client.write("entity_action", {
    entityId: client.entity.id,
    actionId: state ? 0 : 1,
    jumpBoost: 0,
  });
}

export async function holdSneakWhile(
  client: MineflayerBot,
  fn: () => Promise<void>,
): Promise<void> {
  const wasSneaking = client.getControlState("sneak");
  const usePlayerInput = sneakUsesPlayerInput(client);
  const interval = usePlayerInput
    ? setInterval(
        () => writeSneakPacket(client, true),
        SNEAK_PACKET_INTERVAL_MS,
      )
    : undefined;

  writeSneakPacket(client, true);
  if (!wasSneaking && usePlayerInput) {
    client.setControlState("sneak", true);
  }

  try {
    await fn();
  } finally {
    if (interval !== undefined) {
      clearInterval(interval);
    }
    writeSneakPacket(client, wasSneaking);
    if (usePlayerInput) {
      client.setControlState("sneak", wasSneaking);
    }
  }
}
