#!/usr/bin/env bun
import { resolve } from "node:path";

const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "src/main.tsx")],
  outdir: resolve(import.meta.dir, "dist"),
  target: "browser",
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.error(`built ${result.outputs.length} file(s) → packages/web/dist`);
