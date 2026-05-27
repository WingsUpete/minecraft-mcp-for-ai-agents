import type { Bot as MineflayerBot } from "mineflayer";
import { log } from "../logger.js";
import {
  cancelPathfinderMovement,
  gotoGoalWithoutThinkTimeout,
  type GotoGoal,
} from "./pathfinder.js";
import { goals } from "./wrapper.js";
import {
  goalFollowEscapeAnchor,
  gotoWithUnstuck,
  isGoalFollowSatisfied,
  resumeGoalFollow,
  startSetGoalUnstuckMonitor,
  type SetGoalMonitorGoal,
} from "./unstuck.js";

export type MovementSessionOptions = {
  holder: string;
  /**
   * When true (default), release pathfinder ownership when
   * {@linkcode MovementManager.withMovementSession} finishes.
   */
  releaseOnComplete?: boolean;
  /**
   * When true (default), {@linkcode MovementSession.goto} runs wedged-bot
   * recovery. Set false to use plain pathfinder goto only.
   */
  handleStuck?: boolean;
};

export class MovementPreemptedError extends Error {
  readonly name = "MovementPreemptedError";

  constructor(
    readonly preemptedBy: string,
    readonly detail?: unknown,
  ) {
    super(`Movement preempted by ${preemptedBy}`);
  }
}

type MovementOwner = {
  holder: string;
  generation: number;
};

type PathfinderGoal = NonNullable<MineflayerBot["pathfinder"]["goal"]>;

export class MovementManager {
  private owner: MovementOwner | null = null;
  private generation = 0;
  private gotoPreempt: {
    reject: (err: MovementPreemptedError) => void;
  } | null = null;
  private setGoalUnstuckStop: (() => void) | null = null;

  constructor(private readonly getClient: () => MineflayerBot | null) {}

  get currentHolder(): string | null {
    return this.owner?.holder ?? null;
  }

  private clearMovementState(preemptBy: string): void {
    const holder = this.owner?.holder ?? null;
    this.stopSetGoalUnstuckMonitor();
    this.preemptBlockingGoto(preemptBy);
    const client = this.getClient();
    if (client) {
      cancelPathfinderMovement(client);
    }
    this.owner = null;
    if (holder) {
      log(`[MOVEMENT] Cleared ${holder} (${preemptBy})`, "debug");
    }
  }

  /** Clear ownership (e.g. disconnect / stop). */
  onDisconnect(): void {
    this.clearMovementState("disconnect");
  }

  /** Cancel pathfinder goal and movement session when the bot dies (still connected). */
  onDeath(): void {
    this.clearMovementState("death");
    const client = this.getClient();
    if (client) {
      client.clearControlStates();
    }
  }

  async withMovementSession<T>(
    options: MovementSessionOptions,
    fn: (session: MovementSession) => Promise<T>,
  ): Promise<T> {
    const session = this.acquire(
      options.holder,
      options.handleStuck === undefined
        ? undefined
        : { handleStuck: options.handleStuck },
    );
    try {
      return await fn(session);
    } finally {
      if (options.releaseOnComplete !== false) {
        session.release();
      }
    }
  }

  acquire(
    holder: string,
    options?: { handleStuck?: boolean },
  ): MovementSession {
    const previous = this.owner?.holder ?? null;
    if (this.owner !== null) {
      this.stopSetGoalUnstuckMonitor();
      this.preemptBlockingGoto(holder);
      const client = this.getClient();
      if (client) {
        cancelPathfinderMovement(client);
      }
      log(`[MOVEMENT] takeover ${holder} (was: ${previous})`, "debug");
    }
    this.generation += 1;
    const gen = this.generation;
    this.owner = { holder, generation: gen };
    return new MovementSession(this, holder, gen, options?.handleStuck ?? true);
  }

  isSessionActive(session: MovementSession): boolean {
    return (
      this.owner !== null &&
      this.owner.generation === session.generation &&
      this.owner.holder === session.holder
    );
  }

  clientOrThrow(): MineflayerBot {
    const client = this.getClient();
    if (!client) {
      throw new Error("Bot is not connected.");
    }
    return client;
  }

  registerBlockingGoto(): Promise<never> {
    return new Promise((_, reject) => {
      this.gotoPreempt = { reject };
    });
  }

  unregisterBlockingGoto(session: MovementSession): void {
    if (this.gotoPreempt && this.isSessionActive(session)) {
      this.gotoPreempt = null;
    }
  }

  releaseSession(session: MovementSession): void {
    if (!this.isSessionActive(session)) {
      return;
    }
    this.stopSetGoalUnstuckMonitor();
    const holder = this.owner!.holder;
    this.owner = null;
    log(`[MOVEMENT] Released ownership of ${holder}`, "debug");
  }

  stopSetGoalUnstuckMonitor(): void {
    this.setGoalUnstuckStop?.();
    this.setGoalUnstuckStop = null;
  }

  /**
   * Start wedged recovery for non-blocking setGoal goals. Add new goal types here.
   */
  syncSetGoalUnstuckMonitor(
    session: MovementSession,
    goal: PathfinderGoal,
    dynamic: boolean,
  ): void {
    this.stopSetGoalUnstuckMonitor();
    if (!session.handleStuck) {
      return;
    }
    const client = this.getClient();
    if (!client) {
      return;
    }

    if (goal instanceof goals.GoalFollow) {
      this.setGoalUnstuckStop = startSetGoalUnstuckMonitor(client, {
        goalLabel: "GoalFollow",
        shouldContinue: () => this.isSessionActive(session),
        getActiveGoal: (): SetGoalMonitorGoal | null => {
          const active = client.pathfinder.goal;
          return active instanceof goals.GoalFollow && active.isValid()
            ? active
            : null;
        },
        restoreGoal: (activeGoal) => {
          if (!this.isSessionActive(session)) {
            return;
          }
          const refreshed = resumeGoalFollow(client, activeGoal, dynamic);
          if (!refreshed) {
            log(
              "[MOVEMENT] setGoal(GoalFollow) resume skipped (invalid target)",
              "debug",
            );
            return;
          }
          log(
            `[MOVEMENT] setGoal(GoalFollow) resumed toward player at (${refreshed.x}, ${refreshed.y}, ${refreshed.z})`,
            "debug",
          );
        },
        isGoalSatisfied: isGoalFollowSatisfied,
        escapeAnchorFor: goalFollowEscapeAnchor,
      });
      return;
    }
  }

  private preemptBlockingGoto(by: string): void {
    if (!this.gotoPreempt) {
      return;
    }
    const reject = this.gotoPreempt.reject;
    this.gotoPreempt = null;
    reject(new MovementPreemptedError(by));
  }
}

export class MovementSession {
  constructor(
    private readonly manager: MovementManager,
    readonly holder: string,
    readonly generation: number,
    /**
     * When true (default), {@linkcode goto} uses wedged-bot recovery; when false, plain pathfinder only.
     */
    readonly handleStuck: boolean = true,
  ) {}

  setGoal(goal: PathfinderGoal, dynamic = false): void {
    this.assertOwner();
    const client = this.manager.clientOrThrow();
    client.pathfinder.setGoal(goal, dynamic);
    this.manager.syncSetGoalUnstuckMonitor(this, goal, dynamic);
  }

  async goto(goal: GotoGoal): Promise<void> {
    this.assertOwner();
    const client = this.manager.clientOrThrow();
    const preempted = this.manager.registerBlockingGoto();
    const gotoFn = this.handleStuck
      ? gotoWithUnstuck
      : gotoGoalWithoutThinkTimeout;
    try {
      await Promise.race([gotoFn(client, goal), preempted]);
    } finally {
      this.manager.unregisterBlockingGoto(this);
    }
  }

  cancelMovement(): void {
    this.assertOwner();
    this.manager.stopSetGoalUnstuckMonitor();
    cancelPathfinderMovement(this.manager.clientOrThrow());
  }

  release(): void {
    this.manager.releaseSession(this);
  }

  private assertOwner(): void {
    if (!this.manager.isSessionActive(this)) {
      throw new MovementPreemptedError(this.manager.currentHolder ?? "unknown");
    }
  }
}
