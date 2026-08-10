/**
 * Subagent Delegation — dispatches tasks to isolated subagent contexts.
 *
 * Each call to `delegateToSubagent()`:
 * 1. Resolves the role definition (provided directly by caller)
 * 2. Creates a session — root if standalone, child if `parentSessionDir` set
 * 3. Loads or accepts model configuration
 * 4. Renders the prompt template (substituting {{task}} and {{role}})
 * 5. Builds a completely isolated context (no orchestrator history leak)
 * 6. Calls the LLM with the subagent's role-specific system prompt
 * 7. Validates the response against {@link HandoffResponseSchema}
 * 8. Wraps the result in a `ResultArtifactSchema` envelope with provenance
 *    and writes it to disk, then logs the delegation event
 *
 * The orchestrator's chat history is **NEVER** included in the subagent's
 * context — every delegation is a clean slate. The subagent output is
 * treated as untrusted content and validated against the schema before
 * being returned to the orchestrator.
 *
 * ## ADR-005 compliance
 *
 * - Role definition provided directly by caller — no registry lookup.
 * - Result artifact is always `result.json` (generic filename).
 * - Provenance (role, session_id, model) lives inside the file.
 * - Child sessions created under parent's `agents/<uuidv7>/`.
 * - Every event carries the v0.2.0 envelope.
 *
 * @module delegation
 */

import type { z } from "zod";
import { join, basename } from "node:path";
import type { GenerateObjectFn, ModelOptions } from "./llm.ts";
import { generateStructuredResponse } from "./llm.ts";
import type { StructuredResultSuccess, StructuredResultFailure } from "./llm.ts";
import type { EventLogEntry } from "../schemas/event-log.ts";
import { buildContext } from "./context.ts";
import type { ContextModelConfig, ResumeContext } from "./context.ts";
import { initSession, writeArtifact, appendEvent } from "./artifacts.ts";
import { generateSessionId } from "./ids.ts";
import { HandoffResponseSchema, ResultArtifactSchema } from "../schemas/handoff.ts";
import type { HandoffResponse } from "../schemas/handoff.ts";
import type { ResultArtifact } from "../schemas/handoff.ts";
import type { ResolvedRoleDefinition } from "../schemas/role-definition.ts";
import { renderPromptTemplate } from "../schemas/role-definition.ts";
import { writeSessionManifest } from "./session-store.ts";
import { ChildManifestSchema } from "../schemas/session-manifest.ts";
import type { LlmClient } from "@zao/llm-clients";

// ── Delegation Result Type ─────────────────────────────────────

/**
 * Delegation result — extends the standard structured result with the
 * session directory so callers (and tests) can locate written artifacts
 * deterministically.
 */
export type DelegationResult =
  | (StructuredResultSuccess<HandoffResponse> & { sessionDir: string })
  | StructuredResultFailure;

// ── Constants ──────────────────────────────────────────────────────

/**
 * Default context window size for models that don't specify it.
 * Matches the value used in `loop.ts` for consistency.
 */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Default token warning threshold. A warning is emitted when the
 * estimated prompt token count exceeds this fraction of the model's
 * context window. Matches the value used in `loop.ts`.
 */
const DEFAULT_WARNING_THRESHOLD = 0.65;

/**
 * Generic filename for delegation result artifacts (ADR-005 #7).
 * Provenance (role, model, session_id) lives inside the file.
 */
const RESULT_ARTIFACT_NAME = "result.json";

// ── Core Function ──────────────────────────────────────────────────

/**
 * Delegates a task to a subagent running in an isolated, fresh context.
 *
 * ## Key guarantees
 *
 * - **Fresh context**: The subagent receives **NO** orchestrator chat history.
 *   Each delegation starts with a clean {@link buildContext} using only the
 *   subagent's role, the task string, and optional reference artifacts.
 * - **Schema validation**: The subagent's output is validated against
 *   {@link HandoffResponseSchema} before being returned to the orchestrator.
 *   The output is treated as untrusted — if it fails validation, the LLM
 *   call's own retry logic handles re-prompts within the subagent context.
 * - **Persistent audit trail**: The validated result is wrapped in a
 *   provenance envelope (`{ provenance, result }`) and written to
 *   `result.json` in the session directory. The provenance block records the
 *   subagent role, session ID, model, and delegation timestamp. A delegation
 *   event (with `action: "delegation"`) is also appended to `events.jsonl`
 *   with the full v0.2.0 envelope.
 * - **Never throws**: All failures — I/O errors, LLM call exhaustion,
 *   config loading failures, unknown roles — are returned as
 *   `{ success: false, error: "..." }` result objects.
 *
 * ## Pipeline steps
 *
 * ```
 * resolveRole → initSession (root or child) → loadConfig → renderPromptTemplate →
 *   buildContext (fresh) → generateStructuredResponse →
 *   appendEvent (delegation + LLM events) → writeArtifact → return result
 * ```
 *
 * ## Session creation
 *
 * - **With `parentSessionDir`**: Creates a child session under the parent's
 *   `agents/<uuidv7>/`. The `parent_session_id` points to the caller.
 * - **Without `parentSessionDir`** (standalone/test): Creates a root session
 *   in the global store (`~/.zao/sessions/<uuidv7>/`).
 *
 * ## Model resolution
 *
 * The role's resolved model from the registry takes priority over the
 * `modelConfig` parameter. If the role definition has a model set (not
 * inherited default), it overrides `modelConfig.model`. The provider,
 * apiKey, baseURL, temperature, and maxTokens from `modelConfig` (or
 * the loaded config) are still used for the connection details.
 *
 * @param role - The subagent role name (free string, resolved via registry).
 * @param task - The task description to delegate to the subagent.
 * @param artifacts - Optional file paths to include as reference
 *   context (layer 3 artifacts in the prompt).
 * @param llmClient - Optional pre-resolved LLM client. When omitted,
 *   a default registry is created and the role's `llm_id` is used.
 * @param llmOptions - Optional temperature/maxTokens overrides.
 * @param projectDir - Root of the zao project (where `.zao/` lives).
 *   @default process.cwd()
 * @param _generateObjectFn - **Internal/test-only.** Mock injection
 *   point for deterministic tests. Do not use in production.
 * @param _roleDef - **Internal.** Pre-resolved role definition. When provided,
 *   used directly instead of a registry lookup. The caller (controller) is
 *   responsible for providing the fully resolved role.
 * @param parentSessionDir - **ADR-005.** Absolute path to the parent
 *   session directory. When provided, creates a child session under
 *   `agents/<uuidv7>/`. When omitted, creates a root session.
 * @param nodeId - **ADR-005.** Optional flow graph node identifier.
 * @param resumeContext - Optional resume context (summary + recent events)
 *   injected into the subagent's context for resume mode.
 * @param _format - Output format ("table" | "json"). Threaded to executor
 *   via the call chain (controller → delegateToSubagent → executor → HITLContext).
 *   Not directly consumed in this function body.
 * @param _stepInfo - Current flow step info for session_state in
 *   pending_interaction. Threaded via the call chain (controller → executor →
 *   HITL relay). Not directly consumed in this function body.
 *
 * @returns A `StructuredResult<HandoffResponse>` — success with the
 *          typed handoff response and events, or failure with an error
 *          message and any accumulated events.
 */
export async function delegateToSubagent(
  role: string,
  task: string,
  artifacts: string[] = [],
  llmClient?: LlmClient,
  projectDir: string = process.cwd(),
  llmOptions?: ModelOptions,
  _generateObjectFn?: GenerateObjectFn,
  _roleDef?: ResolvedRoleDefinition,
  parentSessionDir?: string,
  nodeId?: string,
  resumeContext?: ResumeContext,
  _format?: "table" | "json",
  _stepInfo?: {
    currentStep: string;
    stepIndex: number;
    totalSteps: number;
  },
): Promise<DelegationResult> {
  // ── Step 0: Resolve role definition ─────────────────────────
  const resolvedRole: ResolvedRoleDefinition = _roleDef ?? {
    prompt_template:
      "You are a developer agent. Write production-quality code following " +
      "the project's conventions and patterns. Prioritize readability, " +
      "defensive error handling, and comprehensive type safety.",
    context_budget: 0.65,
    model: "deepseek-chat",
    llm_id: "deepseek:deepseek-chat",
    provenance: "built-in",
    model_provenance: "built-in",
  };

  // ── Step 1: Resolve LLM client (TD-033: registry-based) ─────────
  let resolvedClient: LlmClient;
  if (llmClient) {
    resolvedClient = llmClient;
  } else {
    // Fallback: try to create a default registry and resolve the client
    try {
      const registry = await import("@zao/llm-clients").then(
        (m) => m.createDefaultRegistry(),
      );
      resolvedClient = await registry.getClient(resolvedRole.llm_id);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to resolve LLM client: ${message}`,
        events: [] as EventLogEntry[],
      } as StructuredResultFailure;
    }
  }

  // Role-resolved model overrides config model (role model takes priority)
  const effectiveModel = resolvedRole.model;

  // Determine parent_session_id for envelope (before initSession for passing in)
  const parentSessionId = parentSessionDir
    ? (basename(parentSessionDir) ?? null)
    : null;

  // ── Step 2: Initialize session (ADR-005) with resolved model ──────
  let sessionDir: string;
  let sessionId: string;
  let isChild: boolean;
  try {
    const initResult = await initSession({
      role,
      taskSummary: task,
      parentSessionDir,
      parentSessionId: parentSessionId ?? undefined,
      nodeId,
      projectDir,
      modelProvider: resolvedClient.providerId,
      modelId: effectiveModel,
    });
    sessionDir = initResult.sessionDir;
    sessionId = initResult.sessionId;
    isChild = !initResult.isRoot;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to initialize session: ${message}`,
      events: [] as EventLogEntry[],
    } as StructuredResultFailure;
  }

  // ── Step 3: Backfill child manifest model_id (fix #6) ─────────────
  // Fail-closed: an unreadable child manifest means the session is
  // corrupted — the model_id backfill is mandatory state, not best-effort
  // (governance §E3).
  if (isChild) {
    const { readArtifact } = await import("./artifacts.ts");
    const manifestResult = await readArtifact(
      join(sessionDir, "session.json"),
      ChildManifestSchema,
    );
    if (!manifestResult.success) {
      throw new Error(
        `Cannot backfill child manifest model_id: ${manifestResult.error}`,
      );
    }
    const updated = { ...manifestResult.data, model_id: effectiveModel };
    await writeSessionManifest(sessionDir, updated, ChildManifestSchema);
  }

  // ── Step 4: Render prompt template (HIGH-004) ────────────────────
  let renderedPrompt: string;
  try {
    renderedPrompt = renderPromptTemplate(resolvedRole.prompt_template, {
      task,
      role,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to render prompt template: ${message}`,
      events: [] as EventLogEntry[],
    } as StructuredResultFailure;
  }

  // ── Step 4: Build fresh isolated context ────────────────────────
  // CRITICAL: No orchestrator history. This is a clean slate build.
  const contextModelConfig: ContextModelConfig = {
    provider: resolvedClient.providerId,
    model: effectiveModel,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    warningThreshold: DEFAULT_WARNING_THRESHOLD,
  };

  const contextResult = await buildContext({
    roleDef: {
      prompt_template: renderedPrompt,
      context_budget: resolvedRole.context_budget,
      model: effectiveModel,
      provenance: resolvedRole.provenance,
      model_provenance: resolvedRole.model_provenance,
    },
    roleName: role,
    task,
    artifacts,
    modelConfig: contextModelConfig,
    projectRoot: projectDir,
    resumeContext,
  });

  // ── Step 5: Call LLM with registry client (TD-033) ───────────
  const llmResult = await generateStructuredResponse<HandoffResponse>(
    contextResult.context,
    HandoffResponseSchema as z.ZodSchema<HandoffResponse>,
    resolvedClient,
    llmOptions,
    _generateObjectFn,
    role,
  );

  // ── Step 6: Log delegation event with v0.2.0 envelope ───────────
  const delegationEvent = {
    schema_version: "0.2.0" as const,
    event_id: generateSessionId(),
    session_id: sessionId,
    parent_session_id: parentSessionId,
    timestamp: new Date().toISOString(),
    agent_role: role,
    model_id: effectiveModel,
    prompt_tokens: contextResult.estimatedTokens,
    completion_tokens: 0,
    cache_hit: false,
    task_summary: task.slice(0, 500),
    action: "delegation",
  };

  try {
    await appendEvent(
      sessionDir,
      delegationEvent as unknown as Record<string, unknown>,
    );
  } catch {
    // Best-effort: event logging is diagnostic, not critical.
  }

  // Log context warnings (path confinement, redaction, budget truncation)
  for (const warning of contextResult.warnings) {
    try {
      await appendEvent(sessionDir, {
        schema_version: "0.2.0",
        event_id: generateSessionId(),
        session_id: sessionId,
        parent_session_id: parentSessionId,
        timestamp: new Date().toISOString(),
        agent_role: role,
        model_id: effectiveModel,
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_hit: false,
        action: "context_warning",
        warning,
      } as unknown as Record<string, unknown>);
    } catch {
      // Best-effort
    }
  }

  // Append all LLM attempt events with v0.2.0 envelope
  for (const event of llmResult.events) {
    try {
      await appendEvent(sessionDir, {
        ...(event as unknown as Record<string, unknown>),
        schema_version: "0.2.0",
        event_id: generateSessionId(),
        session_id: sessionId,
        parent_session_id: parentSessionId,
        agent_role: role,
      } as unknown as Record<string, unknown>);
    } catch {
      // Best-effort
    }
  }

  // ── Step 7: Check LLM result (bail out early on failure) ─────────
  if (!llmResult.success) {
    // Update child manifest status to "failed" — fail-closed (§E3).
    // If the child manifest cannot be read or validated, the session is
    // corrupted; do not silently drop the status transition.
    if (parentSessionDir) {
      const { readArtifact: ra2 } = await import("./artifacts.ts");
      const mResult = await ra2(join(sessionDir, "session.json"), ChildManifestSchema);
      if (!mResult.success) {
        throw new Error(
          `Cannot update child manifest to failed: ${mResult.error}`,
        );
      }
      await writeSessionManifest(
        sessionDir,
        { ...mResult.data, status: "failed" },
        ChildManifestSchema,
      );
    }
    return llmResult;
  }

  // ── Step 8: Write result artifact with provenance (MED-001: consistent envelope) ──
  const artifactPath = join(sessionDir, RESULT_ARTIFACT_NAME);

  const wrappedResult: ResultArtifact = {
    schema_version: "0.2.0",
    provenance: {
      source: "subagent",
      role,
      session_id: sessionId,
      model: effectiveModel,
      model_provenance: resolvedRole.model_provenance,
      timestamp: new Date().toISOString(),
    },
    result: llmResult.result,
  };

  try {
    await writeArtifact(
      artifactPath,
      JSON.stringify(wrappedResult, null, 2),
      ResultArtifactSchema,
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `LLM call succeeded but failed to write artifact: ${message}`,
      events: llmResult.events,
    };
  }

  // ── Step 9: Update child manifest and agents index (fix #9, #16) ──
  if (parentSessionDir) {
    // Update child manifest: status → "complete" — fail-closed (§E3).
    const { readArtifact: ra3 } = await import("./artifacts.ts");
    const mResult = await ra3(join(sessionDir, "session.json"), ChildManifestSchema);
    if (!mResult.success) {
      throw new Error(
        `Cannot update child manifest to complete: ${mResult.error}`,
      );
    }
    await writeSessionManifest(
      sessionDir,
      { ...mResult.data, status: "complete" },
      ChildManifestSchema,
    );

    // Append completion line to agents/index.jsonl (last-line-wins)
    const { appendAgentsIndexLine } = await import("./session-store.ts");
    await appendAgentsIndexLine(parentSessionDir, {
      session_id: sessionId,
      parent_session_id: parentSessionId!,
      role: role,
      started_at: new Date().toISOString(),
      status: "complete",
    });
  }

  return { ...llmResult, sessionDir };

}

// ── Legacy Compatibility (readers) ──────────────────────────────────

/**
 * Reads a delegation result from a session directory, falling back to
 * the legacy filenames (`delegation_result_${role}.json` and
 * `handoff-response.json`) if the new generic `result.json` is not found.
 *
 * This provides one schema-version window of backward compatibility
 * for reading old session artifacts. New writes always use `result.json`.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param role - The expected subagent role (for legacy filename fallback).
 * @returns The parsed result artifact content, or null if not found.
 */
export async function readDelegationResult(
  sessionDir: string,
  role: string,
): Promise<unknown | null> {
  const { readFile } = await import("node:fs/promises");

  // Try new generic name first
  try {
    const raw = await readFile(join(sessionDir, "result.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    // File not found — try legacy names
  }

  // Legacy fallback: delegation_result_${role}.json
  try {
    const raw = await readFile(
      join(sessionDir, `delegation_result_${role}.json`),
      "utf-8",
    );
    return JSON.parse(raw);
  } catch {
    // File not found — try next legacy name
  }

  // Legacy fallback: handoff-response.json (MED-002)
  try {
    const raw = await readFile(
      join(sessionDir, "handoff-response.json"),
      "utf-8",
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
