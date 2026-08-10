/**
 * Execution end-to-end tests — real controller through mocked harness (TD-029-DE Part 3).
 * Updated for R-006A flow-package system.
 *
 * Covers:
 * - TEST-9: 2-step execution: both steps succeed, execution index has 2 entries.
 * - TEST-10: 2-step execution: step 1 fails, execution stops.
 * - Full resume flow: resume after failure completes execution.
 *
 * @module execution-e2e.test
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  execute,
  MockHarnessClient,
  adaptCompiledBlueprintToFlowPackage,
} from "../src/execution-runner.ts";
import type { MockHarnessJobResponse } from "../src/execution-runner.ts";
import type { CompiledFlowPackage } from "../src/flow-package/index.ts";
import type { RolesFile } from "../src/schemas/role-definition.ts";
import type { Flow } from "../src/schemas/flow.ts";
import { compileFlowPackage } from "../src/flow-package/package-compiler.ts";
import type { LoadedFlowPackage } from "../src/flow-package/package-loader.ts";
import { loadBlueprintPackage, compileBlueprint } from "@zao/blueprint";
import { FlowSchema } from "../src/schemas/flow.ts";
import {
  readExecutionManifest,
  readExecutionIndex,
} from "../src/execution-store.ts";
import { resumeExecution, buildResumeExecuteParams } from "../src/execution-resume.ts";

// ── Test Package Fixture ────────────────────────────────────────────

const TEST_ROLES: RolesFile = {
  schema_version: "0.3.0" as const,
  model_defaults: { default_llm_id: "deepseek:deepseek-chat" },
  roles: {
    planner: {
      prompt_template: "You are a planning agent. Break down complex tasks.",
      context_budget: 0.70,
      llm_id: null,
    },
    developer: {
      prompt_template: "You are a developer agent. Write production-quality code.",
      context_budget: 0.65,
      llm_id: null,
    },
    reviewer: {
      prompt_template: "You are a code reviewer. Analyze code for security.",
      context_budget: 0.40,
      llm_id: null,
    },
  },
};

function makeCompiledPackage(flowYaml: string): CompiledFlowPackage {
  const raw = parseYaml(flowYaml);
  const flow = FlowSchema.parse(raw) as Flow;

  const loaded: LoadedFlowPackage = {
    packageId: "test-fixture",
    packageVersion: "0.0.0",
    packageDir: "/tmp/test-fixture",
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
  const dir = join("/tmp", `zao-test-e2e-${randomUUID()}`);
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
});

afterAll(async () => {
  delete process.env["ZAO_HOME"];
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
      { session_id: randomUUID(), prompt_tokens: 150, completion_tokens: 25, timestamp: new Date().toISOString() },
    ],
    ...overrides,
  };
}

function failureResponse(error?: string): MockHarnessJobResponse {
  return {
    success: false,
    error: error ?? "API error: rate limit exceeded",
    events: [
      { session_id: randomUUID(), prompt_tokens: 50, completion_tokens: 0, timestamp: new Date().toISOString() },
    ],
  };
}

// ── TEST-9: 2-step execution end-to-end: both steps succeed ────────

describe("2-step execution succeeds (TEST-9)", () => {
  test("both steps succeed, index has 2 entries", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
  - id: implement
    role: developer
    task: "Implement the feature"
`);

    const mock = new MockHarnessClient([
      successResponse({
        sessionId: "sess-plan-aaa",
        sessionDir: join(testStoreRoot, "sessions", "sess-plan-aaa"),
      }),
      successResponse({
        sessionId: "sess-impl-bbb",
        sessionDir: join(testStoreRoot, "sessions", "sess-impl-bbb"),
      }),
    ]);

    const result = await execute({
      task: "Build the feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(true);
    expect(result.executionId).toBeTruthy();
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.id).toBe("plan");
    expect(result.steps[0]!.status).toBe("success");
    expect(result.steps[1]!.id).toBe("implement");
    expect(result.steps[1]!.status).toBe("success");

    const indexLines = await readExecutionIndex(result.executionDir);
    expect(indexLines.length).toBe(2);
    expect(indexLines[0]!.status).toBe("complete");
    expect(indexLines[1]!.status).toBe("complete");

    const manifest = await readExecutionManifest(result.executionDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.status).toBe("complete");

    const resultRaw = await readFile(
      join(result.executionDir, "result.json"),
      "utf-8",
    );
    const aggregate = JSON.parse(resultRaw);
    expect(aggregate.overall_success).toBe(true);
    expect(aggregate.steps).toHaveLength(2);

    expect(mock.callCount).toBe(2);
  });
});

// ── TEST-10: Step 1 fails, execution stops ──────────────────────────

describe("step 1 fails, execution stops (TEST-10)", () => {
  test("only step 1 is delegated, remaining steps skipped", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: step1
    role: planner
    task: "Plan the work"
  - id: step2
    role: developer
    task: "Implement the feature"
  - id: step3
    role: reviewer
    task: "Review the code"
`);

    const mock = new MockHarnessClient([
      failureResponse("Rate limit exceeded"),
    ]);

    const result = await execute({
      task: "Build the feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate limit exceeded");
    expect(result.steps).toHaveLength(3);

    expect(result.steps[0]!.id).toBe("step1");
    expect(result.steps[0]!.status).toBe("failed");
    expect(result.steps[1]!.status).toBe("skipped");
    expect(result.steps[2]!.status).toBe("skipped");

    expect(mock.callCount).toBe(1);

    const indexLines = await readExecutionIndex(result.executionDir);
    expect(indexLines.length).toBe(1);
    expect(indexLines[0]!.status).toBe("failed");

    const manifest = await readExecutionManifest(result.executionDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.status).toBe("failed");
  });
});

// ── Full resume flow ────────────────────────────────────────────────

describe("full resume flow", () => {
  test("resume after step 1 failure completes execution", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
  - id: implement
    role: developer
    task: "Implement the feature"
`);

    // Phase 1: Run with step 1 success, step 2 failure
    const mock1 = new MockHarnessClient([
      successResponse(),
      failureResponse("API error"),
    ]);

    const execResult = await execute({
      task: "Build the feature",
      projectDir,
      harnessClient: mock1,
      _compiledPackage: compiled,
    });

    expect(execResult.success).toBe(false);
    expect(execResult.steps[0]!.status).toBe("success");
    expect(execResult.steps[1]!.status).toBe("failed");

    // Phase 2: Resume
    const resumeResult = await resumeExecution(execResult.executionId);

    expect(resumeResult.success).toBe(true);
    expect(resumeResult.resumeFromStepId).toBe("implement");
    expect(resumeResult.spec).toBeDefined();

    // Phase 3: Re-enter execute from step 2
    if (resumeResult.resumeFromStepId && resumeResult.spec) {
      const resumeParams = buildResumeExecuteParams(
        execResult.executionId,
        resumeResult.spec,
        resumeResult.resumeFromStepId,
        "Build the feature",
        projectDir,
        resumeResult.resumeContext,
      );

      const mock2 = new MockHarnessClient([successResponse()]);
      const resumedExecResult = await execute({
        ...resumeParams,
        harnessClient: mock2,
      });

      expect(resumedExecResult.steps.length).toBe(2);
      expect(resumedExecResult.steps[0]!.status).toBe("success");
      expect(resumedExecResult.steps[1]!.status).toBe("success");
      expect(resumedExecResult.steps[0]!.id).toBe("plan");
      expect(resumedExecResult.steps[1]!.id).toBe("implement");
    }
  });
});

// ── E2E loop execution (MED-1) ────────────────────────────────────────

describe("e2e loop execution (MED-1)", () => {
  test("compiles and executes a loop blueprint end-to-end", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);
    
    // Create a temporary blueprint package directory
    const bpDir = join(projectDir, "test-loop-e2e");
    await ensureDir(bpDir);
    await writeFile(join(bpDir, "package.yaml"), [
      'schema_version: "0.1.0"',
      'package:',
      '  id: test-loop-e2e',
      '  version: 1.0.0',
      '  type: blueprint',
      '  name: "E2E Loop Test"',
      '  description: "Test blueprint for loop execution"',
    ].join('\n'));
    
    await writeFile(join(bpDir, "blueprint.yaml"), [
      'schema_version: "0.2.0"',
      'blueprint_id: "test-loop-e2e"',
      'steps:',
      '  - id: implement',
      '    role: developer',
      `    task_template: "Implement {task}"`,
      '    loop:',
      '      target: implement',
      '      max_iterations: 2',
      `      exit_when: "review.status == \\"success\\""`,
      '  - id: review',
      '    role: reviewer',
      `    task_template: "Review {task}"`,
      `    when: "implement.status == \\"success\\""`,
      '    output_spec:',
      '      status: requires_actions',
    ].join('\n'));
    
    await writeFile(join(bpDir, "roles.yaml"), [
      'schema_version: "0.3.0"',
      'model_defaults:',
      '  default_llm_id: "deepseek:deepseek-chat"',
      'roles:',
      '  developer:',
      `    prompt_template: "You are a developer. {task}"`,
      '    context_budget: 0.65',
      '    llm_id: null',
      '  reviewer:',
      `    prompt_template: "You are a reviewer. {task}. Output: {{ status: success|failed|requires_actions, findings: string[], recommended_next: string|null }}"`,
      '    context_budget: 0.40',
      '    llm_id: null',
    ].join('\n'));
    
    try {
      const bp = await loadBlueprintPackage(bpDir);
      const compiled = compileBlueprint(bp, "Add login page");
      const compiledPkg = adaptCompiledBlueprintToFlowPackage(compiled);
      
      const mock = new MockHarnessClient([
        { success: true, result: { status: "success" }, sessionId: "s1", events: [{ session_id: "s1", prompt_tokens: 10, completion_tokens: 5 }] },
        { success: true, result: { status: "requires_actions", findings: ["Issue"], recommended_next: "implement" }, sessionId: "s2", events: [{ session_id: "s2", prompt_tokens: 10, completion_tokens: 5 }] },
        { success: true, result: { status: "success" }, sessionId: "s1", events: [{ session_id: "s1", prompt_tokens: 10, completion_tokens: 5 }] },
        { success: true, result: { status: "success", findings: [], recommended_next: undefined }, sessionId: "s2", events: [{ session_id: "s2", prompt_tokens: 10, completion_tokens: 5 }] },
      ]);
      
      const result = await execute({
        task: "Add login page",
        projectDir,
        harnessClient: mock,
        _compiledPackage: compiledPkg,
      });
      
      expect(result.success).toBe(true);
      expect(result.steps.filter(s => s.id === "implement").length).toBe(2);
      expect(result.steps.filter(s => s.id === "review").length).toBe(2);
    } finally {
      await rm(bpDir, { recursive: true, force: true });
    }
  });
});
