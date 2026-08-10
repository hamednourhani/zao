/**
 * Execution Store — controller memory model for run lifecycle management.
 *
 * ## Store layout (ADR-008)
 *
 * ```
 * ~/.zao/executions/
 * └── <execution_id>/
 *     ├── execution.json   ← manifest (atomic write)
 *     ├── index.jsonl      ← append-only, one line per harness session
 *     └── events.jsonl     ← append-only, controller-level lifecycle events
 * ```
 *
 * ## Key design principles
 *
 * - **Fail-closed writes**: `execution.json` is validated against a Zod schema
 *   BEFORE any bytes hit disk (per TD-018 / governance §E2).
 * - **Append-only indexes**: `index.jsonl` and `events.jsonl` are never modified
 *   in-place — new records are appended with `fsync` (per ADR-005 §5).
 * - **Store isolation**: Controller state lives under `~/.zao/executions/`,
 *   NEVER under `~/.zao/sessions/` (which is harness-owned).
 * - **Resolution**: Store root is `$ZAO_HOME`, falling back to `$XDG_DATA_HOME/zao`,
 *   then `~/.zao`.
 *
 * @module execution-store
 */

import { mkdir, readFile } from "node:fs/promises";
import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { logger } from "./logger.ts";

// ── Types & Schemas ───────────────────────────────────────────────

/**
 * Execution manifest schema — the authoritative record of a run.
 * Validated before every write (fail-closed).
 */
export const ExecutionManifestSchema = z
  .object({
    execution_id: z.string().min(1),
    status: z.enum(["active", "complete", "failed"]),
    created_at: z.string().min(1),
    /** Absolute path to the repository root at run start. */
    repo_root: z.string().min(1),
    /** The task description / objective. */
    task: z.string().min(1),
    schema_version: z.literal("0.2.0"),
  })
  .strict();

export type ExecutionManifest = z.infer<typeof ExecutionManifestSchema>;

/**
 * A single line in `index.jsonl` — one per harness session spawned
 * during this execution.
 */
export const ExecutionIndexLineSchema = z
  .object({
    session_id: z.string().min(1),
    /** The status of this session: "active" | "complete" | "failed". */
    status: z.string().min(1),
    /** ISO-8601 timestamp when the session was started. */
    started_at: z.string().min(1),
    /** ISO-8601 timestamp when the session completed, or null if still active. */
    completed_at: z.string().nullable(),
  })
  .strict();

export type ExecutionIndexLine = z.infer<typeof ExecutionIndexLineSchema>;

/**
 * Controller-level lifecycle event written to `events.jsonl`.
 *
 * Event types:
 * - Execution lifecycle: `execution_created`, `execution_resumed`,
 *   `execution_completed`, `execution_failed`
 * - Step lifecycle: `step_started`, `step_completed`, `step_failed`,
 *   `step_skipped`
 */
export const ExecutionEventSchema = z
  .object({
    type: z.enum([
      "execution_created",
      "execution_resumed",
      "execution_completed",
      "execution_failed",
      "step_started",
      "step_completed",
      "step_failed",
      "step_skipped",
    ]),
    execution_id: z.string().min(1),
    timestamp: z.string().min(1),
    /** Optional detail payload — see event type for expected shape. */
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;

/**
 * Parameters for {@link initExecution}.
 */
export interface InitExecutionParams {
  /** Unique execution identifier (UUIDv7 or similar). */
  execution_id: string;
  /** The task description / objective for this run. */
  task: string;
  /** Absolute path to the repository root. */
  repo_root: string;
}

// ── Store Root Resolution ─────────────────────────────────────────

/**
 * Resolves the controller execution store root directory.
 *
 * Resolution order:
 * 1. `$ZAO_HOME` (explicit override) → `$ZAO_HOME/executions`
 * 2. `$XDG_DATA_HOME/zao` → `$XDG_DATA_HOME/zao/executions`
 * 3. `~/.zao/executions` (default)
 *
 * The directory is created with restricted permissions (`0o700`) if
 * it does not already exist.
 *
 * @returns The absolute path to the executions directory.
 */
export async function resolveExecutionStoreRoot(): Promise<string> {
  let base: string;

  if (process.env["ZAO_HOME"]) {
    base = process.env["ZAO_HOME"];
  } else if (process.env["XDG_DATA_HOME"]) {
    base = join(process.env["XDG_DATA_HOME"], "zao");
  } else {
    base = join(homedir(), ".zao");
  }

  const root = join(base, "executions");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

// ── Execution Initialization ──────────────────────────────────────

/**
 * Creates a new execution directory under `~/.zao/executions/<execution_id>/`.
 *
 * This is the entry point for a new run. It:
 * 1. Resolves the store root.
 * 2. Creates the execution directory with `0o700` permissions.
 * 3. Writes `execution.json` (manifest) with atomic write-via-temp.
 * 4. Creates an empty `index.jsonl` (ADR-008 layout contract).
 * 5. Appends an `execution_created` event to `events.jsonl`.
 *
 * ## Fail-closed guarantee
 *
 * The manifest is validated against {@link ExecutionManifestSchema} BEFORE
 * any bytes are written. A validation failure throws immediately — no
 * invalid `execution.json` is ever persisted.
 *
 * @param params - Execution id, task, and repo root.
 * @returns The absolute path to the created execution directory.
 * @throws If the manifest fails schema validation.
 */
export async function initExecution(
  params: InitExecutionParams,
): Promise<{ executionDir: string }> {
  const storeRoot = await resolveExecutionStoreRoot();
  const executionDir = join(storeRoot, params.execution_id);

  // Create the execution directory (EEXIST-safe — init is idempotent)
  await mkdir(executionDir, { recursive: true, mode: 0o700 });

  const now = new Date().toISOString();

  // Build and validate the manifest (fail-closed)
  const manifest: ExecutionManifest = {
    execution_id: params.execution_id,
    status: "active",
    created_at: now,
    repo_root: params.repo_root,
    task: params.task,
    schema_version: "0.2.0",
  };

  await writeExecutionManifest(executionDir, manifest);

  // Create an empty index.jsonl to satisfy the ADR-008 layout contract.
  // The file is created with restricted permissions (0o600) and is initially
  // empty — harness session_ids are appended later.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(executionDir, "index.jsonl"), "", { mode: 0o600 });

  // Append lifecycle event
  const event: ExecutionEvent = {
    type: "execution_created",
    execution_id: params.execution_id,
    timestamp: now,
    detail: { task: params.task, repo_root: params.repo_root },
  };

  await appendExecutionEvent(executionDir, event);

  return { executionDir };
}

// ── Manifest I/O ───────────────────────────────────────────────────

/**
 * Writes `execution.json` atomically using write-to-temp-then-rename.
 *
 * The manifest is validated against {@link ExecutionManifestSchema} BEFORE
 * writing. On any error, the temp file is cleaned up and the original is
 * never touched.
 *
 * ## Atomic write protocol
 *
 * 1. Validate manifest against schema (fail-closed).
 * 2. Serialize to pretty-printed JSON.
 * 3. Write to `<path>.tmp` with `fsync`.
 * 4. Atomically rename `<path>.tmp` → `<path>`.
 * 5. `fsync` parent directory for durability.
 *
 * @param dir - The execution directory.
 * @param manifest - The manifest object to validate and write.
 * @throws If the manifest fails schema validation or write fails.
 */
export async function writeExecutionManifest(
  dir: string,
  manifest: ExecutionManifest,
): Promise<void> {
  // Validate BEFORE any write — fail-closed (§E2)
  const result = ExecutionManifestSchema.safeParse(manifest);
  if (!result.success) {
    throw new Error(
      `Execution manifest validation failed before write: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const content = JSON.stringify(result.data, null, 2);
  const filePath = join(dir, "execution.json");
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;

  const buffer = Buffer.from(content, "utf-8");
  let fd: number | undefined;
  let dirFd: number | undefined;

  try {
    fd = openSync(tmpPath, "w", 0o600);
    writeSync(fd, buffer);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    // Atomic rename
    const { renameSync } = await import("node:fs");
    renameSync(tmpPath, filePath);

    // Durability: fsync the parent directory
    try {
      const { openSync: os } = await import("node:fs");
      dirFd = os(dir, "r");
      fsyncSync(dirFd);
      closeSync(dirFd);
      dirFd = undefined;
    } catch {
      // Best-effort: directory fsync is a durability optimization
    }
  } catch (error) {
    // Clean up file descriptors on error
    try {
      if (fd !== undefined) closeSync(fd);
    } catch {
      /* best-effort */
    }
    try {
      if (dirFd !== undefined) closeSync(dirFd);
    } catch {
      /* best-effort */
    }
    // Clean up temp file
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
    throw error;
  }
}

/**
 * Reads `execution.json` from the execution directory, validates it
 * against {@link ExecutionManifestSchema}, and returns the parsed manifest.
 *
 * ## Error handling
 *
 * - **File not found**: returns `null`.
 * - **Invalid JSON or schema mismatch**: throws a descriptive error
 *   (fail-closed — no silent fallback to partial data).
 *
 * @param dir - The execution directory.
 * @returns The validated manifest, or `null` if the file does not exist.
 * @throws If the file is invalid JSON or fails schema validation.
 */
export async function readExecutionManifest(
  dir: string,
): Promise<ExecutionManifest | null> {
  const filePath = join(dir, "execution.json");

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error: unknown) {
    const errCode =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code: string }).code
        : undefined;
    if (errCode === "ENOENT") return null;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read execution manifest: ${message}`);
  }

  if (raw.trim().length === 0) {
    throw new Error(`Execution manifest is empty: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in execution manifest: ${filePath}`);
  }

  const result = ExecutionManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Execution manifest schema validation failed: ${result.error.message}`,
    );
  }

  return result.data;
}

// ── Atomic JSON Writer ─────────────────────────────────────────────

/**
 * Writes a JSON object atomically to a file path using the
 * write-to-temp-then-rename protocol.
 *
 * ## Atomic write protocol
 *
 * 1. Optionally validate against a Zod schema (fail-closed).
 * 2. Serialize to pretty-printed JSON.
 * 3. Write to `<path>.tmp` with `fsync`.
 * 4. Atomically rename `<path>.tmp` → `<path>`.
 * 5. `fsync` parent directory for durability.
 *
 * ## Fail-closed guarantees
 *
 * If a schema is provided and validation fails, the function throws
 * BEFORE any bytes are written to disk. On write error, the temp file
 * is cleaned up and the original file is never touched.
 *
 * @param filePath - Absolute path to the target file.
 * @param data - The JSON-serializable data to write.
 * @param schema - Optional Zod schema to validate against before writing.
 * @throws If schema validation fails (when schema provided) or write fails.
 */
export async function writeAtomicJson(
  filePath: string,
  data: Record<string, unknown>,
  schema?: z.ZodType<unknown>,
): Promise<void> {
  let validated: unknown = data;

  // Validate BEFORE any write — fail-closed (§E2)
  if (schema) {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new Error(
        `Atomic JSON validation failed before write to "${filePath}": ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    validated = result.data;
  }

  const content = JSON.stringify(validated, null, 2);
  const dir = join(filePath, "..");
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;

  const buffer = Buffer.from(content, "utf-8");
  let fd: number | undefined;
  let dirFd: number | undefined;

  try {
    fd = openSync(tmpPath, "w", 0o600);
    writeSync(fd, buffer);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    // Atomic rename
    const { renameSync } = await import("node:fs");
    renameSync(tmpPath, filePath);

    // Durability: fsync the parent directory
    try {
      const { openSync: os } = await import("node:fs");
      const { statSync } = await import("node:fs");
      // statSync ensures the directory path exists before we open it
      statSync(dir);
      dirFd = os(dir, "r");
      fsyncSync(dirFd);
      closeSync(dirFd);
      dirFd = undefined;
    } catch {
      // Best-effort: directory fsync is a durability optimization
    }
  } catch (error) {
    // Clean up file descriptors on error
    try {
      if (fd !== undefined) closeSync(fd);
    } catch {
      /* best-effort */
    }
    try {
      if (dirFd !== undefined) closeSync(dirFd);
    } catch {
      /* best-effort */
    }
    // Clean up temp file
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
    throw error;
  }
}

// ── Index I/O (append-only) ───────────────────────────────────────

/**
 * Appends a single JSON line to the execution's `index.jsonl`.
 *
 * The file is append-only — existing lines are never modified.
 * Each write is followed by `fsync` for durability.
 *
 * @param dir - The execution directory.
 * @param line - The index entry to append (one harness session).
 */
export async function appendExecutionIndexLine(
  dir: string,
  line: ExecutionIndexLine,
): Promise<void> {
  // Validate BEFORE any write — fail-closed (§E2)
  const result = ExecutionIndexLineSchema.safeParse(line);
  if (!result.success) {
    throw new Error(
      `Execution index line validation failed: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const indexPath = join(dir, "index.jsonl");
  const content = JSON.stringify(result.data) + "\n";
  const fd = openSync(indexPath, "a", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads and parses all lines from the execution's `index.jsonl`.
 *
 * ## Last-line-wins semantics
 *
 * A session may appear in multiple lines (creation + completion).
 * The last line per `session_id` wins. Completion lines override
 * the status and completed_at from creation lines.
 *
 * ## Truncation tolerance
 *
 * If the last line is incomplete (unparseable JSON), it is skipped.
 * Non-last-line parse failures cause the function to return partial
 * results with a warning.
 *
 * @param dir - The execution directory.
 * @returns Array of resolved index entries, ordered by insertion.
 */
export async function readExecutionIndex(
  dir: string,
): Promise<ExecutionIndexLine[]> {
  const indexPath = join(dir, "index.jsonl");

  let raw: string;
  try {
    raw = await readFile(indexPath, "utf-8");
  } catch {
    // File doesn't exist yet — no sessions recorded
    return [];
  }

  // Aggregate: last line per session_id wins
  const byId = new Map<string, ExecutionIndexLine>();
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Skip unparseable lines (truncation tolerance)
      if (i === lines.length - 1) {
        // Last line truncated — skip silently
        continue;
      }
      // Non-last line unparseable — log warning and continue
      logger.warn(
        `Unparseable line at index ${i} in ${indexPath} — skipping`,
      );
      continue;
    }

    const sid = parsed["session_id"];
    if (!sid || typeof sid !== "string") continue;

    const existing = byId.get(sid);

    // Build the entry, merging creation and completion data
    const entry: ExecutionIndexLine = {
      session_id: sid,
      status:
        typeof parsed["status"] === "string"
          ? parsed["status"]
          : existing?.status ?? "active",
      started_at:
        typeof parsed["started_at"] === "string"
          ? parsed["started_at"]
          : existing?.started_at ?? "",
      completed_at:
        "completed_at" in parsed
          ? (parsed["completed_at"] as string | null)
          : existing?.completed_at ?? null,
    };

    byId.set(sid, entry);
  }

  // Return entries in insertion order (Map preserves insertion order)
  return [...byId.values()];
}

// ── Event I/O (append-only) ───────────────────────────────────────

/**
 * Appends a controller-level lifecycle event to the execution's `events.jsonl`.
 *
 * The event is validated against {@link ExecutionEventSchema} BEFORE
 * writing (fail-closed). The file is append-only — never modified in-place.
 *
 * @param dir - The execution directory.
 * @param event - The lifecycle event to append.
 * @throws If the event fails schema validation.
 */
export async function appendExecutionEvent(
  dir: string,
  event: ExecutionEvent,
): Promise<void> {
  // Validate BEFORE write — fail-closed
  const result = ExecutionEventSchema.safeParse(event);
  if (!result.success) {
    throw new Error(
      `Execution event validation failed: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const filePath = join(dir, "events.jsonl");
  const line = JSON.stringify(event) + "\n";
  const fd = openSync(filePath, "a", 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
