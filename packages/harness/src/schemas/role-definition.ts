/**
 * Role definition schemas — the contract between mo and role config files.
 *
 * @module role-definition
 */

import { z } from "zod";

// ── Resolved Role Definition (runtime, not config) ───────────────

/**
 * Zod schema for a fully resolved role definition.
 * Used by SessionConfigSchema to validate the stored role definition at runtime.
 */
export const ResolvedRoleDefinitionSchema = z
  .object({
    prompt_template: z.string().min(1),
    context_budget: z.number().min(0).max(1),
    /** Resolved model identifier. Never null after resolution. */
    model: z.string().min(1),
    /** Canonical LLM identifier (provider:model-slug). Required for registry lookup. */
    llm_id: z.string().min(1),
    provenance: z.string().min(1),
    model_provenance: z.string().min(1),
  })
  .strict();

/**
 * A fully resolved role definition with provenance tracking.
 * This is what the rest of mo consumes — not the raw config schema.
 */
export interface ResolvedRoleDefinition {
  prompt_template: string;
  context_budget: number;
  /** Resolved model identifier. Never null after resolution. */
  model: string;
  /** Canonical LLM identifier (provider:model-slug). Used by the registry to create clients. */
  llm_id: string;
  /** Which layer provided this definition (for debugging). */
  provenance: string;
  /** Which layer supplied the effective model (may differ from provenance if inherited). */
  model_provenance: string;
}

// ── Role Registry (shared type, moved from core/role-registry.ts) ──

/**
 * A loaded role registry — a map of role name → fully resolved definition.
 * Used by tests and caller code to construct registries for role resolution.
 */
export interface RoleRegistry {
  /** Map of role name → fully resolved definition. */
  roles: Map<string, ResolvedRoleDefinition>;
  /** The effective default model after merging all layers. */
  defaultModel: string;
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
