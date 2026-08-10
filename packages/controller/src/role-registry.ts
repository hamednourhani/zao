/**
 * Role Registry — types and utilities for agent role definitions.
 *
 * ## R-006A Cleanup
 *
 * `loadRoleRegistry()` (the 3-layer loader) has been removed. Role
 * resolution now uses the flow-package system. Each flow package
 * bundles its own roles; the global multi-layer registry is no longer
 * loaded at runtime.
 *
 * This module retains:
 * - `RoleRegistry` — the runtime registry type
 * - `resolveRole()` — role lookup with fail-closed error
 * - `generateOrchestrationSpec()` — snapshot generation for execution record
 * - `UnknownRoleError` — typed error for missing roles
 * - `OrchestrationSpecSchema` / `OrchestrationSpec` — snapshot schema
 *
 * @module role-registry
 */

import type { ResolvedRoleDefinition } from "./schemas/role-definition.ts";
import { z } from "zod";

// ── Types ───────────────────────────────────────────────────────────

/**
 * A loaded role registry — maps role names to fully resolved definitions.
 */
export interface RoleRegistry {
  /** Map of role name → fully resolved definition. */
  roles: Map<string, ResolvedRoleDefinition>;
  /** The effective default model after merging all layers. */
  defaultModel: string;
}

/**
 * Error thrown when a role name is not found in the registry.
 */
export class UnknownRoleError extends Error {
  constructor(
    public readonly roleName: string,
    public readonly availableRoles: string[],
  ) {
    super(
      `Unknown role: "${roleName}". ` +
        `Available roles: ${availableRoles.join(", ") || "(none)"}`,
    );
    this.name = "UnknownRoleError";
  }
}

// ── Role Resolution ──────────────────────────────────────────────────

/**
 * Resolves a role by name from the registry.
 *
 * ## Fail-closed
 *
 * Unknown role names throw `UnknownRoleError` — never proceed to the
 * LLM with a silent fallback. The caller must handle this explicitly.
 *
 * @param registry - The loaded `RoleRegistry`.
 * @param roleName - The role name to look up.
 * @returns The fully resolved role definition.
 * @throws {UnknownRoleError} If the role name is not found.
 */
export function resolveRole(
  registry: RoleRegistry,
  roleName: string,
): ResolvedRoleDefinition {
  const role = registry.roles.get(roleName);
  if (!role) {
    throw new UnknownRoleError(
      roleName,
      Array.from(registry.roles.keys()),
    );
  }
  return role;
}

// ── Orchestration Spec ───────────────────────────────────────────────

/** Schema for a single role entry inside an orchestration spec snapshot. */
const OrchestrationSpecRoleSchema = z
  .object({
    prompt_template: z.string().min(1),
    context_budget: z.number().min(0).max(1),
    model: z.string().min(1),
    llm_id: z.string().min(1),
    provenance: z.string().min(1),
    model_provenance: z.string().min(1).optional(),
  })
  .strict();

/** Schema for a flow step as recorded inside an orchestration spec snapshot. */
const OrchestrationSpecFlowStepSchema = z
  .object({
    id: z.string().min(1),
    role: z.string().min(1),
    task: z.string().min(1),
    when: z.string().nullable().optional(),
    context: z.string().nullable().optional(),
    /** Optional receive_from for context pull (R-010). */
    receive_from: z.array(z.string().min(1)).nullable().optional(),
    /** Optional tool declarations for this step (R-009). */
    tools: z.array(z
      .object({
        tool: z.string().min(1),
        scope: z.string().min(1),
        requires_approval: z.boolean().optional(),
      })
    ).nullable().optional(),
    /** Optional loop configuration (R-010). */
    loop: z
      .object({
        target: z.string().min(1),
        max_iterations: z.number().int().min(1).max(10),
        exit_when: z.string().min(1),
      })
      .passthrough() // allow optional context_budget
      .nullable()
      .optional(),
    /** Optional output specification (R-010). */
    output_spec: z
      .object({
        status: z.enum(["success", "failed", "requires_actions"]),
      })
      .passthrough() // allow optional findings, recommended_next
      .nullable()
      .optional(),
  })
  .strict();

/** Schema for the orchestration spec snapshot written at run start (ADR-005 #8). */
export const OrchestrationSpecSchema = z
  .object({
    schema_version: z.literal("0.2.0"),
    generated_at: z.string().min(1),
    default_model: z.string().min(1),
    /** The package ID from the flow package used for this execution. Used during resume drift detection. */
    flow_package_package_id: z.string().min(1).optional(),
    roles: z.record(z.string().min(1), OrchestrationSpecRoleSchema),
    flow: z
      .object({
        schema_version: z.string().min(1),
        provenance: z.string().min(1),
        steps: z.array(OrchestrationSpecFlowStepSchema),
      })
      .strict()
      .optional(),
    /** Embedded flow package snapshot — enables reconstruction on resume without legacy roles+flow fallback. */
    flow_package: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type OrchestrationSpec = z.infer<typeof OrchestrationSpecSchema>;

/**
 * Generates the full orchestration spec snapshot from a resolved registry.
 * This is written to `orchestration-spec.json` at run start (ADR-005 #8).
 *
 * @param registry - The loaded role registry.
 * @returns A plain object ready for JSON serialization.
 */
export function generateOrchestrationSpec(
  registry: RoleRegistry,
): OrchestrationSpec {
  const roles: Record<string, z.infer<typeof OrchestrationSpecRoleSchema>> = {};
  for (const [name, def] of registry.roles) {
    const roleEntry: z.infer<typeof OrchestrationSpecRoleSchema> = {
      prompt_template: def.prompt_template,
      context_budget: def.context_budget,
      model: def.model,
      llm_id: def.llm_id,
      provenance: def.provenance,
      model_provenance: def.model_provenance,
    };
    roles[name] = roleEntry;
  }

  return {
    schema_version: "0.2.0",
    generated_at: new Date().toISOString(),
    default_model: registry.defaultModel,
    roles,
  };
}
