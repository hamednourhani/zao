/**
 * Harness API — programmatic single-job entry point (ADR-008).
 *
 * Exposes a clean `runJob()` function that accepts typed input and returns
 * typed output. Internally delegates to the core {@link runLoop} function.
 * The caller (controller) never imports harness internals — this is the
 * single API boundary.
 *
 * ## Design (ADR-008)
 *
 * - Input validated with Zod (fail fast on bad input).
 * - Never throws across the API boundary — all errors returned as output.
 * - Internally uses `runLoop` from `../core/loop.ts`.
 * - Maps the input role to a resolved role definition.
 * - For subprocess mode (future): accept JSON on stdin, emit JSON on stdout.
 *
 * ## ADR-009 (TD-033)
 *
 * - Role input uses `llm_id` instead of `model_config`.
 * - Credentials are loaded via `@zao/llm-clients` registry, never from the
 *   old `.zao/config.yaml` provider fields.
 *
 * @module run-job
 */

import { z } from "zod";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { runLoop } from "../core/loop.ts";
import type { RunLoopParams, RunLoopResult } from "../core/loop.ts";
import type { GenerateObjectFn, ModelOptions } from "../core/llm.ts";
import type { ResolvedRoleDefinition } from "../schemas/role-definition.ts";
import { SessionConfigSchema } from "../schemas/session-config.ts";
import { findSessionDir, resolveStoreRoot } from "../core/session-store.ts";
import type { LlmClientRegistry } from "@zao/llm-clients";

// ── Zod Schemas ──────────────────────────────────────────────────────

/**
 * Schema for a single tool declaration in the tools array (R-009).
 */
const ToolDeclarationSchema = z
  .object({
    tool: z.enum(["readFile", "writeFile", "executeShell", "delegateToSubagent"]),
    scope: z.literal("agent_decides"),
    requires_approval: z.boolean().optional(),
  })
  .strict();

/**
 * Schema for the role definition within a RunJobInput.
 * Uses `llm_id` (TD-033) instead of the old `model_config`.
 */
const RoleInputSchema = z
  .object({
    role_id: z.string().min(1),
    description: z.string().min(1),
    prompt_template: z.string().optional(),
    llm_id: z.string().min(1).optional(),
  })
  .strict();

/**
 * Schema for the config block within a RunJobInput.
 */
const ConfigSchema = z
  .object({
    auto_yes: z.boolean().optional(),
    format: z.enum(["table", "json"]).optional(),
  })
  .strict()
  .optional();

/**
 * Schema for the resume_context block within a RunJobInput.
 */
const ResumeContextSchema = z
  .object({
    recent_events: z.number().int().positive().optional(),
    summary: z.string().optional(),
  })
  .strict()
  .nullable()
  .optional();

/**
 * Schema for the full RunJobInput per ADR-008.
 * Validated before any LLM work begins.
 */
const RunJobInputSchema = z
  .object({
    request_id: z.string().optional(),
    execution_id: z.string().optional(),
    session_id: z.string().nullable().optional(),
    role: RoleInputSchema,
    task: z.string().min(1),
    project_dir: z.string().min(1),
    config: ConfigSchema,
    resume_context: ResumeContextSchema,
    artifacts: z.array(z.string()).optional(),
    /** Optional tool declarations for this step (R-009). */
    tools: z.array(ToolDeclarationSchema).max(5).optional(),
    // Internal test injection only — not part of public API contract
    _generateObjectFn: z.function().optional(),
    _registry: z.unknown().optional(),
  })
  .strict();

export type RunJobInput = z.infer<typeof RunJobInputSchema>;

// ── Output Types ─────────────────────────────────────────────────────

export interface RunJobOutput {
  success: boolean;
  session_id: string;
  session_dir: string;
  result?: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  error?: string;
  is_validation_error?: boolean;
}

// ── Internal Helpers ─────────────────────────────────────────────────

/**
 * Maps a `RunJobInput` to a `RunLoopParams` that the core loop can consume.
 *
 * ## ADR-009 (TD-033)
 *
 * The role's `llm_id` is used for registry lookup. The `model_config` field
 * has been removed — the registry owns provider/model mapping.
 *
 * When `session_id` is non-null, the session directory is resolved and the
 * session-config.json is read to extract the stored role and llm_id, enabling
 * resume of the existing session.
 *
 * @param input - The validated RunJobInput.
 * @returns A RunLoopParams object ready for runLoop.
 */
async function inputToLoopParams(input: RunJobInput): Promise<RunLoopParams> {
  const llmOptions: ModelOptions = {};

  // ── Resume path: session_id is non-null ────────────────────────
  if (input.session_id) {
    const storeRoot = await resolveStoreRoot();
    const sessionDir = await findSessionDir(storeRoot, input.session_id);
    if (!sessionDir) {
      throw new Error(
        `Session "${input.session_id}" not found in global store.`,
      );
    }

    let configRaw: string;
    try {
      configRaw = await readFile(
        join(sessionDir, "session-config.json"),
        "utf-8",
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot read session config for "${input.session_id}": ${message}`,
      );
    }

    const config = JSON.parse(configRaw);
    const validationResult = SessionConfigSchema.safeParse(config);
    if (!validationResult.success) {
      throw new Error(
        `Session config validation failed: ${validationResult.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }

    const parsed = validationResult.data;
    const storedRoleDef = parsed.resolved_role as ResolvedRoleDefinition;

    return {
      task: input.task,
      projectDir: input.project_dir,
      autoYes: input.config?.auto_yes ?? false,
      roleName: parsed.role_name,
      _roleDef: storedRoleDef,
      _sessionDir: sessionDir,
      _sessionId: input.session_id,
      llmOptions: { ...llmOptions, temperature: parsed.temperature },
      _generateObjectFn: input._generateObjectFn as GenerateObjectFn | undefined,
      _registry: input._registry as LlmClientRegistry | undefined,
      tools: input.tools, // R-009: forward tool declarations to runLoop
    };
  }

  // ── New session path (session_id is null or absent) ────────────

  // Construct a resolved role definition from the API input.
  // The controller provides the full role definition; the harness
  // no longer resolves roles from a registry.
  const roleDef: ResolvedRoleDefinition = {
    prompt_template:
      input.role.prompt_template ??
      `${input.role.description}\n\nTask: {{task}}`,
    context_budget: 0.65,
    model: "deepseek-chat",
    llm_id: input.role.llm_id ?? "deepseek:deepseek-chat",
    provenance: "api",
    model_provenance: "api",
  };

  return {
    task: input.task,
    projectDir: input.project_dir,
    autoYes: input.config?.auto_yes ?? false,
    roleName: input.role.role_id,
    _roleDef: roleDef,
    llmOptions,
    _generateObjectFn: input._generateObjectFn as GenerateObjectFn | undefined,
    _registry: input._registry as LlmClientRegistry | undefined,
    tools: input.tools, // R-009: forward tool declarations to runLoop
  };
}

/**
 * Maps a `RunLoopResult` from the core loop into the ADR-008 `RunJobOutput`
 * envelope. Reads actual session artifacts (result.json, events.jsonl) from
 * the session directory so the controller gets real data, not placeholders.
 *
 * @param loopResult - The result from runLoop.
 * @returns A RunJobOutput with the standardized envelope.
 */
async function loopResultToOutput(loopResult: RunLoopResult): Promise<RunJobOutput> {
  // Read result.json from the session directory
  let result: Record<string, unknown> | undefined;
  if (loopResult.success && loopResult.sessionDir) {
    try {
      const resultRaw = await readFile(
        join(loopResult.sessionDir, "result.json"),
        "utf-8",
      );
      result = JSON.parse(resultRaw) as Record<string, unknown>;
    } catch {
      // If result.json is missing or unreadable, we still return success
      // but with a minimal result envelope
      result = { summary: "Job completed (result.json unreadable)" };
    }
  }

  // Read events.jsonl from the session directory
  const events: Array<Record<string, unknown>> = [];
  if (loopResult.sessionDir) {
    try {
      const eventsRaw = await readFile(
        join(loopResult.sessionDir, "events.jsonl"),
        "utf-8",
      );
      for (const line of eventsRaw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          // Skip unparseable lines
        }
      }
    } catch {
      // No events.jsonl or unreadable — return empty events array
    }
  }

  return {
    success: loopResult.success,
    session_id: loopResult.sessionId,
    session_dir: loopResult.sessionDir,
    result,
    events,
    error: loopResult.error,
    is_validation_error: false,
  };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Runs a single job through the zao harness.
 *
 * This is the programmatic entry point that the controller calls to
 * execute individual steps. Internally it delegates to the core
 * {@link runLoop} function.
 *
 * ## Input validation
 *
 * The input is validated against {@link RunJobInputSchema} BEFORE any
 * harness work begins. Bad input returns a failure result with
 * `is_validation_error: true` — no LLM calls are made.
 *
 * ## Error handling
 *
 * This function **never throws**. All errors (validation, config load,
 * LLM call, I/O) are captured and returned in the {@link RunJobOutput}
 * envelope.
 *
 * ## ADR-009 (TD-033)
 *
 * The `llm_id` field replaces the old `model_config`. Credentials are
 * loaded via `@zao/llm-clients` registry. No `apiKey` crosses the
 * controller-harness boundary.
 *
 * @param input - The job specification per ADR-008.
 * @returns A {@link RunJobOutput} with success status, session info, and events.
 */
export async function runJob(input: unknown): Promise<RunJobOutput> {
  // ── Validate input BEFORE any work (fail fast) ──────────────────
  let validated: RunJobInput;
  try {
    const result = RunJobInputSchema.safeParse(input);
    if (!result.success) {
      return {
        success: false,
        session_id: "",
        session_dir: "",
        error: `Validation error: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        events: [],
        is_validation_error: true,
      };
    }
    validated = result.data;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      session_id: "",
      session_dir: "",
      error: `Input validation failed: ${message}`,
      events: [],
      is_validation_error: true,
    };
  }

  // ── Map input to loop params ────────────────────────────────────
  let loopParams: RunLoopParams;
  try {
    loopParams = await inputToLoopParams(validated);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      session_id: validated.session_id ?? "",
      session_dir: "",
      error: `Resume failed: ${message}`,
      events: [],
      is_validation_error: true,
    };
  }

  // ── Execute via the core runLoop ────────────────────────────────
  try {
    const loopResult = await runLoop(loopParams);
    return await loopResultToOutput(loopResult);
  } catch (error: unknown) {
    // Catch any unexpected throws (shouldn't happen — runLoop never throws)
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      session_id: "",
      session_dir: "",
      error: `Unexpected error in runLoop: ${message}`,
      events: [],
    };
  }
}
