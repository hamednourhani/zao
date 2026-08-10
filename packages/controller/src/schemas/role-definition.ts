/**
 * Role definition schemas — the Zod contracts between the controller and role config files.
 *
 * The canonical Zod schemas (`RolesFileSchema`, `RoleDefinitionSchema`,
 * `ModelDefaultsSchema`) live in `@zao/contracts/schemas/roles` and are
 * re-imported here. This file adds controller-specific runtime types
 * (`ResolvedRoleDefinition`, `RolesSubtreeSchema`) and the
 * `renderPromptTemplate` engine.
 *
 * ## v0.3.0 (TD-033)
 *
 * - Renamed `model` → `llm_id` in role definitions (nullable = inherit default).
 * - Renamed `model_defaults.default` → `model_defaults.default_llm_id`.
 * - Removed `model_config` field (replaced by `llm_id` + `@zao/llm-clients` registry).
 *
 * @module role-definition
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

// Re-export the shared schemas for controller consumers.
export { RolesFileSchema, RoleDefinitionSchema, ModelDefaultsSchema };
export type { RolesFile, RoleDefinition, ModelDefaults };

// ── Local Constants ──────────────────────────────────────────────

/** Validated role name pattern — must start with a letter (a-z), then letters/numbers/underscores/hyphens. */
const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

// ── Controller-Specific Schemas ──────────────────────────────────

/**
 * Partial schema for the roles + model_defaults subtree — used when
 * extracting only the role-relevant sections from a file that also
 * contains other keys (e.g. `.zao/config.yaml` with flat config fields).
 * Does NOT enforce `schema_version` or `.strict()` — validated separately.
 */
export const RolesSubtreeSchema = z.object({
  model_defaults: ModelDefaultsSchema.optional(),
  roles: z.record(
    z.string().min(1).regex(ROLE_NAME_PATTERN, "Role names must use only a-z, 0-9, _, - (and start with a-z or 0-9)"),
    RoleDefinitionSchema,
  ).optional(),
});

export type RolesSubtree = z.infer<typeof RolesSubtreeSchema>;

// ── Resolved Role Definition (runtime, not config) ───────────────

/**
 * A fully resolved role definition with provenance tracking.
 * This is what the rest of the controller consumes — not the raw config schema.
 */
export interface ResolvedRoleDefinition {
  prompt_template: string;
  context_budget: number;
  /** Resolved model identifier (the model slug, e.g. "deepseek-chat"). Never null after resolution. */
  model: string;
  /** Canonical LLM identifier (provider:model-slug). Used by @zao/llm-clients registry. */
  llm_id: string;
  /** Which layer provided this definition (for debugging). */
  provenance: string;
  /** Which layer supplied the effective model (may differ from provenance if inherited). */
  model_provenance: string;
}

// ── Prompt Template Engine ────────────────────────────────────────

/**
 * Substitutes `{{variable}}` placeholders in the prompt template with
 * the provided values. Only `{{variable}}` syntax is supported —
 * anything that looks like eval or code execution is rejected.
 *
 * ## Supported variables
 *
 * | Variable | Source |
 * |---|---|
 * | `{{task}}` | The task description passed by the caller |
 * | `{{role}}` | The resolved role name |
 *
 * ## Safety
 *
 * - Templates containing `{{eval`, `{{exec`, `{{$`, or backtick-syntax
 *   are rejected with a typed error.
 * - Only known variable names are substituted. Unknown variables
 *   cause an error (fail-closed — no silent passing of unreplaced
 *   placeholders to the LLM).
 * - Variable values are interpolated as-is; no escaping is performed
 *   because the resulting prompt is not re-evaluated by any engine.
 *
 * @param template - The raw prompt_template from a role definition.
 * @param variables - Map of variable name → value to substitute.
 * @returns The rendered prompt string.
 * @throws If the template contains forbidden eval-like syntax.
 * @throws If an unknown variable placeholder is found.
 */
export function renderPromptTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  // Fail-closed: reject anything that looks like eval or code execution
  if (
    /\{\{(?:eval|exec|function|require|import|process|global|window|__|constructor|prototype|call|apply|bind|toString|valueOf|Symbol|Reflect|Proxy)/i.test(
      template,
    )
  ) {
    throw new Error(
      "Prompt template contains forbidden eval-like syntax. " +
        "Only simple {{variable}} substitution is supported.",
    );
  }

  let result = template;
  // Find all {{variable}} patterns
  const placeholderRegex = /\{\{([a-z_][a-z0-9_-]*)\}\}/gi;
  let match: RegExpExecArray | null;

  while ((match = placeholderRegex.exec(template)) !== null) {
    const varName = match[1]!;
    const fullMatch = match[0]!;

    if (!(varName in variables)) {
      throw new Error(
        `Unknown template variable: "${varName}". ` +
          `Known variables: ${Object.keys(variables).join(", ") || "(none)"}`,
      );
    }

    result = result.replaceAll(fullMatch, variables[varName]!);
  }

  return result;
}
