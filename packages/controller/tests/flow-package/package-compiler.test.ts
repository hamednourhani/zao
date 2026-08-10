/**
 * Package Compiler tests — R-006A.
 *
 * Covers:
 * - Compiling a valid package into CompiledFlowPackage
 * - Role resolution (llm_id inheritance)
 * - Semantic validation (duplicate ids, when refs, unknown roles)
 * - Fail-closed on invalid flow semantics
 *
 * @module package-compiler.test
 */

import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { compileFlowPackage } from "../../src/flow-package/package-compiler.ts";
import type { LoadedFlowPackage } from "../../src/flow-package/package-loader.ts";
import type { RolesFile } from "../../src/schemas/role-definition.ts";
import type { Flow } from "../../src/schemas/flow.ts";
import { FlowSchema } from "../../src/schemas/flow.ts";
import { resolveRole } from "../../src/role-registry.ts";

const VALID_ROLES: RolesFile = {
  schema_version: "0.3.0" as const,
  model_defaults: { default_llm_id: "deepseek:deepseek-chat" },
  roles: {
    planner: {
      prompt_template: "You are a planner.",
      context_budget: 0.70,
      llm_id: null,
    },
    developer: {
      prompt_template: "You are a developer.",
      context_budget: 0.65,
      llm_id: "deepseek:custom-dev-model",
    },
    reviewer: {
      prompt_template: "You are a reviewer.",
      context_budget: 0.40,
      llm_id: null,
    },
  },
};

function makeLoadedPackage(
  flowYaml: string,
  roles?: RolesFile,
): LoadedFlowPackage {
  const raw = parseYaml(flowYaml);
  const flow = FlowSchema.parse(raw) as Flow;
  const rolesFile = roles ?? VALID_ROLES;

  return {
    packageId: "test-compiler",
    packageVersion: "1.0.0",
    packageDir: "/tmp/test-compiler",
    flow,
    roles: rolesFile,
    rawFlow: flow as unknown as Record<string, unknown>,
    rawRoles: rolesFile as unknown as Record<string, unknown>,
  };
}

describe("compileFlowPackage", () => {
  test("compiles a valid package", () => {
    const loaded = makeLoadedPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
  - id: implement
    role: developer
    task: "Implement the feature"
`);
    const compiled = compileFlowPackage(loaded);

    expect(compiled.packageId).toBe("test-compiler");
    expect(compiled.packageVersion).toBe("1.0.0");
    expect(compiled.resolvedFlow.steps).toHaveLength(2);
    expect(compiled.resolvedFlow.provenance).toContain("test-compiler");
    expect(compiled.roleRegistry.roles.size).toBe(3);
  });

  test("resolves llm_id inheritance for roles with null", () => {
    const loaded = makeLoadedPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
`);

    const compiled = compileFlowPackage(loaded);
    const planner = resolveRole(compiled.roleRegistry, "planner");

    // planner has llm_id: null → inherits default
    expect(planner.llm_id).toBe("deepseek:deepseek-chat");
    expect(planner.model).toBe("deepseek-chat");
  });

  test("respects explicit llm_id on role", () => {
    const loaded = makeLoadedPackage(`
schema_version: "0.2.0"
steps:
  - id: implement
    role: developer
    task: "Implement the feature"
`);

    const compiled = compileFlowPackage(loaded);
    const developer = resolveRole(compiled.roleRegistry, "developer");

    // developer has llm_id: "deepseek:custom-dev-model" → uses explicit
    expect(developer.llm_id).toBe("deepseek:custom-dev-model");
    expect(developer.model).toBe("custom-dev-model");
  });

  test("rejects duplicate step ids", () => {
    const loaded = makeLoadedPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
  - id: plan
    role: developer
    task: "Implement the feature"
`);

    expect(() => compileFlowPackage(loaded)).toThrow(/Duplicate/);
  });

  test("rejects when referencing unknown step", () => {
    const loaded = makeLoadedPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
  - id: implement
    role: developer
    task: "Implement the feature"
    when: nonexistent.status == "success"
`);

    expect(() => compileFlowPackage(loaded)).toThrow(/nonexistent/);
  });

  test("rejects when referencing later step", () => {
    const loaded = makeLoadedPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
    when: review.status == "success"
  - id: review
    role: reviewer
    task: "Review the code"
`);

    expect(() => compileFlowPackage(loaded)).toThrow(/earlier/);
  });

  test("rejects unknown role in flow step", () => {
    const loaded = makeLoadedPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: nonexistent_role
    task: "Do the job"
`);

    expect(() => compileFlowPackage(loaded)).toThrow(/nonexistent_role/);
  });

  test("accepts valid when references to earlier steps", () => {
    const loaded = makeLoadedPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
  - id: implement
    role: developer
    task: "Implement the feature"
    when: plan.status == "success"
  - id: review
    role: reviewer
    task: "Review the code"
    when: implement.status == "success"
`);

    const compiled = compileFlowPackage(loaded);
    expect(compiled.resolvedFlow.steps).toHaveLength(3);
    expect(compiled.resolvedFlow.steps[1]!.when).toBe('plan.status == "success"');
  });

  test("accepts when referencing failed status", () => {
    const loaded = makeLoadedPackage(`
schema_version: "0.2.0"
steps:
  - id: implement
    role: developer
    task: "Implement the feature"
  - id: notify
    role: planner
    task: "Plan the work"
    when: implement.status == "failed"
`);

    const compiled = compileFlowPackage(loaded);
    expect(compiled.resolvedFlow.steps).toHaveLength(2);
  });
});
