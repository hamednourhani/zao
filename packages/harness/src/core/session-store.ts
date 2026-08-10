/**
 * Session Store — global storage resolution, index I/O, and session listing.
 *
 * ## Store root resolution
 *
 * ```
 * $ZAO_HOME → $XDG_DATA_HOME/zao → ~/.zao
 * ```
 *
 * ## Layout (ADR-005)
 *
 * ```
 * ~/.zao/
 * ├── index.jsonl              ← parents only; creation + completion lines
 * └── sessions/
 *     └── <uuidv7>/
 *         ├── session.json
 *         └── agents/
 *             ├── index.jsonl   ← one line per spawned child
 *             └── <uuidv7>/
 * ```
 *
 * @module session-store
 */

import { mkdir, readFile, copyFile, readdir, stat } from "node:fs/promises";
import { openSync, writeSync, fsyncSync, closeSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { z } from "zod";
import { ParentManifestSchema, ChildManifestSchema } from "../schemas/session-manifest.ts";
import type { ParentManifest, ChildManifest } from "../schemas/session-manifest.ts";
import type {
  GlobalIndexCreateEntry,
  GlobalIndexCompleteEntry,
  AgentsIndexEntry,
  GlobalIndexResolvedEntry,
  SessionListEntry,
  SessionListFilters,
} from "../schemas/session-index.ts";
import { readArtifact } from "./artifacts.ts";
import { logger } from "./logger.ts";

// ── Store Root Resolution ────────────────────────────────────────

/**
 * Resolves the global zao store root directory, creating it if needed.
 *
 * Resolution order:
 * 1. `$ZAO_HOME` (explicit override)
 * 2. `$XDG_DATA_HOME/zao` (XDG convention)
 * 3. `~/.zao` (default)
 *
 * @returns The absolute path to the store root (guaranteed to exist).
 */
export async function resolveStoreRoot(): Promise<string> {
  let root: string;

  if (process.env["ZAO_HOME"]) {
    root = process.env["ZAO_HOME"];
  } else if (process.env["XDG_DATA_HOME"]) {
    root = join(process.env["XDG_DATA_HOME"], "zao");
  } else {
    root = join(homedir(), ".zao");
  }

  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

// ── Directory Helpers ─────────────────────────────────────────────

/**
 * Creates the session directory structure for a parent run.
 *
 * Creates:
 * - `sessions/<sessionId>/`
 * - `sessions/<sessionId>/agents/`
 *
 * @param sessionId - The UUIDv7 session identifier.
 * @param storeRoot - The resolved store root (`~/.zao`).
 * @returns The absolute path to the created session directory.
 */
export async function ensureParentDir(
  sessionId: string,
  storeRoot: string,
): Promise<string> {
  const sessionDir = join(storeRoot, "sessions", sessionId);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await mkdir(join(sessionDir, "agents"), { recursive: true, mode: 0o700 });
  return sessionDir;
}

/**
 * Creates a child session directory under a parent's `agents/` folder.
 *
 * @param sessionId - The UUIDv7 session identifier for the child.
 * @param parentSessionDir - The parent session directory (contains `agents/`).
 * @returns The absolute path to the created child session directory.
 */
export async function ensureChildDir(
  sessionId: string,
  parentSessionDir: string,
): Promise<string> {
  const childDir = join(parentSessionDir, "agents", sessionId);
  await mkdir(childDir, { recursive: true, mode: 0o700 });
  return childDir;
}

// ── Manifest I/O ──────────────────────────────────────────────────

/**
 * Writes a session manifest (`session.json`) to the given directory,
 * validating against the provided Zod schema BEFORE writing.
 *
 * ## Fail-closed (governance §E2)
 *
 * If the manifest does not pass schema validation, an `Error` is thrown
 * immediately — no invalid file is ever written to disk. This closes the
 * NEW-H1 class of bugs where a refactor introduces undeclared fields.
 *
 * Uses atomic write-via-temp-then-rename (via {@link writeArtifact}) and
 * restricts permissions to 0o600.
 *
 * @param dir - The session directory.
 * @param manifest - The manifest object to validate and write.
 * @param schema - The Zod schema to validate against.
 * @returns A promise that resolves when the artifact has been written.
 * @throws {Error} If the manifest fails schema validation.
 */
export async function writeSessionManifest<T>(
  dir: string,
  manifest: T,
  schema: z.ZodType<T>,
): Promise<void> {
  // Validate BEFORE any write — fail-closed (§E2)
  const result = schema.safeParse(manifest);
  if (!result.success) {
    throw new Error(
      `Session manifest validation failed before write: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const { writeArtifact } = await import("./artifacts.ts");
  const manifestPath = join(dir, "session.json");
  await writeArtifact(manifestPath, JSON.stringify(result.data, null, 2));
}

/**
 * Reads a session manifest from disk, validating against the appropriate
 * schema (parent or child).
 *
 * @param dir - The session directory.
 * @returns The parsed manifest, or null on any read/parse/validation error.
 */
export async function readSessionManifest(
  dir: string,
): Promise<ParentManifest | ChildManifest | null> {
  // Try parent manifest first
  const parentResult = await readArtifact(
    join(dir, "session.json"),
    ParentManifestSchema,
  );
  if (parentResult.success) return parentResult.data;

  // Try child manifest
  const childResult = await readArtifact(
    join(dir, "session.json"),
    ChildManifestSchema,
  );
  if (childResult.success) return childResult.data;

  return null;
}

// ── Index I/O ─────────────────────────────────────────────────────

/**
 * Appends a single JSON line to `index.jsonl` at the store root.
 *
 * The line is written with `fsync` to ensure durability. The file is
 * append-only — existing lines are never modified.
 *
 * @param storeRoot - The resolved store root (`~/.zao`).
 * @param entry - The index entry to append (creation or completion).
 */
export async function appendGlobalIndexLine(
  storeRoot: string,
  entry: GlobalIndexCreateEntry | GlobalIndexCompleteEntry,
): Promise<void> {
  const indexPath = join(storeRoot, "index.jsonl");
  const line = JSON.stringify(entry) + "\n";
  const fd = openSync(indexPath, "a", 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Appends a single JSON line to a parent's `agents/index.jsonl`.
 *
 * @param parentDir - The parent session directory (contains `agents/`).
 * @param entry - The child index entry.
 */
export async function appendAgentsIndexLine(
  parentDir: string,
  entry: AgentsIndexEntry,
): Promise<void> {
  const indexPath = join(parentDir, "agents", "index.jsonl");
  const line = JSON.stringify(entry) + "\n";
  const fd = openSync(indexPath, "a", 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ── Index Reading ─────────────────────────────────────────────────

/**
 * Reads and parses the global index (`~/.zao/index.jsonl`), optionally
 * applying filters.
 *
 * ## Last-line-wins semantics
 *
 * Both creation and completion lines share the same `session_id`.
 * The last line per id wins for status resolution. Creation lines set
 * `status: "active"`; completion lines overwrite with the final status.
 *
 * @param storeRoot - The resolved store root.
 * @param filters - Optional filters (status, repo, since, sessionId).
 * @returns Array of resolved index entries, sorted by `created_at` descending.
 */
export async function readGlobalIndex(
  storeRoot: string,
  filters?: {
    status?: string;
    repo?: string;
    since?: string;
    sessionId?: string;
  },
): Promise<GlobalIndexResolvedEntry[]> {
  const indexPath = join(storeRoot, "index.jsonl");

  let raw: string;
  try {
    raw = await readFile(indexPath, "utf-8");
  } catch {
    // File doesn't exist yet — no sessions
    return [];
  }

  // Aggregate: last line per session_id wins
  const byId = new Map<string, GlobalIndexResolvedEntry>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Skip corrupt lines
      continue;
    }

    const sid = parsed["session_id"];
    if (!sid || typeof sid !== "string") continue;

    // Check if this is a create entry (has created_at) or complete entry (has completed_at)
    let resolved = byId.get(sid);
    if (!resolved) {
      resolved = {
        session_id: sid,
        created_at: "",
        status: "active",
        repo_root: undefined,
        repo_remote: undefined,
        task_summary: undefined,
        models: [],
        branched_from: null,
        completed_at: undefined,
        agents_spawned: undefined,
        tokens: undefined,
      };
      byId.set(sid, resolved);
    }

    // Check if this looks like a create entry
    if ("created_at" in parsed && typeof parsed["created_at"] === "string") {
      resolved.created_at = parsed["created_at"];
      if ("repo_root" in parsed) resolved.repo_root = parsed["repo_root"] as string | undefined;
      if ("repo_remote" in parsed) resolved.repo_remote = parsed["repo_remote"] as string | undefined;
      if ("task_summary" in parsed) resolved.task_summary = parsed["task_summary"] as string | undefined;
      if ("models" in parsed) resolved.models = parsed["models"] as string[];
      if ("branched_from" in parsed) resolved.branched_from = parsed["branched_from"] as typeof resolved.branched_from;
    }

    // Check if this looks like a complete entry (overrides creation)
    if ("completed_at" in parsed && typeof parsed["completed_at"] === "string") {
      resolved.completed_at = parsed["completed_at"];
      if ("status" in parsed) resolved.status = parsed["status"] as string;
      if ("agents_spawned" in parsed) resolved.agents_spawned = parsed["agents_spawned"] as number | undefined;
      if ("tokens" in parsed) resolved.tokens = parsed["tokens"] as { prompt: number; completion: number } | undefined;
      if ("models" in parsed) resolved.models = parsed["models"] as string[];
    }
  }

  // Apply filters
  let results = [...byId.values()];

  if (filters?.status) {
    results = results.filter((e) => e.status === filters.status);
  }
  if (filters?.repo) {
    results = results.filter(
      (e) =>
        e.repo_root === filters.repo ||
        e.repo_remote === filters.repo,
    );
  }
  if (filters?.since) {
    const sinceDate = filters.since;
    results = results.filter((e) => e.created_at >= sinceDate);
  }
  if (filters?.sessionId) {
    results = results.filter((e) => e.session_id === filters.sessionId);
  }

  // Sort by created_at descending (newest first)
  results.sort((a, b) => b.created_at.localeCompare(a.created_at));

  return results;
}

// ── Session Listing ───────────────────────────────────────────────

/**
 * Lists sessions by reading the global index, resolving statuses,
 * and optionally inspecting session manifests for corrupted sessions.
 *
 * This is the engine behind `zao session list`. It reads the global index
 * ONLY — it never descends into session folders.
 *
 * @param storeRoot - The resolved store root.
 * @param filters - Filters from the CLI flags.
 * @returns Array of session list entries, sorted newest-first.
 */
export async function listSessions(
  storeRoot: string,
  filters: SessionListFilters = {},
): Promise<SessionListEntry[]> {
  const entries = await readGlobalIndex(storeRoot, {
    status: filters.status,
    repo: filters.repo,
    since: filters.since,
  });

  let results: SessionListEntry[] = await Promise.all(
    entries.map(async (e) => {
      let resolvedStatus = e.status;

      // Derive interrupted/corrupted for sessions still marked "active"
      if (resolvedStatus === "active" && !e.completed_at) {
        const sessionDir = join(storeRoot, "sessions", e.session_id);
        try {
          // Check if session.json is readable and valid
          const manifest = await readSessionManifest(sessionDir);
          if (!manifest) {
            resolvedStatus = "corrupted";
          } else {
            // Check if result.json exists
            const { access } = await import("node:fs/promises");
            try {
              await access(join(sessionDir, "result.json"));
              // result.json exists → still running (keep "active")
            } catch {
              // No result.json → interrupted
              resolvedStatus = "interrupted";
            }
          }
        } catch {
          // Cannot access session directory → corrupted
          resolvedStatus = "corrupted";
        }
      }

      return {
        session_id: e.session_id,
        created_at: e.created_at,
        completed_at: e.completed_at,
        status: resolvedStatus,
        repo_root: e.repo_root,
        repo_remote: e.repo_remote,
        task_summary: e.task_summary,
        models: e.models,
        agents_spawned: e.agents_spawned,
        tokens: e.tokens,
      };
    }),
  );

  // Apply limit
  if (filters.limit && filters.limit > 0) {
    results = results.slice(0, filters.limit);
  }

  return results;
}

// ── Repo Identity Capture ─────────────────────────────────────────

/**
 * Captures repository identity from the current working directory.
 *
 * Runs three git commands:
 * - `git rev-parse --show-toplevel` → `repo_root`
 * - `git remote get-url origin` → `repo_remote`
 * - `git rev-parse HEAD` → `repo_commit_at_start`
 *
 * **Never throws** — if any git command fails (e.g., not in a repo,
 * git not installed), the corresponding field is set to `null` and
 * a warning is logged to stderr.
 *
 * @param cwd - The working directory to run git commands from.
 * @returns An object with `repo_root`, `repo_remote`, and `repo_commit_at_start`.
 */
export async function captureRepoIdentity(
  cwd: string,
): Promise<{
  repo_root: string | null;
  repo_remote: string | null;
  repo_commit_at_start: string | null;
}> {
  const result: {
    repo_root: string | null;
    repo_remote: string | null;
    repo_commit_at_start: string | null;
  } = {
    repo_root: null,
    repo_remote: null,
    repo_commit_at_start: null,
  };

  // Only attempt git commands if we can spawn a process
  try {
    const { spawn } = await import("node:child_process");
    const { stdout } = await new Promise<{
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const proc = spawn("git", ["rev-parse", "--show-toplevel"], { cwd });
      let out = "";
      let err = "";
      proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
      proc.on("close", (code: number | null) => {
        if (code === 0) resolve({ stdout: out.trim(), stderr: err });
        else reject(new Error(`git exited ${code}: ${err}`));
      });
      proc.on("error", reject);
    });
    result.repo_root = stdout || null;
  } catch {
    logger.warn("[zao] Not in a git repository — repo_root will be null.");
  }

  // Only try remote if we got a repo root
  if (result.repo_root) {
    try {
      const { spawn } = await import("node:child_process");
      const { stdout } = await new Promise<{
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const proc = spawn("git", ["remote", "get-url", "origin"], {
          cwd: result.repo_root!,
        });
        let out = "";
        let err = "";
        proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
        proc.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
        proc.on("close", (code: number | null) => {
          if (code === 0) resolve({ stdout: out.trim(), stderr: err });
          else reject(new Error(`git exited ${code}: ${err}`));
        });
        proc.on("error", reject);
      });
      result.repo_remote = stdout || null;
    } catch {
      logger.warn("[zao] Could not determine git remote — repo_remote will be null.");
    }

    try {
      const { spawn } = await import("node:child_process");
      const { stdout } = await new Promise<{
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const proc = spawn("git", ["rev-parse", "HEAD"], {
          cwd: result.repo_root!,
        });
        let out = "";
        let err = "";
        proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
        proc.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
        proc.on("close", (code: number | null) => {
          if (code === 0) resolve({ stdout: out.trim(), stderr: err });
          else reject(new Error(`git exited ${code}: ${err}`));
        });
        proc.on("error", reject);
      });
      result.repo_commit_at_start = stdout || null;
    } catch {
      logger.warn(
        "[zao] Could not determine git commit — repo_commit_at_start will be null.",
      );
    }
  }

  return result;
}

// ── Manifest Loading (fail-closed) ─────────────────────────────────

/**
 * Reads a root session manifest from disk, validating against the
 * {@link ParentManifestSchema}. Fail-closed: if the file is missing,
 * corrupt, or invalid, throws a descriptive error.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @returns The validated parent manifest.
 * @throws If the manifest is missing, corrupt, or fails validation.
 */
export async function loadManifest(
  sessionDir: string,
): Promise<ParentManifest> {
  const result = await readArtifact(
    join(sessionDir, "session.json"),
    ParentManifestSchema,
  );
  if (!result.success) {
    throw new Error(
      `Cannot load session manifest at "${sessionDir}": ${result.error}`,
    );
  }
  return result.data;
}

// ── Session Directory Resolution ───────────────────────────────────

/**
 * Resolves a root session directory by session id in the global store.
 * Also checks child sessions under parent agents/ directories.
 *
 * 1. Checks ~/.zao/sessions/SESSIONID directly (root sessions).
 * 2. Scans ~/.zao/sessions/<parent>/agents/<id> for child sessions.
 * 3. Falls back to reading the global index (future multi-store).
 *
 * @param storeRoot - The resolved store root.
 * @param sessionId - The session identifier to look up.
 * @returns The absolute path to the session directory, or null if not found.
 */
export async function findSessionDir(
  storeRoot: string,
  sessionId: string,
): Promise<string | null> {
  // Direct root path
  const directPath = join(storeRoot, "sessions", sessionId);
  if (existsSync(directPath)) {
    return directPath;
  }

  // Search child sessions: iterate parent sessions' agents/ dirs
  try {
    const sessionsDir = join(storeRoot, "sessions");
    if (existsSync(sessionsDir)) {
      const parentEntries = await readdir(sessionsDir);
      for (const parentId of parentEntries) {
        const childPath = join(sessionsDir, parentId, "agents", sessionId);
        if (existsSync(childPath)) {
          return childPath;
        }
      }
    }
  } catch {
    // Dir not accessible
  }

  // Fallback: search global index (for future multi-store support)
  try {
    const entries = await readGlobalIndex(storeRoot, { sessionId });
    if (entries.length > 0 && entries[0]!.repo_root) {
      // Future: multi-store lookup
    }
  } catch {
    // Index read failure → not found
  }

  return null;
}

// ── Checkpoint Helpers ─────────────────────────────────────────────

/**
 * Creates a checkpoint of the session directory before mutation.
 *
 * Copies key files into `checkpoints/<uuidv7>/`:
 * - events.jsonl
 * - session.json
 * - result.json (if exists)
 * - summary.md (if exists)
 * - orchestration-spec.json (if exists)
 *
 * @param sessionDir - Absolute path to the session directory.
 * @returns The absolute path to the created checkpoint directory.
 */
export async function createCheckpoint(
  sessionDir: string,
): Promise<string> {
  const { generateSessionId } = await import("./ids.ts");
  const checkpointId = generateSessionId();
  const checkpointsDir = join(sessionDir, "checkpoints");
  const checkpointDir = join(checkpointsDir, checkpointId);

  await mkdir(checkpointDir, { recursive: true, mode: 0o700 });

  const toCopy = [
    "events.jsonl",
    "session.json",
    "result.json",
    "summary.md",
    "orchestration-spec.json",
  ];

  for (const filename of toCopy) {
    const src = join(sessionDir, filename);
    const dst = join(checkpointDir, filename);
    try {
      await copyFile(src, dst);
    } catch (error: unknown) {
      const errCode =
        error !== null &&
        typeof error === "object" &&
        "code" in error
          ? (error as { code: string }).code
          : undefined;
      if (errCode && errCode !== "ENOENT") {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.warn(
          `Checkpoint: failed to copy "${filename}" — ${message}`,
        );
      }
      // ENOENT is expected (e.g., no summary.md yet)
      // Other errors: log and continue (best-effort)
    }
  }

  return checkpointDir;
}

/**
 * Reads a checkpoint's contents, returning a map of filename → content.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param checkpointId - The UUIDv7 checkpoint identifier.
 * @returns A map of filenames to their string contents.
 */
export async function readCheckpoint(
  sessionDir: string,
  checkpointId: string,
): Promise<Record<string, string>> {
  const checkpointDir = join(sessionDir, "checkpoints", checkpointId);
  const contents: Record<string, string> = {};

  try {
    const entries = await readdir(checkpointDir);
    for (const entry of entries) {
      try {
        const filePath = join(checkpointDir, entry);
        const fileStat = await stat(filePath);
        if (fileStat.isFile()) {
          contents[entry] = await readFile(filePath, "utf-8");
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Checkpoint not found → return empty
  }

  return contents;
}


// ── Re-exports for convenience ────────────────────────────────────

export type { ParentManifest, ChildManifest } from "../schemas/session-manifest.ts";
export type {
  GlobalIndexCreateEntry,
  GlobalIndexCompleteEntry,
  AgentsIndexEntry,
  GlobalIndexResolvedEntry,
  SessionListEntry,
  SessionListFilters,
} from "../schemas/session-index.ts";
