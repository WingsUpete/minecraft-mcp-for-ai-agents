import type { Bot } from "mineflayer";

export type WebInventoryService = {
  isRunning: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  options: {
    port: number;
    webPath?: string;
    startOnLoad?: boolean;
    windowUpdateDebounceTime?: number;
  };
};

declare module "mineflayer" {
  // original mineflayer.Bot does not have a viewer property, so we need to extend it manually
  interface Bot {
    viewer?: {
      close: () => void;
      on?: (...args: unknown[]) => void;
      emit?: (...args: unknown[]) => void;
    };
    webInventory?: WebInventoryService;
  }
}
