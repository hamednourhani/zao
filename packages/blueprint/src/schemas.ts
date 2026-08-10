/**
 * Blueprint package schemas — Zod contracts for blueprint packages.
 *
 * A blueprint package is a directory containing a parameterized
 * development-process template. The compiler takes a blueprint package
 * and a user task, validates everything, and produces a self-contained
 * flow package that the controller can execute.
 *
 * ## v1 scope
 *
 * - Human-authored blueprint packages with `{task}` template substitution
 * - v1 `when` grammar (reused from controller's parseWhenExpression)
 * - Self-contained roles per blueprint (no shared registry)
 * - R-010: Loop blocks for iterative flow loops with session resume
 *
 * @module schemas
 */

import { z } from "zod";
import {
  RolesFileSchema,
  RoleDefinitionSchema,
  ModelDefaultsSchema,
} from "@zao/contracts/schemas/roles";
import type {
  RolesFile,
  RoleDefinition,
  ModelDefaults,
} from "@zao/contracts/schemas/roles";

// Re-export the shared schemas for consumers that import from @zao/blueprint.
export { RolesFileSchema, RoleDefinitionSchema, ModelDefaultsSchema };
export type { RolesFile, RoleDefinition, ModelDefaults };

// ── Blueprint Package Metadata ─────────────────────────────────────

/** Schema for the `package.yaml` metadata file in a blueprint package. */
export const BlueprintPackageMetadataSchema = z.object({
  schema_version: z.literal("0.1.0"),
  package: z.object({
    /** Unique package identifier. */
    id: z.string().min(1),
    /** Semantic version of this blueprint package. */
    version: z.string().min(1),
    /** Must be "blueprint" for blueprint packages. */
    type: z.literal("blueprint"),
    /** Human-readable name. */
    name: z.string().min(1),
    /** Optional description of what this blueprint does. */
    description: z.string().optional(),
  }).strict(),
}).strict();

export type BlueprintPackageMetadata = z.infer<typeof BlueprintPackageMetadataSchema>;

// ── Tool Declaration ────────────────────────────────────────────────

/**
 * Valid tool names the agent may use at runtime.
 * These correspond to harness tool execution functions.
 */
export const VALID_TOOL_NAMES = [
  "readFile",
  "writeFile",
  "executeShell",
  "delegateToSubagent",
] as const;

export type ValidToolName = (typeof VALID_TOOL_NAMES)[number];

/**
 * Schema for a single tool declaration within a blueprint step.
 *
 * - `tool`: The tool capability (must be a valid tool name).
 * - `scope`: v1 always `"agent_decides"` — the harness persona picks
 *   the file/command at runtime.
 * - `requires_approval`: Optional flag. If true, the controller logs
 *   a warning and proceeds (R-004 not yet implemented).
 */
export const ToolDeclarationSchema = z
  .object({
    /** The tool capability. */
    tool: z.enum(VALID_TOOL_NAMES),
    /**
     * v1: always `"agent_decides"`. The harness persona picks the file
     * or command at runtime within the allowed boundaries.
     */
    scope: z.literal("agent_decides"),
    /**
     * If true, the controller should pause for human approval before
     * executing. v1: stubbed — logs a warning and auto-approves.
     */
    requires_approval: z.boolean().optional(),
  })
  .strict();

export type ToolDeclaration = z.infer<typeof ToolDeclarationSchema>;

// ── Blueprint Step ──────────────────────────────────────────────────

/**
 * Context budget schema for loop iterations (R-010).
 *
 * Tracks token usage across loop iterations and specifies a compaction
 * strategy when the budget is exceeded.
 */
export const ContextBudgetSchema = z
  .object({
    /** Maximum estimated tokens per step. */
    max_tokens_per_step: z.number().int().min(100),
    /** Maximum total estimated tokens across all loop iterations. */
    max_total_tokens: z.number().int().min(100),
    /** Strategy for compacting context when budget is exceeded. */
    compaction_strategy: z
      .enum(["summarize", "extract_key_facts", "truncate"])
      .optional(),
  })
  .strict();

export type ContextBudget = z.infer<typeof ContextBudgetSchema>;

/**
 * Loop configuration schema for iterative flow loops (R-010).
 *
 * When a step declares a `loop` block, the controller enters loop
 * tracking mode. Steps from `target` through the step with the loop
 * block form the loop body. After each pass, the exit condition
 * is evaluated; if not met, execution jumps back to the target.
 */
export const LoopConfigSchema = z
  .object({
    /** Step ID to jump back to when exit condition is not met. */
    target: z
      .string()
      .min(1)
      .regex(
        /^[a-z0-9][a-z0-9_-]*$/,
        "Loop target must use only a-z, 0-9, _, - (and start with a-z or 0-9)",
      ),
    /** Hard cap on loop iterations (1-10). Defaults to 3 if not specified. */
    max_iterations: z.number().int().min(1).max(10).default(3),
    /** When expression evaluated at the end of each full flow pass. */
    exit_when: z.string().min(1),
    /** Optional context budget tracking. */
    context_budget: ContextBudgetSchema.optional(),
  })
  .strict();

export type LoopConfig = z.infer<typeof LoopConfigSchema>;

/**
 * Output specification schema for reviewer/critic steps (R-010).
 *
 * Defines the structured output shape for steps that produce a review
 * verdict. The controller uses this to route loops (when combined with
 * a `loop` block) — a `requires_actions` status triggers a jump back to
 * the loop target.
 */
export const OutputSpecSchema = z
  .object({
    /** The review verdict status. */
    status: z.enum(["success", "failed", "requires_actions"]),
    /** Optional list of specific findings from the review. */
    findings: z.array(z.string()).min(1).optional(),
    /** Optional recommended next step ID (must match loop.target if within a loop). */
    recommended_next: z.string().min(1).optional(),
  })
  .strict();

export type OutputSpec = z.infer<typeof OutputSpecSchema>;

/**
 * Schema for a single blueprint step.
 *
 * - `id`: Unique step identifier.
 * - `role`: Role name (resolved against the blueprint's own roles).
 * - `task_template`: **REQUIRED** — the parameterized task for this step.
 *   Compiler substitutes `{task}` with the user task. This maps to the
 *   `task` field on flow steps.
 * - `context_spec`: Optional static framing text OR object with text + receive_from.
 *   Maps to the `context` field on flow steps.
 * - `when`: Optional gate condition (v1 grammar, reused from controller).
 * - `tools`: Optional tool declarations (R-009). Each tool declares
 *   a capability the agent may use at runtime. Capped at 5 per step.
 * - `loop`: Optional loop configuration (R-010). Enables iterative flow loops.
 * - `output_spec`: Optional structured output specification (R-010).
 */
/**
 * Schema for a context_spec object with receive_from (R-010).
 */
const ContextSpecObjectSchema = z
  .object({
    /** Static framing text. */
    text: z.string().min(1),
    /** Optional list of step IDs whose output context is pulled into this step. */
    receive_from: z
      .array(
        z
          .string()
          .min(1)
          .regex(
            /^[a-z0-9][a-z0-9_.-]*$/,
            "receive_from must use format step_id or step_id.field (a-z, 0-9, _, ., -)",
          ),
      )
      .min(1)
      .optional(),
  })
  .strict();

/** context_spec can be a string (backwards compat) or an object with receive_from. */
const ContextSpecSchema = z.union([
  z.string().min(1),
  ContextSpecObjectSchema,
]);

export const BlueprintStepSchema = z
  .object({
    /** Unique step identifier. Must be lowercase alphanumeric, underscores, hyphens. */
    id: z.string().min(1).regex(
      /^[a-z0-9][a-z0-9_-]*$/,
      "Step id must use only a-z, 0-9, _, - (and start with a-z or 0-9)",
    ),
    /** Role name resolved via the blueprint's role definitions. */
    role: z.string().min(1),
    /**
     * **REQUIRED** — parameterized task template. `{task}` is substituted
     * with the user's task at compile time. This becomes the flow step's
     * `task` field.
     */
    task_template: z.string().min(1),
    /**
     * Optional static framing (string) OR object with text and optional
     * receive_from for context pull from prior steps (R-010).
     * Maps to the flow step `context` field.
     */
    context_spec: ContextSpecSchema.optional(),
    /**
     * Optional gate condition.
     * v1 grammar: `"<step-id>.status == \"success\" | \"failed\""`.
     */
    when: z.string().optional(),
    /**
     * Optional tool declarations for this step (R-009).
     * v1 tools declare abstract capabilities the agent may use at runtime.
     * Capped at 5 tools per step.
     */
    tools: z.array(ToolDeclarationSchema).min(1).max(5).optional(),
    /**
     * Optional loop configuration (R-010).
     * When present, the controller may jump back to the target step
     * if the exit condition is not met.
     */
    loop: LoopConfigSchema.optional(),
    /**
     * Optional structured output specification (R-010).
     * Defines the expected shape of the step's result for loop routing.
     */
    output_spec: OutputSpecSchema.optional(),
  })
  .strict();

export type BlueprintStep = z.infer<typeof BlueprintStepSchema>;

// ── Blueprint Schema ────────────────────────────────────────────────

/**
 * Schema for the `blueprint.yaml` file in a blueprint package.
 *
 * ```yaml
 * schema_version: "0.1.0"
 * blueprint_id: "feature-development"
 * steps:
 *   - id: plan
 *     role: planner
 *     task_template: "Plan the implementation of {task}"
 *     context_spec: "Focus on architecture."
 *   - id: implement
 *     role: developer
 *     task_template: "Implement {task} following the plan"
 * ```
 */
export const BlueprintSchema = z
  .object({
    /** Schema contract version. */
    schema_version: z.literal("0.2.0"),
    /** Identifier for this blueprint (must match package id). */
    blueprint_id: z.string().min(1),
    /** Ordered list of blueprint steps. Must contain at least one step. */
    steps: z.array(BlueprintStepSchema).min(1),
  })
  .strict();

export type Blueprint = z.infer<typeof BlueprintSchema>;

// ── Compiled Step ───────────────────────────────────────────────────

/**
 * A compiled blueprint step — the result of substituting `{task}`
 * placeholders in the `task_template`. Ready to become a flow step.
 */
export interface CompiledStep {
  id: string;
  role: string;
  /** The concrete task after `{task}` substitution. */
  task: string;
  /** The optional static context for this step. */
  context?: string;
  /** Optional receive_from from context_spec (R-010). */
  receive_from?: string[];
  when?: string;
  /** Optional tool declarations inherited from the blueprint step (R-009). */
  tools?: ToolDeclaration[];
  /** Optional loop configuration (R-010). */
  loop?: LoopConfig;
  /** Optional output specification (R-010). */
  output_spec?: OutputSpec;
}

/** Zod schema for compiled step validation (R-010). */
export const CompiledStepSchema = z
  .object({
    id: z.string().min(1),
    role: z.string().min(1),
    task: z.string().min(1),
    context: z.string().optional(),
    receive_from: z.array(z.string().min(1)).optional(),
    when: z.string().optional(),
    tools: z.array(ToolDeclarationSchema).min(1).max(5).optional(),
    loop: LoopConfigSchema.optional(),
    output_spec: OutputSpecSchema.optional(),
  })
  .strict();
