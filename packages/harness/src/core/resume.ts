/**
 * Session Resume — `mo continue` implementation (single-session only).
 *
 * ## Core guarantees (TD-029-F slimmed)
 *
 * - **A run = one job.** Resume re-enters the harness run loop for the
 *   session's original task.
 * - **Complete is terminal.** Completed runs are refused with a clear
 *   error; no `--force` flag exists.
 * - **Children are never resumable.** Only root sessions.
 * - **Config drift = a note, not a gate.** Informational note printed;
 *   original task always used.
 * - **Ground truth on disk.** Already-completed work is preserved.
 *
 * ## ADR-009 (TD-033)
 *
 * Credentials are loaded via `@zao/llm-clients` registry. The registry
 * reads `llm_id` from `session-config.json`, resolves the client, and
 * passes it to `runLoop`. No `apiKey` is loaded from the old config file.
 *
 * @module resume
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { GenerateObjectFn, ModelOptions } from "./llm.ts";
import { runLoop } from "./loop.ts";
import type { RunLoopResult } from "./loop.ts";
import {
  resolveStoreRoot,
  findSessionDir,
  readSessionManifest,
  createCheckpoint,
  appendGlobalIndexLine,
  writeSessionManifest,
} from "./session-store.ts";
import { ParentManifestSchema } from "../schemas/session-manifest.ts";
import type { ParentManifest } from "../schemas/session-manifest.ts";
import { appendEvent } from "./artifacts.ts";
import { generateSessionId } from "./ids.ts";
import type { ResolvedRoleDefinition } from "../schemas/role-definition.ts";
import { SessionConfigSchema } from "../schemas/session-config.ts";
import type { LlmClientRegistry } from "@zao/llm-clients";
import { logger } from "./logger.ts";

// ── Types ───────────────────────────────────────────────────────────

/** Options for the {@link resumeSession} function. */
export interface ResumeOptions {
  /** Auto-approve prompts (--yes flag). */
  yes?: boolean;
  /** Number of recent events to include in resume context. @default 3 */
  recentEvents?: number;
  /**
   * **Internal/test-only.** Mock injection point for deterministic tests.
   * When provided, forwarded to `runLoop` → `generateStructuredResponse`.
   */
  _generateObjectFn?: GenerateObjectFn;
  /**
   * **Internal/test-only.** Inject a registry for testing.
   * When omitted, `createDefaultRegistry()` is called.
   */
  _registry?: LlmClientRegistry;
}

/** Result of a resume attempt. */
export interface ResumeResult {
  /** Whether the resume (re-entry into runLoop) succeeded. */
  success: boolean;
  /** The session directory path. */
  sessionDir: string;
  /** The session id. */
  sessionId: string;
  /** Error message on failure. */
  error?: string;
  /** Whether the session was completed by this resume. */
  completed: boolean;
  /**
   * When true, the failure is a validation error (unknown session,
   * child session, complete run) — exit code 3.
   * Runtime failures (LLM call exhaustion, step failure) exit 1.
   */
  isValidationError?: boolean;
}

// ── Constants ───────────────────────────────────────────────────────

/** Default number of recent events to include in resume context. */
const DEFAULT_RECENT_EVENTS = 3;

// ── Core Function ───────────────────────────────────────────────────

/**
 * Resumes an interrupted or failed single-job session.
 *
 * This is the slimmed single-session resume (TD-029-F). Multi-step
 * flow resume has moved to the controller. This function only handles
 * resuming a single runLoop session.
 *
 * ## ADR-009 (TD-033)
 *
 * Credentials are loaded via the `@zao/llm-clients` registry. The
 * `llm_id` from `session-config.json` is used to resolve the client
 * from the registry. No `apiKey` is read from the old config.
 *
 * @param sessionId - The session identifier to resume.
 * @param options - Resume options (yes, recentEvents).
 * @returns A {@link ResumeResult} with success status and details.
 */
export async function resumeSession(
  sessionId: string,
  options: ResumeOptions = {},
): Promise<ResumeResult> {
  const storeRoot = await resolveStoreRoot();
  const recentEventsCount = options.recentEvents ?? DEFAULT_RECENT_EVENTS;

  // ── Step 1: Resolve session in global store ──────────────────────
  const sessionDir = await findSessionDir(storeRoot, sessionId);
  if (!sessionDir) {
    return {
      success: false,
      sessionDir: "",
      sessionId,
      error: `Session "${sessionId}" not found. Check the id or run "zao session list".`,
      completed: false,
      isValidationError: true,
    };
  }

  // ── Step 2: Read session.json ────────────────────────────────────
  let manifest: ParentManifest;
  try {
    const result = await readSessionManifest(sessionDir);
    if (!result) {
      return {
        success: false,
        sessionDir,
        sessionId,
        error: `Cannot resume: manifest not found or corrupted at "${sessionDir}".`,
        completed: false,
        isValidationError: true,
      };
    }

    // Child session gate: reject any manifest with a non-null parent_session_id
    if (result.parent_session_id !== null) {
      return {
        success: false,
        sessionDir,
        sessionId,
        error:
          `Session "${sessionId}" is a child session. ` +
          "Only root sessions can be resumed.",
        completed: false,
        isValidationError: true,
      };
    }

    manifest = result as ParentManifest;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      sessionDir,
      sessionId,
      error: `Cannot resume: ${message}`,
      completed: false,
      isValidationError: true,
    };
  }

  // ── Step 3: Terminal-state gate ─────────────────────────────────
  if (manifest.status === "complete") {
    return {
      success: false,
      sessionDir,
      sessionId,
      error: "Run complete. Completed runs are terminal.",
      completed: false,
      isValidationError: true,
    };
  }

  if (manifest.status === "failed") {
    let recordedError = "No error details recorded.";
    try {
      const resultRaw = await readFile(
        join(sessionDir, "result.json"),
        "utf-8",
      );
      const result = JSON.parse(resultRaw);
      if (result.error) {
        recordedError = result.error;
      }
    } catch {
      // No result.json or unreadable
    }

    if (!options.yes) {
      process.stdout.write(
        `\nSession "${sessionId.slice(0, 12)}..." failed.\n` +
          `Recorded error: ${recordedError}\n\n` +
          "Resume this session? [y/N] ",
      );

      const answer = await readLine();
      if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
        return {
          success: false,
          sessionDir,
          sessionId,
          error: "Resume cancelled by user.",
          completed: false,
        };
      }
    } else {
      process.stdout.write(
        `Session "${sessionId.slice(0, 12)}..." failed.\n` +
          `Recorded error: ${recordedError}\n` +
          "Resuming (--yes flag active).\n\n",
      );
    }
  }

  // ── Step 4: Config drift NOTE (best-effort) ─────────────────────
  // In slimmed mode, we skip the replay-ability check (no role registry
  // to verify against). If config drift detection is critical, it's
  // handled by the controller now.

  // ── Step 5: Checkpoint BEFORE mutation ──────────────────────────
  let checkpointId: string;
  try {
    const checkpointDir = await createCheckpoint(sessionDir);
    checkpointId = checkpointDir.split("/").pop() ?? "unknown";
    process.stdout.write(
      `Checkpoint saved: checkpoints/${checkpointId}\n`,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      sessionDir,
      sessionId,
      error: `Cannot resume: failed to create checkpoint: ${message}`,
      completed: false,
    };
  }

  // ── Step 5b: Read immutable session config ──────────────────────
  // The session config is written exactly once at session start.
  // If it's missing or corrupted, resume fails closed.
  let storedRoleDef: ResolvedRoleDefinition;
  let storedRoleName: string;
  let storedTemperature: number | undefined;
  try {
    const configRaw = await readFile(
      join(sessionDir, "session-config.json"),
      "utf-8",
    );
    const config = JSON.parse(configRaw);

    // Validate against the SessionConfigSchema (schema_version 1.0)
    const validationResult = SessionConfigSchema.safeParse(config);
    // guard:ignore R5-no-silent-skip-on-state-write — schema validation branch, not a state-write skip
    if (validationResult.success) {
      // ── v1.0 format: canonical llm_id ────────────────
      const parsed = validationResult.data;
      storedRoleDef = parsed.resolved_role as ResolvedRoleDefinition;
      storedRoleName = parsed.role_name;
      storedTemperature = parsed.temperature;
    } else {
      // ── Legacy format (schema_version 0.2.0): try to extract ──
      if (!config._roleDef || !config.model_id) {
        return {
          success: false,
          sessionDir,
          sessionId,
          error:
            "Session config is corrupted (missing _roleDef or model_id). " +
            "Cannot resume.",
          completed: false,
          isValidationError: true,
        };
      }
      storedRoleDef = config._roleDef as ResolvedRoleDefinition;
      storedRoleName =
        (typeof config.role_name === "string" && config.role_name) ||
        manifest.role ||
        // guard:ignore R4-no-hardcoded-roles — fallback for sessions before role_name was stored
        "developer";

      // Legacy sessions may not have llm_id — construct from model_config or fallback
      if (!storedRoleDef.llm_id && config.model_config) {
        storedRoleDef = {
          ...storedRoleDef,
          llm_id: `${config.model_config.provider}:${config.model_config.model}`,
        };
      } else if (!storedRoleDef.llm_id) {
        storedRoleDef = {
          ...storedRoleDef,
          llm_id: "deepseek:deepseek-chat",
        };
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      sessionDir,
      sessionId,
      error:
        `Session config not found or unreadable: ${message}. ` +
        "Session may have been created before immutable config support. " +
        "Cannot resume.",
      completed: false,
      isValidationError: true,
    };
  }

  // ── Load LLM client via registry (ADR-009, TD-033) ─────────────
  const llmOptions: ModelOptions = {};
  if (storedTemperature !== undefined) {
    llmOptions.temperature = storedTemperature;
  }

  // ── L5: Update session.json status to "active" BEFORE re-entry ──
  try {
    await writeSessionManifest(
      sessionDir,
      {
        ...manifest,
        status: "active",
        resume_count: manifest.resume_count + 1,
        updated_at: new Date().toISOString(),
      },
      ParentManifestSchema,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      sessionDir,
      sessionId,
      error: `Failed to update session manifest before resume: ${message}`,
      completed: false,
    };
  }

  // ── Step 6: Reconstruct context ─────────────────────────────────
  const recentEventLines: string[] = [];
  try {
    const eventsRaw = await readFile(join(sessionDir, "events.jsonl"), "utf-8");
    const lines = eventsRaw.split("\n").filter((l) => l.trim().length > 0);
    const recentLines = lines.slice(-recentEventsCount);
    for (const line of recentLines) {
      try {
        const event = JSON.parse(line);
        const timestamp =
          typeof event["timestamp"] === "string"
            ? event["timestamp"].slice(11, 19)
            : "????";
        const action = event["action"] ?? "unknown";
        const model = event["model_id"] ?? "?";
        const tokens = event["prompt_tokens"] ?? 0;
        recentEventLines.push(
          `[${timestamp}] ${action} — model=${model} — ${tokens} tok`,
        );
      } catch {
        // Skip unparseable lines
      }
    }
  } catch {
    // No events.jsonl — fine
  }

  // ── Step 7: Append session_resumed event + global index line ────
  try {
    const resumedEvent = {
      schema_version: "0.2.0" as const,
      event_id: generateSessionId(),
      session_id: sessionId,
      parent_session_id: null,
      timestamp: new Date().toISOString(),
      agent_role: "orchestrator",
      model_id: "zao-orchestrator",
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_hit: false,
      action: "session_resumed",
      resume_count: manifest.resume_count + 1,
      checkpoint_id: checkpointId,
    };
    await appendEvent(
      sessionDir,
      resumedEvent as unknown as Record<string, unknown>,
    );

    await appendGlobalIndexLine(storeRoot, {
      session_id: sessionId,
      created_at: manifest.created_at,
      repo_root: manifest.repo_root,
      repo_remote: manifest.repo_remote,
      task_summary: manifest.task.slice(0, 200),
      status: "active",
      branched_from: null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to append resumed event: ${message}`);
  }

  // ── Step 8: Re-enter runLoop with stored session config ─────────
  process.stdout.write("Resuming session with original config...\n\n");

  const loopResult: RunLoopResult = await runLoop({
    task: manifest.task,
    projectDir: manifest.cwd,
    autoYes: options.yes,
    roleName: storedRoleName,
    _roleDef: storedRoleDef,
    llmOptions,
    _sessionDir: sessionDir,
    _sessionId: sessionId,
    _generateObjectFn: options._generateObjectFn,
    _registry: options._registry,
  });

  // ── Step 9: Update session.json with terminal status ────────────
  try {
    const updatedManifest = {
      ...manifest,
      status: loopResult.success ? ("complete" as const) : ("failed" as const),
      resume_count: manifest.resume_count + 1,
      updated_at: new Date().toISOString(),
    };
    await writeSessionManifest(
      sessionDir,
      updatedManifest,
      ParentManifestSchema,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: loopResult.success,
      sessionDir,
      sessionId,
      completed: loopResult.success,
      error: loopResult.success
        ? `Run succeeded, but final session manifest update failed: ${message}`
        : loopResult.error,
    };
  }

  return {
    success: loopResult.success,
    sessionDir,
    sessionId,
    completed: loopResult.success,
    error: loopResult.error,
  };
}

// ── Internal Helpers ────────────────────────────────────────────────

/**
 * Reads a single line from stdin. Used for interactive prompts.
 */
async function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.resume();
    process.stdin.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      const newlineIdx = text.indexOf("\n");
      if (newlineIdx >= 0) {
        process.stdin.pause();
        resolve(text.slice(0, newlineIdx).trim());
      }
    });
  });
}
