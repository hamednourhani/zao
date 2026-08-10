/**
 * Execution loop tests — R-010 Iterative Flow Loops.
 *
 * Tests:
 * - TEST-L7: Simple loop: review requires_actions on iter 1, success on iter 2 → flow completes
 * - TEST-L8: Loop exceeds max_iterations → onLoopClose callback triggered
 * - TEST-L9: Reviewer recommended_next mismatch → error thrown
 * - TEST-L10: Context budget exceeded without compaction → error thrown
 * - TEST-L11: Context budget with compaction → log warning (placeholder)
 * - TEST-L12: Loop with target = different earlier step (not self-targeting)
 * - TEST-L13: Session IDs are reused on loop iterations (verify resume, not fresh spawn)
 *
 * @module execution-loop.test
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { __internalInitLogger, __internalResetLoggerForTest } from "../src/logger.ts";
import {
  execute,
  MockHarnessClient,
} from "../src/execution-runner.ts";
import type { MockHarnessJobResponse } from "../src/execution-runner.ts";
import type { CompiledFlowPackage } from "../src/flow-package/index.ts";
import type { Flow } from "../src/schemas/flow.ts";
import { compileFlowPackage } from "../src/flow-package/package-compiler.ts";
import type { LoadedFlowPackage } from "../src/flow-package/package-loader.ts";
import type { RolesFile } from "../src/schemas/role-definition.ts";
import { FlowSchema } from "../src/schemas/flow.ts";
import type { LoopCloseState } from "../src/schemas/flow.ts";

// ── Test Role Registry Fixture ──────────────────────────────────────

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
      prompt_template: "You are a code reviewer. Output structured JSON.",
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

function makeCompiledPackage(flowYaml: string): CompiledFlowPackage {
  const { parse: parseYaml } = require("yaml");
  const raw = parseYaml(flowYaml);
  const flow = FlowSchema.parse(raw) as Flow;
  const loaded: LoadedFlowPackage = {
    packageId: "test-loop-fixture",
    packageVersion: "0.0.0",
    packageDir: "/tmp/test-loop-fixture",
    flow,
    roles: TEST_ROLES,
    rawFlow: flow as unknown as Record<string, unknown>,
    rawRoles: TEST_ROLES as unknown as Record<string, unknown>,
  };
  return compileFlowPackage(loaded);
}

// ── Temp Directory Management ──────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-loop-${randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

let testStoreRoot: string;

beforeAll(async () => {
  testStoreRoot = makeTempDir();
  await ensureDir(testStoreRoot);
  process.env["ZAO_HOME"] = testStoreRoot;
  __internalInitLogger("info", false);
});

afterAll(async () => {
  delete process.env["ZAO_HOME"];
  __internalResetLoggerForTest();
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
});

// ── Mock Helpers ───────────────────────────────────────────────────

function successResponse(overrides?: Partial<MockHarnessJobResponse>): MockHarnessJobResponse {
  return {
    success: true,
    events: [
      {
        session_id: randomUUID(),
        prompt_tokens: 100,
        completion_tokens: 20,
        timestamp: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

function reviewerResponse(
  status: "success" | "failed" | "requires_actions",
  overrides?: Partial<MockHarnessJobResponse>,
): MockHarnessJobResponse {
  return {
    success: true,
    result: {
      status,
      findings: status === "requires_actions" ? ["Issue found"] : [],
      recommended_next: status === "requires_actions" ? "implement" : undefined,
    },
    events: [
      {
        session_id: randomUUID(),
        prompt_tokens: 150,
        completion_tokens: 15,
        timestamp: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

// ── TEST-L7: Simple loop ───────────────────────────────────────────

describe("simple loop (TEST-L7)", () => {
  test("review requires_actions on iter 1, success on iter 2 → flow completes", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: implement
    role: developer
    task: "Implement the feature"
    loop:
      target: implement
      max_iterations: 3
      exit_when: review.status == "success"
  - id: review
    role: reviewer
    task: "Review the code"
    when: implement.status == "success"
    output_spec:
      status: requires_actions
  - id: doc
    role: documenter
    task: "Write documentation"
    when: review.status == "success"
`);

    // Iteration 1: implement → review (requires_actions) → loop back
    // Iteration 2: implement (resume) → review (success) → doc
    const mock = new MockHarnessClient([
      successResponse(), // iter 1 implement
      reviewerResponse("requires_actions"), // iter 1 review
      successResponse(), // iter 2 implement
      reviewerResponse("success"), // iter 2 review
      successResponse(), // doc
    ]);

    const result = await execute({
      task: "Build feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(true);

    // Should have called 5 jobs (2x implement, 2x review, 1x doc)
    // But wait: the steps declared are implement, review, doc = 3 steps
    // The loop makes implement and review execute twice
    // implement, review (iter 1), implement, review (iter 2), doc = 5 calls
    expect(mock.callCount).toBe(5);

    // Verify doc step ran
    const docStep = result.steps.find((s) => s.id === "doc");
    expect(docStep).toBeDefined();
    expect(docStep!.status).toBe("success");
  });
});

// ── TEST-L8: Loop exceeds max_iterations ──────────────────────────

describe("max iterations exceeded (TEST-L8)", () => {
  test("onLoopClose callback triggered when loop exceeds max", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: implement
    role: developer
    task: "Implement"
    loop:
      target: implement
      max_iterations: 2
      exit_when: review.status == "success"
  - id: review
    role: reviewer
    task: "Review"
    when: implement.status == "success"
    output_spec:
      status: requires_actions
`);

    const mock = new MockHarnessClient([
      successResponse(), // iter 1 implement
      reviewerResponse("requires_actions"), // iter 1 review → jump back
      successResponse(), // iter 2 implement
      reviewerResponse("requires_actions"), // iter 2 review → again → max exceeded
    ]);

    let loopCloseCalled = false;
    let capturedState: LoopCloseState | null = null;

    const result = await execute({
      task: "Build feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
      onLoopClose: async (state) => {
        loopCloseCalled = true;
        capturedState = state;
        return "stop";
      },
    });

    expect(result.success).toBe(false);
    expect(loopCloseCalled).toBe(true);
    expect(capturedState).toBeDefined();
    expect(capturedState!.loopStepId).toBe("implement");
    expect(capturedState!.totalIterations).toBe(2);
  });

  test("onLoopClose returning 'continue' extends by 2 iterations", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: implement
    role: developer
    task: "Implement"
    loop:
      target: implement
      max_iterations: 1
      exit_when: review.status == "success"
  - id: review
    role: reviewer
    task: "Review"
    when: implement.status == "success"
    output_spec:
      status: requires_actions
`);

    let continueCount = 0;
    const mock = new MockHarnessClient([
      successResponse(), // iter 1 implement
      reviewerResponse("requires_actions"), // iter 1 review → max (1) exceeded
      // After "continue" from human gate (max → 3):
      successResponse(), // iter 2 implement (extended)
      reviewerResponse("success"), // iter 2 review → exit condition met!
    ]);

    const result = await execute({
      task: "Build feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
      onLoopClose: async () => {
        continueCount++;
        return "continue";
      },
    });

    // The loop should succeed because after "continue", the second iteration
    // has review.status == "success" which meets the exit condition
    expect(result.success).toBe(true);
    expect(continueCount).toBe(1); // only called once
  });
});

// ── TEST-L9: Reviewer recommended_next mismatch ───────────────────

describe("reviewer recommended_next mismatch (TEST-L9)", () => {
  test("throws when reviewer recommends wrong step", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: implement
    role: developer
    task: "Implement"
    loop:
      target: implement
      max_iterations: 3
      exit_when: review.status == "success"
  - id: review
    role: reviewer
    task: "Review"
    when: implement.status == "success"
    output_spec:
      status: requires_actions
`);

    const mock = new MockHarnessClient([
      successResponse(),
      {
        success: true,
        result: {
          status: "requires_actions",
          findings: ["Bad code"],
          recommended_next: "design", // WRONG: should be "implement"
        },
        events: [
          {
            session_id: randomUUID(),
            prompt_tokens: 100,
            completion_tokens: 10,
            timestamp: new Date().toISOString(),
          },
        ],
      },
    ]);

    await expect(
      execute({
        task: "Build feature",
        projectDir,
        harnessClient: mock,
        _compiledPackage: compiled,
      }),
    ).rejects.toThrow(/recommended.*mismatch/i);
  });
});

// ── TEST-L10: Context budget exceeded without compaction ──────────

describe("context budget exceeded (TEST-L10)", () => {
  test("fails when context budget exceeded without compaction strategy", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: implement
    role: developer
    task: "Implement"
    loop:
      target: implement
      max_iterations: 3
      exit_when: review.status == "success"
      context_budget:
        max_tokens_per_step: 100
        max_total_tokens: 100
  - id: review
    role: reviewer
    task: "Review"
    when: implement.status == "success"
    output_spec:
      status: requires_actions
`);

    // Large token events that will exceed the tiny budget
    const mock = new MockHarnessClient([
      {
        success: true,
        events: [
          {
            session_id: randomUUID(),
            prompt_tokens: 1000,
            completion_tokens: 100,
            timestamp: new Date().toISOString(),
          },
        ],
      },
      reviewerResponse("requires_actions"),
    ]);

    const result = await execute({
      task: "Build feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("per-step token budget");
  });
});

// ── TEST-L11: Context budget with compaction ──────────────────────

describe("context budget with compaction (TEST-L11)", () => {
  test("logs warning when context budget exceeded with compaction", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: implement
    role: developer
    task: "Implement"
    loop:
      target: implement
      max_iterations: 2
      exit_when: review.status == "success"
      context_budget:
        max_tokens_per_step: 100
        max_total_tokens: 100
        compaction_strategy: summarize
  - id: review
    role: reviewer
    task: "Review"
    when: implement.status == "success"
    output_spec:
      status: requires_actions
`);

    let warningLogged = false;
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      if (
        typeof chunk === "string" &&
        chunk.includes("Context budget exceeded")
      ) {
        warningLogged = true;
      }
      return true;
    }) as typeof process.stderr.write;

    // First iteration: implement (100 prompt) → exceeds 100 budget
    // Warning logged. review succeeds → exit loop.
    const mock = new MockHarnessClient([
      {
        success: true,
        events: [
          {
            session_id: randomUUID(),
            prompt_tokens: 80,
            completion_tokens: 30, // total: 110 > 100
            timestamp: new Date().toISOString(),
          },
        ],
      },
      reviewerResponse("success"), // exit loop
    ]);

    try {
      await execute({
        task: "Build feature",
        projectDir,
        harnessClient: mock,
        _compiledPackage: compiled,
      });
      expect(warningLogged).toBe(true);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

// ── TEST-L12: Loop with different earlier step target ─────────────

describe("loop with earlier step target (TEST-L12)", () => {
  test("jumps back to an earlier step (not self-targeting)", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: developer
    task: "Plan"
  - id: implement
    role: developer
    task: "Implement"
  - id: review
    role: reviewer
    task: "Review"
    when: implement.status == "success"
    loop:
      target: plan
      max_iterations: 3
      exit_when: review.status == "success"
    output_spec:
      status: requires_actions
`);

    // plan → implement → review(requires) → jump back to plan
    // plan(resume) → implement(resume) → review(success) → done
    const mock = new MockHarnessClient([
      successResponse(), // iter 1 plan
      successResponse(), // iter 1 implement
      { // iter 1 review → requires_actions, recommended_next matches loop target "plan"
        success: true,
        result: {
          status: "requires_actions",
          findings: ["Plan needs revision"],
          recommended_next: "plan",
        },
        events: [
          {
            session_id: randomUUID(),
            prompt_tokens: 150,
            completion_tokens: 15,
            timestamp: new Date().toISOString(),
          },
        ],
      },
      successResponse(), // iter 2 plan
      successResponse(), // iter 2 implement
      reviewerResponse("success"), // iter 2 review → exit
    ]);

    const result = await execute({
      task: "Build feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(true);
    expect(mock.callCount).toBe(6);
  });
});

// ── TEST-L13: Session IDs reused on loop iterations ───────────────

describe("session resume on loop (TEST-L13)", () => {
  test("session IDs are reused on loop iterations", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: implement
    role: developer
    task: "Implement"
    loop:
      target: implement
      max_iterations: 3
      exit_when: review.status == "success"
  - id: review
    role: reviewer
    task: "Review"
    when: implement.status == "success"
    output_spec:
      status: requires_actions
`);

    // Use the same session ID for each step to verify resume
    const implementSessionId1 = randomUUID();
    const reviewSessionId1 = randomUUID();

    const mock = new MockHarnessClient([
      { ...successResponse(), sessionId: implementSessionId1 }, // iter 1 implement (new)
      { ...reviewerResponse("requires_actions"), sessionId: reviewSessionId1 }, // iter 1 review (new)
      { ...successResponse(), sessionId: implementSessionId1 }, // iter 2 implement (resume — same ID)
      { ...reviewerResponse("success"), sessionId: reviewSessionId1 }, // iter 2 review (resume — same ID)
    ]);

    const runResult = await execute({
      task: "Build feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(runResult.success).toBe(true);

    // Verify the result has session IDs
    const implSessionIds = runResult.steps
      .filter((s) => s.id === "implement")
      .map((s) => s.sessionId);
    // implement appears twice in results (iter 1 and iter 2)
    // They should have the same session ID (resume)
    expect(implSessionIds.length).toBeGreaterThanOrEqual(1);

    // Verify session IDs are tracked
    expect(runResult.sessionIds.length).toBe(4); // 4 jobs total

    // L-003: Verify that on loop resume, the mock harness receives the same sessionId
    // Call 0: iter 1 implement (new) → sessionId = implementSessionId1
    // Call 1: iter 1 review (new) → sessionId = reviewSessionId1
    // Call 2: iter 2 implement (resume) → should receive sessionId = implementSessionId1
    expect(mock.calls[2]?.sessionId).toBe(implementSessionId1);
    // Call 3: iter 2 review (resume) → should receive sessionId = reviewSessionId1
    expect(mock.calls[3]?.sessionId).toBe(reviewSessionId1);
  });
});

// ── TEST: Truly nested loops (C-001 fix) ──────────────────────────

describe("truly nested loops (C-001)", () => {
  test("inner loop iterates, outer continues after inner completes", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    // Two loops:
    // - Outer: outer-loop (target=outer-loop) → inner-loop → inner-review → outer-review
    // - Inner: inner-loop (target=inner-loop) → inner-review
    // The inner loop's jump should not interfere with the outer loop.
    // Flow:
    //   iter 1: outer-loop → inner-loop(activate inner) → inner-review(req) → jump inner
    //   iter 2:              inner-loop(reenter)        → inner-review(success) → pop inner
    //                       → outer-review(req) → outer exit_when not met → jump outer
    //   iter 2: outer-loop(reenter) → inner-loop(activate inner again) → inner-review(success) → pop inner
    //                       → outer-review(success) → pop outer → done
    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: outer-loop
    role: developer
    task: "Outer task"
    loop:
      target: outer-loop
      max_iterations: 3
      exit_when: outer-review.status == "success"
  - id: inner-loop
    role: developer
    task: "Inner task"
    loop:
      target: inner-loop
      max_iterations: 2
      exit_when: inner-review.status == "success"
  - id: inner-review
    role: reviewer
    task: "Inner review"
    output_spec:
      status: requires_actions
  - id: outer-review
    role: reviewer
    task: "Outer review"
    output_spec:
      status: requires_actions
`);

    // Mock responses — 8 total calls:
    // iter 1: outer-loop, inner-loop, inner-review(req→jump), inner-loop, inner-review(success→pop), outer-review(req→jump)
    // Wait, that's only 6. Let me re-count:
    // Outer iter 1: outer-loop + inner-loop + inner-review(req) [inner jumps] + inner-loop + inner-review(success) [inner pops] + outer-review(req→not met→jump outer)
    // = 6 calls so far
    // Outer iter 2: outer-loop + inner-loop + inner-review(success) [inner pops] + outer-review(success) [outer pops]
    // = 4 more calls
    // Total: 10 calls
    const mock = new MockHarnessClient([
      successResponse(), // outer iter 1: outer-loop
      successResponse(), // outer iter 1: inner-loop (inner activated)
      reviewerResponse("requires_actions", { result: { status: "requires_actions", findings: ["Issue"], recommended_next: "inner-loop" } }), // outer iter 1 / inner iter 1: inner-review → jump inner
      successResponse(), // outer iter 1 / inner iter 2: inner-loop (reenter)
      reviewerResponse("success", { result: { status: "success", findings: [], recommended_next: undefined } }), // outer iter 1 / inner iter 2: inner-review → inner pops
      reviewerResponse("requires_actions", { result: { status: "requires_actions", findings: ["Issue"], recommended_next: "outer-loop" } }), // outer iter 1: outer-review → outer exit not met → jump outer
      successResponse(), // outer iter 2: outer-loop (reenter)
      successResponse(), // outer iter 2: inner-loop (inner activated again)
      reviewerResponse("success", { result: { status: "success", findings: [], recommended_next: undefined } }), // outer iter 2 / inner iter 1: inner-review → inner pops
      reviewerResponse("success", { result: { status: "success", findings: [], recommended_next: undefined } }), // outer iter 2: outer-review → outer pops → done
    ]);

    const result = await execute({
      task: "Nested loops test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(true);
    expect(mock.callCount).toBe(10);

    // Verify all steps completed
    const outerLoopSteps = result.steps.filter((s) => s.id === "outer-loop");
    expect(outerLoopSteps.length).toBe(2); // 2 outer iterations
    expect(outerLoopSteps.every((s) => s.status === "success")).toBe(true);

    const innerLoopSteps = result.steps.filter((s) => s.id === "inner-loop");
    expect(innerLoopSteps.length).toBe(3); // inner iter 1, inner iter 2, outer iter 2 inner iter 1

    const innerReviewSteps = result.steps.filter((s) => s.id === "inner-review");
    expect(innerReviewSteps.length).toBe(3); // 2 in first outer iter, 1 in second

    const outerReviewSteps = result.steps.filter((s) => s.id === "outer-review");
    expect(outerReviewSteps.length).toBe(2); // once per outer iteration
  });
});

// ── TEST: max_tokens_per_step exceeded (H-003 fix) ─────────────────

describe("max_tokens_per_step enforcement (H-003)", () => {
  test("fails closed when per-step token budget exceeded without compaction", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: implement
    role: developer
    task: "Implement"
    loop:
      target: implement
      max_iterations: 2
      exit_when: review.status == "success"
      context_budget:
        max_tokens_per_step: 200
        max_total_tokens: 10000
  - id: review
    role: reviewer
    task: "Review"
    when: implement.status == "success"
    output_spec:
      status: requires_actions
`);

    // Step that exceeds per-step budget (300 > 200)
    const mock = new MockHarnessClient([
      {
        success: true,
        events: [
          {
            session_id: randomUUID(),
            prompt_tokens: 250,
            completion_tokens: 60, // total: 310 > max_tokens_per_step (200)
            timestamp: new Date().toISOString(),
          },
        ],
      },
      reviewerResponse("requires_actions"),
    ]);

    const result = await execute({
      task: "Build feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("per-step token budget");
  });

  test("warns when per-step token budget exceeded with compaction strategy", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: implement
    role: developer
    task: "Implement"
    loop:
      target: implement
      max_iterations: 2
      exit_when: review.status == "success"
      context_budget:
        max_tokens_per_step: 100
        max_total_tokens: 10000
        compaction_strategy: summarize
  - id: review
    role: reviewer
    task: "Review"
    when: implement.status == "success"
    output_spec:
      status: requires_actions
`);

    let warningLogged = false;
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      if (
        typeof chunk === "string" &&
        chunk.includes("per-step token budget")
      ) {
        warningLogged = true;
      }
      return true;
    }) as typeof process.stderr.write;

    const mock = new MockHarnessClient([
      {
        success: true,
        events: [
          {
            session_id: randomUUID(),
            prompt_tokens: 120,
            completion_tokens: 30, // total: 150 > 100
            timestamp: new Date().toISOString(),
          },
        ],
      },
      reviewerResponse("success"),
    ]);

    try {
      const result = await execute({
        task: "Build feature",
        projectDir,
        harnessClient: mock,
        _compiledPackage: compiled,
      });
      // With compaction, the warning should have been logged
      // and execution continues (review success exits loop)
      expect(warningLogged).toBe(true);
      expect(result.success).toBe(true);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

// ── TEST: Unparseable exit_when throws (M-001 fix) ──────────────────

describe("unparseable exit_when (M-001)", () => {
  test("throws when exit_when cannot be parsed", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    // Use output_spec to trigger evaluateLoopExit with an invalid exit_when
    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: implement
    role: developer
    task: "Implement"
    loop:
      target: implement
      max_iterations: 3
      exit_when: "!!invalid!!"
  - id: review
    role: reviewer
    task: "Review"
    when: implement.status == "success"
    output_spec:
      status: requires_actions
`);

    const mock = new MockHarnessClient([
      successResponse(), // implement
      reviewerResponse("requires_actions"), // review → triggers evaluateLoopExit
    ]);

    await expect(
      execute({
        task: "Build feature",
        projectDir,
        harnessClient: mock,
        _compiledPackage: compiled,
      }),
    ).rejects.toThrow(/Failed to parse loop exit_when/);
  });
});
