/**
 * Test fixtures for role registry — provides pre-built ResolvedRoleDefinition
 * objects and RoleRegistry instances for deterministic tests.
 *
 * These match the verbatim prompts and budgets from the shipped defaults
 * to ensure golden-test consistency.
 *
 * @module role-registry-fixtures
 */

import type { ResolvedRoleDefinition } from "../../src/schemas/role-definition.ts";
import type { RoleRegistry } from "../../src/schemas/role-definition.ts";

// ── Default prompts (verbatim from defaults/roles.yaml) ──────────

const PROMPT_PLANNER =
  "You are a planning agent. Break down complex tasks into ordered " +
  "steps with clear dependencies. Identify risks, prerequisites, " +
  "and decision points before execution begins.";

const PROMPT_DEVELOPER =
  "You are a developer agent. Write production-quality code following " +
  "the project's conventions and patterns. Prioritize readability, " +
  "defensive error handling, and comprehensive type safety.";

const PROMPT_REVIEWER =
  "You are a code reviewer. Analyze code for security vulnerabilities, " +
  "correctness issues, and adherence to conventions. Identify edge " +
  "cases, potential bugs, and deviations from established patterns.";

const PROMPT_ARCHITECT =
  "You are an architect. Design systems, choose appropriate patterns, " +
  "and define clear interfaces between components. Evaluate tradeoffs " +
  "and document the rationale behind each design decision.";

// ── ResolvedRoleDefinition fixtures ─────────────────────────────

export const PLANNER_DEF: ResolvedRoleDefinition = {
  prompt_template: PROMPT_PLANNER,
  context_budget: 0.70,
  model: "deepseek-chat",
  llm_id: "deepseek:deepseek-chat",
  provenance: "defaults/roles.yaml",
  model_provenance: "defaults/roles.yaml",
};

export const DEVELOPER_DEF: ResolvedRoleDefinition = {
  prompt_template: PROMPT_DEVELOPER,
  context_budget: 0.65,
  model: "deepseek-chat",
  llm_id: "deepseek:deepseek-chat",
  provenance: "defaults/roles.yaml",
  model_provenance: "defaults/roles.yaml",
};

export const REVIEWER_DEF: ResolvedRoleDefinition = {
  prompt_template: PROMPT_REVIEWER,
  context_budget: 0.40,
  model: "deepseek-chat",
  llm_id: "deepseek:deepseek-chat",
  provenance: "defaults/roles.yaml",
  model_provenance: "defaults/roles.yaml",
};

export const ARCHITECT_DEF: ResolvedRoleDefinition = {
  prompt_template: PROMPT_ARCHITECT,
  context_budget: 0.60,
  model: "deepseek-chat",
  llm_id: "deepseek:deepseek-chat",
  provenance: "defaults/roles.yaml",
  model_provenance: "defaults/roles.yaml",
};

/** Map of role name → ResolvedRoleDefinition (for convenience). */
export const ROLE_DEFS: Record<string, ResolvedRoleDefinition> = {
  planner: PLANNER_DEF,
  developer: DEVELOPER_DEF,
  reviewer: REVIEWER_DEF,
  architect: ARCHITECT_DEF,
};

// ── RoleRegistry fixture (test-only) ────────────────────────────

/**
 * Returns a pre-built RoleRegistry containing the four standard roles.
 * This avoids loading the defaults/roles.yaml file on disk in tests.
 *
 * @param overrides - Optional per-role overrides and default model override.
 * @returns A RoleRegistry with the four standard roles.
 */
export function createTestRegistry(overrides?: {
  defaultModel?: string;
  roles?: Record<string, Partial<ResolvedRoleDefinition>>;
}): RoleRegistry {
  const defaultModel = overrides?.defaultModel ?? "deepseek-chat";
  const roleOverrides = overrides?.roles ?? {};

  const roles = new Map<string, ResolvedRoleDefinition>();
  for (const [name, baseDef] of Object.entries(ROLE_DEFS)) {
    const override = roleOverrides[name];
    roles.set(name, {
      prompt_template: override?.prompt_template ?? baseDef!.prompt_template,
      context_budget: override?.context_budget ?? baseDef!.context_budget,
      model: override?.model ?? baseDef!.model,
      llm_id: override?.llm_id ?? baseDef!.llm_id,
      provenance: override?.provenance ?? baseDef!.provenance,
      model_provenance: override?.model_provenance ?? baseDef!.model_provenance,
    });
  }

  return { roles, defaultModel };
}

// ── Helpers for context tests ────────────────────────────────────

/**
 * Returns a ResolvedRoleDefinition for a given role name.
 * Uses the standard defaults. Throws for unknown roles.
 */
export function getRoleDef(roleName: string): ResolvedRoleDefinition {
  const def = ROLE_DEFS[roleName];
  if (!def) {
    throw new Error(`No test fixture for role: ${roleName}`);
  }
  return def;
}
