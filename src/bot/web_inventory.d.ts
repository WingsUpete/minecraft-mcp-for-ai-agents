declare module "mineflayer-web-inventory" {
  import type { Bot } from "mineflayer";

  export type InventoryViewerOptions = {
    port?: number;
    webPath?: string;
    startOnLoad?: boolean;
    windowUpdateDebounceTime?: number;
  };

  export default function inventoryViewer(
    bot: Bot,
    options?: InventoryViewerOptions,
  ): void;
}
