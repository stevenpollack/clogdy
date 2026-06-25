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
  // Client-side UI buffer cap. Logdy evicts by ARRIVAL order, not order_key — so
  // when `follow --full` replays every session as one burst, a small cap keeps
  // only the last files to stream in and silently drops earlier ones (incl. the
  // live session). Sized to hold a full multi-session replay; match or stay under
  // Logdy's server buffer (`--max-message-count`, default 100000).
  maxMessages: 100000,
  entriesOrder: "asc", // chronological — read turns top-to-bottom
  correlationIdField: "corr", // column whose cell text Logdy hashes into a color
  paintCorrelationIdCell: true, // tint linked tool_use <-> tool_result cells
};
