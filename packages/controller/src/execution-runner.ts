/**
 * Execution Runner — sequential executor for flow pipelines.
 *
 * ## Control-Flow Invariant (binding)
 *
 * The executor walks a declared list. Gates evaluate typed output values
 * only. The model never chooses order, never initiates a step.
 *
 * ## R-006A Changes
 *
 * - Removed `loadFlow()` / `loadRoleRegistry()` imports — uses flow-package system.
 * - Added `_compiledPackage` test-mode override (replaces `_roleRegistry` + `_preloadedFlow`).
 * - Added `flowPackage` parameter for package ID or explicit path resolution.
 * - Removed `flowPath` / `rolesPath` parameters (deprecated by flow packages).
 *
 * ## Execution flow
 *
 * ```
 * 1. Resolve + compile flow package (or use test-mode override). Fail closed.
 * 2. initExecution (execution store) — creates ~/.zao/executions/<execution_id>/
 * 3. Write orchestration-spec.json (roles + flow + package snapshot)
 * 4. For each step, in declared order:
 *    a. Emit step_started event to execution events.jsonl
 *    b. if step.when: parse gate, check recorded prior step status;
 *       false → record "skipped", emit step_skipped event, continue
 *    c. effectiveTask = step.context ? step.context + "\n\n" + task : task
 *    d. harnessClient.runJob({ role, task: effectiveTask, projectDir, config })
 *    e. Append harness session_id to execution index.jsonl
 *    f. Record status (success/failed) in a local array
 *    g. On failed: STOP immediately. Record remaining steps as NOT run.
 * 5. Write aggregate result.json to execution directory
 * 6. Update execution manifest with terminal status (complete/failed)
 * 7. Emit execution_completed event
 * ```
 *
 * @module execution-runner
 */

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import Ajv from "ajv";
import { parseWhenExpression, FlowAggregateResultSchema } from "./flow-loader.ts";
import type { ResolvedFlow } from "./flow-loader.ts";
import {
  resolveRole,
  generateOrchestrationSpec,
  OrchestrationSpecSchema,
} from "./role-registry.ts";
import type { RoleRegistry } from "./role-registry.ts";
import type { ResolvedRoleDefinition } from "./schemas/role-definition.ts";
import type { ToolDeclaration } from "./schemas/flow.ts";
import type {
  LoopState,
  LoopCloseState,
} from "./schemas/flow.ts";
import type { FlowStep } from "./schemas/flow.ts";
import { ReviewerOutputSchema } from "./schemas/flow.ts";
import type { ReviewerOutput } from "./schemas/flow.ts";
import { existsSync } from "node:fs";
import {
  initExecution,
  writeExecutionManifest,
  readExecutionManifest,
  writeAtomicJson,
  appendExecutionIndexLine,
  appendExecutionEvent,
  resolveExecutionStoreRoot,
} from "./execution-store.ts";
import { DefaultHarnessClient } from "./harness-client.ts";
import { resolveAndCompileFlowPackage, copyPackageToExecutionDir, validateCompiledPackageSemantics, snapshotCompiledPackage, emitCompiledFlowPackage, type CompiledFlowPackage } from "./flow-package/index.ts";
import { resolveBlueprintPackage, compileBlueprint, type CompiledBlueprint } from "@zao/blueprint";
import type { ToolApprovalCallback } from "./human-gate.ts";
import { validateStepOutput } from "./output-validator.ts";
import { escalateToUser, type EscalationCallback } from "./escalation.ts";
import { createDecisionLogger, type DecisionLogger } from "./decision-logger.ts";
import { createSandbox, applySandboxChanges, discardSandbox } from "./sandbox.ts";
import { logger } from "./logger.ts";
import type { SandboxHandle } from "./sandbox.ts";
import type { Blueprint } from "@zao/blueprint";

// ── HarnessClient Interface ────────────────────────────────────────

/**
 * Context passed when resuming an interrupted execution.
 * Carries a summary and recent event log for the harness to inject
 * into the subagent's context window.
 */
export interface ResumeContext {
  /** Human-readable summary of prior steps. */
  summary?: string;
  /** Recent event log entries for context continuity. */
  recentEvents?: string[];
}

/**
 * Contract for communicating with the zao harness.
 *
 * The controller owns orchestration (what to run, in what order).
 * The harness owns execution (how to run a single job: init session,
 * build context, call LLM, write artifacts).
 */
export interface HarnessClient {
  /**
   * Runs a single job via the harness.
   *
   * @param params.sessionId - Optional existing session ID for resume.
   * // guard:ignore R4-no-hardcoded-roles — example role name in JSDoc
   * @param params.roleId - The role name (e.g. "developer") as declared in the flow.
   * @param params.resolvedRole - The resolved role definition for the agent.
   * @param params.task - The effective task description.
   * @param params.projectDir - Root of the project being operated on.
   * @param params.config - Execution configuration (autoYes, format).
   * @param params.resumeContext - Optional context for resuming a prior session.
   * @param params.tools - Optional tool declarations for this step (R-009).
   * @returns The result of the harness job, including session info and events.
   */
  runJob(params: {
    sessionId?: string;
    roleId: string;
    resolvedRole: ResolvedRoleDefinition;
    task: string;
    projectDir: string;
    config: { autoYes?: boolean; format?: string };
    resumeContext?: ResumeContext;
    tools?: ToolDeclaration[];
    onToolApproval?: ToolApprovalCallback;
  }): Promise<{
    success: boolean;
    sessionId: string;
    sessionDir: string;
    result?: Record<string, unknown>;
    events: Array<Record<string, unknown>>;
    error?: string;
  }>;
}

// ── MockHarnessClient ──────────────────────────────────────────────

/**
 * A single pre-configured response from the mock harness client.
 */
export interface MockHarnessJobResponse {
  /** Whether this job succeeded. */
  success: boolean;
  /** Override the auto-generated session ID. */
  sessionId?: string;
  /** Override the auto-generated session directory path. */
  sessionDir?: string;
  /** Events emitted by the harness for this job (includes token usage). */
  events?: Array<Record<string, unknown>>;
  /** Error message (only relevant when success is false). */
  error?: string;
  /** Optional result payload (only relevant when success is true). */
  result?: Record<string, unknown>;
}

/**
 * Mock implementation of {@link HarnessClient} for deterministic testing.
 */
export class MockHarnessClient implements HarnessClient {
  private _callIndex = 0;
  private _calls: Array<{
    roleId: string;
    resolvedRole: ResolvedRoleDefinition;
    role: string;
    task: string;
    projectDir: string;
    config: Record<string, unknown>;
    resumeContext?: ResumeContext;
    tools?: ToolDeclaration[];
    sessionId?: string;
    onToolApproval?: ToolApprovalCallback;
  }> = [];

  constructor(private _responses: MockHarnessJobResponse[]) {}

  /** The number of times `runJob` has been called. */
  get callCount(): number {
    return this._callIndex;
  }

  /** All recorded calls made to `runJob`, in order. */
  get calls(): ReadonlyArray<{
    roleId: string;
    resolvedRole: ResolvedRoleDefinition;
    role: string;
    task: string;
    projectDir: string;
    config: Record<string, unknown>;
    resumeContext?: ResumeContext;
    tools?: ToolDeclaration[];
    sessionId?: string;
    onToolApproval?: ToolApprovalCallback;
  }> {
    return this._calls;
  }

  async runJob(params: {
    sessionId?: string;
    roleId: string;
    resolvedRole: ResolvedRoleDefinition;
    task: string;
    projectDir: string;
    config: { autoYes?: boolean; format?: string };
    resumeContext?: ResumeContext;
    tools?: ToolDeclaration[];
    onToolApproval?: ToolApprovalCallback;
  }): Promise<{
    success: boolean;
    sessionId: string;
    sessionDir: string;
    result?: Record<string, unknown>;
    events: Array<Record<string, unknown>>;
    error?: string;
  }> {
    this._calls.push({
      roleId: params.roleId,
      resolvedRole: params.resolvedRole,
      role: params.resolvedRole.model,
      task: params.task,
      projectDir: params.projectDir,
      config: params.config as Record<string, unknown>,
      resumeContext: params.resumeContext,
      tools: params.tools,
      sessionId: params.sessionId,
      onToolApproval: params.onToolApproval,
    });

    if (this._callIndex >= this._responses.length) {
      throw new Error(
        `MockHarnessClient exhausted at call ${
          this._callIndex
        } (only ${this._responses.length} responses configured)`,
      );
    }

    const response = this._responses[this._callIndex]!;
    this._callIndex++;

    const sessionId = response.sessionId ?? randomUUID();
    const sessionDir =
      response.sessionDir ?? `/tmp/mo-mock-session-${sessionId}`;

    const defaultEvents: Array<Record<string, unknown>> = [
      {
        session_id: sessionId,
        prompt_tokens: 150,
        completion_tokens: 25,
        timestamp: new Date().toISOString(),
      },
    ];

    return {
      success: response.success,
      sessionId,
      sessionDir,
      result:
        response.result ??
        (response.success
          ? { status: "success", summary: "Mock harness job completed" }
          : undefined),
      events: response.events ?? defaultEvents,
      error: response.error ?? (response.success ? undefined : "Mock harness job failed"),
    };
  }
}

// ── Type Definitions ───────────────────────────────────────────────

/** Parameters for the {@link execute} function. */
export interface ExecuteParams {
  /**
   * The task / objective description.
   *
   * REQUIRED for `--blueprint` mode (used for `{task}` substitution);
   * an absent or empty task in blueprint mode is a fail-closed
   * validation error. Optional for `--flow` mode (tasks are embedded in
   * flow steps). When absent in flow mode, the execution manifest
   * records a derived label.
   */
  task?: string;
  /**
   * Flow package ID to resolve (e.g. "default"), or an absolute path
   * to a flow package directory. When omitted, resolves the "default" package.
   * Mutually exclusive with {@link blueprintPackage}.
   */
  flowPackage?: string;
  /**
   * Blueprint package ID to compile and execute (e.g. "feature-development"),
   * or an absolute path to a blueprint package directory.
   * When set, the blueprint is compiled with the user's task and the
   * resulting flow package is executed automatically.
   * Mutually exclusive with {@link flowPackage}.
   */
  blueprintPackage?: string;
  /** Whether `--yes` flag is active (auto-approves Tier 2 actions). */
  autoYes?: boolean;
  /** Project root directory (where `.zao/` lives). @default process.cwd() */
  projectDir?: string;
  /**
   * Output format: "table" (default, human prose) or "json"
   * (machine-readable envelope).
   */
  format?: "table" | "json";
  /**
   * The harness client used to execute individual steps.
   * In production, defaults to the real {@link DefaultHarnessClient}.
   * For tests, inject a {@link MockHarnessClient}.
   */
  harnessClient?: HarnessClient;
  /**
   * **Internal/test-only.** Pre-compiled flow package for deterministic
   * tests. When provided, skips flow package resolution entirely.
   */
  _compiledPackage?: CompiledFlowPackage;
  /**
   * **Internal/test-only.** Override the auto-generated execution ID.
   */
  _executionId?: string;
  /**
   * Resume entry point: when set, steps BEFORE this step id are skipped
   * and their harness sessions are recorded as already complete.
   * Steps FROM this id onward execute normally.
   */
  resumeFromStepId?: string;
  /**
   * Resume context: summary + recent events injected into harness context.
   * Only used in resume mode (when resumeFromStepId is set).
   */
  resumeContext?: ResumeContext;
  /**
   * Callback invoked when a loop exceeds its max_iterations.
   * The controller pauses execution and delegates the decision
   * (continue, stop, ask_reviewer) to the caller.
   *
   * When not provided, max_iterations exceeded causes a hard stop
   * (fail closed — no automatic extension).
   *
   * // TODO: TD-010-D — implement ask_reviewer and modify options.
   * // In v1, the callback only returns "continue" or "stop".
   */
  onLoopClose?: (state: LoopCloseState) => Promise<"continue" | "stop">;
  /**
   * Callback invoked for tools that require human approval (R-012 / REQ-3).
   *
   * Before executing a step that declares tools with `requires_approval: true`,
   * the controller calls this callback for each such tool. The human's decision
   * (approve / reject / modify) is applied before the harness runs the job.
   *
   * In production, this is {@link requestToolApproval} (stdin-based CLI prompt).
   * In tests, this is {@link createMockToolApproval} (pre-configured responses).
   *
   * When not provided, tools requiring approval cause the step to be skipped
   * (fail closed — no automatic approval).
   */
  onToolApproval?: ToolApprovalCallback;
  /**
   * Callback invoked for escalations (timeout, security violation, loop exceeded).
   *
   * In production, this is {@link escalateToUser} (stdin-based CLI prompt).
   * In tests, this is {@link createMockEscalation} (pre-configured responses).
   *
   * When not provided, escalations use the real {@link escalateToUser}.
   */
  onEscalation?: EscalationCallback;
  /**
   * Whether to use git worktree sandboxing (default: true).
   *
   * When enabled (default), the controller creates a git worktree at
   * `/tmp/mo-sandbox-<executionId>` before execution. All harness
   * operations then run inside the worktree. On success, the diff is
   * applied to the original repo. On failure, the worktree is discarded.
   *
   * Set to `false` to skip sandboxing (e.g., for testing or non-git repos).
   * The `--no-sandbox` CLI flag maps to this parameter.
   */
  sandbox?: boolean;
  /**
   * Pre-compiled {@link Blueprint} to execute directly without disk
   * resolution. When set, the controller skips blueprint package
   * resolution and uses this blueprint verbatim.
   *
   * This allows the crunch pipeline to produce a blueprint via
   * {@link emitBlueprint} and pass it directly to `execute()` without
   * writing to an intermediate file.
   */
  blueprint?: Blueprint;
}

/** Status of a single execution step. */
interface StepResult {
  id: string;
  status: "success" | "failed" | "skipped";
  error?: string;
  wasDelegated: boolean;
  role: string;
  model: string;
  childSessionId?: string;
  /** Loop iteration number (if inside a loop, 1-based). undefined for non-loop steps. */
  loopIteration?: number;
  /** Tool calls made during this step (R-009). */
  toolCalls?: Array<{
    tool: string;
    toolCallId?: string;
    args?: Record<string, unknown>;
    result?: Record<string, unknown>;
  }>;
}

/** The result of an {@link execute} call. */
export interface ExecutionResult {
  success: boolean;
  executionId: string;
  executionDir: string;
  /** Absolute path to the compiled flow package directory inside the execution dir. */
  flowPackageDir?: string;
  sessionIds: string[];
  error?: string;
  steps: Array<{
    id: string;
    status: "success" | "failed" | "skipped";
    role: string;
    model: string;
    sessionId?: string;
    /** Tool calls made during this step (R-009). */
    toolCalls?: Array<{
      tool: string;
      toolCallId?: string;
      args?: Record<string, unknown>;
      result?: Record<string, unknown>;
    }>;
  }>;
  tokenUsage: { prompt: number; completion: number };
  isValidationFailure?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────

const ORCHESTRATION_SPEC_NAME = "orchestration-spec.json";
const RESULT_ARTIFACT_NAME = "result.json";

// ── Contracts Validation ───────────────────────────────────────────

async function getResultContractsValidator(): Promise<
  ReturnType<Ajv["compile"]>
> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const schemaPath = resolvePath(
    moduleDir,
    "..",
    "..",
    "contracts",
    "schemas",
    "execution-result.schema.json",
  );

  let raw: string;
  try {
    raw = await readFile(schemaPath, "utf-8");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load contracts execution-result schema from "${schemaPath}": ${message}. ` +
        "This file must exist — result validation cannot proceed without the contracts schema.",
    );
  }

  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(raw) as Record<string, unknown>;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid JSON in contracts execution-result schema at "${schemaPath}": ${message}`,
    );
  }

  const { $schema: _unused, ...schemaWithoutMeta } = schema;
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schemaWithoutMeta);
}

async function validateResultAgainstContracts(
  result: Record<string, unknown>,
): Promise<void> {
  const validator = await getResultContractsValidator();
  const valid = validator(result);
  if (!valid) {
    const errors =
      validator.errors
        ?.map(
          (e: { instancePath?: string; message?: string }) =>
            `${e.instancePath || "(root)"}: ${e.message ?? "unknown error"}`,
        )
        .join("; ") ?? "unknown validation error";

    throw new Error(
      `Aggregate result validation against contracts schema failed: ${errors}. ` +
        "The result data must conform to packages/contracts/schemas/execution-result.schema.json.",
    );
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Derives a human-readable model slug from a canonical `llm_id`.
 *
 * ## Heuristic
 *
 * `llm_id` may use `provider:model` notation (e.g. `deepseek:deepseek-chat`).
 * We split on the FIRST `:` and use the last part as the model slug.
 * Simple model names without a `:` prefix (e.g. `claude-opus-4-6`) are
 * returned as-is.
 *
 * @param llmId - The canonical LLM identifier (e.g. `deepseek:deepseek-chat`).
 * @returns The model slug (e.g. `deepseek-chat`, `claude-opus-4-6`).
 */
export function deriveModelSlug(llmId: string): string {
  const colonIdx = llmId.indexOf(":");
  return colonIdx >= 0 ? llmId.slice(colonIdx + 1) : llmId;
}

function returnValidationError(
  context: string,
  message: string,
): ExecutionResult {
  return {
    success: false,
    executionId: "",
    executionDir: "",
    sessionIds: [],
    error: `${context}: ${message}`,
    steps: [],
    tokenUsage: { prompt: 0, completion: 0 },
    isValidationFailure: true,
  };
}

function returnError(
  context: string,
  message: string,
  executionId: string,
  executionDir = "",
): ExecutionResult {
  return {
    success: false,
    executionId,
    executionDir,
    sessionIds: [],
    error: `${context}: ${message}`,
    steps: [],
    tokenUsage: { prompt: 0, completion: 0 },
  };
}

async function appendStepEvent(
  executionDir: string,
  executionId: string,
  type: "step_started" | "step_completed" | "step_failed" | "step_skipped",
  stepId: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await appendExecutionEvent(executionDir, {
      type,
      execution_id: executionId,
      timestamp: new Date().toISOString(),
      detail: { step_id: stepId, ...extra },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`Failed to append step event: ${msg}`);
  }
}

// ── Blueprint Adapter ─────────────────────────────────────────────────

/**
 * Converts a compiled blueprint into a {@link CompiledFlowPackage}.
 *
 * Builds a RoleRegistry from the blueprint's roles and a resolved flow
 * from the compiled steps. This adapter bridges the advisory-plane
 * blueprint compiler to the control-plane flow execution engine.
 *
 * The returned package records structured `derivedFrom` provenance
 * (blueprint id + version) in addition to the human-readable
 * `resolvedFlow.provenance` string.
 *
 * @param compiled - The compiled blueprint from {@link compileBlueprint}.
 * @returns A fully resolved CompiledFlowPackage ready for execution.
 */
export function adaptCompiledBlueprintToFlowPackage(
  compiled: CompiledBlueprint,
): CompiledFlowPackage {
  // Build role registry from blueprint roles
  const roles = new Map<string, ResolvedRoleDefinition>();
  const defaultLlmId = compiled.roles.model_defaults.default_llm_id;

  for (const [roleName, roleDef] of Object.entries(compiled.roles.roles)) {
    const effectiveLlmId = roleDef.llm_id ?? defaultLlmId;

    // Derive model slug from llm_id using the shared heuristic (see deriveModelSlug).
    const effectiveModel = deriveModelSlug(effectiveLlmId);

    const modelProvenance = roleDef.llm_id !== null && roleDef.llm_id !== undefined
      ? `blueprint:${compiled.blueprintDir} (role-level)`
      : `blueprint:${compiled.blueprintDir} (inherited default)`;

    roles.set(roleName, {
      prompt_template: roleDef.prompt_template,
      context_budget: roleDef.context_budget,
      model: effectiveModel,
      llm_id: effectiveLlmId,
      provenance: `blueprint:${compiled.blueprintId}@${compiled.blueprintVersion}`,
      model_provenance: modelProvenance,
    });
  }

  const roleRegistry: RoleRegistry = {
    roles,
    defaultModel: defaultLlmId,
  };

  // Build provenance string with derived_from for traceability (REQ-6)
  const provenance = [
    `package:${compiled.blueprintId}@${compiled.blueprintVersion}`,
    `(derived_from blueprint:${compiled.blueprintId}@${compiled.blueprintVersion})`,
    `(${compiled.blueprintDir})`,
  ].join(" ");

  return {
    resolvedFlow: {
      schema_version: compiled.flow.schema_version,
      steps: compiled.flow.steps.map((s) => ({
        id: s.id,
        role: s.role,
        task: s.task,
        when: s.when,
        context: s.context,
        receive_from: s.receive_from, // R-010: pass receive_from through
        tools: s.tools, // R-009: pass tool declarations through to flow steps
        loop: s.loop, // R-010: pass loop config through
        output_spec: s.output_spec, // R-010: pass output_spec through
      })),
      provenance,
    },
    roleRegistry,
    packageDir: compiled.blueprintDir,
    packageId: compiled.blueprintId,
    packageVersion: compiled.blueprintVersion,
    derivedFrom: {
      blueprint_id: compiled.blueprintId,
      blueprint_version: compiled.blueprintVersion,
    },
  };
}

// ── Core Function ──────────────────────────────────────────────────

/**
 * Executes a flow pipeline: resolves a flow package, validates, then runs
 * each step in declared order via the {@link HarnessClient}.
 *
 * ## R-006A Changes
 *
 * Uses the flow-package system instead of the old multi-layer config
 * resolution (`loadFlow` + `loadRoleRegistry`). The `_compiledPackage`
 * parameter replaces `_roleRegistry` + `_preloadedFlow` for test injection.
 *
 * @param params - Task (required), optional flow package, harness client.
 * @returns An {@link ExecutionResult} with success status, execution path,
 *          per-step results, and (on success) session IDs.
 */

/** Maximum duration per step before escalation (R-012/REQ-5). */
const STEP_TIMEOUT_MS = 5 * 60 * 1000;

export async function execute(
  params: ExecuteParams,
): Promise<ExecutionResult> {
  const projectDir = params.projectDir ?? process.cwd();
  const executionId = params._executionId ?? randomUUID();
  const harnessClient = params.harnessClient ?? new DefaultHarnessClient();

  // ── Step 1: Resolve + compile flow package ───────────────────────
  let compiledPkg: CompiledFlowPackage;
  let packageWasResolved = false; // track whether we resolved from disk

  if (params._compiledPackage) {
    // Test-mode override: use as-is, but re-validate semantics because
    // test-mode overrides bypass compile-time checks.
    compiledPkg = params._compiledPackage;
    try {
      validateCompiledPackageSemantics(compiledPkg);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return returnValidationError("Compiled package semantic validation failed", message);
    }
    packageWasResolved = false;
  } else if (params.blueprint) {
    // ── Direct blueprint mode: skip disk resolution ───────────────
    // Used by crunch-cli.ts and analyze-cli.ts to pass a blueprint
    // directly without writing to an intermediate file.
    try {
      // Validate the blueprint against the canonical schema
      const { BlueprintSchema } = await import("@zao/blueprint");
      const validated = BlueprintSchema.safeParse(params.blueprint);
      if (!validated.success) {
        const errors = validated.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        return returnValidationError(
          "Blueprint validation failed",
          `Provided blueprint does not conform to BlueprintSchema: ${errors}`,
        );
      }
      // Generate default roles from the blueprint step role names.
      // Crunch-emitted blueprints reference roles like "explorer",
      // "designer", "coder", "inspector". Since no roles file exists
      // for direct blueprint mode, we create synthetic role definitions.
      const stepRoleNames = [
        ...new Set(validated.data.steps.map((s) => s.role)),
      ];
      const directBlueprintRoles: import("@zao/blueprint").RolesFile = {
        schema_version: "0.3.0" as const,
        model_defaults: { default_llm_id: "deepseek:deepseek-chat" },
        roles: Object.fromEntries(
          stepRoleNames.map((name) => [
            name,
            {
              prompt_template: `You are a ${name} agent.`,
              context_budget: 0.65,
              llm_id: null,
            },
          ]),
        ),
      };

      // Compile the blueprint (substitute {task} into templates)
      const compiled = compileBlueprint(
        {
          packageId: "crunch",
          packageVersion: "0.1.0",
          packageDir: "",
          blueprint: validated.data,
          roles: directBlueprintRoles,
          rawBlueprint: validated.data as unknown as Record<string, unknown>,
          rawRoles: {},
        },
        params.task ?? "",
      );
      compiledPkg = adaptCompiledBlueprintToFlowPackage(compiled);
      packageWasResolved = false; // no disk package to copy
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return returnValidationError("Failed to compile provided blueprint", message);
    }
  } else if (params.blueprintPackage) {
    // ── Blueprint mode: compile blueprint → flow package ──────────
    try {
      // Fail-closed: a blueprint substitutes the user task into every
      // step's {task} placeholder. An empty task would produce
      // meaningless steps, so require a non-empty task up front.
      const userTask = params.task ?? "";
      if (userTask.trim() === "") {
        return returnValidationError(
          "Blueprint task validation failed",
          "A non-empty --task is required when using --blueprint. " +
            "The user task is substituted into every step's {task} placeholder.",
        );
      }

      const bp = params.blueprintPackage;
      let loaded;
      // explicitPath bypasses path confinement because it is a local user
      // choosing the path. If blueprint mode is ever exposed via a service,
      // add isPathWithinRoot check here.
      if (bp.startsWith("/") && existsSync(bp)) {
        loaded = await resolveBlueprintPackage({ explicitPath: bp });
      } else if (bp.startsWith("/")) {
        // Looks like a path but doesn't exist — treat as explicitPath
        // so the error message is about the missing directory.
        loaded = await resolveBlueprintPackage({ explicitPath: bp });
      } else {
        loaded = await resolveBlueprintPackage({ packageId: bp });
      }
      const compiled = compileBlueprint(loaded, userTask);
      compiledPkg = adaptCompiledBlueprintToFlowPackage(compiled);
      packageWasResolved = true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return returnValidationError("Failed to resolve or compile blueprint", message);
    }
  } else if (params.flowPackage) {
    // ── Flow mode: resolve a flow package by ID or explicit path ──
    try {
      const fp = params.flowPackage;
      // explicitPath bypasses path confinement because it is a local user
      // choosing the path. If flow mode is ever exposed via a service,
      // add isPathWithinRoot check here.
      if (fp.startsWith("/") && existsSync(fp)) {
        compiledPkg = await resolveAndCompileFlowPackage({
          explicitPath: fp,
        });
      } else if (fp.startsWith("/")) {
        // Looks like a path but doesn't exist — treat as explicitPath
        // so the error message is about the missing directory.
        compiledPkg = await resolveAndCompileFlowPackage({
          explicitPath: fp,
        });
      } else {
        compiledPkg = await resolveAndCompileFlowPackage({
          packageId: fp,
          projectRoot: projectDir,
        });
      }
      packageWasResolved = true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return returnValidationError("Failed to resolve flow package", message);
    }
  } else {
    // ── Default mode: resolve the shipped "default" flow package ──
    try {
      compiledPkg = await resolveAndCompileFlowPackage({
        packageId: "default",
        projectRoot: projectDir,
      });
      packageWasResolved = true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return returnValidationError("Failed to resolve flow package", message);
    }
  }

  const registry: RoleRegistry = compiledPkg.roleRegistry;
  const resolvedFlow: ResolvedFlow = compiledPkg.resolvedFlow;

  // Resolve the first step's role for the root model reference
  const firstStep = resolvedFlow.steps[0];
  if (!firstStep) {
    return returnValidationError(
      "Flow validation failed",
      "Flow package contains no steps. At least one step is required.",
    );
  }

  let rootRoleDef: ResolvedRoleDefinition;
  try {
    rootRoleDef = resolveRole(registry, firstStep.role);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return returnValidationError(
      `Failed to resolve root role "${firstStep.role}"`,
      message,
    );
  }

  // ── Step 2: Init execution via execution store ──────────────────
  let executionDir: string;
  if (params.resumeFromStepId) {
    try {
      const storeRoot = await resolveExecutionStoreRoot();
      executionDir = join(storeRoot, executionId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return returnError("Failed to resolve execution store", message, executionId);
    }
    if (!existsSync(join(executionDir, "execution.json"))) {
      return returnError(
        "Cannot resume execution: execution directory is missing or corrupted",
        `execution.json not found at "${executionDir}"`,
        executionId,
      );
    }
  } else {
    try {
      const initResult = await initExecution({
        execution_id: executionId,
        task: params.task ?? "Flow execution",
        repo_root: projectDir,
      });
      executionDir = initResult.executionDir;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return returnError(
        "Failed to initialize execution",
        message,
        executionId,
      );
    }
  }

  // ── Step 2b: Copy flow package into execution directory (ADR-008 D7) ──
  if (packageWasResolved) {
    try {
      await copyPackageToExecutionDir(compiledPkg.packageDir, executionDir);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return returnError(
        "Failed to copy flow package to execution directory",
        message,
        executionId,
        executionDir,
      );
    }
  }

  // ── Step 2c: Emit compiled flow package (blueprint mode) ──────────
  // For blueprint mode, the source package directory contains template
  // files with {task} placeholders. Write the fully compiled flow
  // package over the top so the execution directory is self-describing
  // and analyzers see the actual compiled content.
  if (params.blueprintPackage && !params._compiledPackage) {
    try {
      const compiledDest = join(executionDir, "flow-package");
      await emitCompiledFlowPackage(compiledPkg, compiledDest);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return returnError(
        "Failed to emit compiled flow package to execution directory",
        message,
        executionId,
        executionDir,
      );
    }
  }

  // ── Step 3: Write orchestration spec snapshot ───────────────────
  try {
    const roleSpec = generateOrchestrationSpec(registry);
    const flowStepsForSpec = resolvedFlow.steps.map((s) => ({
      id: s.id,
      role: s.role,
      task: s.task,
      when: s.when ?? null,
      context: s.context ?? null,
      receive_from: s.receive_from ?? null, // R-010
      tools: s.tools ?? null, // R-009
      loop: s.loop ?? null, // R-010
      output_spec: s.output_spec ?? null, // R-010
    }));
    const spec = {
      ...roleSpec,
      flow_package_package_id: compiledPkg.packageId,
      flow: {
        schema_version: resolvedFlow.schema_version,
        provenance: resolvedFlow.provenance,
        steps: flowStepsForSpec,
      },
      flow_package: snapshotCompiledPackage(compiledPkg),
    };

    const validationResult = OrchestrationSpecSchema.safeParse(spec);
    if (!validationResult.success) {
      return returnError(
        "Orchestration spec validation failed",
        validationResult.error.message,
        executionId,
        executionDir,
      );
    }

    const specPath = join(executionDir, ORCHESTRATION_SPEC_NAME);
    await writeAtomicJson(
      specPath,
      spec as Record<string, unknown>,
      OrchestrationSpecSchema,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return returnError(
      "Failed to write orchestration spec",
      message,
      executionId,
      executionDir,
    );
  }

  // ── Step 3b: Create sandbox (git worktree isolation) ────────────
  // When sandboxing is enabled (default), all harness operations run
  // inside a git worktree. Changes are applied to the original repo
  // only on success. Default: sandbox ON.
  //
  // createSandbox may return null if git is not available or if the
  // project directory cannot be sandboxed — in that case we proceed
  // without sandboxing and log a warning.
  const useSandbox = params.sandbox !== false; // true by default
  let sandbox: SandboxHandle | null = null;
  let effectiveProjectDir = projectDir;

  if (useSandbox) {
    try {
      sandbox = await createSandbox(projectDir, executionId);
      if (sandbox) {
        effectiveProjectDir = sandbox.worktreePath;
      } else {
        logger.warn(
          `[zao] Sandbox creation returned null — proceeding without sandbox. ` +
          `All harness operations will run directly in "${projectDir}".`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return returnError(
        "Sandbox creation failed",
        message,
        executionId,
        executionDir,
      );
    }
  }

  // ── Step 4: Execute steps sequentially ──────────────────────────
  // ── R-012/REQ-7: Decision audit trail logger ────────────────────
  const decisionLogger: DecisionLogger = createDecisionLogger(executionDir);
  const stepResults: StepResult[] = [];
  const sessionIds: string[] = [];
  let overallSuccess = true;
  let failureError: string | undefined;
  let failedStepIndex = -1;
  const effectiveModel = rootRoleDef.model;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  // ── Loop Tracking State (R-010) ─────────────────────────────────
  // Stack-based tracking for nested loop support (C-001 fix).
  // The top of the stack is the innermost active loop.
  const loopStack: LoopState[] = [];
  let loopClosed = false; // set when human gate stops the loop

  /**
   * Returns the topmost (innermost) active loop, or null if no loop
   * is currently on the stack. Use this instead of a single `loopTracker`
   * variable to support nested loops (ADR-008 §6).
   */
  function getCurrentLoop(): LoopState | null {
    return loopStack.length > 0 ? (loopStack[loopStack.length - 1] as LoopState) : null;
  }

  /** Records the final iteration before popping a completed loop from the stack. */
  function recordFinalIteration(loop: LoopState) {
    loop.iterations.push({
      iteration: loop.iteration,
      stepResults: stepResults
        .filter((r) => r.loopIteration === loop.iteration)
        .map((r) => ({
          stepId: r.id,
          status: r.status,
          error: r.error,
        })),
    });
  }

  // Helper: create a LoopState from a step's loop config
  function createLoopTracker(step: FlowStep): LoopState {
    const cfg = step.loop!;
    return {
      active: true,
      target: cfg.target,
      loopStepId: step.id,
      iteration: 1,
      max_iterations: cfg.max_iterations,
      exit_when: cfg.exit_when,
      context_budget: cfg.context_budget,
      iterations: [],
      sessionIds: new Map(),
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
    };
  }

  /**
   * Estimates token usage from harness job result events.
   *
   * Iterates over the events array, summing `prompt_tokens` and
   * `completion_tokens` fields. Also accounts for `context_budget`
   * events emitted by the harness (R-010), which carry an
   * `estimated_tokens` field added to the prompt count.
   *
   * @param events - Events emitted by the harness during job execution.
   * @returns An object with total prompt and completion token counts.
   */
  function estimateTokensFromEvents(
    events: Array<Record<string, unknown>>,
  ): { prompt: number; completion: number } {
    let prompt = 0;
    let completion = 0;
    for (const event of events) {
      if (typeof event["prompt_tokens"] === "number") {
        prompt += event["prompt_tokens"] as number;
      }
      if (typeof event["completion_tokens"] === "number") {
        completion += event["completion_tokens"] as number;
      }
      // Also check for context_budget events emitted by the harness (R-010)
      if (
        event["type"] === "context_budget" &&
        typeof event["estimated_tokens"] === "number"
      ) {
        prompt += event["estimated_tokens"] as number;
      }
    }
    return { prompt, completion };
  }

  /**
   * Parses structured reviewer output from a harness job result.
   *
   * Uses Zod validation ({@link ReviewerOutputSchema}) rather than manual
   * type checking (Guardrail §2). If the result object does not conform
   * to the expected schema, returns `null` so the loop routing logic can
   * skip the iteration gracefully.
   *
   * @param result - The harness job result containing optional structured output.
   * @returns A validated {@link ReviewerOutput} object, or `null` if validation fails.
   */
  function parseReviewerOutput(result: {
    success: boolean;
    result?: Record<string, unknown>;
    error?: string;
  }): ReviewerOutput | null {
    if (!result.success || !result.result) return null;

    const parsed = ReviewerOutputSchema.safeParse(result.result);
    if (!parsed.success) return null;

    return parsed.data;
  }

  /**
   * Evaluates a loop's exit_when expression against the reviewer's output.
   *
   * Parses the exit_when string and checks whether the reviewer's status
   * matches the expected status in the expression.
   *
   * ## Fail-closed (M-001 fix)
   *
   * Previously returned `true` (exit loop) on parse failure, silently
   * ending the loop. Now throws with a descriptive error so the caller
   * can handle the malformed condition explicitly.
   *
   * @param exitWhen - The exit_when expression (e.g. `"review.status == \"success\""`).
   * @param reviewerOutput - The parsed reviewer output containing the status field.
   * @returns `true` if the exit condition is met, `false` otherwise.
   * @throws If the exit_when expression cannot be parsed.
   */
  function evaluateLoopExit(
    exitWhen: string,
    reviewerOutput: { status: string },
  ): boolean {
    // Parse exit_when (e.g., "review.status == success")
    const parsed = parseWhenExpression(exitWhen);
    if (!parsed) {
      throw new Error(
        `Failed to parse loop exit_when expression: "${exitWhen}". ` +
          `Expected format: "<step-id>.status == \"success\" or \"failed\".`,
      );
    }

    const { expectedStatus } = parsed;

    // Match reviewer output status against expected status
    return reviewerOutput.status === expectedStatus;
  }

  // ── Resume mode: skip steps before the resume point ─────────────
  let startIndex = 0;
  if (params.resumeFromStepId) {
    const resumeIdx = resolvedFlow.steps.findIndex(
      (s) => s.id === params.resumeFromStepId,
    );
    if (resumeIdx >= 0) {
      for (let i = 0; i < resumeIdx; i++) {
        const step = resolvedFlow.steps[i]!;
        let stepModel: string;
        try {
          const stepRoleDef = resolveRole(registry, step.role);
          stepModel = stepRoleDef.model;
        } catch {
          stepModel = effectiveModel;
        }
        stepResults.push({
          id: step.id,
          status: "success",
          wasDelegated: false,
          role: step.role,
          model: stepModel,
          childSessionId: undefined,
        });
        await appendStepEvent(
          executionDir,
          executionId,
          "step_skipped",
          step.id,
          { reason: "Already completed in prior execution (resume)" },
        );
      }
      startIndex = resumeIdx;
    }
  }

  let remainingResumeContext = params.resumeContext;

  for (let i = startIndex; i < resolvedFlow.steps.length; i++) {
    const step = resolvedFlow.steps[i]!;

    // ── R-010: Loop Activation ────────────────────────────────────
    // Push a new loop state when a step declares a loop block.
    // If this exact loop is already on the stack (re-entry from a jump),
    // don't push another — reuse the existing one.
    if (step.loop) {
      const existing = loopStack.find(
        (l) => l.loopStepId === step.id && l.active,
      );
      if (!existing) {
        loopStack.push(createLoopTracker(step as FlowStep));
      }
    }

    const currentLoop = getCurrentLoop();

    // ── Check if flow is stopped by human gate ────────────────────
    if (loopClosed) {
      // Record remaining steps as skipped
      let skipModel: string;
      try {
        const skipRoleDef = resolveRole(registry, step.role);
        skipModel = skipRoleDef.model;
      } catch {
        skipModel = effectiveModel;
      }
      stepResults.push({
        id: step.id,
        status: "skipped",
        error: "Loop was stopped by human gate",
        wasDelegated: false,
        role: step.role,
        model: skipModel,
      });
      await appendStepEvent(
        executionDir,
        executionId,
        "step_skipped",
        step.id,
        { reason: "Flow stopped after loop close (human gate)" },
      );
      continue;
    }

    // ── Resolve step model ────────────────────────────────────────
    let stepModel: string;
    try {
      const stepRoleDef = resolveRole(registry, step.role);
      stepModel = stepRoleDef.model;
    } catch {
      stepModel = effectiveModel;
    }

    // ── Emit step_started event ─────────────────────────────────
    await appendStepEvent(
      executionDir,
      executionId,
      "step_started",
      step.id,
      {
        step_index: i,
        role: step.role,
        ...(currentLoop?.active ? { loop_iteration: currentLoop.iteration } : {}),
      },
    );

    // ── R-012/REQ-7: Log step start decision ──────────────────────
    // NOTE (L3 fix): session_id is "pending" because the harness
    // session has not yet been created at this point — the step start
    // log entry is emitted BEFORE the harness job runs. The real
    // session_id is available after the job completes and is used in
    // downstream log entries (step completion, tool events). This
    // "pending" placeholder preserves chronological ordering in the
    // decision log while being honest about when the value is known.
    decisionLogger.logDecision({
      schema_version: "0.1.0",
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      execution_id: executionId,
      session_id: "pending",
      step_id: step.id,
      actor: "controller",
      action: "gate_decision",
      data: {
        step_role: step.role,
        step_index: i,
        loop_iteration: currentLoop?.active ? currentLoop.iteration : null,
      },
    }).catch(() => {
      // Best-effort: decision logging is diagnostic, never blocks execution
    });

    // ── Evaluate gate (when) ────────────────────────────────────
    // In loop mode, the first step of a new iteration (the target step)
    // should not be gated — it's the loop re-entry point.
    const isLoopReentry = currentLoop?.active && step.id === currentLoop.target;

    if (step.when && !isLoopReentry) {
      const parsed = parseWhenExpression(step.when);

      if (!parsed) {
        stepResults.push({
          id: step.id,
          status: "skipped",
          wasDelegated: false,
          role: step.role,
          model: stepModel,
        });
        await appendStepEvent(
          executionDir,
          executionId,
          "step_skipped",
          step.id,
          { reason: `Invalid when expression: ${step.when}` },
        );
        continue;
      }

      const { refId, expectedStatus } = parsed;
      // In loop mode, find the most recent result for the referenced step
      // (it may have been run multiple times across iterations)
      const priorResults = stepResults.filter((r) => r.id === refId);
      const priorResult = priorResults.length > 0
        ? priorResults[priorResults.length - 1] // most recent
        : undefined;

      if (!priorResult) {
        stepResults.push({
          id: step.id,
          status: "skipped",
          wasDelegated: false,
          role: step.role,
          model: stepModel,
        });
        await appendStepEvent(
          executionDir,
          executionId,
          "step_skipped",
          step.id,
          { reason: `When references step "${refId}" which has not run` },
        );
        continue;
      }

      if (priorResult.status !== expectedStatus) {
        stepResults.push({
          id: step.id,
          status: "skipped",
          wasDelegated: false,
          role: step.role,
          model: stepModel,
        });
        await appendStepEvent(
          executionDir,
          executionId,
          "step_skipped",
          step.id,
          {
            reason: `When not met: ${refId}.status is "${priorResult.status}", expected "${expectedStatus}"`,
          },
        );
        continue;
      }
    }

    // ── R-010: Gather receive_from context from prior step results ──
    // TODO: TD-010-E — extract specific fields from prior step outputs (review.findings, review.recommended_next)
    let receivedContext = "";
    if (step.receive_from && step.receive_from.length > 0) {
      const contextParts: string[] = [];
      for (const ref of step.receive_from) {
        // ref format: "step_id.field" or just "step_id"
        const [refStepId, ...fieldParts] = ref.split('.');
        const field = fieldParts.join('.');
        
        // Find the most recent result for this step (across all loop iterations)
        const priorResults = stepResults.filter(r => r.id === refStepId);
        const latestResult = priorResults[priorResults.length - 1];
        
        if (latestResult && latestResult.loopIteration !== undefined) {
          contextParts.push(`[${refStepId}]: ${field || "completed"}`);
        } else if (latestResult) {
          contextParts.push(`[${refStepId}]: ${field || "completed"}`);
        }
      }
      if (contextParts.length > 0) {
        receivedContext = "\n--- Context from previous steps ---\n" + contextParts.join('\n') + "\n--- End context ---\n";
      }
    }

    // ── Build effective task ────────────────────────────────────
    const effectiveTask = (step.context ? step.context + "\n" : "") + receivedContext + step.task;

    // ── Delegate to harness ─────────────────────────────────────
    let stepRoleDef: ResolvedRoleDefinition;
    try {
      stepRoleDef = resolveRole(registry, step.role);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Internal invariant violation: role "${step.role}" for step "${step.id}" ` +
        `was validated at load time but failed to resolve at runtime. ${message}`,
      );
    }

    // ── R-012/REQ-3: Tools requiring human approval ─────────────────
    // NOTE: Actual approval happens in the harness via onToolApproval
    // with real tool call args. This pre-check only logs which tools
    // require approval for audit purposes.
    const stepTools = step.tools;
    if (stepTools && stepTools.length > 0) {
      const toolsNeedingApproval = stepTools.filter((td) => td.requires_approval);
      if (toolsNeedingApproval.length > 0) {
        decisionLogger.logDecision({
          schema_version: "0.1.0",
          event_id: randomUUID(),
          timestamp: new Date().toISOString(),
          execution_id: executionId,
          session_id: "pending",
          step_id: step.id,
          actor: "controller",
          action: "gate_decision",
          data: {
            tools_requiring_approval: toolsNeedingApproval.map(t => t.tool),
            note: "Actual approval will occur in harness with real tool args",
          },
        }).catch(() => {});
      }
    }

    // ── R-010: Resume session for loop iterations ──────────────────
    // NOTE: The harness resume path re-reads the stored role from session-config.json
    // rather than using the controller's resolvedRole. This is correct — a step's role
    // configuration is immutable for the lifetime of a loop iteration, ensuring the
    // LLM sees a consistent role definition across resumes.
    const existingSessionId = currentLoop?.active
      ? currentLoop.sessionIds.get(step.id)
      : undefined;

    // ── R-012/REQ-5: Step timeout wrapping ──────────────────────────

    let jobResult: Awaited<ReturnType<HarnessClient["runJob"]>>;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("STEP_TIMEOUT"));
        }, STEP_TIMEOUT_MS);
      });

      jobResult = await Promise.race([
        harnessClient.runJob({
          sessionId: existingSessionId,
          roleId: step.role,
          resolvedRole: stepRoleDef,
          task: effectiveTask,
          projectDir: effectiveProjectDir,
          config: {
            autoYes: params.autoYes,
            format: params.format ?? "table",
          },
          resumeContext: remainingResumeContext,
          tools: stepTools,
          onToolApproval: params.onToolApproval,
        }),
        timeoutPromise,
      ]);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "STEP_TIMEOUT") {
        // ── R-012/REQ-5: Escalate timeout to user ───────────────────
        const escalationCallback = params.onEscalation ?? escalateToUser;
        const escalationResp = await escalationCallback({
          type: "timeout",
          reason: `Step "${step.id}" timed out after ${STEP_TIMEOUT_MS / 1000}s`,
          events: [],
          executionId,
          stepId: step.id,
        });

        // Log escalation
        decisionLogger.logDecision({
          schema_version: "0.1.0",
          event_id: randomUUID(),
          timestamp: new Date().toISOString(),
          execution_id: executionId,
          session_id: "pending",
          step_id: step.id,
          actor: "controller",
          action: "escalation",
          data: { type: "timeout", reason: `Step "${step.id}" timed out` },
        }).catch(() => {});

        if (escalationResp.action === "continue") {
          // ── KNOWN LIMITATIONS (v1, C3 fix) ─────────────────────────
          // When the user chooses "continue" after a timeout, the harness
          // job that triggered the timeout is STILL RUNNING in the
          // background. Promise.race only resolves with the timeout winner;
          // it does NOT cancel the losing promise. The harness does NOT
          // support AbortController in v1 — there is no way to signal the
          // running job to stop.
          //
          // Consequences:
          //  1. The harness job leaks — it may complete later but its
          //     result is discarded (we've already recorded failure here).
          //  2. Any side effects from the harness job (file writes,
          //     shell commands) may still occur after we've moved on.
          //  3. Bun will not garbage-collect the orphaned async work
          //     until the process exits.
          //
          // Future work (TD-041): add AbortController support to the
          // harness's runJob() so the controller can propagate a cancel
          // signal. Until then, timeout+continue is a best-effort
          // recovery that records failure and moves on.
          //
          // We record as failed — the harness result was lost.
          const errMsg = `Step "${step.id}" timed out. Escalated; user chose continue but harness result was lost (v1 limitation: no AbortController).`;
          stepResults.push({
            id: step.id,
            status: "failed",
            error: errMsg,
            wasDelegated: true,
            role: step.role,
            model: stepModel,
            childSessionId: "pending",
            loopIteration: currentLoop?.active ? currentLoop.iteration : undefined,
          });
          failureError = errMsg;
          overallSuccess = false;
          failedStepIndex = i;
          loopStack.length = 0;
          break;
        }

        // "abort" → record failure and stop
        const errMsg = `Step "${step.id}" timed out. Escalation: user aborted.`;
        stepResults.push({
          id: step.id,
          status: "failed",
          error: errMsg,
          wasDelegated: true,
          role: step.role,
          model: stepModel,
          childSessionId: "pending",
          loopIteration: currentLoop?.active ? currentLoop.iteration : undefined,
        });
        await appendStepEvent(
          executionDir,
          executionId,
          "step_failed",
          step.id,
          { error: errMsg },
        );
        failureError = errMsg;
        overallSuccess = false;
        failedStepIndex = i;
        loopStack.length = 0;
        break;
      }
      throw error; // re-throw non-timeout errors
    }
    remainingResumeContext = undefined;

    // ── R-010: Track session ID for resume ─────────────────────────
    if (currentLoop?.active) {
      currentLoop.sessionIds.set(step.id, jobResult.sessionId);
    }

    sessionIds.push(jobResult.sessionId);

    await appendExecutionIndexLine(executionDir, {
      session_id: jobResult.sessionId,
      status: jobResult.success ? "complete" : "failed",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    // ── R-010: Context budget tracking ─────────────────────────────
    const stepTokens = estimateTokensFromEvents(jobResult.events);

    // ── R-010/H-003: Per-step token budget enforcement ───────────────
    if (currentLoop?.active && currentLoop.context_budget?.max_tokens_per_step) {
      const perStepTotal = stepTokens.prompt + stepTokens.completion;
      if (perStepTotal > currentLoop.context_budget.max_tokens_per_step) {
        if (currentLoop.context_budget.compaction_strategy) {
          logger.warn(
            `[zao] Step exceeded per-step token budget ` +
              `(${perStepTotal} / ${currentLoop.context_budget.max_tokens_per_step}). ` +
              `Compaction would be triggered (TD-010-C placeholder).`,
          );
        } else {
          const errMsg =
            `Step exceeded per-step token budget ` +
            `(${perStepTotal} / ${currentLoop.context_budget.max_tokens_per_step}) ` +
            `without a compaction strategy. Add "compaction_strategy" to loop.context_budget.`;
          currentLoop.active = false;
          loopStack.pop();
          failureError = errMsg;
          overallSuccess = false;
          failedStepIndex = i;
          break;
        }
      }
    }

    if (currentLoop?.active) {
      currentLoop.total_prompt_tokens += stepTokens.prompt;
      currentLoop.total_completion_tokens += stepTokens.completion;

      if (currentLoop.context_budget) {
        const budget = currentLoop.context_budget;
        const totalTokens =
          currentLoop.total_prompt_tokens + currentLoop.total_completion_tokens;

        if (totalTokens > budget.max_total_tokens) {
          if (budget.compaction_strategy) {
            // TD-010-C placeholder: log warning for now
            logger.warn(
              `[zao] Context budget exceeded (${totalTokens} / ${budget.max_total_tokens} tokens). ` +
                `Compaction strategy "${budget.compaction_strategy}" would be triggered (TD-010-C not yet implemented).`,
            );
          } else {
            const errMsg =
              `Context budget exceeded (${totalTokens} / ${budget.max_total_tokens} tokens) ` +
              `without a compaction strategy. Add "compaction_strategy" to loop.context_budget.`;
            currentLoop.active = false;
            loopStack.pop();
            failureError = errMsg;
            overallSuccess = false;
            failedStepIndex = i;
            break;
          }
        }
      }
    }

    for (const event of jobResult.events) {
      const p =
        typeof event["prompt_tokens"] === "number"
          ? (event["prompt_tokens"] as number)
          : 0;
      const c =
        typeof event["completion_tokens"] === "number"
          ? (event["completion_tokens"] as number)
          : 0;
      totalPromptTokens += p;
      totalCompletionTokens += c;
    }

    if (jobResult.success) {
      stepResults.push({
        id: step.id,
        status: "success",
        wasDelegated: true,
        role: step.role,
        model: stepModel,
        childSessionId: jobResult.sessionId,
        loopIteration: currentLoop?.active ? currentLoop.iteration : undefined,
      });
      await appendStepEvent(
        executionDir,
        executionId,
        "step_completed",
        step.id,
        {
          session_id: jobResult.sessionId,
        ...(currentLoop?.active ? { loop_iteration: currentLoop.iteration } : {}),
        },
      );

      // ── R-012/REQ-7: Log harness tool events to decisions.jsonl ───
      // The harness emits tool_call / tool_result events during execution.
      // The controller re-logs them into the decision audit trail so that
      // all tool actions are visible in a single chronological log.
      // The harness never writes into the execution directory directly
      // (ADR-008 D1), so the controller is the canonical decision writer.
      for (const event of jobResult.events) {
        const action = event["action"] as string | undefined;
        if (action === "tool_call" || action === "tool_result") {
          decisionLogger.logDecision({
            schema_version: "0.1.0",
            event_id: randomUUID(),
            timestamp: new Date().toISOString(),
            execution_id: executionId,
            session_id: jobResult.sessionId,
            step_id: step.id,
            actor: "harness",
            action: action as import("./decision-logger.ts").Action,
            data: {
              tool: event["tool"],
              args: event["args"],
              success: event["success"],
              error: event["error"],
              event_id: event["event_id"],
            },
          }).catch(() => {
            // Best-effort: decision logging is diagnostic, never blocks execution
          });
        }
      }

      // ── R-012/REQ-4: Validate output against output_spec ───────────
      if (step.output_spec && jobResult.result) {
        const validation = validateStepOutput(
          jobResult.result,
          step.output_spec as import("./output-validator.ts").OutputSpec,
          step.id,
        );
        if (!validation.valid) {
          // Store the index explicitly to avoid race conditions
          // (stepResults[stepResults.length - 1] could reference the
          // wrong entry if another async operation mutates the array).
          const successEntryIndex = stepResults.length - 1;
          stepResults[successEntryIndex] = {
            id: step.id,
            status: "failed",
            error: validation.error,
            wasDelegated: true,
            role: step.role,
            model: stepModel,
            childSessionId: jobResult.sessionId,
            loopIteration: currentLoop?.active ? currentLoop.iteration : undefined,
          };
          await appendStepEvent(
            executionDir,
            executionId,
            "step_failed",
            step.id,
            { error: validation.error, session_id: jobResult.sessionId },
          );
          failureError = validation.error ?? "Output validation failed";
          overallSuccess = false;
          failedStepIndex = i;
          loopStack.length = 0;
          // R-012/REQ-7: Log validation failure
          decisionLogger.logDecision({
            schema_version: "0.1.0",
            event_id: randomUUID(),
            timestamp: new Date().toISOString(),
            execution_id: executionId,
            session_id: jobResult.sessionId,
            step_id: step.id,
            actor: "controller",
            action: "tool_result",
            data: { error: validation.error },
          }).catch(() => {});
          break;
        }
      }

      // ── R-012/REQ-7: Log step completion decision ────────────────
      decisionLogger.logDecision({
        schema_version: "0.1.0",
        event_id: randomUUID(),
        timestamp: new Date().toISOString(),
        execution_id: executionId,
        session_id: jobResult.sessionId,
        step_id: step.id,
        actor: "controller",
        action: "tool_result",
        data: { success: true },
      }).catch(() => {});

      // ── R-010: Loop Routing ─────────────────────────────────────
      // After a step with output_spec runs, check for loop routing
      if (currentLoop?.active && step.output_spec) {
        const reviewerOutput = parseReviewerOutput(jobResult);

        if (reviewerOutput) {
          // Record reviewer output for loop tracking
          const thisIterRecord = currentLoop.iterations.find(
            (it) => it.iteration === currentLoop.iteration,
          );
          if (thisIterRecord) {
            thisIterRecord.reviewerOutput = reviewerOutput;
          }

          // Always check exit condition for any reviewer output
          const exitMet = evaluateLoopExit(
            currentLoop.exit_when,
            reviewerOutput,
          );

          if (reviewerOutput.status === "requires_actions") {
            // Validate recommended_next matches loop target
            if (
              reviewerOutput.recommended_next &&
              reviewerOutput.recommended_next !== currentLoop.target
            ) {
              throw new Error(
                `Reviewer recommended "${reviewerOutput.recommended_next}" but loop target is "${currentLoop.target}". ` +
                  `Mismatch at step "${step.id}" (loop "${currentLoop.loopStepId}").`,
              );
            }

            if (exitMet) {
              // Exit condition met even on requires_actions — pop loop
              recordFinalIteration(currentLoop);
              currentLoop.active = false;
              loopStack.pop();
            } else {
              // Loop back: increment iteration and jump to target
              currentLoop.iteration++;

              // Check if max iterations exceeded
              if (currentLoop.iteration > currentLoop.max_iterations) {
                // Build LoopCloseState for human gate
                const closeState: LoopCloseState = {
                  loopStepId: currentLoop.loopStepId,
                  totalIterations: currentLoop.max_iterations,
                  iterations: currentLoop.iterations,
                  tokenUsage: {
                    prompt: currentLoop.total_prompt_tokens,
                    completion: currentLoop.total_completion_tokens,
                  },
                };

                const decision = params.onLoopClose
                  ? await params.onLoopClose(closeState)
                  : "stop"; // fail closed: no handler → stop

                // TODO: TD-010-D — implement ask_reviewer and modify options.
                if (decision !== "continue") {
                  currentLoop.active = false;
                  loopStack.pop();
                  loopClosed = true;
                  failureError = `Loop "${currentLoop.loopStepId}" exceeded max_iterations (${currentLoop.max_iterations}). Human gate decision: ${decision}.`;
                  overallSuccess = false;
                  failedStepIndex = i;
                  break;
                }
                // "continue" → add 2 more iterations
                currentLoop.max_iterations += 2;
              }

              // Record current iteration before jumping back
              // Record the PREVIOUS iteration (currentLoop.iteration was already incremented above)
              // This off-by-one is correct: we record iteration N before jumping to N+1
              currentLoop.iterations.push({
                iteration: currentLoop.iteration - 1,
                stepResults: stepResults
                  .filter((r) => r.loopIteration === currentLoop.iteration - 1)
                  .map((r) => ({
                    stepId: r.id,
                    status: r.status,
                    error: r.error,
                  })),
              });

              // Jump back to target step
              const targetIndex = resolvedFlow.steps.findIndex(
                (s) => s.id === currentLoop.target,
              );
              if (targetIndex >= 0) {
                i = targetIndex - 1; // -1 because i++ happens next
              }
              continue;
            }
          } else if (reviewerOutput.status === "failed") {
            // Reviewer explicitly failed — pop loop immediately
            currentLoop.active = false;
            loopStack.pop();
          } else {
            // status === "success": check exit condition
            if (exitMet) {
              // Exit condition met — pop loop from stack
              recordFinalIteration(currentLoop);
              currentLoop.active = false;
              loopStack.pop();
            }
            // If exit not met on success, loop stays active — next iteration will check
          }
        }
      }
    } else {
      const errorMsg = jobResult.error ?? "Unknown error";
      const isSecurityViolation = errorMsg.startsWith("BANNED ACTION:");

      // ── R-012/REQ-6: Security violation — log, escalate, stop ──────
      if (isSecurityViolation) {
        decisionLogger.logViolation({
          schema_version: "0.1.0",
          event_id: randomUUID(),
          timestamp: new Date().toISOString(),
          execution_id: executionId,
          session_id: jobResult.sessionId || "pending",
          step_id: step.id,
          actor: "harness",
          action: "tool_result",
          data: { error: errorMsg },
        }).catch(() => {});

        const escalationCallback = params.onEscalation ?? escalateToUser;
        await escalationCallback({
          type: "security_violation",
          reason: "BANNED action attempted by LLM",
          events: [],
          executionId,
          stepId: step.id,
          attemptedAction: errorMsg,
          projectRoot: projectDir,
        });
        // Security violations are always fatal; fall through to step failure
      }

      stepResults.push({
        id: step.id,
        status: "failed",
        error: errorMsg,
        wasDelegated: true,
        role: step.role,
        model: stepModel,
        childSessionId: jobResult.sessionId,
        loopIteration: currentLoop?.active ? currentLoop.iteration : undefined,
      });
      await appendStepEvent(
        executionDir,
        executionId,
        "step_failed",
        step.id,
        { error: errorMsg, session_id: jobResult.sessionId },
      );

      // ── R-012/REQ-7: Log step failure decision ───────────────────
      decisionLogger.logDecision({
        schema_version: "0.1.0",
        event_id: randomUUID(),
        timestamp: new Date().toISOString(),
        execution_id: executionId,
        session_id: jobResult.sessionId,
        step_id: step.id,
        actor: "controller",
        action: "tool_result",
        data: { error: errorMsg },
      }).catch(() => {});

      failureError = errorMsg;
      overallSuccess = false;
      failedStepIndex = i;
      loopStack.length = 0; // Clear all loops on step failure
      break;
    }
  }

  // ── R-010: Clean up any remaining active loops (flow completed normally) ──
  while (loopStack.length > 0) {
    const remainingLoop = loopStack[loopStack.length - 1] as LoopState;
    recordFinalIteration(remainingLoop);
    remainingLoop.active = false;
    loopStack.pop();
  }

  // ── Record remaining steps as skipped (pipeline stopped early) ──
  if (!overallSuccess) {
    for (let i = failedStepIndex + 1; i < resolvedFlow.steps.length; i++) {
      const step = resolvedFlow.steps[i]!;
      let remainingModel: string;
      try {
        const stepRoleDef = resolveRole(registry, step.role);
        remainingModel = stepRoleDef.model;
      } catch {
        remainingModel = effectiveModel;
      }
      stepResults.push({
        id: step.id,
        status: "skipped",
        error: `Skipped: pipeline stopped due to earlier failure at step "${resolvedFlow.steps[failedStepIndex]!.id}"`,
        wasDelegated: false,
        role: step.role,
        model: remainingModel,
      });
    }
  }

  // ── Step 5: Write aggregate result.json ─────────────────────────
  const aggregateResult = {
    schema_version: "0.2.0" as const,
    timestamp: new Date().toISOString(),
    flow_provenance: resolvedFlow.provenance,
    overall_success: overallSuccess,
    error: failureError ?? null,
    compiled_flow_package_dir: join(executionDir, "flow-package"),
    steps: stepResults.map((r) => ({
      id: r.id,
      status: r.status,
      error: r.error ?? null,
    })),
  };

  const resultPath = join(executionDir, RESULT_ARTIFACT_NAME);

  await validateResultAgainstContracts(
    aggregateResult as Record<string, unknown>,
  );

  await writeAtomicJson(
    resultPath,
    aggregateResult as Record<string, unknown>,
    FlowAggregateResultSchema,
  );

  // ── Step 6: Update execution manifest ───────────────────────────
  const manifest = await readExecutionManifest(executionDir);
  if (!manifest) {
    throw new Error(
      `Execution manifest not found at "${executionDir}" — ` +
      "cannot update terminal status. The execution directory may be corrupted.",
    );
  }
  await writeExecutionManifest(executionDir, {
    ...manifest,
    status: overallSuccess ? "complete" : "failed",
  });

  // ── Step 7: Emit execution_completed event ─────────────────────
  try {
    await appendExecutionEvent(executionDir, {
      type: overallSuccess ? "execution_completed" : "execution_failed",
      execution_id: executionId,
      timestamp: new Date().toISOString(),
      detail: {
        overall_success: overallSuccess,
        step_count: stepResults.length,
        session_count: sessionIds.length,
      },
    });
  } catch {
    // Best-effort: event logging is diagnostic
  }

  // ── Post-run artifact validation (Governance §E1) ──────────────────
  // Re-validate that all artifacts on disk are schema-conformant
  try {
    const resultPath = join(executionDir, "result.json");
    if (existsSync(resultPath)) {
      const resultJson = JSON.parse(await readFile(resultPath, "utf-8"));
      const parsed = FlowAggregateResultSchema.safeParse(resultJson);
      if (!parsed.success) {
        logger.error(`[zao] Post-run validation FAILED: result.json is not conformant: ${parsed.error.message}`);
      }
    }
    // Re-validate index.jsonl lines
    const indexPath = join(executionDir, "index.jsonl");
    if (existsSync(indexPath)) {
      const lines = (await readFile(indexPath, "utf-8")).trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          JSON.parse(line);
        } catch {
          logger.error(`[zao] Post-run validation: corrupted index line: ${line.substring(0, 80)}...`);
        }
      }
    }
  } catch (err) {
    logger.error(`[zao] Post-run validation error: ${(err as Error).message}`);
  }

  // ── Step 7b: Sandbox lifecycle — apply or discard ──────────────
  if (sandbox) {
    if (overallSuccess) {
      // Apply worktree changes to the original repo
      try {
        await applySandboxChanges(sandbox);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        // Applying the diff failed — execution is still a logical failure
        // because the changes weren't persisted.
        logger.error(`[zao] Failed to apply sandbox changes: ${message}`);
        if (!failureError) {
          failureError = `Sandbox apply failed: ${message}`;
        }
        overallSuccess = false;
      }
    }
    // Discard sandbox (regardless of apply result)
    try {
      await discardSandbox(sandbox);
    } catch {
      // Best-effort: sandbox cleanup should not mask the execution result
    }
  }

  return {
    success: overallSuccess,
    executionId,
    executionDir,
    flowPackageDir: join(executionDir, "flow-package"),
    sessionIds,
    error: failureError,
    steps: stepResults.map((r) => ({
      id: r.id,
      status: r.status,
      role: r.role,
      model: r.model,
      ...(r.childSessionId ? { sessionId: r.childSessionId } : {}),
      ...(r.toolCalls && r.toolCalls.length > 0 ? { toolCalls: r.toolCalls } : {}),
    })),
    tokenUsage: {
      prompt: totalPromptTokens,
      completion: totalCompletionTokens,
    },
  };
}

// ── Re-exports ─────────────────────────────────────────────────────

export { parseWhenExpression } from "./flow-loader.ts";
export type { ResolvedFlow } from "./flow-loader.ts";
export type { CompiledFlowPackage } from "./flow-package/index.ts";
