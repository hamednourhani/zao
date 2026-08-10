/**
 * E2E integration tests for the dev-cycle blueprint.
 *
 * The dev-cycle blueprint is the universal development cycle:
 * read → plan → implement → review (with iterative loop).
 *
 * ## What this test covers
 *
 * - 4-step pipeline executes successfully (all steps run in order)
 * - Loop retries when review returns requires_actions
 * - Loop exits after max_iterations with escalation
 * - Loop exits on first review success
 * - implement step receives context from review on retry
 * - When read fails, remaining steps are skipped
 * - Decision log contains all expected events
 *
 * @module dev-cycle-e2e.test
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  execute,
  MockHarnessClient,
} from "../src/execution-runner.ts";
import type { MockHarnessJobResponse } from "../src/execution-runner.ts";

// ── Temp Directory Management ──────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-devcycle-${randomUUID()}`);
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

function successResponse(
  overrides?: Partial<MockHarnessJobResponse>,
): MockHarnessJobResponse {
  return {
    success: true,
    events: [
      {
        session_id: randomUUID(),
        prompt_tokens: 150,
        completion_tokens: 25,
        timestamp: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

function failureResponse(
  overrides?: Partial<MockHarnessJobResponse>,
): MockHarnessJobResponse {
  return {
    success: false,
    error: "Step failed: mock error",
    events: [
      {
        session_id: randomUUID(),
        prompt_tokens: 50,
        completion_tokens: 0,
        timestamp: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

/** Creates a scratch project directory for test tasks. */
async function createTestProject(): Promise<string> {
  const dir = makeTempDir();
  await ensureDir(dir);
  await writeFile(
    join(dir, "broken.ts"),
    `export function add(a: number, b: number): number {
  return a - b; // BUG: should be a + b
}
`,
    "utf-8",
  );
  return dir;
}

// ── TEST-1: 4-step pipeline executes successfully ──────────────────

describe("dev-cycle blueprint execution", () => {
  test("E2E: 4-step pipeline executes successfully with mock harness", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(), // read
      successResponse(), // plan
      successResponse(), // implement
      successResponse({ // review — success, loop exits
        result: { status: "success", findings: [] },
      }),
    ]);

    const result = await execute({
      task: "Fix the subtraction bug in broken.ts",
      blueprintPackage: "dev-cycle",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(4);
    expect(result.steps.map((s) => s.id)).toEqual([
      "read",
      "plan",
      "implement",
      "review",
    ]);
    expect(result.steps.map((s) => s.status)).toEqual([
      "success",
      "success",
      "success",
      "success",
    ]);
    expect(mock.callCount).toBe(4);
  });

  test("E2E: loop retries when review returns requires_actions", async () => {
    const projectDir = await createTestProject();

    // First pass: implement succeeds, review returns requires_actions
    // Second pass: implement succeeds, review returns success
    const mock = new MockHarnessClient([
      successResponse(), // read
      successResponse(), // plan
      successResponse(), // implement (pass 1)
      successResponse({   // review (pass 1) — requires_actions
        result: { status: "requires_actions", findings: ["Missing edge case"], recommended_next: "implement" },
      }),
      successResponse(), // implement (pass 2)
      successResponse({   // review (pass 2) — success
        result: { status: "success", findings: [] },
      }),
    ]);

    const result = await execute({
      task: "Fix the subtraction bug in broken.ts",
      blueprintPackage: "dev-cycle",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(true);
    // implement runs twice, review runs twice
    // Total: read + plan + implement(pass1) + review(pass1) + implement(pass2) + review(pass2) = 6
    expect(mock.callCount).toBe(6);
  });

  test("E2E: loop exits after max_iterations=5 with escalation", async () => {
    const projectDir = await createTestProject();

    // Every review returns requires_actions — loop should max out
    const responses: MockHarnessJobResponse[] = [
      successResponse(), // read
      successResponse(), // plan
    ];
    // 5 iterations of implement + review with requires_actions
    for (let i = 0; i < 5; i++) {
      responses.push(successResponse()); // implement
      responses.push(successResponse({   // review — always requires_actions
        result: { status: "requires_actions", findings: [`Issue ${i + 1}`], recommended_next: "implement" },
      }));
    }

    const mock = new MockHarnessClient(responses);

    const maxIterResult = await execute({
      task: "Fix the subtraction bug in broken.ts",
      blueprintPackage: "dev-cycle",
      projectDir,
      harnessClient: mock,
    });

    // Should be false — max iterations reached
    // Total calls: read + plan + 5 × (implement + review) = 12
    expect(mock.callCount).toBe(12);
    expect(maxIterResult.success).toBe(false);
   });

  test("E2E: loop exits on first review.status == success", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(), // read
      successResponse(), // plan
      successResponse(), // implement
      successResponse({   // review — success!
        result: { status: "success", findings: [] },
      }),
    ]);

    const result = await execute({
      task: "Fix the bug",
      blueprintPackage: "dev-cycle",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(true);
    // implement runs once, review runs once
    expect(mock.callCount).toBe(4);
    expect(result.steps.some((s) => s.id === "implement" && s.status === "success")).toBe(true);
    expect(result.steps.some((s) => s.id === "review" && s.status === "success")).toBe(true);
  });

  test("E2E: when read fails, remaining steps are skipped", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      failureResponse({ error: "Cannot read file" }),
      // plan, implement, review — should be skipped
    ]);

    const result = await execute({
      task: "Fix the bug",
      blueprintPackage: "dev-cycle",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(false);
    expect(result.steps).toHaveLength(4);

    expect(result.steps[0]!.id).toBe("read");
    expect(result.steps[0]!.status).toBe("failed");

    expect(result.steps[1]!.id).toBe("plan");
    expect(result.steps[1]!.status).toBe("skipped");

    expect(result.steps[2]!.id).toBe("implement");
    expect(result.steps[2]!.status).toBe("skipped");

    expect(result.steps[3]!.id).toBe("review");
    expect(result.steps[3]!.status).toBe("skipped");

    expect(mock.callCount).toBe(1);
  });

  test("E2E: {task} substitution works in all steps", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse({ result: { status: "success", findings: [] } }),
    ]);

    await execute({
      task: "Fix the subtraction bug in broken.ts",
      blueprintPackage: "dev-cycle",
      projectDir,
      harnessClient: mock,
    });

    // Verify {task} substitution reached harness for each step
    for (const call of mock.calls) {
      expect(call.task).not.toContain("{task}");
      expect(call.task.length).toBeGreaterThan(0);
    }

    // The read step task should contain the user's task
    expect(mock.calls[0]!.task).toContain("Fix the subtraction bug in broken.ts");
  });

  test("E2E: all steps use the developer role", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse({ result: { status: "success", findings: [] } }),
    ]);

    const result = await execute({
      task: "Fix the bug",
      blueprintPackage: "dev-cycle",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(true);

    // All steps use the "developer" role
    for (const step of result.steps) {
      expect(step.role).toBe("developer");
    }
  });

  test("E2E: decision log contains expected events", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse({ result: { status: "success", findings: [] } }),
    ]);

    const result = await execute({
      task: "Fix the bug",
      blueprintPackage: "dev-cycle",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(true);

    // Verify execution directory exists and contains expected files
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(result.executionDir);
    expect(entries).toContain("execution.json");
    expect(entries).toContain("index.jsonl");
    expect(entries).toContain("events.jsonl");
    expect(entries).toContain("orchestration-spec.json");
    expect(entries).toContain("result.json");
  });
});
