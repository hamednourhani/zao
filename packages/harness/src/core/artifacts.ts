/**
 * Artifact I/O & Atomic File Operations — the foundation of mo's
 * file-based state machine.
 *
 * ## Core guarantees
 *
 * - **Atomic writes**: `writeArtifact` uses write-to-temp-then-rename
 *   (`fsync` + `rename`) so a crash mid-write never corrupts the
 *   canonical artifact (GUARDRAILS Rule 6).
 * - **Redaction before persistence**: `writeArtifact` automatically
 *   scrubs common secret patterns before writing (GUARDRAILS Rule 15).
 * - **Structured reads**: `readArtifact` validates against a Zod schema
 *   and returns a discriminated union — it **never throws**.
 * - **Truncation-tolerant events**: `readEvents` recovers from a
 *   truncated `events.jsonl` by skipping the incomplete final line
 *   (GUARDRAILS Rule 6 — append-only recovery).
 * - **Session init (ADR-005)**: `initSession` creates root or child
 *   sessions in the global store (`~/.zao/sessions/<uuidv7>/`),
 *   writes manifests, and appends index lines.
 *
 * @module artifacts
 */

import {
  writeSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { generateSessionId } from "./ids.ts";
import {
  resolveStoreRoot,
  ensureParentDir,
  ensureChildDir,
  writeSessionManifest,
  appendGlobalIndexLine,
  appendAgentsIndexLine,
  captureRepoIdentity,
} from "./session-store.ts";
import type { ParentManifest, ChildManifest } from "../schemas/session-manifest.ts";
import { ParentManifestSchema, ChildManifestSchema } from "../schemas/session-manifest.ts";
import { logger } from "./logger.ts";

// ── Types ───────────────────────────────────────────────────────

/** Successful artifact read result. */
export interface ArtifactReadSuccess<T> {
  success: true;
  data: T;
}

/** Failed artifact read result. */
export interface ArtifactReadFailure {
  success: false;
  error: string;
}

/** Discriminated union for `readArtifact` — never throws. */
export type ArtifactReadResult<T> =
  | ArtifactReadSuccess<T>
  | ArtifactReadFailure;

// ── Redaction ────────────────────────────────────────────────────

/**
 * Conservative secret redaction patterns applied before persistence.
 *
 * Replaces matching patterns with `[REDACTED]` to prevent accidental
 * storage of API keys, Bearer tokens, and common environment-variable
 * secrets.
 *
 * ## Covered patterns
 *
 * | Pattern | Example | Replacement |
 * |---|---|---|
 * | Anthropic API keys | `sk-ant-api03-abc123...` | `[REDACTED]` |
 * | OpenAI-style keys | `sk-abc123def456...` | `[REDACTED]` |
 * | JWT Bearer tokens | `Bearer eyJhbGci...` | `Bearer [REDACTED]` |
 * | Custom API key headers | `x-api-key: secr3t` | `x-api-key: [REDACTED]` |
 * | Env-var secrets | `SECRET=abc`, `API_KEY:xyz` | `SECRET=[REDACTED]` |
 *
 * > [!NOTE]  
 * > This is **conservative mode only**. Aggressive redaction (base64
 * > heuristics, structured secret detection) is deferred to a future
 * > story (see TD-001). False negatives are accepted; false positives
 * > are avoided by requiring minimum length thresholds.
 *
 * @param content - Raw content to scan for secrets.
 * @returns The content with recognized secret patterns replaced.
 */
export function redactSecrets(content: string): string {
  let result = content;

  // Anthropic API keys: sk-ant-api03-<alphanumeric+hYphen>
  // Pattern: sk-ant-api03- followed by at least 1 alphanumeric/dash/underscore
  result = result.replace(
    /sk-ant-api03-[A-Za-z0-9_\-]+/g,
    "[REDACTED]",
  );

  // OpenAI-style keys: sk- followed by 20+ alphanumeric/hyphen/underscore chars
  // Catches sk-abc123..., sk-proj-..., and sk-or-v1-... style keys
  result = result.replace(
    /sk-[A-Za-z0-9_-]{20,}/g,
    "[REDACTED]",
  );

  // JWT Bearer tokens: "Bearer eyJ..." (case-insensitive per RFC 6750)
  result = result.replace(
    /Bearer\s+eyJ[A-Za-z0-9_\-\.]+/gi,
    "Bearer [REDACTED]",
  );

  // Custom API key headers: x-api-key: <value> (case-insensitive)
  result = result.replace(
    /(x-api-key):\s*\S+/gi,
    "$1: [REDACTED]",
  );

  // Common env-var secret patterns (plain text):
  // VAR_NAME=value or VAR_NAME:value where VAR_NAME contains SECRET/TOKEN/KEY/PASSWORD/API_KEY
  result = result.replace(
    /(?<![A-Za-z-])(SECRET|TOKEN|KEY|PASSWORD|API_KEY)\s*[=:]\s*\S+/gi,
    "$1=[REDACTED]",
  );

  // JSON-aware redaction: catches secrets in JSON key-value format
  // e.g. {"api_key":"secret123"} — the plain-text patterns above
  // don't match JSON because of the quotes between key and colon.
  result = result.replace(
    /"((?:SECRET|TOKEN|KEY|PASSWORD|API_KEY|x-api-key))"\s*:\s*"[^"]*"/gi,
    '"$1":"[REDACTED]"',
  );

  return result;
}

// ── Atomic Write ─────────────────────────────────────────────────

/**
 * Writes content to a file atomically using write-to-temp-then-rename.
 *
 * ## Guarantees
 *
 * 1. Content is **redacted** via {@link redactSecrets} before writing.
 * 2. If a `schema` is provided, the content is parsed as JSON and validated
 *    against the schema BEFORE writing — fail-closed (governance §E2).
 *    A validation failure throws at the write line; no invalid file is
 *    ever persisted.
 * 3. Data is written to `${path}.tmp` and `fsync`'d to disk.
 * 4. The temp file is atomically renamed to `path` (same filesystem).
 * 5. On any error, the `.tmp` file is cleaned up and the error is
 *    re-thrown. The original `path` is never touched.
 *
 * @param path    - Absolute path to the target artifact file.
 * @param content - Raw string content to write.
 * @param schema  - Optional Zod schema to validate JSON content against.
 * @returns A promise that resolves when the artifact has been written.
 * @throws If the write, fsync, or rename fails, or if schema validation fails.
 */
export async function writeArtifact<T>(
  path: string,
  content: string,
  schema?: z.ZodType<T>,
): Promise<void> {
  let contentToWrite = content;

  // ── Fail-closed schema validation (§E2) ───────────────────────────
  if (schema) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON before write to ${path}: ${message}`);
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Artifact validation failed before write to ${path}: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }

    contentToWrite = JSON.stringify(result.data, null, 2);
  }

  const redacted = redactSecrets(contentToWrite);
  const tmpPath = `${path}.${randomUUID()}.tmp`;

  // Ensure parent directory exists with restricted permissions
  const lastSep = path.lastIndexOf("/");
  if (lastSep > 0) {
    await mkdir(path.slice(0, lastSep), { recursive: true, mode: 0o700 });
  }

  const buffer = Buffer.from(redacted, "utf-8");
  let fd: number | undefined;
  let dirFd: number | undefined;

  try {
    fd = openSync(tmpPath, "w", 0o600);
    writeSync(fd, buffer);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    renameSync(tmpPath, path);

    // Durability: fsync the parent directory so the rename is persisted
    const parentDir = path.slice(0, path.lastIndexOf("/"));
    try {
      dirFd = openSync(parentDir, "r");
      fsyncSync(dirFd);
      closeSync(dirFd);
      dirFd = undefined;
    } catch {
      // Best-effort: directory fsync is a durability optimization,
      // not required for correctness.
    }
  } catch (error) {
    // Clean up file descriptors
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
    // Clean up the temp file if it still exists
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

// ── Structured Read ──────────────────────────────────────────────

/**
 * Reads an artifact file, parses it as JSON, and validates it against
 * a Zod schema.
 *
 * ## Behavior
 *
 * - **Never throws** — all failures are returned as
 *   `{ success: false, error: "..." }`.
 * - Error messages do NOT contain raw file content (prevents
 *   accidental secret leakage in logs).
 * - Handles: file-not-found, invalid JSON, schema mismatch, and
 *   truncated/empty files.
 *
 * @param path   - Absolute path to the artifact file.
 * @param schema - Zod schema to validate the parsed content against.
 * @returns A discriminated union: `{ success: true, data: T }` or
 *          `{ success: false, error: string }`.
 */
export async function readArtifact<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<ArtifactReadResult<T>> {
  let raw: string;

  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    // File not found, permission denied, etc.
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "ENOENT"
    ) {
      return { success: false, error: `Artifact not found: ${path}` };
    }
    return {
      success: false,
      error: `Failed to read artifact: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // Empty file is a parse failure
  if (raw.trim().length === 0) {
    return { success: false, error: `Artifact is empty: ${path}` };
  }

  // Parse JSON — never include raw content in error messages.
  // Runtime error messages (Bun/JSC, Node V8) may embed content
  // snippets from truncated artifacts; returning a generic message
  // prevents secret leakage via error strings.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { success: false, error: `Invalid JSON in artifact: ${path}` };
  }

  // Validate against Zod schema
  const result = schema.safeParse(parsed);
  if (!result.success) {
    // ZodError messages contain field paths, not raw content — safe to include
    return {
      success: false,
      error: `Schema validation failed: ${result.error.message}`,
    };
  }

  return { success: true, data: result.data as T };
}

// ── Event Logging ────────────────────────────────────────────────

/**
 * Appends a single event as a JSON line to the session's `events.jsonl`.
 *
 * The event is serialized as a single-line JSON string (no pretty
 * printing) and appended with a trailing newline. The file is created
 * if it does not exist.
 *
 * ## v0.2.0 Envelope enforcement
 *
 * Every event MUST carry `event_id`, `session_id`, and `parent_session_id`
 * (nullable). If any required field is missing, an `Error` is thrown
 * immediately — this is a **fail-closed** check, not a warning.
 *
 * @param sessionDir - Absolute path to the session directory (from
 *                     {@link initSession}).
 * @param event      - The event object to append.
 * @returns A promise that resolves when the event has been appended.
 * @throws {Error} If the event is missing required envelope fields.
 */
export async function appendEvent(
  sessionDir: string,
  event: Record<string, unknown>,
): Promise<void> {
  // ── v0.2.0 envelope enforcement (fail-closed) ──
  // Validate full event against EventLogEntrySchema to catch missing
  // required fields (event_id, session_id, parent_session_id, timestamp,
  // agent_role, model_id, action, prompt_tokens, completion_tokens, cache_hit).
  const { EventLogEntrySchema } = await import("../schemas/event-log.ts");
  const result = EventLogEntrySchema.safeParse(event);
  if (!result.success) {
    throw new Error(
      `Event validation failed: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const filePath = join(sessionDir, "events.jsonl");
  const line = redactSecrets(JSON.stringify(event)) + "\n";
  // Open with restricted permissions (0o600) — events may contain
  // sensitive operational data even after redaction.
  const fd = openSync(filePath, "a", 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ── Session Initialization (ADR-005) ─────────────────────────────

/**
 * Parameters for initializing a new session (root or child).
 */
export interface InitSessionParams {
  /**
   * The agent role name (e.g., developer, architect).
   * Used in the session manifest.
   */
  role?: string;
  /**
   * Short summary of the task (first 200 chars used in index).
   */
  taskSummary?: string;
  /**
   * Absolute path to the parent session directory.
   * When provided, creates a child session under `agents/<uuidv7>/`.
   * When omitted, creates a root session under `~/.zao/sessions/<uuidv7>/`.
   */
  parentSessionDir?: string;
  /**
   * Explicit parent session UUIDv7 for the edge (v0.3.0).
   * Placement is always determined by `parentSessionDir`; this
   * field sets the `parent_session_id` in child manifests/indexes.
   * When omitted, derived from `basename(parentSessionDir)`.
   */
  parentSessionId?: string;
  /**
   * Optional flow graph node identifier (for flow executor).
   */
  nodeId?: string;
  /**
   * Root of the mo project. Used only for repo identity capture
   * on root sessions. Defaults to `process.cwd()`.
   */
  projectDir?: string;
  /**
   * Model provider name. Used for root manifest model_config.
   * When omitted, manifest is written with empty model_config
   * and backfilled by the caller after registry resolution.
   */
  modelProvider?: string;
  /**
   * Model identifier. Used for root manifest model_config.
   * When omitted, manifest is written with empty model_config
   * and backfilled by the caller after registry resolution.
   */
  modelId?: string;
}

/**
 * Result of calling {@link initSession}.
 */
export interface InitSessionResult {
  /** Absolute path to the created session directory. */
  sessionDir: string;
  /** The UUIDv7 session identifier. */
  sessionId: string;
  /** Whether this is a root session (true) or child (false). */
  isRoot: boolean;
}

/**
 * Creates a new session in the global store (ADR-005).
 *
 * ## Root session (no `parentSessionDir`)
 *
 * 1. Resolves store root (`~/.zao`)
 * 2. Generates a UUIDv7 session id
 * 3. Creates `sessions/<uuidv7>/` + `agents/` subdirectory
 * 4. Writes parent `session.json` manifest
 * 5. Appends creation line to global index (`index.jsonl`)
 * 6. Captures repo identity via git commands
 *
 * ## Child session (has `parentSessionDir`)
 *
 * 1. Generates a UUIDv7 session id
 * 2. Creates `agents/<uuidv7>/` under the parent session directory
 * 3. Writes child `session.json` manifest
 * 4. Appends line to parent's `agents/index.jsonl`
 *
 * @param params - Role, task summary, optional parent dir, optional node id.
 * @returns The session directory path, session id, and whether it's a root session.
 */
export async function initSession(
  params: InitSessionParams = {},
): Promise<InitSessionResult> {
  const sessionId = generateSessionId();
  const now = new Date().toISOString();
  const cwd = params.projectDir ?? process.cwd();

  // ── Root session ──────────────────────────────────────────────
  if (!params.parentSessionDir) {
    const storeRoot = await resolveStoreRoot();
    const sessionDir = await ensureParentDir(sessionId, storeRoot);

    // Capture repo identity (never throws — null fields on failure)
    const repoIdentity = await captureRepoIdentity(cwd);

    // Build parent manifest
    const manifest: ParentManifest = {
      schema_version: "0.2.0",
      session_id: sessionId,
      parent_session_id: null,
      created_at: now,
      updated_at: now,
      status: "active",
      task: params.taskSummary ?? "",
      role: params.role || "(unset)",
      model_config: {
        provider: params.modelProvider || "(unset)",
        model: params.modelId || "(unset)",
      },
      repo_root: repoIdentity.repo_root,
      repo_remote: repoIdentity.repo_remote,
      repo_commit_at_start: repoIdentity.repo_commit_at_start,
      cwd,
      branched_from: null,
      resume_count: 0,
      compaction_history: [],
    };

    await writeSessionManifest(
      sessionDir,
      manifest,
      ParentManifestSchema,
    );

    // Append creation line to global index (models filled on completion)
    await appendGlobalIndexLine(storeRoot, {
      session_id: sessionId,
      created_at: now,
      repo_root: repoIdentity.repo_root,
      repo_remote: repoIdentity.repo_remote,
      task_summary: (params.taskSummary ?? "").slice(0, 200),
      status: "active",
      branched_from: null,
    });

    return { sessionDir, sessionId, isRoot: true };
  }

  // ── Child session ─────────────────────────────────────────────
  const sessionDir = await ensureChildDir(sessionId, params.parentSessionDir);

  // Parent session id: explicit param takes priority; fall back to basename
  const parentSessionId = params.parentSessionId
    ?? (params.parentSessionDir.split("/").pop() || null);
  if (!parentSessionId) {
    throw new Error(
      "Cannot derive parent_session_id for child session: no parentSessionId " +
      "provided and parentSessionDir has no valid basename",
    );
  }

  // Build child manifest
  const manifest: ChildManifest = {
    schema_version: "0.2.0",
    session_id: sessionId,
    parent_session_id: parentSessionId,
    node_id: params.nodeId,
    role: params.role || "(unset)",
    task_summary: (params.taskSummary ?? "").slice(0, 200),
    model_id: params.modelId || "(unset)", // Populated by caller after resolution
    created_at: now,
    status: "active",
  };

  await writeSessionManifest(
    sessionDir,
    manifest,
    ChildManifestSchema,
  );

  // Append to agents index
  await appendAgentsIndexLine(params.parentSessionDir, {
    session_id: sessionId,
    parent_session_id: parentSessionId,
    node_id: params.nodeId,
    role: params.role ?? "",
    started_at: now,
    status: "active",
  });

  return { sessionDir, sessionId, isRoot: false };
}

// ── Event Reading ────────────────────────────────────────────────

/** Result of reading events from an events.jsonl file. */
export interface ReadEventsResult {
  success: true;
  events: Record<string, unknown>[];
}

/** Result when events.jsonl has a truncated final line. */
export interface ReadEventsTruncatedResult {
  success: true;
  events: Record<string, unknown>[];
  /** Set to `true` when the final line was truncated and skipped. */
  truncated: true;
}

/** Result when events.jsonl could not be read (other than ENOENT). */
export interface ReadEventsFailure {
  success: false;
  error: string;
  events: Record<string, unknown>[];
}

/**
 * Reads all events from the session's `events.jsonl` file.
 *
 * ## Truncation tolerance (GUARDRAILS Rule 6)
 *
 * If the last line of the file fails to parse as JSON (e.g., due to a
 * crash mid-write), it is silently skipped. A warning is logged via
 * `console.warn`. All preceding valid lines are returned with
 * `truncated: true`.
 *
 * If a non-final line fails to parse, a warning is also logged and
 * the function returns the events parsed up to that point with
 * `truncated: true`. The system should treat any `truncated` result
 * as a signal that the file may be incomplete.
 *
 * **Never throws** — I/O errors other than ENOENT are returned as
 * `{ success: false, error: "..." }`.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @returns The parsed events, or a failure/truncation indicator.
 */
export async function readEvents(
  sessionDir: string,
): Promise<ReadEventsResult | ReadEventsTruncatedResult | ReadEventsFailure> {
  const filePath = join(sessionDir, "events.jsonl");

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    const errCode =
      error !== null &&
      typeof error === "object" &&
      "code" in error
        ? (error as { code: string }).code
        : undefined;
    if (errCode === "ENOENT") {
      return { success: true, events: [] };
    }
    return {
      success: false,
      error: `Failed to read events: ${
        error instanceof Error ? error.message : String(error)
      }`,
      events: [],
    };
  }

  if (raw.trim().length === 0) {
    return { success: true, events: [] };
  }

  const lines = raw.split("\n");
  const events: Record<string, unknown>[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;

    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      events.push(parsed);
    } catch (_parseError) {
      const isLastLine = i === lines.length - 1;
      if (isLastLine) {
        logger.warn(
          `Truncated final line in events.jsonl (session: ${sessionDir}) — skipping`,
        );
      } else {
        logger.warn(
          `Unparseable line at index ${i} in events.jsonl (session: ${sessionDir}) — returning partial results`,
        );
      }
      return { success: true, events, truncated: true };
    }
  }

  return { success: true, events };
}
