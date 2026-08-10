/**
 * Blueprint loop validation tests — R-010 Iterative Flow Loops.
 *
 * Tests:
 * - TEST-L1: Valid loop config compiles successfully
 * - TEST-L2: Loop with invalid target (nonexistent step ID) → throws
 * - TEST-L3: Loop with max_iterations 0 → validation error
 * - TEST-L4: Loop with max_iterations 11 → validation error
 * - TEST-L5: Context budget without compaction_strategy compiles OK
 * - TEST-L6: output_spec with valid enum values compiles OK
 *
 * @module blueprint-loop.test
 */

import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import {
  BlueprintSchema,
  BlueprintStepSchema,
  LoopConfigSchema,
  OutputSpecSchema,
  ContextBudgetSchema,
} from "../src/schemas.ts";
import type { Blueprint } from "../src/schemas.ts";
import { compileBlueprint } from "../src/blueprint-compiler.ts";
import type { LoadedBlueprintPackage } from "../src/blueprint-loader.ts";
import type { RolesFile } from "../src/schemas.ts";

// ── Helpers ──────────────────────────────────────────────────────────

const TEST_ROLES: RolesFile = {
  schema_version: "0.3.0" as const,
  model_defaults: { default_llm_id: "deepseek:deepseek-chat" },
  roles: {
    developer: {
      prompt_template: "You are a developer agent.",
      context_budget: 0.65,
      llm_id: null,
    },
    reviewer: {
      prompt_template: "You are a code reviewer.",
      context_budget: 0.40,
      llm_id: null,
    },
    documenter: {
      prompt_template: "You are a documentation agent.",
      context_budget: 0.50,
      llm_id: null,
    },
  },
};

function makeLoaded(
  blueprintYaml: string,
  roles?: RolesFile,
): LoadedBlueprintPackage {
  const raw = parseYaml(blueprintYaml);
  const blueprint = BlueprintSchema.parse(raw) as Blueprint;
  return {
    packageId: blueprint.blueprint_id,
    packageVersion: "1.0.0",
    packageDir: "/tmp/test-bp",
    blueprint,
    roles: roles ?? TEST_ROLES,
    rawBlueprint: blueprint as unknown as Record<string, unknown>,
    rawRoles: (roles ?? TEST_ROLES) as unknown as Record<string, unknown>,
  };
}

// ── Schema Validation Tests ──────────────────────────────────────────

describe("LoopConfigSchema", () => {
  test("validates a minimal loop config", () => {
    const result = LoopConfigSchema.safeParse({
      target: "implement",
      max_iterations: 3,
      exit_when: 'review.status == "success"',
    });
    expect(result.success).toBe(true);
  });

  test("rejects target with invalid characters", () => {
    const result = LoopConfigSchema.safeParse({
      target: "INVALID-STEP",
      max_iterations: 3,
      exit_when: 'review.status == "success"',
    });
    expect(result.success).toBe(false);
  });

  test("rejects max_iterations below 1", () => {
    const result = LoopConfigSchema.safeParse({
      target: "implement",
      max_iterations: 0,
      exit_when: 'review.status == "success"',
    });
    expect(result.success).toBe(false);
  });

  test("rejects max_iterations above 10", () => {
    const result = LoopConfigSchema.safeParse({
      target: "implement",
      max_iterations: 11,
      exit_when: 'review.status == "success"',
    });
    expect(result.success).toBe(false);
  });

  test("accepts context_budget with compaction_strategy", () => {
    const result = LoopConfigSchema.safeParse({
      target: "implement",
      max_iterations: 3,
      exit_when: 'review.status == "success"',
      context_budget: {
        max_tokens_per_step: 4000,
        max_total_tokens: 16000,
        compaction_strategy: "summarize",
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts context_budget without compaction_strategy", () => {
    const result = LoopConfigSchema.safeParse({
      target: "implement",
      max_iterations: 3,
      exit_when: 'review.status == "success"',
      context_budget: {
        max_tokens_per_step: 100,
        max_total_tokens: 500,
      },
    });
    expect(result.success).toBe(true);
  });

  test("defaults max_iterations to 3 when omitted", () => {
    const result = LoopConfigSchema.safeParse({
      target: "implement",
      exit_when: 'review.status == "success"',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_iterations).toBe(3);
    }
  });
});

describe("OutputSpecSchema", () => {
  test("validates a minimal output_spec with status", () => {
    const result = OutputSpecSchema.safeParse({
      status: "success",
    });
    expect(result.success).toBe(true);
  });

  test("validates output_spec with all fields", () => {
    const result = OutputSpecSchema.safeParse({
      status: "requires_actions",
      findings: ["Missing error handling", "Untested edge case"],
      recommended_next: "implement",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid status value", () => {
    const result = OutputSpecSchema.safeParse({
      status: "pending",
    });
    expect(result.success).toBe(false);
  });

  test("rejects output_spec without status", () => {
    const result = OutputSpecSchema.safeParse({
      findings: ["issue 1"],
    });
    expect(result.success).toBe(false);
  });
});

describe("ContextBudgetSchema", () => {
  test("validates minimal context_budget", () => {
    const result = ContextBudgetSchema.safeParse({
      max_tokens_per_step: 100,
      max_total_tokens: 500,
    });
    expect(result.success).toBe(true);
  });

  test("rejects max_tokens_per_step below 100", () => {
    const result = ContextBudgetSchema.safeParse({
      max_tokens_per_step: 99,
      max_total_tokens: 500,
    });
    expect(result.success).toBe(false);
  });
});

// ── Compilation Tests ────────────────────────────────────────────────

describe("compileBlueprint with loops", () => {
  test("TEST-L1: valid loop config compiles successfully", () => {
    const loaded = makeLoaded(`
schema_version: "0.2.0"
blueprint_id: "test-loop"
steps:
  - id: implement
    role: developer
    task_template: "Implement {task}"
    loop:
      target: implement
      max_iterations: 3
      exit_when: 'review.status == "success"'
  - id: review
    role: reviewer
    task_template: "Review {task}"
    output_spec:
      status: requires_actions
      recommended_next: implement
  - id: doc
    role: documenter
    task_template: "Document {task}"
    when: review.status == "success"
`);

    const result = compileBlueprint(loaded, "test feature");
    expect(result.blueprintId).toBe("test-loop");

    // Verify loop field is preserved in compiled steps
    const implStep = result.flow.steps[0]!;
    expect(implStep.loop).toBeDefined();
    expect(implStep.loop!.target).toBe("implement");
    expect(implStep.loop!.max_iterations).toBe(3);
    expect(implStep.loop!.exit_when).toBe('review.status == "success"');

    // Verify output_spec is preserved
    const reviewStep = result.flow.steps[1]!;
    expect(reviewStep.output_spec).toBeDefined();
    expect(reviewStep.output_spec!.status).toBe("requires_actions");
  });

  test("TEST-L2: loop with invalid target (nonexistent step) throws", () => {
    const loaded = makeLoaded(`
schema_version: "0.2.0"
blueprint_id: "test-loop-bad"
steps:
  - id: implement
    role: developer
    task_template: "Implement {task}"
    loop:
      target: nonexistent-step
      max_iterations: 3
      exit_when: 'review.status == "success"'
  - id: review
    role: reviewer
    task_template: "Review {task}"
`);
    // Validation happens during compileBlueprint (semantic check), not schema parse
    expect(() => compileBlueprint(loaded, "test")).toThrow(/does not exist/);
  });

  test("TEST-L3: loop with max_iterations 0 is rejected by schema", () => {
    const result = BlueprintSchema.safeParse({
      schema_version: "0.2.0",
      blueprint_id: "test-loop-0",
      steps: [
        {
          id: "implement",
          role: "developer",
          task_template: "Implement {task}",
          loop: {
            target: "implement",
            max_iterations: 0,
            exit_when: 'review.status == "success"',
          },
        },
        {
          id: "review",
          role: "reviewer",
          task_template: "Review {task}",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("TEST-L4: loop with max_iterations 11 is rejected by schema", () => {
    const result = BlueprintSchema.safeParse({
      schema_version: "0.2.0",
      blueprint_id: "test-loop-11",
      steps: [
        {
          id: "implement",
          role: "developer",
          task_template: "Implement {task}",
          loop: {
            target: "implement",
            max_iterations: 11,
            exit_when: 'review.status == "success"',
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("TEST-L5: context budget without compaction_strategy compiles OK", () => {
    const loaded = makeLoaded(`
schema_version: "0.2.0"
blueprint_id: "test-budget"
steps:
  - id: implement
    role: developer
    task_template: "Implement {task}"
    loop:
      target: implement
      max_iterations: 3
      exit_when: 'review.status == "success"'
      context_budget:
        max_tokens_per_step: 4000
        max_total_tokens: 16000
  - id: review
    role: reviewer
    task_template: "Review {task}"
`);

    const result = compileBlueprint(loaded, "test");
    const implStep = result.flow.steps[0]!;
    expect(implStep.loop?.context_budget).toBeDefined();
    expect(implStep.loop!.context_budget!.max_tokens_per_step).toBe(4000);
    expect(implStep.loop!.context_budget!.max_total_tokens).toBe(16000);
    expect(implStep.loop!.context_budget!.compaction_strategy).toBeUndefined();
  });

  test("TEST-L6: output_spec with valid enum values compiles OK", () => {
    const loaded = makeLoaded(`
schema_version: "0.2.0"
blueprint_id: "test-output"
steps:
  - id: implement
    role: developer
    task_template: "Implement {task}"
  - id: review
    role: reviewer
    task_template: "Review {task}"
    output_spec:
      status: requires_actions
      findings:
        - "Issue 1"
        - "Issue 2"
      recommended_next: implement
`);

    const result = compileBlueprint(loaded, "test");
    const reviewStep = result.flow.steps[1]!;
    expect(reviewStep.output_spec?.status).toBe("requires_actions");
    expect(reviewStep.output_spec?.findings).toEqual(["Issue 1", "Issue 2"]);
    expect(reviewStep.output_spec?.recommended_next).toBe("implement");
  });

  test("rejects loop target that is after the loop step", () => {
    const loaded = makeLoaded(`
schema_version: "0.2.0"
blueprint_id: "test-fwd-loop"
steps:
  - id: implement
    role: developer
    task_template: "Implement {task}"
    loop:
      target: review
      max_iterations: 3
      exit_when: 'review.status == "success"'
  - id: review
    role: reviewer
    task_template: "Review {task}"
`);
    // Validation happens during compileBlueprint (semantic check), not schema parse
    expect(() => compileBlueprint(loaded, "test")).toThrow(/target.*at position/);
  });

  test("context_spec with receive_from compiles correctly", () => {
    const loaded = makeLoaded(`
schema_version: "0.2.0"
blueprint_id: "test-recv"
steps:
  - id: plan
    role: developer
    task_template: "Plan {task}"
  - id: implement
    role: developer
    task_template: "Implement {task}"
    context_spec:
      text: "Follow the plan"
      receive_from:
        - plan
`);

    const result = compileBlueprint(loaded, "test");
    const implStep = result.flow.steps[1]!;
    expect(implStep.receive_from).toEqual(["plan"]);
    expect(implStep.context).toBe("Follow the plan");
  });

  test("rejects receive_from with nonexistent step ID (H-002 fix)", () => {
    const loaded = makeLoaded(`
schema_version: "0.2.0"
blueprint_id: "test-recv-bad"
steps:
  - id: plan
    role: developer
    task_template: "Plan {task}"
  - id: implement
    role: developer
    task_template: "Implement {task}"
    context_spec:
      text: "Follow the plan"
      receive_from:
        - nonexistent-step.feedback
`);
    expect(() => compileBlueprint(loaded, "test")).toThrow(/receive_from references unknown step/);
  });
});

describe("BlueprintStepSchema with new fields", () => {
  test("accepts step with loop, output_spec, and receive_from", () => {
    const result = BlueprintStepSchema.safeParse({
      id: "implement",
      role: "developer",
      task_template: "Implement {task}",
      context_spec: {
        text: "Focus on code quality",
        receive_from: ["plan"],
      },
      loop: {
        target: "implement",
        max_iterations: 3,
        exit_when: 'review.status == "success"',
      },
      output_spec: {
        status: "success",
      },
    });
    expect(result.success).toBe(true);
  });
});
