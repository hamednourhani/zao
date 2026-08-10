/**
 * Role Registry tests — TD-029-A, updated for R-006A.
 *
 * R-006A Cleanup: `loadRoleRegistry()` has been removed. Role resolution
 * now uses the flow-package system. This test file retains:
 * - resolveRole (unknown role → fail closed)
 * - generateOrchestrationSpec (snapshot generation)
 * - Prompt template safety
 * - Schema validation for role definitions
 * - Test fixtures
 *
 * @module role-registry.test
 */

import { describe, expect, test } from "bun:test";
import {
  resolveRole,
  generateOrchestrationSpec,
  UnknownRoleError,
} from "../src/role-registry.ts";
import {
  RoleDefinitionSchema,
  RolesFileSchema,
  renderPromptTemplate,
} from "../src/schemas/role-definition.ts";
import type { ResolvedRoleDefinition } from "../src/schemas/role-definition.ts";
import type { RoleRegistry } from "../src/role-registry.ts";

// ── Fixtures ────────────────────────────────────────────────────────

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

const PLANNER_DEF: ResolvedRoleDefinition = {
  prompt_template: PROMPT_PLANNER,
  context_budget: 0.70,
  model: "deepseek-chat",
  llm_id: "deepseek:deepseek-chat",
  provenance: "defaults/flows/default/roles.yaml",
  model_provenance: "defaults/flows/default/roles.yaml",
};

const DEVELOPER_DEF: ResolvedRoleDefinition = {
  prompt_template: PROMPT_DEVELOPER,
  context_budget: 0.65,
  model: "deepseek-chat",
  llm_id: "deepseek:deepseek-chat",
  provenance: "defaults/flows/default/roles.yaml",
  model_provenance: "defaults/flows/default/roles.yaml",
};

const REVIEWER_DEF: ResolvedRoleDefinition = {
  prompt_template: PROMPT_REVIEWER,
  context_budget: 0.40,
  model: "deepseek-chat",
  llm_id: "deepseek:deepseek-chat",
  provenance: "defaults/flows/default/roles.yaml",
  model_provenance: "defaults/flows/default/roles.yaml",
};

const ARCHITECT_DEF: ResolvedRoleDefinition = {
  prompt_template: PROMPT_ARCHITECT,
  context_budget: 0.60,
  model: "deepseek-chat",
  llm_id: "deepseek:deepseek-chat",
  provenance: "defaults/flows/default/roles.yaml",
  model_provenance: "defaults/flows/default/roles.yaml",
};

const ROLE_DEFS: Record<string, ResolvedRoleDefinition> = {
  planner: PLANNER_DEF,
  developer: DEVELOPER_DEF,
  reviewer: REVIEWER_DEF,
  architect: ARCHITECT_DEF,
};

function createTestRegistry(overrides?: {
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

function getRoleDef(roleName: string): ResolvedRoleDefinition {
  const def = ROLE_DEFS[roleName];
  if (!def) {
    throw new Error(`No test fixture for role: ${roleName}`);
  }
  return def;
}

// ── T2: Unknown role → fail closed ──────────────────────────────────

describe("Role Registry — T2: Unknown role fail-closed", () => {
  test("resolveRole throws for unknown role", () => {
    const registry = createTestRegistry();
    expect(() => resolveRole(registry, "invalid_role_xyz")).toThrow(
      UnknownRoleError,
    );
  });

  test("UnknownRoleError contains helpful message", () => {
    const registry = createTestRegistry();
    try {
      resolveRole(registry, "my_custom_role");
      throw new Error("Should have thrown");
    } catch (error) {
      expect(error instanceof UnknownRoleError).toBe(true);
      const msg = (error as Error).message;
      expect(msg).toContain("my_custom_role");
      expect(msg).toContain("Available roles");
    }
  });
});

// ── T3: Invalid schema validation → fail closed ─────────────────────

describe("Role Registry — T3: Fail-closed on invalid input", () => {
  test("rejects role definition with context_budget > 1", () => {
    const testObject = {
      schema_version: "0.3.0" as const,
      model_defaults: { default_llm_id: "test" },
      roles: {
        dev: { prompt_template: "hi", context_budget: 1.5, llm_id: null },
      },
    };

    const result = RolesFileSchema.safeParse(testObject);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("context_budget");
    }
  });

  test("rejects role definition with empty prompt_template", () => {
    const result = RoleDefinitionSchema.safeParse({
      prompt_template: "",
      context_budget: 0.5,
      llm_id: null,
    });

    expect(result.success).toBe(false);
  });
});

// ── T8: Orchestration spec ──────────────────────────────────────────

describe("Role Registry — T8: Orchestration spec", () => {
  test("generateOrchestrationSpec produces valid spec with all roles", () => {
    const registry = createTestRegistry();
    const spec = generateOrchestrationSpec(registry);

    expect(spec.schema_version).toBe("0.2.0");
    expect(typeof spec.generated_at).toBe("string");
    expect(spec.default_model).toBe("deepseek-chat");

    const roles = spec.roles as Record<string, unknown>;
    expect(roles.developer).toBeDefined();
    expect(roles.planner).toBeDefined();
    expect(roles.reviewer).toBeDefined();
    expect(roles.architect).toBeDefined();

    const devRole = roles.developer as Record<string, unknown>;
    expect(devRole.prompt_template).toBe(DEVELOPER_DEF.prompt_template);
    expect(devRole.context_budget).toBe(0.65);
    expect(devRole.model).toBe("deepseek-chat");
    expect(devRole.provenance).toBe("defaults/flows/default/roles.yaml");
  });

  test("orchestration spec includes provenance for each role", () => {
    const registry = createTestRegistry();
    const spec = generateOrchestrationSpec(registry);

    const roles = spec.roles as Record<string, Record<string, unknown>>;
    for (const roleName of ["planner", "developer", "reviewer", "architect"]) {
      expect(roles[roleName]!.provenance).toBeDefined();
    }
  });

  test("generateOrchestrationSpec returns immutable-like snapshot", () => {
    const registry = createTestRegistry({
      defaultModel: "original-model",
    });

    const spec = generateOrchestrationSpec(registry);

    registry.defaultModel = "mutated-model";
    registry.roles.set("developer", {
      prompt_template: "mutated",
      context_budget: 0.99,
      model: "mutated-model",
      llm_id: "deepseek:mutated-model",
      provenance: "test",
      model_provenance: "test",
    });

    expect(spec.default_model).toBe("original-model");
    const devRole = (spec.roles as Record<string, Record<string, unknown>>).developer!;
    expect(devRole.prompt_template).toBe(DEVELOPER_DEF.prompt_template);
    expect(devRole.model).toBe("deepseek-chat");
    expect(devRole.context_budget).toBe(0.65);
  });
});

// ── T9: Prompt template safety ──────────────────────────────────────

describe("Role Registry — T9: Prompt template safety", () => {
  test("substitutes known variables correctly", () => {
    const result = renderPromptTemplate("Hello {{name}}, your task is {{task}}", {
      name: "Developer",
      task: "Write code",
    });

    expect(result).toBe("Hello Developer, your task is Write code");
  });

  test("rejects eval-like syntax in template", () => {
    expect(() =>
      renderPromptTemplate("Execute {{eval(code)}}", { code: "alert(1)" }),
    ).toThrow(/forbidden eval/i);
  });

  test("rejects exec-like syntax in template", () => {
    expect(() =>
      renderPromptTemplate("{{exec(cmd)}}", { cmd: "ls" }),
    ).toThrow(/forbidden eval/i);
  });

  test("rejects function-like syntax in template", () => {
    expect(() =>
      renderPromptTemplate("{{function() { return 1; }}}", {}),
    ).toThrow(/forbidden eval/i);
  });

  test("rejects constructor-like syntax in template", () => {
    expect(() =>
      renderPromptTemplate("{{constructor}}", {}),
    ).toThrow(/forbidden eval/i);
  });

  test("rejects unknown variable placeholder", () => {
    expect(() =>
      renderPromptTemplate("Hello {{unknown_var}}", { name: "Dev" }),
    ).toThrow(/Unknown template variable.*unknown_var/);
  });

  test("allows valid variable names with underscores and numbers", () => {
    const result = renderPromptTemplate(
      "{{task_name}} and {{step_1}}",
      { task_name: "Build", step_1: "First" },
    );
    expect(result).toBe("Build and First");
  });

  test("handles template with no variables", () => {
    const result = renderPromptTemplate("Just a static prompt.", {});
    expect(result).toBe("Just a static prompt.");
  });
});

// ── Test registry fixture ───────────────────────────────────────────

describe("Role Registry — fixtures", () => {
  test("createTestRegistry returns all four standard roles", () => {
    const registry = createTestRegistry();
    expect(registry.roles.size).toBe(4);
    expect(registry.roles.has("planner")).toBe(true);
    expect(registry.roles.has("developer")).toBe(true);
    expect(registry.roles.has("reviewer")).toBe(true);
    expect(registry.roles.has("architect")).toBe(true);
  });

  test("getRoleDef returns correct definition for each role", () => {
    expect(getRoleDef("developer").context_budget).toBe(0.65);
    expect(getRoleDef("planner").context_budget).toBe(0.70);
    expect(getRoleDef("reviewer").context_budget).toBe(0.40);
    expect(getRoleDef("architect").context_budget).toBe(0.60);
  });

  test("createTestRegistry with role overrides works", () => {
    const registry = createTestRegistry({
      defaultModel: "gpt-4o",
      roles: {
        developer: { model: "gpt-4-turbo" },
      },
    });

    expect(registry.defaultModel).toBe("gpt-4o");
    const dev = registry.roles.get("developer")!;
    expect(dev.model).toBe("gpt-4-turbo");
    const planner = registry.roles.get("planner")!;
    expect(planner.model).toBe("deepseek-chat");
  });
});

// ── Model provenance tracking ───────────────────────────────────────

describe("Role Registry — Model provenance", () => {
  test("orchestration spec includes model_provenance per role", () => {
    const registry = createTestRegistry();
    const spec = generateOrchestrationSpec(registry);

    const roles = spec.roles as Record<string, Record<string, unknown>>;
    for (const roleName of ["planner", "developer", "reviewer", "architect"]) {
      expect(roles[roleName]!.model_provenance).toBeDefined();
      expect(typeof roles[roleName]!.model_provenance).toBe("string");
    }
  });
});

// ── MED-004: Role name constraints ──────────────────────────────────

describe("Role Registry — MED-004: Role name constraints", () => {
  test("rejects role names with dots", () => {
    const result = RolesFileSchema.safeParse({
      schema_version: "0.3.0" as const,
      model_defaults: { default_llm_id: "test" },
      roles: {
        "bad.role": { prompt_template: "hi", context_budget: 0.5, llm_id: null },
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects role names with slashes (path traversal)", () => {
    const result = RolesFileSchema.safeParse({
      schema_version: "0.3.0" as const,
      model_defaults: { default_llm_id: "test" },
      roles: {
        "../../../x": { prompt_template: "hi", context_budget: 0.5, llm_id: null },
      },
    });
    expect(result.success).toBe(false);
  });

  test("accepts valid role names (lowercase, numbers, underscores, hyphens)", () => {
    const result = RolesFileSchema.safeParse({
      schema_version: "0.3.0" as const,
      model_defaults: { default_llm_id: "test" },
      roles: {
        "my_role": { prompt_template: "hi", context_budget: 0.5, llm_id: null },
        "role_2": { prompt_template: "hi", context_budget: 0.5, llm_id: null },
        "code-reviewer": { prompt_template: "hi", context_budget: 0.5, llm_id: null },
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects role names starting with underscore", () => {
    const result = RolesFileSchema.safeParse({
      schema_version: "0.3.0" as const,
      model_defaults: { default_llm_id: "test" },
      roles: {
        "_private": { prompt_template: "hi", context_budget: 0.5, llm_id: null },
      },
    });
    expect(result.success).toBe(false);
  });
});

// ── Edge cases (schema-level) ───────────────────────────────────────

describe("Role Registry — Edge cases", () => {
  test("rejects YAML with unexpected keys (strict schema)", () => {
    const testObject = {
      schema_version: "0.3.0" as const,
      model_defaults: { default_llm_id: "test" },
      roles: {
        dev: {
          prompt_template: "hi",
          context_budget: 0.5,
          llm_id: null,
          unexpected_field: "should not be here",
        },
      },
    };

    const result = RolesFileSchema.safeParse(testObject);
    expect(result.success).toBe(false);
  });

  test("rejects YAML with unexpected top-level keys", () => {
    const testObject = {
      schema_version: "0.3.0" as const,
      model_defaults: { default_llm_id: "test" },
      roles: {
        dev: { prompt_template: "hi", context_budget: 0.5, llm_id: null },
      },
      unexpected_top_level: "bad",
    };

    const result = RolesFileSchema.safeParse(testObject);
    expect(result.success).toBe(false);
  });

  test("role definition with 0 context_budget is valid", () => {
    const result = RoleDefinitionSchema.safeParse({
      prompt_template: "Minimal prompt",
      context_budget: 0,
      llm_id: null,
    });
    expect(result.success).toBe(true);
  });

  test("role definition with 1.0 context_budget is valid", () => {
    const result = RoleDefinitionSchema.safeParse({
      prompt_template: "Maximal prompt",
      context_budget: 1.0,
      llm_id: null,
    });
    expect(result.success).toBe(true);
  });
});
