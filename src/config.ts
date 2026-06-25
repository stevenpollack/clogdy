import type { LogdySettings } from "./logdy";

/**
 * Envelope defaults for the generated logdy.config.json — everything except the
 * `columns` and `settings.middlewares`, which are generated from the registry.
 *
 * Values mirror a real Logdy "Settings -> Export"; tune them here (they're UI
 * layout prefs) rather than re-exporting from Logdy, so the build stays the
 * single, deterministic source of truth.
 */
export const configName = "main";

export const baseSettings: Omit<LogdySettings, "middlewares"> = {
  leftColWidth: 300,
  drawerColWidth: 900,
  maxMessages: 1000,
  entriesOrder: "asc", // chronological — read turns top-to-bottom
  paintCorrelationIdCell: true, // tint linked tool_use <-> tool_result rows
};
