import type { Bot } from "mineflayer";
import { goals } from "./wrapper.js";

export { goals };

export function goalRange(goal: { rangeSq: number }): number {
  return Math.sqrt(goal.rangeSq);
}

export function describeGoal(
  goal: NonNullable<Bot["pathfinder"]["goal"]>,
): string {
  if (goal instanceof goals.GoalFollow) {
    const player =
      goal.entity.username ??
      (goal.entity as { displayName?: string }).displayName ??
      "unknown";
    const valid = goal.isValid() ? "valid" : "invalid (target lost)";
    return `Following player ${player} within ${goalRange(goal)} blocks (${valid})`;
  }
  if (goal instanceof goals.GoalBlock) {
    return `Moving to block (${goal.x}, ${goal.y}, ${goal.z})`;
  }
  if (goal instanceof goals.GoalNear) {
    return `Moving to (${goal.x}, ${goal.y}, ${goal.z}) within ${goalRange(goal)} blocks`;
  }
  if (goal instanceof goals.GoalNearXZ) {
    return `Moving to (${goal.x}, ?, ${goal.z}) within ${goalRange(goal)} blocks (any Y)`;
  }
  if (goal instanceof goals.GoalPlaceBlock) {
    const { x, y, z } = goal.pos;
    return `Moving to place block at (${x}, ${y}, ${z})`;
  }
  if (goal instanceof goals.GoalLookAtBlock) {
    const { x, y, z } = goal.pos;
    return `Moving to interact with block at (${x}, ${y}, ${z}) (reach ${goal.reach})`;
  }
  return `Active goal: ${goal.constructor.name}`;
}

/** Clears move/follow goals (and any active path). */
export function cancelPathfinderMovement(client: Bot): void {
  client.pathfinder.setGoal(null);
}

/**
 * Pathfind to a goal without the default 5s A* think timeout failing long routes.
 */
export type GotoGoal =
  | InstanceType<typeof goals.GoalNear>
  | InstanceType<typeof goals.GoalNearXZ>
  | InstanceType<typeof goals.GoalBlock>
  | InstanceType<typeof goals.GoalPlaceBlock>
  | InstanceType<typeof goals.GoalLookAtBlock>;

export async function withPathfinderThinkTimeout<T>(
  client: Bot,
  fn: () => Promise<T>,
): Promise<T> {
  const previousThinkTimeout = client.pathfinder.thinkTimeout;
  client.pathfinder.thinkTimeout = Number.POSITIVE_INFINITY;
  try {
    return await fn();
  } finally {
    client.pathfinder.thinkTimeout = previousThinkTimeout;
  }
}

export async function gotoGoalWithoutThinkTimeout(
  client: Bot,
  goal: GotoGoal,
): Promise<void> {
  await withPathfinderThinkTimeout(client, () => client.pathfinder.goto(goal));
}
