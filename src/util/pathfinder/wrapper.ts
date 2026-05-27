/**
 * ESM interop for the CommonJS mineflayer-pathfinder package.
 * Named imports like `{ goals }` fail under Node "type": "module".
 */
import pathfinderPkg from "mineflayer-pathfinder";

export const pathfinder = pathfinderPkg.pathfinder;
export const Movements = pathfinderPkg.Movements;
export const goals = pathfinderPkg.goals;
