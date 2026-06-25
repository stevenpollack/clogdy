/**
 * Shared session-discovery + selection logic for the runtime scripts
 * (`picker.tsx`, `snapshot.ts`, `follow.ts`).
 *
 * These are ordinary CLI modules — NOT Logdy handlers — so the repo's
 * "handlers must be self-contained / no runtime imports" rule does not apply
 * here. Defining the scan + filter predicate once keeps the picker (which lists
 * sessions) and the streaming scripts (which filter rows) in agreement about
 * what a "session" is.
 *
 * Bun-only (Bun.Glob / Bun.file).
 */
import { basename, dirname } from "node:path";

export type SessionMeta = {
  /** Filename stem — equals the transcript's `sessionId` (verified). */
  sessionId: string;
  /** basename of the session's `cwd`; falls back to a de-slugged dir name. */
  project: string;
  /** Absolute path to the `.jsonl`. */
  path: string;
  /** ms-epoch of the last *timestamped* line (max over a tail read), 0 if none. */
  lastTs: number;
  sizeBytes: number;
};

/**
 * A row filter. `sessions` are session-id *prefixes* (so a short id from the
 * CLI matches); `projects` are project-name *substrings* (mirrors snapshot's
 * historical `--project`). Both lowercased. Absent/empty array ⇒ no constraint
 * on that axis; an empty Selection matches everything.
 */
export type Selection = {
  sessions?: string[];
  projects?: string[];
};

const HEAD_BYTES = 16_384;
const TAIL_BYTES = 65_536;

/** Last path segment of a `cwd` (the project name we surface and facet on). */
export function projectFromCwd(cwd: string): string {
  return cwd.replace(/\/+$/, "").split("/").pop() ?? "";
}

/**
 * Best-effort project name from a Claude project dir slug
 * (`-home-steven-repos-clogdy` → `clogdy`). Only used when no line in the file
 * carries a `cwd`; ambiguous for names containing dashes, hence the fallback.
 */
export function projectFromSlug(slug: string): string {
  const parts = slug.split("-").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : slug;
}

/** Read the first `cwd`-bearing line in the file's head; else de-slug the dir. */
async function readProject(path: string): Promise<string> {
  try {
    const file = Bun.file(path);
    const head = await file.slice(0, HEAD_BYTES).text();
    for (const line of head.split("\n")) {
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (typeof j?.cwd === "string" && j.cwd) return projectFromCwd(j.cwd);
      } catch {
        // partial trailing line or non-JSON — skip
      }
    }
  } catch {
    // file vanished mid-scan
  }
  return projectFromSlug(basename(dirname(path)));
}

/** Max `timestamp` over the file's tail (the real "last message" time). */
async function readLastTs(path: string, sizeBytes: number): Promise<number> {
  try {
    const tail = await Bun.file(path).slice(Math.max(0, sizeBytes - TAIL_BYTES), sizeBytes).text();
    let max = 0;
    for (const line of tail.split("\n")) {
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (typeof j?.timestamp === "string") {
          const t = Date.parse(j.timestamp);
          if (!Number.isNaN(t) && t > max) max = t;
        }
      } catch {
        // partial leading line / non-JSON — skip
      }
    }
    return max;
  } catch {
    return 0;
  }
}

/** Scan every `*.jsonl` under `root` into table-ready metadata. */
export async function scanSessions(root: string): Promise<SessionMeta[]> {
  const metas: SessionMeta[] = [];
  for await (const path of new Bun.Glob("**/*.jsonl").scan({ cwd: root, absolute: true })) {
    let sizeBytes: number;
    try {
      sizeBytes = Bun.file(path).size;
    } catch {
      continue; // vanished between glob and stat
    }
    const [project, lastTs] = await Promise.all([readProject(path), readLastTs(path, sizeBytes)]);
    metas.push({
      sessionId: basename(path).replace(/\.jsonl$/, ""),
      project,
      path,
      lastTs,
      sizeBytes,
    });
  }
  return metas;
}

/** Does a parsed transcript line pass the selection? (per-line, used by snapshot.) */
export function matchesLine(j: any, sel: Selection): boolean {
  if (sel.sessions?.length) {
    const sid = typeof j?.sessionId === "string" ? j.sessionId.toLowerCase() : "";
    if (!sel.sessions.some((p) => sid.startsWith(p))) return false;
  }
  if (sel.projects?.length) {
    const proj = typeof j?.cwd === "string" ? projectFromCwd(j.cwd).toLowerCase() : "";
    if (!sel.projects.some((s) => proj.includes(s))) return false;
  }
  return true;
}

/**
 * File-granular matcher for `follow.ts`: a whole session file is in or out, so
 * we decide from its path (stem = session id) plus a cached project read,
 * without parsing every appended line. Returns a closure with its own project
 * cache (follow is long-running). No filters ⇒ always true (unchanged follow).
 */
export function makeFileMatcher(sel: Selection): (path: string) => Promise<boolean> {
  const projectCache = new Map<string, string>();
  const hasSessions = !!sel.sessions?.length;
  const hasProjects = !!sel.projects?.length;
  return async (path: string): Promise<boolean> => {
    if (hasSessions) {
      const sid = basename(path).replace(/\.jsonl$/, "").toLowerCase();
      if (!sel.sessions!.some((p) => sid.startsWith(p))) return false;
    }
    if (hasProjects) {
      let proj = projectCache.get(path);
      if (proj === undefined) {
        proj = (await readProject(path)).toLowerCase();
        projectCache.set(path, proj);
      }
      if (!sel.projects!.some((s) => proj!.includes(s))) return false;
    }
    return true;
  };
}

/**
 * Shrink a set of selected session ids into the most compact equivalent
 * Selection for the spawned command. If *every* session of a project is
 * selected, emit the project name (one `--projects` token) instead of listing
 * each UUID — but only when that's unambiguous and shell-safe:
 *   - the name is plain (`[a-z0-9._-]`), so it needs no quoting, and
 *   - no *other* scanned project name contains it as a substring (else the
 *     substring `--projects` match would pull in sessions we didn't pick).
 * Otherwise the group's ids are listed explicitly. Session ids are hex+dashes,
 * always shell-safe.
 */
export function collapseSelection(metas: SessionMeta[], selectedIds: Set<string>): Selection {
  const byProject = new Map<string, SessionMeta[]>();
  for (const m of metas) {
    const g = byProject.get(m.project);
    if (g) g.push(m);
    else byProject.set(m.project, [m]);
  }
  const allProjectNames = [...byProject.keys()];

  const projects: string[] = [];
  const sessions: string[] = [];
  for (const [project, group] of byProject) {
    const picked = group.filter((m) => selectedIds.has(m.sessionId));
    if (picked.length === 0) continue;

    const plain = /^[a-z0-9._-]+$/i.test(project);
    const collides = allProjectNames.some((q) => q !== project && q.toLowerCase().includes(project.toLowerCase()));
    if (picked.length === group.length && plain && !collides) {
      projects.push(project.toLowerCase());
    } else {
      for (const m of picked) sessions.push(m.sessionId);
    }
  }

  const sel: Selection = {};
  if (projects.length) sel.projects = projects;
  if (sessions.length) sel.sessions = sessions;
  return sel;
}
