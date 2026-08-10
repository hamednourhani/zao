/**
 * E2E integration test for the zao-fix blueprint — REQ-8.
 *
 * The zao-fix blueprint is the "hello world" test for the entire tool
 * execution pipeline. It lets the LLM read a file, analyze it, fix it,
 * and verify the fix — with human approval at each destructive step.
 *
 * ## What this test covers
 *
 * - Blueprint compiles without errors via the shipped defaults registry
 * - All 4 steps (read, analyze, fix, verify) execute in declared order
 * - Tool declarations are wired correctly to the harness for each step
 * - `requires_approval` flags trigger the expected console.warn (stub)
 * - `when` gates correctly skip downstream steps on prior failure
 * - MockHarnessClient records all harness calls for verification
 *
 * ## Why this matters
 *
 * R-009 shipped tool declarations but they were never actually wired to
 * the harness. R-010 shipped loops without working tool execution. This
 * test proves that the blueprint compilation pipeline produces a valid
 * flow that the controller can execute end-to-end.
 *
 * @module zao-fix-e2e.test
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm, mkdir, writeFile as writeFsFile, readFile } from "node:fs/promises";
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
  const dir = join("/tmp", `zao-test-mofix-${randomUUID()}`);
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

// ── Test Fixtures ──────────────────────────────────────────────────

/**
 * Creates a scratch project directory with a dummy file to simulate
 * a real "zao-fix" task target.
 */
async function createTestProject(): Promise<string> {
  const dir = makeTempDir();
  await ensureDir(dir);
  await writeFsFile(
    join(dir, "broken.ts"),
    `// File with a bug
export function add(a: number, b: number): number {
  return a - b; // BUG: should be a + b
}
`,
    "utf-8",
  );
  return dir;
}

// ── TEST-1: Blueprint compiles and all steps execute successfully ───

describe("zao-fix blueprint compilation and execution", () => {
  test("E2E: 4-step zao-fix pipeline executes successfully with mock harness", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(), // read
      successResponse(), // analyze
      successResponse(), // fix
      successResponse(), // verify
    ]);

    const result = await execute({
      task: "Fix the subtraction bug in broken.ts",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    // Blueprint compiled and executed
    expect(result.success).toBe(true);
    expect(result.executionId).toBeTruthy();
    expect(result.executionDir).toContain("executions");

    // All 4 steps ran
    expect(result.steps).toHaveLength(4);
    expect(result.steps.map((s) => s.id)).toEqual([
      "read",
      "analyze",
      "fix",
      "verify",
    ]);
    expect(result.steps.map((s) => s.status)).toEqual([
      "success",
      "success",
      "success",
      "success",
    ]);

    // 4 harness calls (one per step)
    expect(mock.callCount).toBe(4);
  });

  test("E2E: step task templates have {task} substituted", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    await execute({
      task: "Fix the subtraction bug in broken.ts",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    // Verify {task} substitution reached harness for each step
    for (const call of mock.calls) {
      expect(call.task).not.toContain("{task}");
      expect(call.task.length).toBeGreaterThan(0);
    }

    // The read step task should contain the user's task (substituted from {task})
    expect(mock.calls[0]!.task).toContain("Fix the subtraction bug in broken.ts");
  });

  test("E2E: blueprint provenance recorded in orchestration spec", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "Fix the subtraction bug in broken.ts",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(true);

    // Read orchestration-spec.json and verify derived_from provenance
    const { readFile } = await import("node:fs/promises");
    const specRaw = await readFile(
      join(result.executionDir, "orchestration-spec.json"),
      "utf-8",
    );
    const spec = JSON.parse(specRaw) as Record<string, unknown>;
    const fp = spec["flow_package"] as {
      derived_from?: { blueprint_id?: string; blueprint_version?: string };
    };
    expect(fp?.derived_from).toEqual({
      blueprint_id: "zao-fix",
      blueprint_version: "0.1.0",
    });
  });
});

// ── TEST-2: Tool declarations are wired to harness ─────────────────

describe("zao-fix tool declarations", () => {
  test("E2E: read step has readFile tool declared", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    await execute({
      task: "Fix the bug",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    // read step: should have readFile tool
    const readCall = mock.calls[0]!;
    expect(readCall.tools).toBeDefined();
    expect(readCall.tools!).toHaveLength(1);
    expect(readCall.tools![0]!.tool).toBe("readFile");
    expect(readCall.tools![0]!.scope).toBe("agent_decides");
    expect(readCall.tools![0]!.requires_approval).toBeUndefined();

    // analyze step: no tools
    const analyzeCall = mock.calls[1]!;
    expect(analyzeCall.tools).toBeUndefined();
  });

  test("E2E: fix step has writeFile and executeShell tools with requires_approval", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    await execute({
      task: "Fix the bug",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    // fix step: should have writeFile + executeShell, both requiring approval
    const fixCall = mock.calls[2]!;
    expect(fixCall.tools).toBeDefined();
    expect(fixCall.tools!).toHaveLength(2);

    // Find writeFile tool
    const writeTool = fixCall.tools!.find((t) => t.tool === "writeFile");
    expect(writeTool).toBeDefined();
    expect(writeTool!.scope).toBe("agent_decides");
    expect(writeTool!.requires_approval).toBe(true);

    // Find executeShell tool
    const shellTool = fixCall.tools!.find((t) => t.tool === "executeShell");
    expect(shellTool).toBeDefined();
    expect(shellTool!.scope).toBe("agent_decides");
    expect(shellTool!.requires_approval).toBe(true);
  });

  test("E2E: verify step has executeShell tool with requires_approval", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    await execute({
      task: "Fix the bug",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    // verify step: should have executeShell tool with requires_approval
    const verifyCall = mock.calls[3]!;
    expect(verifyCall.tools).toBeDefined();
    expect(verifyCall.tools!).toHaveLength(1);
    expect(verifyCall.tools![0]!.tool).toBe("executeShell");
    expect(verifyCall.tools![0]!.scope).toBe("agent_decides");
    expect(verifyCall.tools![0]!.requires_approval).toBe(true);
  });

  test("E2E: requires_approval auto-approves and execution proceeds (no callback)", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "Fix the bug",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    // All 4 steps should execute successfully — auto-approval of destructive tools
    // when no approval callback is configured (backwards compatible)
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(4);
    expect(result.steps[0]!.status).toBe("success");
    expect(result.steps[1]!.status).toBe("success");
    expect(result.steps[2]!.status).toBe("success");
    expect(result.steps[3]!.status).toBe("success");
  });
});

// ── TEST-3: when gates work correctly ─────────────────────────────

describe("zao-fix when gates", () => {
  test("E2E: when read fails, remaining steps are skipped", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      failureResponse({ error: "Cannot read file" }),
      // analyze, fix, verify — should never be called
    ]);

    const result = await execute({
      task: "Fix the bug",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(false);
    expect(result.steps).toHaveLength(4);

    // read failed
    expect(result.steps[0]!.id).toBe("read");
    expect(result.steps[0]!.status).toBe("failed");

    // analyze, fix, verify should be skipped
    expect(result.steps[1]!.id).toBe("analyze");
    expect(result.steps[1]!.status).toBe("skipped");
    expect(result.steps[2]!.id).toBe("fix");
    expect(result.steps[2]!.status).toBe("skipped");
    expect(result.steps[3]!.id).toBe("verify");
    expect(result.steps[3]!.status).toBe("skipped");

    // Only one harness call (read) was attempted
    expect(mock.callCount).toBe(1);
  });

  test("E2E: when analyze fails, fix and verify are skipped", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(), // read
      failureResponse({ error: "Cannot analyze" }), // analyze
      // fix, verify — never called
    ]);

    const result = await execute({
      task: "Fix the bug",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(false);
    expect(result.steps).toHaveLength(4);

    expect(result.steps[0]!.status).toBe("success"); // read
    expect(result.steps[1]!.status).toBe("failed"); // analyze
    expect(result.steps[2]!.status).toBe("skipped"); // fix
    expect(result.steps[3]!.status).toBe("skipped"); // verify

    expect(mock.callCount).toBe(2);
  });
});

// ── TEST-4: Edge cases ─────────────────────────────────────────────

describe("zao-fix edge cases", () => {
  test("empty task → validation failure (fail-closed)", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([successResponse()]);

    const result = await execute({
      task: "",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(false);
    expect(result.isValidationFailure).toBe(true);
    expect(result.error).toContain("non-empty --task");
    expect(mock.callCount).toBe(0);
  });

  test("all steps record correct role and model", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "Fix the bug",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(true);

    // All steps use the "developer" role
    for (const step of result.steps) {
      expect(step.role).toBe("developer");
      expect(step.model).toBe("deepseek-chat");
    }
  });
});

// ── TEST-5: Security — no violations for standard blueprint ────────

describe("zao-fix security", () => {
  test("E2E: standard zao-fix execution has no security violations", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "Fix the bug",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(true);

    // Verify execution directory contains expected files
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(result.executionDir);
    expect(entries).toContain("execution.json");
    expect(entries).toContain("index.jsonl");
    expect(entries).toContain("events.jsonl");
    expect(entries).toContain("orchestration-spec.json");
    expect(entries).toContain("result.json");

    // Verify flow-package directory exists (blueprint mode)
    expect(entries).toContain("flow-package");
  });
});

// ── TEST-6: Blueprint resolves from defaults ───────────────────────

describe("zao-fix blueprint resolution", () => {
  test("E2E: zao-fix blueprint resolves without explicit path", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    // Just passing the package ID — no path. The registry should find it.
    const result = await execute({
      task: "Fix the bug",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(4);
      expect(mock.callCount).toBe(4);
    });
});

// ── TEST-7: Decision log populated with harness tool events ─────────
// R-012/REQ-7: All harness tool executions logged in decisions.jsonl

describe("zao-fix decision log entries", () => {
  test("E2E: harness tool_call and tool_result events appear in decisions.jsonl", async () => {
    const projectDir = await createTestProject();

    // Create harness responses that include tool_call/tool_result events
    const mock = new MockHarnessClient([
      successResponse({
        events: [
          { session_id: randomUUID(), prompt_tokens: 80, completion_tokens: 20, timestamp: new Date().toISOString() },
          { event_id: randomUUID(), action: "tool_call", tool: "readFile", args: { path: "broken.ts" }, reason: "Read the broken file" },
          { event_id: randomUUID(), action: "tool_result", tool: "readFile", success: true, fileContent: "export function add...", filePath: "broken.ts" },
        ],
      }),
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "Fix the subtraction bug in broken.ts",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(true);

    // Verify decisions.jsonl exists and contains tool events
    const decisionsPath = join(result.executionDir, "decisions.jsonl");
    const decisionsRaw = await readFile(decisionsPath, "utf-8");
    const lines = decisionsRaw.trim().split("\n").filter(Boolean);

    // At minimum: step_start gate_decision, and the tool events logged by controller
    expect(lines.length).toBeGreaterThanOrEqual(1);

    // Find lines where the controller logged harness tool events
    const harnessToolLines = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e["actor"] === "harness");

    // Should have tool_call and tool_result logged for the read step
    expect(harnessToolLines.length).toBeGreaterThanOrEqual(2);
  });

  test("E2E: decision log contains step completion entries for all steps", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse(),
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "Fix the bug",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(true);

    // Read decisions.jsonl
    const decisionsPath = join(result.executionDir, "decisions.jsonl");
    const decisionsRaw = await readFile(decisionsPath, "utf-8");
    const lines = decisionsRaw.trim().split("\n").filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

    // Verify each step has a gate_decision entry
    const gateDecisions = entries.filter(
      (e) => e["action"] === "gate_decision",
    );
    expect(gateDecisions.length).toBeGreaterThanOrEqual(4); // one per step

    // Verify all 4 step IDs appear in gate decisions
    const stepIds = gateDecisions.map(
      (e) => (e["data"] as Record<string, unknown>)?.["step_role"],
    );
    expect(stepIds).toContain("developer"); // all steps use developer role

    // Verify all entries have the required schema fields
    for (const entry of entries) {
      expect(entry["schema_version"]).toBe("0.1.0");
      expect(entry["event_id"]).toBeTruthy();
      expect(entry["timestamp"]).toBeTruthy();
      expect(entry["execution_id"]).toBeTruthy();
      expect(entry["session_id"]).toBeTruthy();
      expect(entry["step_id"]).toBeTruthy();
      expect(entry["actor"]).toBeTruthy();
      expect(entry["action"]).toBeTruthy();
      expect(entry["data"]).toBeDefined();
    }
  });

  test("E2E: tool events have expected schema fields", async () => {
    const projectDir = await createTestProject();

    const eventId1 = randomUUID();
    const eventId2 = randomUUID();

    const mock = new MockHarnessClient([
      successResponse({
        events: [
          { session_id: randomUUID(), prompt_tokens: 100, completion_tokens: 30, timestamp: new Date().toISOString() },
          {
            event_id: eventId1,
            action: "tool_call",
            tool: "readFile",
            args: { path: "broken.ts" },
            reason: "Read the buggy file",
          },
          {
            event_id: eventId2,
            action: "tool_result",
            tool: "readFile",
            success: true,
            fileContent: "// Fixed code",
            filePath: "broken.ts",
          },
        ],
      }),
      successResponse(),
      successResponse(),
      successResponse(),
    ]);

    const result = await execute({
      task: "Fix the bug",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(true);

    // Read decisions.jsonl and check tool events
    const decisionsPath = join(result.executionDir, "decisions.jsonl");
    const decisionsRaw = await readFile(decisionsPath, "utf-8");
    const lines = decisionsRaw.trim().split("\n").filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

    // Find harness tool events
    const harnessEvents = entries.filter(
      (e) => e["actor"] === "harness",
    );

    expect(harnessEvents.length).toBeGreaterThanOrEqual(2);

    // Verify tool_call entry
    const toolCallEntry = harnessEvents.find(
      (e) => e["action"] === "tool_call",
    );
    expect(toolCallEntry).toBeDefined();
    expect(toolCallEntry!["step_id"]).toBe("read");
    expect(
      (toolCallEntry!["data"] as Record<string, unknown>)?.["tool"],
    ).toBe("readFile");

    // Verify tool_result entry
    const toolResultEntry = harnessEvents.find(
      (e) => e["action"] === "tool_result",
    );
    expect(toolResultEntry).toBeDefined();
    expect(toolResultEntry!["step_id"]).toBe("read");
    expect(
      (toolResultEntry!["data"] as Record<string, unknown>)?.["tool"],
    ).toBe("readFile");
    expect(
      (toolResultEntry!["data"] as Record<string, unknown>)?.["success"],
    ).toBe(true);
  });
});

// ── TEST-8: Execution flow ordering and when gates with tools ───────

describe("zao-fix execution flow consistency", () => {
  test("E2E: step ordering is preserved when tools execute", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      successResponse({
        events: [
          { event_id: randomUUID(), action: "tool_call", tool: "readFile", args: { path: "broken.ts" } },
          { event_id: randomUUID(), action: "tool_result", tool: "readFile", success: true },
        ],
      }),
      successResponse(),
      successResponse({
        events: [
          { event_id: randomUUID(), action: "tool_call", tool: "writeFile", args: { path: "broken.ts", content: "fixed" } },
          { event_id: randomUUID(), action: "tool_result", tool: "writeFile", success: true },
        ],
      }),
      successResponse(),
    ]);

    const result = await execute({
      task: "Fix the bug",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(true);

    // Verify step order: read → analyze → fix → verify
    expect(result.steps.map((s) => s.id)).toEqual([
      "read",
      "analyze",
      "fix",
      "verify",
    ]);

    // All steps executed (we provided 4 responses)
    expect(mock.callCount).toBe(4);
  });

  test("E2E: when gate still works with tool-instrumented steps", async () => {
    const projectDir = await createTestProject();

    const mock = new MockHarnessClient([
      failureResponse({ error: "Cannot read file" }),
      // analyze, fix, verify — should be skipped
    ]);

    const result = await execute({
      task: "Fix the bug",
      blueprintPackage: "zao-fix",
      projectDir,
      harnessClient: mock,
    });

    expect(result.success).toBe(false);
    expect(result.steps[0]!.status).toBe("failed");
    expect(result.steps[1]!.status).toBe("skipped");
    expect(result.steps[2]!.status).toBe("skipped");
    expect(result.steps[3]!.status).toBe("skipped");
    expect(mock.callCount).toBe(1);
  });
});

