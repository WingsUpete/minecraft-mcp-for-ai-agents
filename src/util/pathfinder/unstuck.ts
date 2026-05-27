import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import { log } from "../logger.js";
import {
  cancelPathfinderMovement,
  gotoGoalWithoutThinkTimeout,
  type GotoGoal,
} from "./pathfinder.js";
import { goals } from "./wrapper.js";

/**
 * Wedged-bot recovery for mineflayer-pathfinder movement.
 *
 * When the bot moves less than ~0.2 blocks for 4s and is not at its goal, it is
 * treated as wedged. Recovery cancels the current path, adds a short-lived
 * step-exclusion around the wedge cell, tries nearby GoalBlock escape offsets
 * (biased toward the main target), then resumes movement.
 *
 * Two entry points (see MovementManager / MovementSession):
 *
 * - {@link gotoWithUnstuck} — blocking legs via {@link MovementSession.goto}
 *   (move, place_block, move_to_interactable_block, …). Awaits pathfinder.goto
 *   until the leg finishes or throws {@link BotWedgedError}.
 *
 * - {@link startSetGoalUnstuckMonitor} — non-blocking goals via
 *   {@link MovementSession.setGoal} (e.g. GoalFollow). Runs a background
 *   watchdog for the session; on escape, restores the active dynamic goal.
 *   Register new setGoal goal types in MovementManager.syncSetGoalUnstuckMonitor.
 *
 * Shared internals: evaluateStuckIdle, attemptWedgeRecovery, tryEscape.
 */

/** Position change (blocks) that resets the stuck idle timer. */
const STUCK_MOVE_THRESHOLD = 0.2;
/** No meaningful movement for this long → wedged (ms). */
const STUCK_IDLE_MS = 4_000;
const WATCH_INTERVAL_MS = 500;
/** Max consecutive wedge events without a successful escape before giving up. */
const MAX_UNSTUCK_CYCLES = 3;
/** Max time per escape goto before trying the next offset (ms). */
const ESCAPE_GOTO_TIMEOUT_MS = 8_000;
/** Min horizontal (X/Z) distance from wedged point to count as escaped. */
const ESCAPE_MIN_HORIZONTAL = 1.5;
const ESCAPE_PATH_CHECK_MS = 2_000;
/** Horizontal radius around a wedge cell to avoid stepping on again. */
const WEDGE_EXCLUSION_RADIUS = 1;

/** (dx, dz) offsets from the wedged block cell — tried in order. */
const ESCAPE_OFFSETS: readonly [number, number][] = [
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
  [3, 0],
  [-3, 0],
  [0, 3],
  [0, -3],
  [2, 2],
  [2, -2],
  [-2, 2],
  [-2, -2],
];

type StepExclusion = (block: Block) => number;

type StuckIdlePhase = "moving" | "idle_ok" | "wedged";

export class BotWedgedError extends Error {
  readonly name = "BotWedgedError";

  constructor(
    message: string,
    readonly position: { x: number; y: number; z: number },
    readonly unstuckAttempts: number,
  ) {
    super(message);
  }
}

class StuckError extends Error {
  readonly name = "StuckError";
}

class EscapeGotoTimeoutError extends Error {
  readonly name = "EscapeGotoTimeoutError";
}

type WedgeRecoveryOutcome = "escaped" | "no_escape" | "max_cycles";

type GoalEndNode = Parameters<GotoGoal["isEnd"]>[0];

/** GoalFollow today; extend when other setGoal-only goals need wedged recovery. */
export type SetGoalMonitorGoal = InstanceType<typeof goals.GoalFollow>;

/** Goals used to bias escape offsets toward a target. */
type EscapeAnchorGoal = GotoGoal | SetGoalMonitorGoal;

type StuckIdleState = {
  lastMovePos: Vec3;
  lastMoveTime: number;
  unstuckCycles: number;
};

function createStuckIdleState(client: Bot): StuckIdleState {
  return {
    lastMovePos: client.entity.position.clone(),
    lastMoveTime: Date.now(),
    unstuckCycles: 0,
  };
}

function flooredBotBlockNode(client: Bot): Vec3 {
  const p = client.entity.position;
  return new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
}

function isAtGotoGoal(client: Bot, goal: GotoGoal): boolean {
  // GoalLookAtBlock.isEnd calls node.distanceTo; plain {x,y,z} objects crash.
  const block = flooredBotBlockNode(client);
  const node = block as unknown as GoalEndNode;
  if (goal.isEnd(node)) {
    return true;
  }
  // match pathfinder's behavior of checking the goal node + 1 block above
  const above = block.offset(0, 1, 0) as unknown as GoalEndNode;
  return goal.isEnd(above);
}

function formatBlockPos(pos: Vec3): string {
  return `(${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`;
}

/** Position plus block at the wedged cell (and footing if standing in air). */
function formatWedgedLocation(client: Bot, pos: Vec3): string {
  const cell = new Vec3(
    Math.floor(pos.x),
    Math.floor(pos.y),
    Math.floor(pos.z),
  );
  const coords = formatBlockPos(pos);
  const block = client.blockAt(cell);
  if (!block) {
    return `${coords} (chunk unloaded)`;
  }
  if (block.name === "air") {
    const below = client.blockAt(cell.offset(0, -1, 0));
    if (below && below.name !== "air") {
      return `${coords} (air, on ${below.name})`;
    }
    return `${coords} (air)`;
  }
  return `${coords} - ${block.name}`;
}

function horizontalDistanceXZ(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function goalTargetXZ(goal: EscapeAnchorGoal): { x: number; z: number } | null {
  if (goal instanceof goals.GoalFollow) {
    return { x: goal.x, z: goal.z };
  }
  if (goal instanceof goals.GoalLookAtBlock) {
    return {
      x: Math.floor(goal.pos.x),
      z: Math.floor(goal.pos.z),
    };
  }
  if (goal instanceof goals.GoalPlaceBlock) {
    return {
      x: Math.floor(goal.pos.x),
      z: Math.floor(goal.pos.z),
    };
  }
  if (goal instanceof goals.GoalNear || goal instanceof goals.GoalBlock) {
    return { x: goal.x, z: goal.z };
  }
  if (goal instanceof goals.GoalNearXZ) {
    return { x: goal.x, z: goal.z };
  }
  return null;
}

function orderedEscapeOffsets(
  wedgedPos: Vec3,
  mainGoal: EscapeAnchorGoal,
): readonly [number, number][] {
  const target = goalTargetXZ(mainGoal);
  if (!target) {
    return ESCAPE_OFFSETS;
  }

  const wx = Math.floor(wedgedPos.x);
  const wz = Math.floor(wedgedPos.z);
  return [...ESCAPE_OFFSETS].sort((a, b) => {
    const ax = wx + a[0];
    const az = wz + a[1];
    const bx = wx + b[0];
    const bz = wz + b[1];
    const da = (ax - target.x) ** 2 + (az - target.z) ** 2;
    const db = (bx - target.x) ** 2 + (bz - target.z) ** 2;
    return da - db;
  });
}

/** True when the bot actually left the wedged spot (not just pathfinder "at goal"). */
function hasEscapedWedged(
  wedgedPos: Vec3,
  currentPos: Vec3,
  attemptStart: Vec3,
): boolean {
  if (horizontalDistanceXZ(wedgedPos, currentPos) < ESCAPE_MIN_HORIZONTAL) {
    return false;
  }
  if (currentPos.distanceTo(attemptStart) < STUCK_MOVE_THRESHOLD) {
    return false;
  }
  return true;
}

function addWedgeExclusion(
  client: Bot,
  wedgedPos: Vec3,
  exclusions: StepExclusion[],
): void {
  const wx = Math.floor(wedgedPos.x);
  const wy = Math.floor(wedgedPos.y);
  const wz = Math.floor(wedgedPos.z);

  const exclude: StepExclusion = (block) => {
    const p = block.position;
    if (p.y !== wy) {
      return 0;
    }
    if (
      Math.abs(p.x - wx) <= WEDGE_EXCLUSION_RADIUS &&
      Math.abs(p.z - wz) <= WEDGE_EXCLUSION_RADIUS
    ) {
      return 100;
    }
    return 0;
  };

  exclusions.push(exclude);
  const movements = client.pathfinder.movements;
  if (movements) {
    movements.exclusionAreasStep.push(exclude);
    client.pathfinder.setMovements(movements);
  }
  log(
    `[MOVEMENT] avoid wedge ${formatBlockPos(wedgedPos)} (±${WEDGE_EXCLUSION_RADIUS} block)`,
    "debug",
  );
}

function removeWedgeExclusions(client: Bot, exclusions: StepExclusion[]): void {
  const movements = client.pathfinder.movements;
  if (!movements || exclusions.length === 0) {
    return;
  }
  for (const exclude of exclusions) {
    const index = movements.exclusionAreasStep.indexOf(exclude);
    if (index >= 0) {
      movements.exclusionAreasStep.splice(index, 1);
    }
  }
  client.pathfinder.setMovements(movements);
  exclusions.length = 0;
}

/**
 * Shared idle detection: moving, still waiting, or wedged (idle too long and not satisfied).
 */
function evaluateStuckIdle(
  client: Bot,
  state: StuckIdleState,
  isSatisfied: (client: Bot) => boolean,
): StuckIdlePhase {
  const pos = client.entity.position;
  if (pos.distanceTo(state.lastMovePos) > STUCK_MOVE_THRESHOLD) {
    state.lastMovePos = pos.clone();
    state.lastMoveTime = Date.now();
    state.unstuckCycles = 0;
    return "moving";
  }
  if (Date.now() - state.lastMoveTime < STUCK_IDLE_MS) {
    return "idle_ok";
  }
  if (isSatisfied(client)) {
    state.lastMoveTime = Date.now();
    return "idle_ok";
  }
  return "wedged";
}

function startStuckIdleWatchdog(
  client: Bot,
  state: StuckIdleState,
  isSatisfied: (client: Bot) => boolean,
  onWedged: (wedgedPos: Vec3) => void,
  wedgedLog: (wedgedPos: Vec3) => string,
): () => void {
  const interval = setInterval(() => {
    if (evaluateStuckIdle(client, state, isSatisfied) !== "wedged") {
      return;
    }
    const wedgedPos = client.entity.position.clone();
    log(wedgedLog(wedgedPos), "debug");
    cancelPathfinderMovement(client);
    onWedged(wedgedPos);
  }, WATCH_INTERVAL_MS);
  return () => clearInterval(interval);
}

async function attemptWedgeRecovery(
  client: Bot,
  wedgedPos: Vec3,
  escapeAnchor: EscapeAnchorGoal,
  wedgeExclusions: StepExclusion[],
  state: StuckIdleState,
  logPrefix: string,
): Promise<WedgeRecoveryOutcome> {
  state.unstuckCycles += 1;
  if (state.unstuckCycles > MAX_UNSTUCK_CYCLES) {
    return "max_cycles";
  }

  log(
    `${logPrefix} unstuck attempt ${state.unstuckCycles}/${MAX_UNSTUCK_CYCLES} from ${formatWedgedLocation(client, wedgedPos)}`,
    "debug",
  );

  addWedgeExclusion(client, wedgedPos, wedgeExclusions);

  const escaped = await tryEscape(client, wedgedPos, escapeAnchor);
  if (!escaped) {
    return "no_escape";
  }

  state.unstuckCycles = 0;
  state.lastMovePos = client.entity.position.clone();
  state.lastMoveTime = Date.now();
  return "escaped";
}

async function gotoWithStuckWatchdog(
  client: Bot,
  goal: GotoGoal,
): Promise<void> {
  let stuckAbort = false;
  const idleState = createStuckIdleState(client);

  const stopWatchdog = startStuckIdleWatchdog(
    client,
    idleState,
    (c) => isAtGotoGoal(c, goal),
    () => {
      stuckAbort = true;
    },
    (wedgedPos) =>
      `[MOVEMENT] wedged at ${formatWedgedLocation(client, wedgedPos)} (idle ${STUCK_IDLE_MS}ms), aborting segment`,
  );

  try {
    await gotoGoalWithoutThinkTimeout(client, goal);
  } catch (error) {
    if (stuckAbort) {
      throw new StuckError();
    }
    throw error;
  } finally {
    stopWatchdog();
  }
}

async function gotoEscapeGoal(
  client: Bot,
  escapeGoal: GotoGoal,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      cancelPathfinderMovement(client);
      reject(new EscapeGotoTimeoutError());
    }, ESCAPE_GOTO_TIMEOUT_MS);
  });

  try {
    await Promise.race([gotoWithStuckWatchdog(client, escapeGoal), timeout]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function tryEscape(
  client: Bot,
  wedgedPos: Vec3,
  mainGoal: EscapeAnchorGoal,
): Promise<boolean> {
  cancelPathfinderMovement(client);
  client.clearControlStates();

  const movements = client.pathfinder.movements;
  const baseX = Math.floor(wedgedPos.x);
  const baseY = Math.floor(wedgedPos.y);
  const baseZ = Math.floor(wedgedPos.z);

  for (const [dx, dz] of orderedEscapeOffsets(wedgedPos, mainGoal)) {
    const tx = baseX + dx;
    const tz = baseZ + dz;
    const escapeGoal = new goals.GoalBlock(tx, baseY, tz);

    if (movements) {
      const pathResult = client.pathfinder.getPathTo(
        movements,
        escapeGoal,
        ESCAPE_PATH_CHECK_MS,
      );
      if (pathResult.status === "noPath" || pathResult.path.length === 0) {
        continue;
      }
    }

    const attemptStart = client.entity.position.clone();
    try {
      await gotoEscapeGoal(client, escapeGoal);
    } catch (error) {
      cancelPathfinderMovement(client);
      const reason =
        error instanceof StuckError
          ? "stuck"
          : error instanceof EscapeGotoTimeoutError
            ? "timeout"
            : "failed";
      log(
        `[MOVEMENT] escape ${reason} toward ${formatBlockPos(new Vec3(tx, baseY, tz))}`,
        "debug",
      );
      continue;
    }

    const pos = client.entity.position;
    if (!hasEscapedWedged(wedgedPos, pos, attemptStart)) {
      log(
        `[MOVEMENT] escape goal reached but still near wedge ${formatBlockPos(wedgedPos)} at ${formatBlockPos(pos)}`,
        "debug",
      );
      cancelPathfinderMovement(client);
      continue;
    }

    log(`[MOVEMENT] escape ok → ${formatBlockPos(pos)}`, "debug");
    return true;
  }

  return false;
}

/**
 * Pathfind to {@link goal} with wedged-bot recovery. No cap on total move time.
 *
 * Blocking {@link MovementSession.goto}. Non-blocking {@link MovementSession.setGoal}
 * uses {@link startSetGoalUnstuckMonitor} with the same idle detection and escape logic.
 */
export async function gotoWithUnstuck(
  client: Bot,
  goal: GotoGoal,
): Promise<void> {
  const wedgeExclusions: StepExclusion[] = [];
  const idleState = createStuckIdleState(client);
  const logPrefix = "[MOVEMENT] goto";

  try {
    while (true) {
      try {
        await gotoWithStuckWatchdog(client, goal);
        return;
      } catch (error) {
        if (!(error instanceof StuckError)) {
          throw error;
        }

        const wedgedPos = client.entity.position.clone();
        const outcome = await attemptWedgeRecovery(
          client,
          wedgedPos,
          goal,
          wedgeExclusions,
          idleState,
          logPrefix,
        );

        if (outcome === "escaped") {
          continue;
        }

        const pos = {
          x: Math.floor(wedgedPos.x),
          y: Math.floor(wedgedPos.y),
          z: Math.floor(wedgedPos.z),
        };
        if (outcome === "max_cycles") {
          throw new BotWedgedError(
            `Bot wedged at ${formatWedgedLocation(client, wedgedPos)} after ${MAX_UNSTUCK_CYCLES} recovery attempts`,
            pos,
            MAX_UNSTUCK_CYCLES,
          );
        }
        throw new BotWedgedError(
          `Bot wedged at ${formatWedgedLocation(client, wedgedPos)}: no reachable escape point`,
          pos,
          idleState.unstuckCycles,
        );
      }
    }
  } finally {
    removeWedgeExclusions(client, wedgeExclusions);
  }
}

/** Rebuild follow goal from the entity's current position (GoalFollow caches x/y/z). */
export function refreshGoalFollow(
  goal: SetGoalMonitorGoal,
): SetGoalMonitorGoal {
  return new goals.GoalFollow(goal.entity, Math.sqrt(goal.rangeSq));
}

/**
 * Clear pathfinder state and set a fresh GoalFollow at the player's current position.
 * Escape goto clears the active goal; callers must not rely on pathfinder.goal after wedge recovery.
 */
export function resumeGoalFollow(
  client: Bot,
  followGoal: SetGoalMonitorGoal,
  dynamic: boolean,
): SetGoalMonitorGoal | null {
  if (!followGoal.isValid()) {
    return null;
  }
  cancelPathfinderMovement(client);
  client.clearControlStates();
  const refreshed = refreshGoalFollow(followGoal);
  client.pathfinder.setGoal(refreshed, dynamic);
  return refreshed;
}

export function goalFollowEscapeAnchor(
  goal: SetGoalMonitorGoal,
): InstanceType<typeof goals.GoalNear> {
  const p = goal.entity.position;
  return new goals.GoalNear(
    Math.floor(p.x),
    Math.floor(p.y),
    Math.floor(p.z),
    Math.sqrt(goal.rangeSq),
  );
}

/** True when the bot is within follow range of the player entity (not a stale goal cell). */
export function isGoalFollowSatisfied(
  client: Bot,
  goal: SetGoalMonitorGoal,
): boolean {
  if (!goal.isValid()) {
    return false;
  }
  const block = flooredBotBlockNode(client);
  const ep = goal.entity.position;
  const ex = Math.floor(ep.x);
  const ey = Math.floor(ep.y);
  const ez = Math.floor(ep.z);
  const dx = ex - block.x;
  const dy = ey - block.y;
  const dz = ez - block.z;
  return dx * dx + dy * dy + dz * dz <= goal.rangeSq;
}

export type SetGoalUnstuckMonitorOptions = {
  shouldContinue: () => boolean;
  getActiveGoal: () => SetGoalMonitorGoal | null;
  restoreGoal: (goal: SetGoalMonitorGoal) => void;
  isGoalSatisfied: (client: Bot, goal: SetGoalMonitorGoal) => boolean;
  /** Build the escape goal from the current follow goal (GoalFollow caches x/y/z). */
  escapeAnchorFor: (goal: SetGoalMonitorGoal) => EscapeAnchorGoal;
  /** Log label, e.g. GoalFollow */
  goalLabel: string;
};

/**
 * Wedged recovery for non-blocking {@link MovementSession.setGoal} usage
 * (dynamic goals). Shares idle detection and escape with {@link gotoWithUnstuck}.
 */
export function startSetGoalUnstuckMonitor(
  client: Bot,
  options: SetGoalUnstuckMonitorOptions,
): () => void {
  const {
    shouldContinue,
    getActiveGoal,
    restoreGoal,
    isGoalSatisfied,
    escapeAnchorFor,
    goalLabel,
  } = options;
  const logTag = `[MOVEMENT] setGoal(${goalLabel})`;
  const wedgeExclusions: StepExclusion[] = [];
  const idleState = createStuckIdleState(client);
  let recovering = false;
  let active = true;

  const stop = () => {
    active = false;
    clearInterval(interval);
    removeWedgeExclusions(client, wedgeExclusions);
  };

  const interval = setInterval(() => {
    void (async () => {
      if (!active || recovering || !shouldContinue()) {
        return;
      }
      const goal = getActiveGoal();
      if (!goal) {
        return;
      }

      const phase = evaluateStuckIdle(client, idleState, (c) =>
        isGoalSatisfied(c, goal),
      );
      if (phase !== "wedged") {
        return;
      }

      recovering = true;
      const wedgedPos = client.entity.position.clone();
      const followGoal = goal;
      try {
        cancelPathfinderMovement(client);

        const outcome = await attemptWedgeRecovery(
          client,
          wedgedPos,
          escapeAnchorFor(followGoal),
          wedgeExclusions,
          idleState,
          logTag,
        );

        if (outcome === "max_cycles") {
          log(
            `${logTag} gave up at ${formatWedgedLocation(client, wedgedPos)} after ${MAX_UNSTUCK_CYCLES} recovery attempts`,
            "error",
          );
          cancelPathfinderMovement(client);
          stop();
          return;
        }
        if (outcome === "no_escape") {
          log(
            `${logTag} no escape from ${formatWedgedLocation(client, wedgedPos)}`,
            "error",
          );
          return;
        }

        if (!shouldContinue() || !active || !followGoal.isValid()) {
          return;
        }
        restoreGoal(followGoal);
        removeWedgeExclusions(client, wedgeExclusions);
      } finally {
        recovering = false;
      }
    })();
  }, WATCH_INTERVAL_MS);

  return stop;
}
