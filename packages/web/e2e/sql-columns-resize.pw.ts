import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Evidence for two UX fixes:
//   1. SQL editor surfaces the available columns — a "Columns ▾" reference panel
//      (click to insert) and schema-aware CodeMirror autocomplete.
//   2. Events-table columns are user-resizable (drag the header edge), persisted.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SHOTS = resolve(HERE, "../../../docs/v2/artifacts/phase5");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => resolve(SHOTS, name);

test("SQL columns reference + autocomplete are discoverable", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(
    page.locator("#events tbody#rows tr[data-id]").first(),
  ).toBeVisible({ timeout: 30_000 });

  // Enter SQL mode.
  await page.locator("#sql-btn").click();
  await expect(page.locator("#sql-editor")).toBeVisible();

  // The Columns reference lists every queryable field with type + description.
  await page.locator("#sql-columns-btn").click();
  await expect(page.locator("#sql-columns-list")).toBeVisible();
  const cols = page.locator("#sql-columns-list .sql-column");
  await expect(cols.first()).toBeVisible();
  expect(await cols.count()).toBe(21); // all 21 event columns
  await expect(page.locator("#sql-columns-list")).toContainText("session_id");
  await expect(page.locator("#sql-columns-list")).toContainText("is_error");
  await page.screenshot({ path: shot("SQL-columns-panel.png") });
  // Close the panel so it no longer overlaps the editor.
  await page.locator("#sql-columns-btn").click();
  await expect(page.locator("#sql-columns-list")).toBeHidden();

  // Clicking a column inserts it into the editor at the cursor.
  await page.locator("#sql-cm .cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("SELECT  FROM events");
  // Place cursor after "SELECT " (move left past " FROM events" = 12 chars).
  for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowLeft");
  await page.locator("#sql-columns-btn").click();
  await page.locator("#sql-columns-list .sql-column", { hasText: "session_id" }).click();
  await expect(page.locator("#sql-cm .cm-content")).toContainText(
    "SELECT session_id FROM events",
  );

  // Schema-aware autocomplete: typing a column prefix + Ctrl-Space lists matches.
  await page.locator("#sql-cm .cm-content").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("SELECT is_e");
  await page.keyboard.press("Control+Space");
  const tip = page.locator(".cm-tooltip-autocomplete");
  await expect(tip).toBeVisible({ timeout: 5_000 });
  await expect(tip).toContainText("is_error");
  await page.screenshot({ path: shot("SQL-autocomplete.png") });
});

test("events table columns are resizable and persist", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(
    page.locator("#events tbody#rows tr[data-id]").first(),
  ).toBeVisible({ timeout: 30_000 });

  const projectHeader = page.locator("#events thead th").first();
  const before = (await projectHeader.boundingBox())!;
  await page.screenshot({ path: shot("resize-before.png") });

  // Drag the PROJECT column's resize handle ~140px to the right.
  const handle = projectHeader.locator(".resizer");
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 140, hb.y + hb.height / 2, { steps: 10 });
  await page.mouse.up();

  const after = (await projectHeader.boundingBox())!;
  expect(after.width).toBeGreaterThan(before.width + 80);
  await page.screenshot({ path: shot("resize-after.png") });

  // Width persists across reload (localStorage-backed column sizing).
  await page.reload();
  await expect(
    page.locator("#events tbody#rows tr[data-id]").first(),
  ).toBeVisible({ timeout: 30_000 });
  const afterReload = (await page.locator("#events thead th").first().boundingBox())!;
  expect(Math.abs(afterReload.width - after.width)).toBeLessThan(4);
});
