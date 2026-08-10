/**
 * Blueprint Compiler tests — R-006B.
 *
 * Covers:
 * - Compiling a valid blueprint with task substitution
 * - {task} placeholder substitution into task field
 * - context_spec mapping to flow step context
 * - Semantic validation (duplicate ids, when refs, missing {task})
 * - Role validation (unknown roles)
 * - Fail-closed on invalid input
 *
 * @module blueprint-compiler.test
 */

import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { compileBlueprint } from "../src/blueprint-compiler.ts";
import type { LoadedBlueprintPackage } from "../src/blueprint-loader.ts";
import type { RolesFile } from "../src/schemas.ts";
import type { Blueprint } from "../src/schemas.ts";
import { BlueprintSchema } from "../src/schemas.ts";

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

function makeLoadedBlueprint(
  blueprintYaml: string,
  roles?: RolesFile,
): LoadedBlueprintPackage {
  const raw = parseYaml(blueprintYaml);
  const blueprint = BlueprintSchema.parse(raw) as Blueprint;
  const rolesFile = roles ?? VALID_ROLES;

  return {
    packageId: blueprint.blueprint_id,
    packageVersion: "1.0.0",
    packageDir: "/tmp/test-blueprint",
    blueprint,
    roles: rolesFile,
    rawBlueprint: blueprint as unknown as Record<string, unknown>,
    rawRoles: rolesFile as unknown as Record<string, unknown>,
  };
}

describe("compileBlueprint", () => {
  describe("happy path", () => {
    test("compiles a valid blueprint with task substitution", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "test-bp"
steps:
  - id: plan
    role: planner
    task_template: "Plan the implementation of {task}"
  - id: implement
    role: developer
    task_template: "Implement {task} following the plan"
`);

      const result = compileBlueprint(loaded, "user login feature");

      expect(result.blueprintId).toBe("test-bp");
      expect(result.blueprintVersion).toBe("1.0.0");
      expect(result.userTask).toBe("user login feature");

      // Flow steps should have concrete tasks
      expect(result.flow.steps).toHaveLength(2);
      expect(result.flow.schema_version).toBe("0.2.0");

      // Step 1: task should have {task} substituted
      expect(result.flow.steps[0]!.id).toBe("plan");
      expect(result.flow.steps[0]!.role).toBe("planner");
      expect(result.flow.steps[0]!.task).toBe("Plan the implementation of user login feature");
      expect(result.flow.steps[0]!.context).toBeUndefined();
      expect(result.flow.steps[0]!.when).toBeUndefined();

      // Step 2: task should have {task} substituted
      expect(result.flow.steps[1]!.id).toBe("implement");
      expect(result.flow.steps[1]!.role).toBe("developer");
      expect(result.flow.steps[1]!.task).toBe("Implement user login feature following the plan");
    });

    test("maps context_spec to flow step context", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "test-context"
steps:
  - id: plan
    role: planner
    task_template: "Plan {task}"
    context_spec: "Focus on architecture."
`);

      const result = compileBlueprint(loaded, "build API");

      expect(result.flow.steps[0]!.task).toBe("Plan build API");
      expect(result.flow.steps[0]!.context).toBe("Focus on architecture.");
    });

    test("preserves when expressions in compiled steps", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "test-when"
steps:
  - id: plan
    role: planner
    task_template: "Plan {task}"
  - id: review
    role: reviewer
    task_template: "Review {task}"
    when: plan.status == "success"
`);

      const result = compileBlueprint(loaded, "test task");

      expect(result.flow.steps[1]!.when).toBe('plan.status == "success"');
    });

    test("preserves role definitions unchanged", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "test-roles"
steps:
  - id: plan
    role: planner
    task_template: "Plan {task}"
`);

      const result = compileBlueprint(loaded, "test");

      expect(result.roles).toEqual(VALID_ROLES);
      expect(result.roles.roles.planner).toBeDefined();
    });
  });

  describe("template substitution", () => {
    test("substitutes {task} in multiple steps", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "multi-sub"
steps:
  - id: plan
    role: planner
    task_template: "First: {task}"
  - id: implement
    role: developer
    task_template: "Second: {task}"
  - id: review
    role: reviewer
    task_template: "Third: {task}"
`);

      const result = compileBlueprint(loaded, "the feature");

      expect(result.flow.steps[0]!.task).toBe("First: the feature");
      expect(result.flow.steps[1]!.task).toBe("Second: the feature");
      expect(result.flow.steps[2]!.task).toBe("Third: the feature");
    });

    test("rejects task_template without {task} placeholder", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "no-placeholder"
steps:
  - id: plan
    role: planner
    task_template: "Plan everything"
`);

      expect(() => compileBlueprint(loaded, "test"))
        .toThrow(/must contain the {task} placeholder/);
    });

    test("rejects task_template with dangerous patterns", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "dangerous-template"
steps:
  - id: plan
    role: planner
    task_template: "Plan {task} and eval(someCode)"
`);

      expect(() => compileBlueprint(loaded, "test"))
        .toThrow(/task_template contains forbidden patterns/);
    });

    test("rejects user task with dangerous patterns (HIGH-002)", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "dangerous-task"
steps:
  - id: plan
    role: planner
    task_template: "Plan {task}"
`);

      expect(() => compileBlueprint(loaded, "Refactor the eval() module"))
        .toThrow(/User task contains forbidden patterns/);
      expect(() => compileBlueprint(loaded, "import x from 'y'"))
        .toThrow(/User task contains forbidden patterns/);
    });

    test("rejects user task containing literal {task} placeholder (EDGE-2)", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "literal-task-placeholder"
steps:
  - id: plan
    role: planner
    task_template: "Plan {task}"
`);

      expect(() => compileBlueprint(loaded, "Fix the {task} issue"))
        .toThrow(/must not contain the literal "\{task\}"/);
    });

    test("accepts plain-text user task with special characters", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "plain-task"
steps:
  - id: plan
    role: planner
    task_template: "Plan {task}"
`);

      const result = compileBlueprint(
        loaded,
        "Fix bug #42 in the auth module (urgent, do it now!)",
      );
      expect(result.flow.steps[0]!.task).toBe(
        "Plan Fix bug #42 in the auth module (urgent, do it now!)",
      );
    });
  });

  describe("semantic validation", () => {
    test("rejects duplicate step ids", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "dup-ids"
steps:
  - id: plan
    role: planner
    task_template: "Plan {task}"
  - id: plan
    role: developer
    task_template: "Dev {task}"
`);

      expect(() => compileBlueprint(loaded, "test"))
        .toThrow(/Duplicate step id/);
    });

    test("rejects when referencing unknown step", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "bad-when"
steps:
  - id: plan
    role: planner
    task_template: "Plan {task}"
  - id: review
    role: reviewer
    task_template: "Review {task}"
    when: nonexistent.status == "success"
`);

      expect(() => compileBlueprint(loaded, "test"))
        .toThrow(/references unknown step/);
    });

    test("rejects when referencing later step", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "future-when"
steps:
  - id: plan
    role: planner
    task_template: "Plan {task}"
    when: implement.status == "success"
  - id: implement
    role: developer
    task_template: "Impl {task}"
`);

      expect(() => compileBlueprint(loaded, "test"))
        .toThrow(/earlier/);
    });

    test("rejects invalid when expression syntax", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "bad-when-syntax"
steps:
  - id: plan
    role: planner
    task_template: "Plan {task}"
  - id: review
    role: reviewer
    task_template: "Review {task}"
    when: "not a valid when expr"
`);

      expect(() => compileBlueprint(loaded, "test"))
        .toThrow(/invalid when expression/i);
    });

    test("rejects unknown role in blueprint step", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "bad-role"
steps:
  - id: plan
    role: nonexistent_role
    task_template: "Plan {task}"
`);

      expect(() => compileBlueprint(loaded, "test"))
        .toThrow(/unknown role/);
    });
  });

  describe("tools (R-009)", () => {
    test("compiles blueprint step with readFile tool", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "tool-test"
steps:
  - id: read
    role: developer
    task_template: "Read {task}"
    tools:
      - tool: readFile
        scope: "agent_decides"
  - id: summarize
    role: reviewer
    task_template: "Summarize {task}"
`);

      const result = compileBlueprint(loaded, "src/cli.ts");

      expect(result.flow.steps).toHaveLength(2);

      // Step 1: should have tools copied
      const readStep = result.flow.steps[0]!;
      expect(readStep.id).toBe("read");
      expect(readStep.tools).toBeDefined();
      expect(readStep.tools!).toHaveLength(1);
      expect(readStep.tools![0]!.tool).toBe("readFile");
      expect(readStep.tools![0]!.scope).toBe("agent_decides");

      // Step 2: should NOT have tools (none declared)
      const sumStep = result.flow.steps[1]!;
      expect(sumStep.tools).toBeUndefined();
    });

    test("compiles blueprint step with multiple tools", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "multi-tool"
steps:
  - id: work
    role: developer
    task_template: "Work on {task}"
    tools:
      - tool: readFile
        scope: "agent_decides"
      - tool: writeFile
        scope: "agent_decides"
        requires_approval: true
      - tool: executeShell
        scope: "agent_decides"
`);

      const result = compileBlueprint(loaded, "the feature");

      expect(result.flow.steps).toHaveLength(1);
      const step = result.flow.steps[0]!;
      expect(step.tools).toBeDefined();
      expect(step.tools!).toHaveLength(3);
      expect(step.tools![0]!.tool).toBe("readFile");
      expect(step.tools![1]!.tool).toBe("writeFile");
      expect(step.tools![1]!.requires_approval).toBe(true);
      expect(step.tools![2]!.tool).toBe("executeShell");
    });

    test("rejects blueprint step with invalid tool name", () => {
      const blueprintYaml = `
schema_version: "0.2.0"
blueprint_id: "invalid-tool"
steps:
  - id: bad
    role: developer
    task_template: "Do {task}"
    tools:
      - tool: deleteEverything
        scope: "agent_decides"
`;
      const raw = parseYaml(blueprintYaml);

      // Schema validation should reject the invalid tool name
      const result = BlueprintSchema.safeParse(raw);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain("tools");
      }
    });

    test("rejects blueprint step with missing scope", () => {
      const blueprintYaml = `
schema_version: "0.2.0"
blueprint_id: "no-scope"
steps:
  - id: bad
    role: developer
    task_template: "Do {task}"
    tools:
      - tool: readFile
`;
      const raw = parseYaml(blueprintYaml);

      const result = BlueprintSchema.safeParse(raw);
      expect(result.success).toBe(false);
    });

    test("tools are optional — step without tools compiles fine", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "no-tools"
steps:
  - id: step1
    role: developer
    task_template: "Do {task}"
`);

      const result = compileBlueprint(loaded, "the thing");
      expect(result.flow.steps).toHaveLength(1);
      expect(result.flow.steps[0]!.tools).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    test("compiles blueprint with a single step", () => {
      const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "single-step"
steps:
  - id: do
    role: developer
    task_template: "Do {task}"
`);

      const result = compileBlueprint(loaded, "the thing");
      expect(result.flow.steps).toHaveLength(1);
      expect(result.flow.steps[0]!.task).toBe("Do the thing");
    });
  });
});
