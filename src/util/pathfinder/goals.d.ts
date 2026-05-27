import type { Vec3 } from "vec3";

/**
 * mineflayer-pathfinder's published types omit `pos` on GoalPlaceBlock,
 * but the runtime class always sets it in the constructor.
 */
declare module "mineflayer-pathfinder" {
  /** Runtime treats all fields as optional (defaults applied in constructor). */
  export interface GoalPlaceBlockOptions {
    range?: number;
    LOS?: boolean;
    faces?: Vec3[];
    facing?: "north" | "east" | "south" | "west" | "up" | "down";
    facing3D?: boolean;
    half?: "top" | "bottom";
  }

  namespace goals {
    interface GoalPlaceBlock {
      readonly pos: Vec3;
    }
  }
}
