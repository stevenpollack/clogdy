#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePaths } from "@clogdy/shared";
import { createApp } from "./app";

const paths = resolvePaths({});
const db = new Database(paths.db, { readonly: true });
const webDir = resolve(import.meta.dir, "../../web");

if (!existsSync(resolve(webDir, "dist", "main.js"))) {
  process.stderr.write(
    "clogdy v2: web assets not built (packages/web/dist/main.js missing). Run `bun run v2:web:build`.\n",
  );
}

const app = createApp({ db, webDir, dbPath: paths.db });
const port = Number(process.env.CLOGDY_PORT ?? 7331);

Bun.serve({ port, fetch: app.fetch });
process.stdout.write(`clogdy v2 → http://localhost:${port}\n`);
