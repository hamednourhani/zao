/**
 * Execution runner tests — TD-029-C, updated for R-006A flow-package system.
 *
 * Covers:
 * - TEST-1: Happy path — 2-step execution succeeds
 * - TEST-2: Skip step when `when` gate evaluates false
 * - TEST-3: Stop execution on first failed step
 * - TEST-4: Write execution index with correct session_ids and statuses
 * - TEST-5: Write execution manifest with terminal status
 *
 * Uses {@link MockHarnessClient} for deterministic harness simulation.
 *
 * @module execution-runner.test
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm, readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  execute,
  MockHarnessClient,
  adaptCompiledBlueprintToFlowPackage,
  deriveModelSlug,
} from "../src/execution-runner.ts";
import type { MockHarnessJobResponse } from "../src/execution-runner.ts";
import type { CompiledFlowPackage } from "../src/flow-package/index.ts";
import type { Flow } from "../src/schemas/flow.ts";
import { compileFlowPackage } from "../src/flow-package/package-compiler.ts";
import type { LoadedFlowPackage } from "../src/flow-package/package-loader.ts";
import type { RolesFile } from "../src/schemas/role-definition.ts";
import { FlowSchema } from "../src/schemas/flow.ts";
import { readExecutionManifest, readExecutionIndex } from "../src/execution-store.ts";
import {
  compileBlueprint,
  BlueprintSchema,
} from "@zao/blueprint";
import type {
  Blueprint,
  RolesFile as BlueprintRolesFile,
  LoadedBlueprintPackage,
} from "@zao/blueprint";

// ── Test Role Registry Fixture ────────────────────────────────────

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

/**
 * Creates a CompiledFlowPackage from a flow YAML string and optional roles.
 * This replaces the old _roleRegistry + flowPath pattern.
 */
function makeCompiledPackage(
  flowYaml: string,
  roles?: RolesFile,
): CompiledFlowPackage {
  const raw = parseYaml(flowYaml);
  const flow = FlowSchema.parse(raw) as Flow;
  const rolesFile = roles ?? TEST_ROLES;

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

/** Minimal compiled package for the default single-step flow. */
const DEFAULT_PACKAGE = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: default
    role: developer
    task: "Implement the feature"
    context: "Execute the task as specified."
`);

// ── Temp Directory Management ──────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-execrun-${randomUUID()}`);
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

// ── TEST-1: Happy path ─────────────────────────────────────────────

describe("happy path (TEST-1)", () => {
  test("2-step flow executes both steps in order", async () => {
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
      successResponse(),
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
    expect(mock.callCount).toBe(2);
  });

  test("3-step flow produces results in declared order", async () => {
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
  - id: review
    role: reviewer
    task: "Review the code"
`);

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "Build the feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]!.id).toBe("plan");
    expect(result.steps[0]!.status).toBe("success");
    expect(result.steps[1]!.id).toBe("implement");
    expect(result.steps[1]!.status).toBe("success");
    expect(result.steps[2]!.id).toBe("review");
    expect(result.steps[2]!.status).toBe("success");
  });
});

// ── TEST-2: Gate evaluation (when) ─────────────────────────────────

describe("gate evaluation (TEST-2)", () => {
  test("when success on prior success → step runs", async () => {
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
    when: plan.status == "success"
`);

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "Build the feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.status).toBe("success");
    expect(result.steps[1]!.status).toBe("success");
    expect(mock.callCount).toBe(2);
  });

  test("when failed on prior success → step skipped", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: first
    role: planner
    task: "Plan the work"
  - id: cleanup
    role: developer
    task: "Implement the feature"
    when: first.status == "failed"
`);

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(true);
    expect(result.steps[0]!.status).toBe("success");
    expect(result.steps[1]!.status).toBe("skipped");
    expect(mock.callCount).toBe(1);
  });

  test("when success on prior failure → step skipped", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: first
    role: planner
    task: "Plan the work"
  - id: second
    role: developer
    task: "Implement the feature"
    when: first.status == "success"
`);

    const mock = new MockHarnessClient([
      failureResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(false);
    expect(result.steps[0]!.status).toBe("failed");
    expect(result.steps[1]!.status).toBe("skipped");
    expect(mock.callCount).toBe(1);
  });
});

// ── TEST-3: Stop on first failure ──────────────────────────────────

describe("stop on failure (TEST-3)", () => {
  test("pipeline stops after first failure", async () => {
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
  - id: review
    role: reviewer
    task: "Review the code"
`);

    const mock = new MockHarnessClient([
      successResponse(),
      failureResponse(),
      successResponse(), // unused
    ]);

    const result = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(false);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]!.status).toBe("success");
    expect(result.steps[1]!.status).toBe("failed");
    expect(result.steps[2]!.status).toBe("skipped");
    expect(mock.callCount).toBe(2);
  });

  test("all steps recorded in result even when pipeline stops", async () => {
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
  - id: review
    role: reviewer
    task: "Review the code"
  - id: deploy
    role: developer
    task: "Implement the feature"
`);

    const mock = new MockHarnessClient([
      successResponse(),
      failureResponse(),
      successResponse(), // unused
      successResponse(), // unused
    ]);

    const result = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(false);
    expect(result.steps).toHaveLength(4);
    expect(result.steps[0]!.status).toBe("success");
    expect(result.steps[1]!.status).toBe("failed");
    expect(result.steps[2]!.status).toBe("skipped");
    expect(result.steps[3]!.status).toBe("skipped");
  });

  test("error message propagates from failed step", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
`);

    const mock = new MockHarnessClient([
      failureResponse({ error: "Timeout after 30s" }),
    ]);

    const result = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Timeout after 30s");
  });
});

// ── TEST-4: Execution index ────────────────────────────────────────

describe("execution index (TEST-4)", () => {
  test("index.jsonl records harness session_ids", async () => {
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
      successResponse(),
    ]);

    const result = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(true);

    const indexLines = await readExecutionIndex(result.executionDir);
    expect(indexLines).toHaveLength(2);
    expect(indexLines[0]!.status).toBe("complete");
    expect(indexLines[1]!.status).toBe("complete");
    expect(result.sessionIds[0]!).toBe(indexLines[0]!.session_id);
    expect(result.sessionIds[1]!).toBe(indexLines[1]!.session_id);
  });
});

// ── TEST-5: Execution manifest ─────────────────────────────────────

describe("execution manifest (TEST-5)", () => {
  test("manifest records terminal status on success", async () => {
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

    const result = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(true);

    const manifest = await readExecutionManifest(result.executionDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.status).toBe("complete");
  });

  test("manifest records terminal status on failure", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
`);

    const mock = new MockHarnessClient([failureResponse()]);

    const result = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(false);

    const manifest = await readExecutionManifest(result.executionDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.status).toBe("failed");
  });
});

// ── Per-step Role and Model Tracking ───────────────────────────────

describe("per-step role and model tracking", () => {
  test("each step records resolved role and model", async () => {
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
  - id: review
    role: reviewer
    task: "Review the code"
`);

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(true);
    expect(result.steps[0]!.role).toBe("planner");
    expect(result.steps[0]!.model).toBe("deepseek-chat");
    expect(result.steps[1]!.role).toBe("developer");
    expect(result.steps[1]!.model).toBe("deepseek-chat");
    expect(result.steps[2]!.role).toBe("reviewer");
    expect(result.steps[2]!.model).toBe("deepseek-chat");
  });
});

// ── Context Prepending ─────────────────────────────────────────────

describe("context prepending", () => {
  test("step context is prepended to task", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
    context: "Focus on authentication module boundaries."
`);

    const mock = new MockHarnessClient([successResponse()]);

    await execute({
      task: "Build auth system",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(mock.callCount).toBe(1);
    expect(mock.calls[0]!.task).toContain("Focus on authentication module boundaries.");
    expect(mock.calls[0]!.task).toContain("Plan the work");
  });

  test("step without context passes task unchanged", async () => {
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

    await execute({
      task: "Build auth system",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(mock.callCount).toBe(1);
    expect(mock.calls[0]!.task).toBe("Plan the work");
  });
});

// ── HarnessClient Integration ──────────────────────────────────────

describe("harness client integration", () => {
  test("resolvedRole is passed correctly to harness", async () => {
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

    await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(mock.callCount).toBe(1);
    expect(mock.calls[0]!.role).toBe("deepseek-chat");
    expect(mock.calls[0]!.roleId).toBe("planner");
    expect(mock.calls[0]!.resolvedRole.model).toBe("deepseek-chat");
    expect(mock.calls[0]!.resolvedRole.llm_id).toBe("deepseek:deepseek-chat");
  });
});

// ── Token Usage Aggregation ────────────────────────────────────────

describe("token usage aggregation", () => {
  test("aggregates token usage across all steps", async () => {
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
        events: [
          { session_id: "s1", prompt_tokens: 100, completion_tokens: 50, timestamp: "" },
        ],
      }),
      successResponse({
        events: [
          { session_id: "s2", prompt_tokens: 200, completion_tokens: 75, timestamp: "" },
        ],
      }),
    ]);

    const result = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(true);
    expect(result.tokenUsage.prompt).toBe(300);
    expect(result.tokenUsage.completion).toBe(125);
  });
});

// ── Default Flow Behavior ──────────────────────────────────────────

describe("default flow behavior", () => {
  test("no flow flags → uses compiled package as-is", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = new MockHarnessClient([successResponse()]);

    const result = await execute({
      task: "Write a function",
      projectDir,
      harnessClient: mock,
      _compiledPackage: DEFAULT_PACKAGE,
    });

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.id).toBe("default");
    expect(result.steps[0]!.status).toBe("success");
  });
});

// ── Execution Result Shape ─────────────────────────────────────────

describe("execution result shape", () => {
  test("result includes executionId, executionDir, sessionIds", async () => {
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
      successResponse(),
    ]);

    const result = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(true);
    expect(result.executionId).toBeTruthy();
    expect(result.executionDir).toContain("executions");
    expect(result.sessionIds).toHaveLength(2);
    expect(result.steps[0]!.sessionId).toBeTruthy();
    expect(result.steps[1]!.sessionId).toBeTruthy();
    expect(result.sessionIds[0]!).toBe(result.steps[0]!.sessionId!);
    expect(result.sessionIds[1]!).toBe(result.steps[1]!.sessionId!);
  });
});

// ── Edge Cases ─────────────────────────────────────────────────────

describe("edge cases", () => {
  test("nonexistent flow package path → validation error (fail-closed)", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = new MockHarnessClient([successResponse()]);

    const result = await execute({
      task: "test",
      flowPackage: "/tmp/does-not-exist-package",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(false);
    expect(result.isValidationFailure).toBe(true);
    expect(result.error).toContain("not found");
    expect(mock.callCount).toBe(0);
  });

  test("empty task → still delegates", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = new MockHarnessClient([successResponse()]);

    const result = await execute({
      task: "",
      projectDir,
      harnessClient: mock,
      _compiledPackage: DEFAULT_PACKAGE,
    });

    expect(result.executionId || result.isValidationFailure).toBeTruthy();
  });

  test("execution directory contains expected files", async () => {
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

    const result = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(true);

    const entries = await readdir(result.executionDir);
    expect(entries).toContain("execution.json");
    expect(entries).toContain("index.jsonl");
    expect(entries).toContain("events.jsonl");
    expect(entries).toContain("orchestration-spec.json");
    expect(entries).toContain("result.json");
  });

  test("MockHarnessClient throws when exhausted", async () => {
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

    const mock = new MockHarnessClient([successResponse()]);

    await expect(
      execute({
        task: "test",
        projectDir,
        harnessClient: mock,
        _compiledPackage: compiled,
      }),
    ).rejects.toThrow("MockHarnessClient exhausted");
  });
});

// ── Orchestration Spec ─────────────────────────────────────────────

describe("orchestration spec", () => {
  test("writes orchestration-spec.json with roles and flow", async () => {
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
    when: plan.status == "success"
`);

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(true);

    const specRaw = await readFile(
      join(result.executionDir, "orchestration-spec.json"),
      "utf-8",
    );
    const spec = JSON.parse(specRaw);
    expect(spec.schema_version).toBe("0.2.0");
    expect(spec.default_model).toBe("deepseek:deepseek-chat");
    expect(spec.roles.planner).toBeDefined();
    expect(spec.roles.developer).toBeDefined();
    expect(spec.roles.reviewer).toBeDefined();
    expect(spec.flow.steps).toHaveLength(2);
    expect(spec.flow.steps[0].id).toBe("plan");
    expect(spec.flow.steps[1].when).toBe('plan.status == "success"');
  });
});

// ── Resume Mode ─────────────────────────────────────────────────────

describe("resume mode", () => {
  test("resumeFromStepId skips earlier steps", async () => {
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
  - id: review
    role: reviewer
    task: "Review the code"
`);

    // Execute all three steps successfully
    const firstRunMock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    const firstRun = await execute({
      task: "test",
      projectDir,
      harnessClient: firstRunMock,
      _compiledPackage: compiled,
      _executionId: randomUUID(),
    });

    expect(firstRun.success).toBe(true);

    // Now resume from "implement" — plan should be recorded as already complete
    const mock = new MockHarnessClient([
      successResponse(), // implement
      successResponse(), // review
    ]);

    const result = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
      _executionId: firstRun.executionId,
      resumeFromStepId: "implement",
    });

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]!.id).toBe("plan");
    expect(result.steps[0]!.status).toBe("success");
    expect(result.steps[0]!.sessionId).toBeUndefined();
    expect(result.steps[1]!.id).toBe("implement");
    expect(result.steps[1]!.status).toBe("success");
    expect(result.steps[2]!.id).toBe("review");
    expect(result.steps[2]!.status).toBe("success");
    expect(mock.callCount).toBe(2);
  });
});

// ── Blueprint Execution Path (MED-001) ──────────────────────────────

// Fixture: a self-contained blueprint package (mirrors the shipped
// defaults) used to exercise the advisory-plane compiler → adapter
// → controller pipeline.
const BLUEPRINT_ROLES: BlueprintRolesFile = {
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
  roles?: BlueprintRolesFile,
): LoadedBlueprintPackage {
  const raw = parseYaml(blueprintYaml);
  const blueprint = BlueprintSchema.parse(raw) as Blueprint;
  const rolesFile = roles ?? BLUEPRINT_ROLES;

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

describe("blueprint execution path (MED-001)", () => {
  test("compiles feature-development blueprint and executes all steps", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "Implement login flow",
      blueprintPackage: "feature-development",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(6);
    expect(result.steps.map((s) => s.status)).toEqual([
      "success",
      "success",
      "success",
      "success",
      "success",
      "success",
    ]);
    expect(mock.callCount).toBe(6);

    // {task} substitution reached the harness: the first step's effective
    // task contains the user's task.
    expect(mock.calls[0]!.task).toContain("Implement login flow");

    // LOW-001: the orchestration spec snapshot records structured
    // derived_from provenance for the compiled package.
    const specRaw = await readFile(
      join(result.executionDir, "orchestration-spec.json"),
      "utf-8",
    );
    const spec = JSON.parse(specRaw) as Record<string, unknown>;
    const fp = spec["flow_package"] as {
      derived_from?: { blueprint_id?: string; blueprint_version?: string };
    };
    expect(fp?.derived_from).toEqual({
      blueprint_id: "feature-development",
      blueprint_version: "0.1.0",
    });
  });

  test("nonexistent blueprint → validation failure (fail-closed)", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = new MockHarnessClient([successResponse()]);

    const result = await execute({
      task: "test",
      blueprintPackage: "no-such-blueprint-xyz",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(false);
    expect(result.isValidationFailure).toBe(true);
    expect(result.error).toContain("Failed to resolve or compile blueprint");
    expect(mock.callCount).toBe(0);
  });

  test("empty task with blueprint → validation failure (fail-closed, EDGE-1)", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = new MockHarnessClient([successResponse()]);

    const result = await execute({
      task: "",
      blueprintPackage: "feature-development",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(false);
    expect(result.isValidationFailure).toBe(true);
    expect(result.error).toContain("non-empty --task");
    expect(mock.callCount).toBe(0);
  });

  test("adapter produces valid CompiledFlowPackage with derived_from", async () => {
    const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "adapter-test"
steps:
  - id: plan
    role: planner
    task_template: "Plan the implementation of {task}"
    context_spec: "Focus on architecture decisions."
  - id: implement
    role: developer
    task_template: "Implement {task} following the plan"
`);

    const compiled = compileBlueprint(loaded, "login feature");
    const adapted = adaptCompiledBlueprintToFlowPackage(compiled);

    // Package identity comes from the blueprint
    expect(adapted.packageId).toBe("adapter-test");
    expect(adapted.packageVersion).toBe("1.0.0");

    // task is present (and non-empty) on every compiled step
    expect(adapted.resolvedFlow.steps).toHaveLength(2);
    for (const step of adapted.resolvedFlow.steps) {
      expect(step.task.length).toBeGreaterThan(0);
    }
    expect(adapted.resolvedFlow.steps[0]!.task).toBe(
      "Plan the implementation of login feature",
    );
    expect(adapted.resolvedFlow.steps[1]!.task).toBe(
      "Implement login feature following the plan",
    );

    // context_spec is preserved as the step context
    expect(adapted.resolvedFlow.steps[0]!.context).toBe(
      "Focus on architecture decisions.",
    );

    // Structured derived_from provenance recorded (LOW-001)
    expect(adapted.derivedFrom).toEqual({
      blueprint_id: "adapter-test",
      blueprint_version: "1.0.0",
    });

    // Human-readable provenance string retained
    expect(adapted.resolvedFlow.provenance).toContain(
      "derived_from blueprint:adapter-test@1.0.0",
    );

    // The adapted package is executable end-to-end
    const projectDir = makeTempDir();
    await ensureDir(projectDir);
    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
    ]);
    const result = await execute({
      task: "login feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: adapted,
    });
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(mock.callCount).toBe(2);
  });

  test("blueprint with when step compiles and when expression is preserved", async () => {
    const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "when-test"
steps:
  - id: plan
    role: planner
    task_template: "Plan {task}"
  - id: review
    role: reviewer
    task_template: "Review {task}"
    when: plan.status == "success"
`);

    const compiled = compileBlueprint(loaded, "feature");
    const adapted = adaptCompiledBlueprintToFlowPackage(compiled);

    expect(adapted.resolvedFlow.steps[0]!.when).toBeUndefined();
    expect(adapted.resolvedFlow.steps[1]!.when).toBe(
      'plan.status == "success"',
    );

    // Executing the compiled package evaluates the gate: plan succeeds
    // so the review step runs.
    const projectDir = makeTempDir();
    await ensureDir(projectDir);
    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
    ]);
    const result = await execute({
      task: "feature",
      projectDir,
      harnessClient: mock,
      _compiledPackage: adapted,
    });

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.status).toBe("success");
    expect(result.steps[1]!.status).toBe("success");
    expect(mock.callCount).toBe(2);
  });

  test("Q1: compiled flow package emitted to execution directory", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "Implement login flow",
      blueprintPackage: "feature-development",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(true);

    // Verify flow-package directory exists
    const fpDir = join(result.executionDir, "flow-package");
    const { readFile: readFpFile } = await import("node:fs/promises");

    // package.yaml should exist with compiled metadata
    const pkgRaw = await readFpFile(join(fpDir, "package.yaml"), "utf-8");
    const pkgYaml = parseYaml(pkgRaw) as Record<string, unknown>;
    expect(pkgYaml.schema_version).toBe("0.1.0");
    expect((pkgYaml.package as Record<string, unknown>)?.id).toBe("feature-development");
    expect(pkgYaml.derived_from).toBeDefined();
    expect((pkgYaml.derived_from as Record<string, unknown>)?.blueprint_id).toBe("feature-development");

    // flow.yaml should exist with substituted tasks (not {task} placeholders)
    const flowRaw = await readFpFile(join(fpDir, "flow.yaml"), "utf-8");
    const flowYaml = parseYaml(flowRaw) as Record<string, unknown>;
    const steps = flowYaml.steps as Array<{ task: string }>;
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.task).not.toContain("{task}");
      expect(step.task.length).toBeGreaterThan(0);
    }

    // roles.yaml should exist with resolved roles
    const rolesRaw = await readFpFile(join(fpDir, "roles.yaml"), "utf-8");
    const rolesYaml = parseYaml(rolesRaw) as Record<string, unknown>;
    expect(rolesYaml.schema_version).toBe("0.3.0");
    const rolesObj = rolesYaml.roles as Record<string, unknown>;
    expect(Object.keys(rolesObj).length).toBeGreaterThan(0);

    // result.json should include compiled_flow_package_dir
    const resultRaw = await readFpFile(
      join(result.executionDir, "result.json"),
      "utf-8",
    );
    const resultJson = JSON.parse(resultRaw) as Record<string, unknown>;
    expect(resultJson.compiled_flow_package_dir).toBeString();
    expect(resultJson.compiled_flow_package_dir as string).toContain("flow-package");
  });
});

// ── Tool-Aware Blueprint Execution (R-009) ────────────────────────────

describe("tool-aware blueprint execution (R-009)", () => {
  test("E2E: blueprint with readFile tool passes tools to harness", async () => {
    const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "read-tool-test"
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

    const compiled = compileBlueprint(loaded, "src/cli.ts");
    const adapted = adaptCompiledBlueprintToFlowPackage(compiled);

    const projectDir = makeTempDir();
    await ensureDir(projectDir);
    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "src/cli.ts",
      projectDir,
      harnessClient: mock,
      _compiledPackage: adapted,
    });

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);

    // Tools should have been passed to the harness for step 1
    expect(mock.calls.length).toBe(2);
    const call1 = mock.calls[0]!;
    expect(call1.tools).toBeDefined();
    expect(call1.tools!).toHaveLength(1);
    expect(call1.tools![0]!.tool).toBe("readFile");
    expect(call1.tools![0]!.scope).toBe("agent_decides");

    // Step 2 should have no tools
    const call2 = mock.calls[1]!;
    expect(call2.tools).toBeUndefined();
  });

  test("E2E: blueprint with writeFile+requires_approval auto-approves (no callback)", async () => {
    const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "write-warn-test"
steps:
  - id: write
    role: developer
    task_template: "Write {task}"
    tools:
      - tool: writeFile
        scope: "agent_decides"
        requires_approval: true
`);

    const compiled = compileBlueprint(loaded, "test output");
    const adapted = adaptCompiledBlueprintToFlowPackage(compiled);

    const projectDir = makeTempDir();
    await ensureDir(projectDir);
    const mock = new MockHarnessClient([successResponse()]);

    const result = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: adapted,
    });

    // Execution should succeed — auto-approval when no callback is configured
    expect(result.success).toBe(true);
    // The decision log should capture the auto-approval (tested in decision-logger.test.ts)
  });

  test("E2E: step without tools works as before (no regression)", async () => {
    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: step1
    role: developer
    task: "Do something"
  - id: step2
    role: reviewer
    task: "Review something"
`);

    const projectDir = makeTempDir();
    await ensureDir(projectDir);
    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "test",
      projectDir,
      harnessClient: mock,
      _compiledPackage: compiled,
    });

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);

    // No tools should be present in either harness call
    for (const call of mock.calls) {
      expect(call.tools).toBeUndefined();
    }
  });

  test("E2E: adapter preserves tools in compiled flow steps", async () => {
    const loaded = makeLoadedBlueprint(`
schema_version: "0.2.0"
blueprint_id: "preserve-tools"
steps:
  - id: work
    role: developer
    task_template: "Work on {task}"
    tools:
      - tool: executeShell
        scope: "agent_decides"
`);

    const compiled = compileBlueprint(loaded, "the feature");
    const adapted = adaptCompiledBlueprintToFlowPackage(compiled);

    // Verify tools are in the adapted flow step
    const adaptedStep = adapted.resolvedFlow.steps[0]!;
    const adaptedTools = (adaptedStep as Record<string, unknown>)["tools"] as Array<Record<string, unknown>> | undefined;
    expect(adaptedTools).toBeDefined();
    expect(adaptedTools!).toHaveLength(1);
    expect(adaptedTools![0]!.tool).toBe("executeShell");
    expect(adaptedTools![0]!.scope).toBe("agent_decides");
  });

  test("zao-read-codebase blueprint compiles and executes", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "Read src/cli.ts",
      blueprintPackage: "zao-read-codebase",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);

    // First step should have readFile tool passed to harness
    expect(mock.calls.length).toBe(2);
    const firstCall = mock.calls[0]!;
    expect(firstCall.tools).toBeDefined();
    expect(firstCall.tools!).toHaveLength(1);
    expect(firstCall.tools![0]!.tool).toBe("readFile");
  });

  test("blueprint with invalid tool name is rejected at schema validation", () => {
    const blueprintYaml = `
schema_version: "0.2.0"
blueprint_id: "bad-tools"
steps:
  - id: bad
    role: developer
    task_template: "Do {task}"
    tools:
      - tool: unsupportedTool
        scope: "agent_decides"
`;
    const raw = parseYaml(blueprintYaml);
    const result = BlueprintSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });
});

// ── deriveModelSlug (Q5) ─────────────────────────────────────────────

describe("deriveModelSlug (Q5)", () => {
  test('"deepseek:deepseek-chat" → "deepseek-chat"', () => {
    expect(deriveModelSlug("deepseek:deepseek-chat")).toBe("deepseek-chat");
  });

  test('"claude-opus-4-6" → "claude-opus-4-6" (no colon, returned as-is)', () => {
    expect(deriveModelSlug("claude-opus-4-6")).toBe("claude-opus-4-6");
  });

  test('"openai:gpt-4-turbo" → "gpt-4-turbo"', () => {
    expect(deriveModelSlug("openai:gpt-4-turbo")).toBe("gpt-4-turbo");
  });

  test("empty string returns empty string", () => {
    expect(deriveModelSlug("")).toBe("");
  });

  test("multiple colons: splits on first, takes rest", () => {
    expect(deriveModelSlug("a:b:c")).toBe("b:c");
  });
});
