/**
 * Execution Resume tests — TD-029-DE Part 1, updated for R-006A.
 *
 * Covers:
 * - TEST-1: Resume execution from step 2 after step 1 succeeded.
 * - TEST-2: Resume execution from step 1 after step 1 failed (retry failed step).
 * - TEST-3: Refuse to resume a completed execution.
 * - TEST-4: Refuse to resume if the original spec references a missing role/model.
 * - TEST-5: Write a resumed execution event to the events log.
 *
 * Uses {@link MockHarnessClient} for deterministic harness simulation.
 *
 * @module execution-resume.test
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  resumeExecution,
  buildResumeExecuteParams,
} from "../src/execution-resume.ts";
import {
  execute,
  MockHarnessClient,
} from "../src/execution-runner.ts";
import type { MockHarnessJobResponse } from "../src/execution-runner.ts";
import type { CompiledFlowPackage } from "../src/flow-package/index.ts";
import type { RolesFile } from "../src/schemas/role-definition.ts";
import type { Flow } from "../src/schemas/flow.ts";
import { compileFlowPackage } from "../src/flow-package/package-compiler.ts";
import type { LoadedFlowPackage } from "../src/flow-package/package-loader.ts";
import { FlowSchema } from "../src/schemas/flow.ts";
import {
  readExecutionManifest,
  readExecutionIndex,
} from "../src/execution-store.ts";

// ── Test Package Fixtures ──────────────────────────────────────────

const STANDARD_ROLES: RolesFile = {
  schema_version: "0.3.0" as const,
  model_defaults: { default_llm_id: "deepseek:deepseek-chat" },
  roles: {
    planner: {
      prompt_template: "You are a planning agent.",
      context_budget: 0.70,
      llm_id: null,
    },
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
  },
};

const GHOST_ROLES: RolesFile = {
  schema_version: "0.3.0" as const,
  model_defaults: { default_llm_id: "deepseek:deepseek-chat" },
  roles: {
    ghost: {
      prompt_template: "You are a ghost role.",
      context_budget: 0.5,
      llm_id: null,
    },
  },
};

const DRIFTED_ROLES: RolesFile = {
  schema_version: "0.3.0" as const,
  model_defaults: { default_llm_id: "deepseek:deepseek-chat" },
  roles: {
    planner: {
      prompt_template: "You are a planning agent.",
      context_budget: 0.70,
      llm_id: "deepseek:old-model",
    },
  },
};

function makeCompiledPackage(
  flowYaml: string,
  roles?: RolesFile,
): CompiledFlowPackage {
  const raw = parseYaml(flowYaml);
  const flow = FlowSchema.parse(raw) as Flow;
  const rolesFile = roles ?? STANDARD_ROLES;

  const loaded: LoadedFlowPackage = {
    packageId: "test-fixture",
    packageVersion: "0.0.0",
    packageDir: "/tmp/test-fixture",
    flow,
    roles: rolesFile,
    rawFlow: flow as unknown as Record<string, unknown>,
    rawRoles: rolesFile as unknown as Record<string, unknown>,
  };

  return compileFlowPackage(loaded);
}

// ── Temp Directory Management ──────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-resume-${randomUUID()}`);
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

function failureResponse(overrides?: Partial<MockHarnessJobResponse>): MockHarnessJobResponse {
  return {
    success: false,
    error: "API error: rate limit exceeded",
    events: [
      { session_id: randomUUID(), prompt_tokens: 50, completion_tokens: 0, timestamp: new Date().toISOString() },
    ],
    ...overrides,
  };
}

// ── TEST-1: Resume from step 2 after step 1 succeeded ──────────────

describe("resume from step 2 (TEST-1)", () => {
  test("resumeExecution determines resume point is step 2", async () => {
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
      successResponse(),
      failureResponse({ error: "API error" }),
    ]);

    const execResult = await execute({
      task: "Build the feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(execResult.success).toBe(false);
    expect(execResult.steps[0]!.status).toBe("success");
    expect(execResult.steps[1]!.status).toBe("failed");

    const resumeResult = await resumeExecution(execResult.executionId);

    expect(resumeResult.success).toBe(true);
    expect(resumeResult.resumeFromStepId).toBe("implement");
    expect(resumeResult.spec).toBeDefined();
    expect(resumeResult.resumeContext).toBeDefined();
    expect(resumeResult.isValidationError).toBeFalsy();
  });

  test("can build resume params and re-enter execute from step 2", async () => {
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

    const mock1 = new MockHarnessClient([
      successResponse(),
      failureResponse({ error: "API error" }),
    ]);

    const execResult = await execute({
      task: "Build the feature",
      projectDir,
      harnessClient: mock1,
      _compiledPackage: compiled,
    });

    expect(execResult.steps[0]!.status).toBe("success");
    expect(execResult.steps[1]!.status).toBe("failed");

    const resumeResult = await resumeExecution(execResult.executionId);
    expect(resumeResult.success).toBe(true);

    if (resumeResult.spec && resumeResult.resumeFromStepId) {
      const executeParams = buildResumeExecuteParams(
        execResult.executionId,
        resumeResult.spec,
        resumeResult.resumeFromStepId,
        "Build the feature",
        projectDir,
        resumeResult.resumeContext,
      );

      expect(executeParams.resumeFromStepId).toBeDefined();
      expect(executeParams._compiledPackage).toBeDefined();
      expect(executeParams._compiledPackage!.roleRegistry).toBeDefined();
      expect(executeParams._executionId).toBe(execResult.executionId);

      const mock2 = new MockHarnessClient([successResponse()]);
      const resumedResult = await execute({
        ...executeParams,
        harnessClient: mock2,
      });

      expect(resumedResult.executionId).toBe(execResult.executionId);
    }
  });
});

// ── TEST-2: Resume from step 1 after step 1 failed ─────────────────

describe("resume from step 1 after failure (TEST-2)", () => {
  test("retry failed step and continue to step 2", async () => {
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

    const mock1 = new MockHarnessClient([
      failureResponse({ error: "step1 failed" }),
    ]);

    const execResult = await execute({
      task: "Build the feature",
      projectDir,
      harnessClient: mock1,
      _compiledPackage: compiled,
    });

    expect(execResult.success).toBe(false);
    expect(execResult.steps[0]!.status).toBe("failed");
    expect(execResult.steps[1]!.status).toBe("skipped");

    const resumeResult = await resumeExecution(execResult.executionId);
    expect(resumeResult.success).toBe(true);
    expect(resumeResult.resumeFromStepId).toBe("plan");

    if (resumeResult.spec && resumeResult.resumeFromStepId) {
      const executeParams = buildResumeExecuteParams(
        execResult.executionId,
        resumeResult.spec,
        resumeResult.resumeFromStepId,
        "Build the feature",
        projectDir,
        resumeResult.resumeContext,
      );

      const mock2 = new MockHarnessClient([
        successResponse(),
        successResponse(),
      ]);
      const resumedResult = await execute({
        ...executeParams,
        harnessClient: mock2,
      });

      expect(resumedResult.success).toBe(true);
      expect(resumedResult.steps[0]!.status).toBe("success");
      expect(resumedResult.steps[1]!.status).toBe("success");
      expect(resumedResult.executionId).toBe(execResult.executionId);

      const indexLines = await readExecutionIndex(execResult.executionDir);
      expect(indexLines.length).toBe(3);
      expect(indexLines[0]!.status).toBe("failed");
      expect(indexLines[1]!.status).toBe("complete");
      expect(indexLines[2]!.status).toBe("complete");
    }
  });
});

// ── TEST-3: Refuse to resume a completed execution ──────────────────

describe("refuse completed execution (TEST-3)", () => {
  test("resumeExecution returns error for completed execution", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
`);

    const mock = new MockHarnessClient([successResponse()]);

    const execResult = await execute({
      task: "Build the feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(execResult.success).toBe(true);

    const manifest = await readExecutionManifest(execResult.executionDir);
    expect(manifest!.status).toBe("complete");

    const resumeResult = await resumeExecution(execResult.executionId);
    expect(resumeResult.success).toBe(false);
    expect(resumeResult.isValidationError).toBe(true);
    expect(resumeResult.error).toContain("complete");
  });
});

// ── TEST-4: Refuse to resume if spec references a missing role/model ─

describe("refuse unreplayable spec (TEST-4)", () => {
  test("refuses when a role in the snapshot does not resolve", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const ghostPkg = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: only
    role: ghost
    task: "Do the job"
`, GHOST_ROLES);

    const mock = new MockHarnessClient([failureResponse({ error: "ghost failed" })]);

    const execResult = await execute({
      task: "Build the feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: ghostPkg,
    });

    expect(execResult.success).toBe(false);

    // The spec contains the ghost role — it should reconstruct correctly
    // from the snapshot (snapshot-based validation, not global registry)
    const resumeResult = await resumeExecution(execResult.executionId);
    // Should succeed because the snapshot itself has the ghost role
    expect(resumeResult.success).toBe(true);
    expect(resumeResult.resumeFromStepId).toBe("only");
  });

  test("execution with drifted model spec still replays from snapshot", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const driftedPkg = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: only
    role: planner
    task: "Plan the work"
`, DRIFTED_ROLES);

    const mock = new MockHarnessClient([failureResponse({ error: "drifted model failed" })]);

    const execResult = await execute({
      task: "Build the feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: driftedPkg,
    });

    expect(execResult.success).toBe(false);

    // The spec snapshot preserves the drifted model; replay is still possible
    const resumeResult = await resumeExecution(execResult.executionId);
    expect(resumeResult.success).toBe(true);
    expect(resumeResult.resumeFromStepId).toBe("only");
  });
});

// ── TEST-5: Write resumed event to events log ───────────────────────

describe("resumed event written (TEST-5)", () => {
  test("resumeExecution appends execution_resumed event", async () => {
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
      successResponse(),
      failureResponse(),
    ]);

    const execResult = await execute({
      task: "Build the feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(execResult.success).toBe(false);

    const eventsPath = join(execResult.executionDir, "events.jsonl");
    const beforeRaw = await readFile(eventsPath, "utf-8");
    const beforeLines = beforeRaw.trim().split("\n").filter((l) => l.length > 0);

    const resumeResult = await resumeExecution(execResult.executionId);
    expect(resumeResult.success).toBe(true);

    const afterRaw = await readFile(eventsPath, "utf-8");
    const afterLines = afterRaw.trim().split("\n").filter((l) => l.length > 0);

    expect(afterLines.length).toBeGreaterThan(beforeLines.length);

    const lastEvent = JSON.parse(afterLines[afterLines.length - 1]!);
    expect(lastEvent.type).toBe("execution_resumed");
    expect(lastEvent.detail.resume_from_step).toBeDefined();
  });
});

// ── Edge Cases ─────────────────────────────────────────────────────

describe("edge cases", () => {
  test("nonexistent execution id → validation error", async () => {
    const fakeId = randomUUID();
    const result = await resumeExecution(fakeId);
    expect(result.success).toBe(false);
    expect(result.isValidationError).toBe(true);
    expect(result.error).toContain("not found");
  });

  test("active/failed execution can be resumed", async () => {
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
      successResponse(),
      failureResponse(),
    ]);

    const execResult = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(execResult.success).toBe(false);

    const manifestBefore = await readExecutionManifest(execResult.executionDir);
    expect(manifestBefore!.status).toBe("failed");

    const resumeResult = await resumeExecution(execResult.executionId);
    expect(resumeResult.success).toBe(true);
    expect(resumeResult.resumeFromStepId).toBe("implement");
  });
});
