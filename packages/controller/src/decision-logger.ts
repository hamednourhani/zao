/**
 * Decision Logger — append-only JSONL decision audit trail.
 *
 * Every decision by every actor (LLM, harness, controller, user) is logged
 * for debugging and learning. Violations are also written to a separate
 * `violations.jsonl` file in addition to `decisions.jsonl`.
 *
 * ## File layout
 *
 * ```
 * <executionDir>/
 * ├── decisions.jsonl   ← all decisions (append-only)
 * └── violations.jsonl  ← banned action attempts (append-only)
 * ```
 *
 * ## Key design principles
 *
 * - **Fail-closed writes**: Every entry is validated against a Zod schema
 *   BEFORE any bytes hit disk (per governance §E2).
 * - **Append-only**: Files are never modified in-place — new records are
 *   appended with `fsync`.
 * - **Safe for concurrent writes**: Append-only + fsync per write.
 * - **Schema version pinned**: All entries carry `schema_version: "0.1.0"`.
 *
 * @module decision-logger
 */

import { mkdir, writeFile } from "node:fs/promises";
import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// ── Types & Schema ────────────────────────────────────────────────

/**
 * Valid actor types for decision log entries.
 * - `llm`: A language model agent made the decision.
 * - `harness`: The zao harness infrastructure made the decision.
 * - `controller`: The zao controller/orchestration layer made the decision.
 * - `user`: A human user made the decision.
 */
export const ActorSchema = z.enum(["llm", "harness", "controller", "user"]);
export type Actor = z.infer<typeof ActorSchema>;

/**
 * Valid action types for decision log entries.
 * - `tool_call`: An actor invoked a tool.
 * - `tool_result`: The result of a tool invocation was recorded.
 * - `gate_decision`: A gate/human-in-the-loop decision was made.
 * - `escalation`: An issue was escalated to a higher authority.
 * - `approval`: A human approved an action or artifact.
 * - `rejection`: A human rejected an action or artifact.
 */
export const ActionSchema = z.enum([
  "tool_call",
  "tool_result",
  "gate_decision",
  "escalation",
  "approval",
  "rejection",
]);
export type Action = z.infer<typeof ActionSchema>;

/**
 * Schema for a single decision log entry (JSONL line).
 *
 * Matches the REQ-7 ticket spec:
 * ```typescript
 * {
 *   "schema_version": "0.1.0",
 *   "event_id": "uuid",
 *   "timestamp": "2026-08-08T10:23:45Z",
 *   "execution_id": "uuid",
 *   "session_id": "uuid",
 *   "step_id": "fix",
 *   "actor": "llm" | "harness" | "controller" | "user",
 *   "action": "tool_call" | "tool_result" | "gate_decision" |
 *             "escalation" | "approval" | "rejection",
 *   "data": { ... }
 * }
 * ```
 */
export const DecisionLogEntrySchema = z
  .object({
    /** Schema version — currently "0.1.0". */
    schema_version: z.literal("0.1.0"),
    /** Unique event identifier (UUID). */
    event_id: z.string().min(1),
    /** ISO-8601 timestamp of the decision. */
    timestamp: z.string().min(1),
    /** The execution this decision belongs to. */
    execution_id: z.string().min(1),
    /** The session this decision belongs to. */
    session_id: z.string().min(1),
    /** The step identifier (e.g., "fix", "review", "plan"). */
    step_id: z.string().min(1),
    /** Who made the decision. */
    actor: ActorSchema,
    /** What kind of decision was made. */
    action: ActionSchema,
    /** Actor-specific payload — shape varies by actor and action. */
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export type DecisionLogEntry = z.infer<typeof DecisionLogEntrySchema>;

// ── Logger Interface ─────────────────────────────────────────────

/**
 * A decision logger bound to a specific execution directory.
 *
 * Returned by {@link createDecisionLogger}.
 */
export interface DecisionLogger {
  /**
   * Appends a decision entry to `decisions.jsonl`.
   *
   * The entry is validated against {@link DecisionLogEntrySchema} BEFORE
   * writing (fail-closed).
   *
   * @param entry - The decision entry to log.
   * @throws If the entry fails schema validation or the write fails.
   */
  logDecision(entry: DecisionLogEntry): Promise<void>;

  /**
   * Appends a violation entry to both `violations.jsonl` and
   * `decisions.jsonl`.
   *
   * Violations represent banned action attempts or policy violations.
   * They are logged to a separate file for easy auditability, and also
   * included in the main decisions log for chronological completeness.
   *
   * @param entry - The violation entry to log.
   * @throws If the entry fails schema validation or the write fails.
   */
  logViolation(entry: DecisionLogEntry): Promise<void>;
}

// ── Internal Append Helper ───────────────────────────────────────

/**
 * Appends a single JSON line to a file with `fsync` for durability.
 *
 * This is the low-level write primitive shared by both logDecision
 * and logViolation. It assumes the caller has already validated the
 * entry against the schema.
 *
 * ## M4: Synchronous fsyncSync by design
 *
 * `fsyncSync` blocks the Node.js event loop until data is flushed to
 * disk. This is intentional: decision/violation logs MUST be durable
 * before the caller proceeds (fail-closed semantics — if we crash
 * after returning but before the write lands, the audit trail is
 * incomplete). The write volume is low (tens of entries per execution,
 * each a single JSON line), so the blocking cost is acceptable for v1.
 * Future versions may use `writeSync` with `O_DSYNC` or batched
 * fsync to reduce latency.
 *
 * @param filePath - Absolute path to the target file.
 * @param line - The JSON line content (NOT serialized — caller serializes).
 */
function appendLine(filePath: string, line: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "a", 0o600);
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Serializes and validates an entry, throwing on schema failure.
 *
 * This is the fail-closed gate: validation happens BEFORE any bytes
 * touch disk.
 *
 * @param entry - The raw entry to validate.
 * @returns The validated entry (parsed by Zod).
 * @throws If the entry fails schema validation.
 */
function validateEntry(entry: DecisionLogEntry): DecisionLogEntry {
  const result = DecisionLogEntrySchema.safeParse(entry);
  if (!result.success) {
    throw new Error(
      `Decision log entry validation failed: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Initializes the decision log for an execution directory.
 *
 * Creates the execution directory (if it doesn't exist) and an empty
 * `decisions.jsonl` file. Idempotent — safe to call multiple times.
 *
 * @param executionDir - The absolute path to the execution directory.
 */
export async function initializeDecisionLog(
  executionDir: string,
): Promise<void> {
  await mkdir(executionDir, { recursive: true, mode: 0o700 });
  // Create decisions.jsonl if it doesn't exist (EEXIST-safe)
  const decisionsPath = join(executionDir, "decisions.jsonl");
  await writeFile(decisionsPath, "", { mode: 0o600, flag: "wx" }).catch(
    (err: unknown) => {
      // EEXIST is fine — file already exists
      const code =
        err !== null && typeof err === "object" && "code" in err
          ? (err as { code: string }).code
          : undefined;
      if (code !== "EEXIST") throw err;
    },
  );
}

/**
 * Creates a decision logger bound to a specific execution directory.
 *
 * If the directory or `decisions.jsonl` haven't been initialized yet,
 * this function calls {@link initializeDecisionLog} automatically.
 *
 * @param executionDir - The absolute path to the execution directory.
 * @returns A {@link DecisionLogger} instance bound to the directory.
 */
export function createDecisionLogger(
  executionDir: string,
): DecisionLogger {
  let initialized = false;

  async function ensureInit(): Promise<void> {
    if (initialized) return;
    await initializeDecisionLog(executionDir);
    initialized = true;
  }

  return {
    async logDecision(entry: DecisionLogEntry): Promise<void> {
      await ensureInit();

      // Fail-closed: validate BEFORE writing
      const validated = validateEntry(entry);

      const decisionsPath = join(executionDir, "decisions.jsonl");
      const line = JSON.stringify(validated) + "\n";
      appendLine(decisionsPath, line);
    },

    async logViolation(entry: DecisionLogEntry): Promise<void> {
      await ensureInit();

      // Fail-closed: validate BEFORE writing
      const validated = validateEntry(entry);
      const line = JSON.stringify(validated) + "\n";

      // Write to violations.jsonl
      const violationsPath = join(executionDir, "violations.jsonl");
      appendLine(violationsPath, line);

      // Also write to decisions.jsonl for chronological completeness
      const decisionsPath = join(executionDir, "decisions.jsonl");
      appendLine(decisionsPath, line);
    },
  };
}
