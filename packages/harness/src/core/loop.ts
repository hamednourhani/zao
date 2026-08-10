/**
 * The core run loop — mo's single-job execution pipeline.
 *
 * Wires together the full pipeline from Story 002–005:
 *
 * ```
 * (registry or defaultRegistry) → initSession → renderPromptTemplate →
 *   buildContext → generateStructuredResponse → appendEvent → writeArtifact → return result
 * ```
 *
 * ## ADR-005 compliance
 *
 * - Role definition provided directly by the caller (controller or CLI).
 *   No registry lookup — the harness no longer resolves roles from config.
 * - Output artifact is `result.json` (generic filename per ADR-005 #7).
 * - Result artifact uses the `ResultArtifactSchema` envelope with provenance.
 * - Sessions created in global store (`~/.zao/sessions/<uuidv7>/`).
 * - Every event carries the v0.2.0 envelope (`event_id`, `session_id`,
 *   `parent_session_id`).
 * - Completion line appended to global index at run end.
 *
 * ## ADR-009 — LLM Client Registry (TD-033)
 *
 * - Provider credentials are owned by `@zao/llm-clients`. The harness never
 *   reads `api_key` from config files.
 * - The `llm_id` field in the resolved role is used for registry lookup.
 * - A default registry is created if none is provided.
 *
 * ## Single-job identity (TD-029-F)
 *
 * The harness is now a pure single-job executor. Flow/orchestration logic
 * has moved to the controller (ADR-006). `runLoop` executes exactly one
 * task with one role per invocation.
 *
 * @module loop
 */

import { z } from "zod";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { GenerateObjectFn } from "./llm.ts";
import { generateStructuredResponse } from "./llm.ts";
import type { ModelOptions } from "./llm.ts";
import { buildContext } from "./context.ts";
import type { ContextModelConfig, BuildContextResult } from "./context.ts";
import { initSession, writeArtifact, appendEvent } from "./artifacts.ts";
import { generateSessionId } from "./ids.ts";
import { HandoffResponseSchema, ResultArtifactSchema } from "../schemas/handoff.ts";
import type { HandoffResponse } from "../schemas/handoff.ts";
import type { ResultArtifact } from "../schemas/handoff.ts";
import { loadConfig } from "./config.ts";
import type { ResolvedRoleDefinition } from "../schemas/role-definition.ts";
import { renderPromptTemplate } from "../schemas/role-definition.ts";
import {
  resolveStoreRoot,
  appendGlobalIndexLine,
  writeSessionManifest,
} from "./session-store.ts";
import { ParentManifestSchema } from "../schemas/session-manifest.ts";
import { SessionConfigSchema } from "../schemas/session-config.ts";
import type { LlmClientRegistry, LlmClient } from "@zao/llm-clients";
import {
  createDefaultRegistry,
} from "@zao/llm-clients";
import { runToolLoop } from "./tool-loop.ts";
import type { HandoffWithTools } from "../schemas/tool-call.ts";
import type { ToolDeclaration } from "../schemas/flow.ts";
import { logger } from "./logger.ts";
import { progress } from "./progress.ts";
import { resolveContextWindow, supportsCaching } from "./model-registry.ts";
import {
  ContextCompactionNeeded,
  runCompactionFlow,
  type CompactionHITLDetails,
} from "./compaction.ts";

// ── Type Definitions ───────────────────────────────────────────────

/** Parameters for the {@link runLoop} function. */
export interface RunLoopParams {
  /** The task / objective description to execute. */
  task: string;
  /**
   * Project root directory (where `.zao/` lives).
   * @default process.cwd()
   */
  projectDir?: string;
  /**
   * Optional override for LLM generation options (temperature, maxTokens).
   * When omitted, defaults from `.zao/config.yaml` are used.
   */
  llmOptions?: ModelOptions;
  /**
   * Whether `--yes` flag is active (auto-approves Tier 2 actions).
   * Threaded through the pipeline for HITL permission decisions.
   */
  autoYes?: boolean;
  /**
   * The agent role name for display and logging purposes.
   * Used for the session manifest, event logging, and context building.
   * This is a label only — the actual role definition comes from {@link _roleDef}.
   */
  roleName: string;
  /**
   * **REQUIRED for production.** The fully resolved role definition to use.
   * When provided, the harness uses this role directly without any registry
   * lookup. The caller (controller or CLI) is responsible for providing
   * the role definition.
   *
   * When omitted for backward compat (tests only), a minimal developer role
   * default is used.
   */
  _roleDef?: ResolvedRoleDefinition;
  /**
   * **Internal/test-only.** Allows injecting a mock `generateObject`
   * implementation for deterministic tests. Do not use in production.
   */
  _generateObjectFn?: GenerateObjectFn;
  /**
   * **Internal.** Provide an existing session directory to resume into.
   * When set, `initSession` is skipped and the harness writes to the
   * existing session directory.
   */
  _sessionDir?: string;
  /**
   * **Internal.** Provide an existing session id to resume into.
   * Must be paired with {@link _sessionDir}.
   */
  _sessionId?: string;
  /**
   * **Internal/test-only.** Inject a registry for testing.
   * When omitted, `createDefaultRegistry()` is called.
   */
  _registry?: LlmClientRegistry;
  /**
   * Optional tool declarations for this step (R-009 / R-012).
   * Each tool declares a capability the agent may use at runtime.
   * When present, the multi-turn tool execution loop is used instead
   * of the single-call path. Backwards compatible: steps without tools
   * use the existing single-call flow.
   */
  tools?: ToolDeclaration[];
}

/** The result of a {@link runLoop} execution. */
export interface RunLoopResult {
  /** Whether the LLM call produced a valid, schema-compliant result. */
  success: boolean;
  /** Absolute path to the session directory under `~/.zao/sessions/<id>/`. */
  sessionDir: string;
  /** UUIDv7 session identifier. */
  sessionId: string;
  /**
   * Absolute path to the output artifact (result), written
   * only on success. `undefined` on failure.
   */
  artifactPath?: string;
  /** Error message, populated only when `success` is `false`. */
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────────

/** Default token warning threshold. */
const DEFAULT_WARNING_THRESHOLD = 0.65;

/**
 * Generic filename for output artifacts (ADR-005 #7).
 * Provenance lives inside the file, not in the filename.
 */
const OUTPUT_ARTIFACT_NAME = "result.json";

// ── Core Function ──────────────────────────────────────────────────

/**
 * Executes a single pass of the mo harness pipeline for a given task.
 *
 * ## Pipeline steps
 *
 * 1. **Load config** — Reads `.zao/config.yaml` for non-credential settings
 *    (temperature, maxTokens).
 * 2. **Resolve role** — Uses the `_roleDef` provided by the caller directly.
 * 3. **Init session** — Creates `~/.zao/sessions/<uuidv7>/` in the global
 *    store (skip if `_sessionDir` is provided for resume).
 * 4. **Get LLM client** — Resolves `llm_id` from role via the registry.
 * 5. **Render prompt template** — Substitutes `{{task}}` and `{{role}}`
 *    variables in the role's prompt template.
 * 6. **Write session config** — Writes an immutable `session-config.json`
 *    snapshot (role, llm_id, temperature — no credentials per ADR-009).
 * 7. **Build context** — Assembles the LLM prompt (system + guardrails + task).
 * 8. **Call LLM** — Generates a structured `HandoffResponse` via
 *    {@link generateStructuredResponse} using the resolved client.
 * 9. **Log events** — Appends LLM attempt events to `events.jsonl`.
 * 10. **Check result** — If the LLM call failed, bails out early.
 * 11. **Write artifact** — On success, persists the response as `result.json`.
 * 12. **Append completion line** — Writes a completion index line.
 * 13. **Return result** — Returns a {@link RunLoopResult} (never throws).
 *
 * @param params - Task, role definition, optional registry/options override.
 * @returns A {@link RunLoopResult} with success status and session info.
 */
export async function runLoop(
  params: RunLoopParams,
): Promise<RunLoopResult> {
  const projectDir = params.projectDir ?? process.cwd();
  const roleName = params.roleName;

  // Resolve role definition: use provided _roleDef, or fall back to
  // a minimal built-in developer role (backward compat / tests).
  const resolvedRole: ResolvedRoleDefinition = params._roleDef ?? {
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

  // ── Step 1: Load configuration (non-credential settings) ─────────
  const loopConfig = await loadConfig(projectDir);
  const generationOptions: ModelOptions = {
    temperature: params.llmOptions?.temperature ?? loopConfig.temperature,
    maxTokens: params.llmOptions?.maxTokens ?? loopConfig.maxTokens,
  };

  // ── Step 1c: Enable prompt caching when the model supports it ─
  // Prompt caching reuses the stable prefix (Layer 1: system prompt +
  // role identity) across requests, reducing latency and cost. The
  // cache flag is a no-op for unsupported models.
  //
  // Moved before Step 1b because llmClient is not yet resolved —
  // we use the role's llm_id to extract provider/model before the
  // registry lookup. This avoids a chicken-and-egg: we need the
  // cache flag set BEFORE generateStructuredResponse is called.
  {
    const colonIdx = resolvedRole.llm_id.indexOf(":");
    if (colonIdx >= 0) {
      const provider = resolvedRole.llm_id.slice(0, colonIdx);
      const model = resolvedRole.llm_id.slice(colonIdx + 1);
      if (supportsCaching(provider, model)) {
        generationOptions.cache = true;
      }
    }
  }

  // ── Step 1b: Resolve LLM client via registry (ADR-009) ───────────
  let registry: LlmClientRegistry;
  if (params._registry) {
    registry = params._registry;
  } else {
    try {
      registry = await createDefaultRegistry();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        sessionDir: "",
        sessionId: "",
        error: `Failed to load LLM providers config: ${message}`,
      };
    }
  }

  let llmClient: LlmClient;
  try {
    llmClient = await registry.getClient(resolvedRole.llm_id);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      sessionDir: "",
      sessionId: "",
      error: `Failed to resolve LLM client for "${resolvedRole.llm_id}": ${message}`,
    };
  }

  // ── Step 2: Initialize session (or reuse existing for resume) ──
  const effectiveModel = resolvedRole.model;
  let sessionDir: string;
  let sessionId: string;
  let isNewSession = false;
  if (params._sessionDir && params._sessionId) {
    // Resume mode: use existing session directory
    sessionDir = params._sessionDir;
    sessionId = params._sessionId;
  } else {
    try {
      const initResult = await initSession({
        role: roleName,
        taskSummary: params.task,
        projectDir,
        modelProvider: llmClient.providerId,
        modelId: effectiveModel,
      });
      sessionDir = initResult.sessionDir;
      sessionId = initResult.sessionId;
      isNewSession = true;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        sessionDir: "",
        sessionId: "",
        error: `Failed to initialize session: ${message}`,
      };
    }
  }

  // ── Step 2b: Write immutable session config (new sessions only) ──
  // Written exactly once, at session start, before any model calls.
  // This is the immutable session config — never overwritten.
  // SECURITY: ADR-009 — no credential fields in session files.
  if (isNewSession) {
    const sessionConfig = {
      schema_version: "1.0" as const,
      role_name: roleName,
      resolved_role: resolvedRole,
      llm_id: resolvedRole.llm_id,
      temperature: generationOptions.temperature ?? 0.1,
      created_at: new Date().toISOString(),
      model_id: effectiveModel,
    };

    // Validate BEFORE writing — fail-closed (§E2)
    const validationResult = SessionConfigSchema.safeParse(sessionConfig);
    if (!validationResult.success) {
      return {
        success: false,
        sessionDir,
        sessionId,
        error: `Session config validation failed: ${validationResult.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      };
    }

    try {
      await writeFile(
        join(sessionDir, "session-config.json"),
        JSON.stringify(validationResult.data, null, 2),
        { encoding: "utf-8", flag: "wx", mode: 0o600 },
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        sessionDir,
        sessionId,
        error: `Failed to write session config: ${message}`,
      };
    }
  }

  // ── Step 3: Render prompt template (HIGH-004) ──────────────────
  let renderedPrompt: string;
  try {
    renderedPrompt = renderPromptTemplate(resolvedRole.prompt_template, {
      task: params.task,
      role: roleName,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      sessionDir,
      sessionId,
      error: `Failed to render prompt template: ${message}`,
    };
  }

  // ── R-009: Append tool declarations to prompt if present ──────
  if (params.tools && params.tools.length > 0) {
    const toolList = params.tools
      .map((t) => `- ${t.tool} (scope: ${t.scope}${t.requires_approval ? ", requires approval" : ""})`)
      .join("\n");
    renderedPrompt = `${renderedPrompt}\n\n## Available Tools\n\nYou may use the following tools during this task:\n\n${toolList}\n\nInstructions:\n- Use these tools to read files, write code, execute safe commands, or delegate to subagents.\n- For each tool call, explain WHY you are using it.\n- All file paths must be within the project root.`;
  }

  // ── Step 4: Build context ─────────────────────────────────────
  // TD-010-D: Use registry to resolve context window instead of hardcoding
  const resolvedWindow = resolveContextWindow(
    llmClient.providerId,
    effectiveModel,
    loopConfig.contextWindow,
  );
  const contextModelConfig: ContextModelConfig = {
    provider: llmClient.providerId,
    model: effectiveModel,
    contextWindow: resolvedWindow.contextWindow,
    warningThreshold: DEFAULT_WARNING_THRESHOLD,
    compactionThreshold: loopConfig.compactionThreshold,
  };

  let contextResult: BuildContextResult;
  try {
    contextResult = await buildContext({
      roleDef: {
        prompt_template: renderedPrompt,
        context_budget: resolvedRole.context_budget,
        model: effectiveModel,
        provenance: resolvedRole.provenance,
        model_provenance: resolvedRole.model_provenance,
      },
      roleName,
      task: params.task,
      modelConfig: contextModelConfig,
      projectRoot: projectDir,
    });
  } catch (err) {
    if (err instanceof ContextCompactionNeeded) {
      // ── Compaction flow (TD-010-C) ───────────────────────────────
      logger.info(
        `Context compaction triggered: ${err.estimatedTokens} tokens > ` +
        `${Math.round(err.threshold * 100)}% of ${err.contextWindow}`,
      );

      // Resolve compactor client
      let compactorClient: LlmClient;
      try {
        const compactorLlmId = loopConfig.compactorProvider && loopConfig.compactorModel
          ? `${loopConfig.compactorProvider}:${loopConfig.compactorModel}`
          : resolvedRole.llm_id;
        compactorClient = await registry.getClient(compactorLlmId);
      } catch (compactorErr: unknown) {
        const msg = compactorErr instanceof Error ? compactorErr.message : String(compactorErr);
        return {
          success: false,
          sessionDir,
          sessionId,
          error: `Compaction failed: could not resolve compactor client: ${msg}`,
        };
      }

      const compactionResult = await runCompactionFlow({
        sessionDir,
        sessionId,
        eventsJsonl: "",
        currentContext: renderedPrompt,
        task: params.task,
        roleName,
        modelConfig: contextModelConfig,
        estimatedTokens: err.estimatedTokens,
        generateCompactor: async (prompt: string) => {
          const CompactorResponseSchema = z.object({
            summary: z.string(),
          });
          const result = await generateStructuredResponse(
            prompt,
            CompactorResponseSchema,
            compactorClient,
            { temperature: 0.1 },
          );
          if (!result.success) {
            return { success: false, error: result.error ?? "Compactor LLM call failed" };
          }
          return {
            success: true,
            result: {
              summary: result.result.summary,
            },
          };
        },
        promptForCompactionHITL: async (step: "pre" | "post", details: CompactionHITLDetails) => {
          // Log the HITL prompt details (the actual HITL UI is handled
          // via the existing promptForPermission or a simple console prompt).
          if (step === "pre") {
            logger.info(
              `\n⚠ CONTEXT COMPACTION NEEDED\n` +
              `  Estimated tokens: ${err.estimatedTokens}\n` +
              `  Model window: ${details.contextWindow} tokens\n` +
              `  Threshold: ${Math.round(details.threshold * 100)}%\n` +
              `  Compaction is lossy — some conversation detail will be lost.\n`,
            );
          } else {
            logger.info(
              `\nCompaction complete. Summary written to ${details.summaryPath ?? "summary.md"}\n` +
              `  Tokens after compaction: ~${details.tokensAfter ?? "?"}\n` +
              (details.promptPreview
                ? `  Preview:\n${details.promptPreview.slice(0, 500)}\n`
                : ""),
            );
          }

          // Use the existing promptForPermission for the HITL gate
          // or fall back to a simple console prompt
          const { promptForPermission: hitlPrompt, PermissionSession: PS, HITLResponse: HR } = await import("./hitl.ts");
          const { TrustTier: TT } = await import("./command-guard.ts");

          const hitlResult = await hitlPrompt({
            actionType: "compaction",
            command: step === "pre"
              ? "Approve lossy context compaction?"
              : "Approve resuming with compacted context?",
            explanation: step === "pre"
              ? `Context is at ${err.estimatedTokens} tokens (${Math.round(details.threshold * 100)}% of ${details.contextWindow}). Compaction will summarize the conversation, which is lossy.`
              : `Compacted context ready. Estimated tokens after: ~${details.tokensAfter ?? "unknown"}. Summary written to ${details.summaryPath ?? "summary.md"}. Resume execution?`,
            verdict: {
              tier: TT.Tier1,
              blocked: null,
              reasons: [
                step === "pre"
                  ? "Context exceeds compaction threshold"
                  : "Compacted context requires human approval to resume",
              ],
            },
            session: new PS(),
            autoYes: false, // --yes does NOT auto-approve compaction
          });

          return hitlResult.response === HR.Approve;
        },
      });

      if (!compactionResult.resumed) {
        // Update manifest status to awaiting_hitl
        // Fail-closed (§E3): manifest read/write failure must throw.
        const { readArtifact: ra } = await import("./artifacts.ts");
        const mResult = await ra(join(sessionDir, "session.json"), ParentManifestSchema);
        if (!mResult.success) {
          throw new Error(
            `Cannot update manifest to awaiting_hitl: ${mResult.error}`,
          );
        }
        await writeSessionManifest(
          sessionDir,
          { ...mResult.data, status: "awaiting_hitl", updated_at: new Date().toISOString() },
          ParentManifestSchema,
        );

        return {
          success: false,
          sessionDir,
          sessionId,
          error: compactionResult.error ?? "compaction_denied",
        };
      }

      // Retry buildContext with the compacted summary as resume context.
      // Wrap in try/catch: if compaction didn't reduce tokens enough,
      // the second buildContext() throws ContextCompactionNeeded again.
      // Catch it and return a graceful error instead of crashing.
      try {
        contextResult = await buildContext({
          roleDef: {
            prompt_template: renderedPrompt,
            context_budget: resolvedRole.context_budget,
            model: effectiveModel,
            provenance: resolvedRole.provenance,
            model_provenance: resolvedRole.model_provenance,
          },
          roleName,
          task: params.task,
          modelConfig: contextModelConfig,
          projectRoot: projectDir,
          resumeContext: {
            summary: compactionResult.summary,
            recentEvents: [
              `Context compaction performed at ${new Date().toISOString()}`,
              `Original estimated tokens: ${err.estimatedTokens}`,
              `Compacted summary: ${compactionResult.summary ? compactionResult.summary.slice(0, 200) + "..." : "N/A"}`,
            ],
          },
        });
      } catch (retryErr) {
        if (retryErr instanceof ContextCompactionNeeded) {
          return {
            success: false,
            sessionDir,
            sessionId,
            error: "compaction_failed: compaction did not reduce context enough",
          };
        }
        throw retryErr; // re-throw unknown errors
      }
    } else {
      throw err; // re-throw unknown errors
    }
  }

  // ── Step 7: Call LLM via the registry client (ADR-009) ──────────
  // R-012: When tools are present, use the multi-turn tool execution loop.
  // Otherwise, use the existing single-call path (backwards compatible).

  progress.start({
    step: 1,
    totalSteps: 1,
    role: roleName,
    model: effectiveModel,
    sessionId,
    phase: "thinking",
  });

  let llmSuccess: boolean;
  let llmError: string | undefined;
  let llmEvents: Array<Record<string, unknown>>;
  let finalResult: HandoffResponse | undefined;

  if (params.tools && params.tools.length > 0) {
    // ── Tool path: multi-turn tool execution loop (R-012) ───────────
    const toolLoopResult = await runToolLoop({
      prompt: contextResult.context,
      projectRoot: projectDir,
      sessionDir,
      sessionId,
      tools: params.tools,
      llmClient,
      options: generationOptions,
      _generateObjectFn: params._generateObjectFn,
      agentRole: roleName,
    });

    llmSuccess = toolLoopResult.success;
    llmError = toolLoopResult.error;
    // Cast tool-loop events to match the single-call event shape used below
    llmEvents = toolLoopResult.events as unknown as Array<Record<string, unknown>>;

    if (toolLoopResult.success && toolLoopResult.result) {
      const tr = toolLoopResult.result as HandoffWithTools;
      if (tr.type === "final") {
        // Convert HandoffWithTools "final" variant to HandoffResponse-compatible shape
        finalResult = {
          schema_version: "0.1.0" as const,
          status: tr.status,
          summary: tr.summary,
          changes: tr.changes ?? [],
        };
      } else {
        // runToolLoop should never return success with a non-final result
        llmSuccess = false;
        llmError = "Tool loop returned non-final result";
      }
    }
  } else {
    // ── No tools: existing single-call path (backwards compatible) ──
    const llmResult = await generateStructuredResponse<HandoffResponse>(
      contextResult.context,
      HandoffResponseSchema as z.ZodSchema<HandoffResponse>,
      llmClient,
      generationOptions,
      params._generateObjectFn,
      roleName,
    );

    llmSuccess = llmResult.success;
    llmError = llmResult.success ? undefined : llmResult.error;
    llmEvents = llmResult.events as unknown as Array<Record<string, unknown>>;
    finalResult = llmResult.success ? llmResult.result : undefined;
  }

  progress.update({ phase: "writing" });

  // ── Step 8: Log events with v0.2.0 envelope ─────────────────────
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (const event of llmEvents) {
    try {
      // Track token usage for completion line
      const promptTokens =
        typeof event["prompt_tokens"] === "number"
          ? event["prompt_tokens"]
          : 0;
      const completionTokens =
        typeof event["completion_tokens"] === "number"
          ? event["completion_tokens"]
          : 0;
      totalPromptTokens += promptTokens;
      totalCompletionTokens += completionTokens;

      await appendEvent(sessionDir, {
        ...(event as unknown as Record<string, unknown>),
        event_id: generateSessionId(),
        session_id: sessionId,
        parent_session_id: null,
        agent_role: roleName,
        schema_version: "0.2.0",
      } as unknown as Record<string, unknown>);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.warn(
        `Failed to append event to ${sessionDir}/events.jsonl: ${message}`,
      );
    }
  }

  // ── Step 9: Check result (bail out early on failure) ───────────────
  if (!llmSuccess) {
    // Update manifest status — fail-closed (§E3). The failure transition
    // is mandatory; an unreadable manifest means the session is corrupted.
    const { readArtifact } = await import("./artifacts.ts");
    const mResult = await readArtifact(join(sessionDir, "session.json"), ParentManifestSchema);
    if (!mResult.success) {
      throw new Error(
        `Cannot update manifest to failed: ${mResult.error}`,
      );
    }
    await writeSessionManifest(
      sessionDir,
      { ...mResult.data, status: "failed", updated_at: new Date().toISOString() },
      ParentManifestSchema,
    );

    // Append completion line with failure status
    try {
      const storeRoot = await resolveStoreRoot();
      // TODO: TD-011/TD-013 — compute agents_spawned from agents/index.jsonl line count
      await appendGlobalIndexLine(storeRoot, {
        session_id: sessionId,
        completed_at: new Date().toISOString(),
        status: "failed",
        agents_spawned: 0,
        models: [effectiveModel],
        tokens: {
          prompt: totalPromptTokens,
          completion: totalCompletionTokens,
        },
      });
    } catch {
      // Best-effort: index update is diagnostic
    }

    progress.stop();
    return {
      success: false,
      sessionDir,
      sessionId,
      error: llmError,
    };
  }

  // ── Step 10: Write output artifact (MED-001: consistent envelope) ──
  const artifactPath = join(sessionDir, OUTPUT_ARTIFACT_NAME);
  try {
    // MED-001: Use ResultArtifactSchema envelope — same shape as delegation
    const wrappedResult: ResultArtifact = {
      schema_version: "0.2.0",
      provenance: {
        source: "orchestrator",
        role: roleName,
        session_id: sessionId,
        model: effectiveModel,
        model_provenance: resolvedRole.model_provenance,
        timestamp: new Date().toISOString(),
      },
      result: finalResult!,
    };

    await writeArtifact(
      artifactPath,
      JSON.stringify(wrappedResult, null, 2),
      ResultArtifactSchema,
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);

    // Update manifest status on artifact write failure — fail-closed (§E3).
    const { readArtifact: ra } = await import("./artifacts.ts");
    const mResult = await ra(join(sessionDir, "session.json"), ParentManifestSchema);
    if (!mResult.success) {
      throw new Error(
        `Cannot update manifest to failed after artifact write failure: ${mResult.error}`,
      );
    }
    await writeSessionManifest(
      sessionDir,
      { ...mResult.data, status: "failed", updated_at: new Date().toISOString() },
      ParentManifestSchema,
    );

    // Still write completion line for the failure
    try {
      const storeRoot = await resolveStoreRoot();
      await appendGlobalIndexLine(storeRoot, {
        session_id: sessionId,
        completed_at: new Date().toISOString(),
        status: "failed",
        agents_spawned: 0,
        models: [effectiveModel],
        tokens: {
          prompt: totalPromptTokens,
          completion: totalCompletionTokens,
        },
      });
    } catch {
      // Best-effort
    }

    progress.stop();

    return {
      success: false,
      sessionDir,
      sessionId,
      artifactPath,
      error: `LLM call succeeded but failed to write artifact: ${message}`,
    };
  }

  // ── Step 11: Update manifest and append completion line ──────────
  // Fail-closed (§E3): the manifest status transition is mandatory. If the
  // manifest cannot be read or validated, throw at the mutation line so the
  // session cannot be left stuck at "active".
  const importArtifacts = await import("./artifacts.ts");
  const manifestResult = await importArtifacts.readArtifact(
    join(sessionDir, "session.json"),
    ParentManifestSchema,
  );
  if (!manifestResult.success) {
    throw new Error(
      `Cannot update manifest to complete: ${manifestResult.error}`,
    );
  }
  const updated = {
    ...manifestResult.data,
    status: "complete" as const,
    updated_at: new Date().toISOString(),
  };
  await writeSessionManifest(
    sessionDir,
    updated,
    ParentManifestSchema,
  );

  try {
    const storeRoot = await resolveStoreRoot();
    // TODO: TD-011/TD-013 — compute agents_spawned from agents/index.jsonl line count
    // For now agents_spawned is 0 when no children are spawned; this is correct
    // for the current sequential executor and will be enriched in TD-013.
    await appendGlobalIndexLine(storeRoot, {
      session_id: sessionId,
      completed_at: new Date().toISOString(),
      status: "complete",
      agents_spawned: 0,
      models: [effectiveModel],
      tokens: {
        prompt: totalPromptTokens,
        completion: totalCompletionTokens,
      },
    });
  } catch {
    // Best-effort: index update is diagnostic
  }

  progress.stop();
  return {
    success: true,
    sessionDir,
    sessionId,
    artifactPath,
  };
}
