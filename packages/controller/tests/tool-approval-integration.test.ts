/**
 * Tool approval integration test — REQ-3: Human Gate for Destructive Actions.
 *
 * Tests the controller → harness → tool approval flow:
 * - When a step declares tools with `requires_approval: true`, the
 *   `onToolApproval` callback is passed to the harness client.
 * - The harness invokes `onToolApproval` when the LLM attempts to use
 *   a tool requiring approval (simulated by a wrapper harness).
 * - Approval → step succeeds.
 * - Rejection → step fails with "Denied by user".
 *
 * ## Design
 *
 * MockHarnessClient just records calls — it doesn't invoke `onToolApproval`.
 * To test the full flow, this file creates a lightweight `ApprovalAwareMockHarness`
 * that extends MockHarnessClient and invokes `onToolApproval` before
 * resolving the response. This simulates what the real harness does
 * when the LLM emits a tool_call and the tool loop checks approval.
 *
 * @module tool-approval-integration.test
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  execute,
  MockHarnessClient,
} from "../src/execution-runner.ts";
import type {
  HarnessClient,
  MockHarnessJobResponse,
} from "../src/execution-runner.ts";
import {
  createMockToolApproval,
} from "../src/human-gate.ts";
import type {
  ToolApprovalCallback,
  ToolApprovalResponse,
} from "../src/human-gate.ts";
import { compileFlowPackage } from "../src/flow-package/package-compiler.ts";
import type { LoadedFlowPackage } from "../src/flow-package/package-loader.ts";
import { FlowSchema } from "../src/schemas/flow.ts";
import type { Flow } from "../src/schemas/flow.ts";
import type { RolesFile } from "../src/schemas/role-definition.ts";
import type { ResolvedRoleDefinition } from "../src/schemas/role-definition.ts";
import type { ToolDeclaration } from "../src/schemas/flow.ts";

// ── Temp Directory Management ──────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-approval-${randomUUID()}`);
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

// ── Test Fixtures ──────────────────────────────────────────────────

const TEST_ROLES: RolesFile = {
  schema_version: "0.3.0" as const,
  model_defaults: { default_llm_id: "deepseek:deepseek-chat" },
  roles: {
    developer: {
      prompt_template: "You are a developer agent.",
      context_budget: 0.65,
      llm_id: null,
    },
  },
};

/**
 * Creates a compiled flow package with steps that have approval-requiring tools.
 */
function makeFlowWithApprovalTools(): ReturnType<typeof compileFlowPackage> {
  const flowYaml = `
schema_version: "0.2.0"
steps:
  - id: fix
    role: developer
    task: "Fix the bug by writing code"
    tools:
      - tool: readFile
        scope: agent_decides
      - tool: writeFile
        scope: agent_decides
        requires_approval: true
      - tool: executeShell
        scope: agent_decides
        requires_approval: true
  `;

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

// ── Approval-Aware Mock Harness ────────────────────────────────────

/**
 * A wrapper around MockHarnessClient that simulates the harness
 * invoking `onToolApproval` when a tool requires approval.
 *
 * Before resolving each mock response, it checks whether the step's tools
 * include any `requires_approval` tools and invokes the callback once
 * for the first such tool. If the callback rejects, the job fails.
 * If it approves (or if no approval-requiring tools exist), the job
 * proceeds normally.
 */
class ApprovalAwareMockHarness implements HarnessClient {
  private _inner: MockHarnessClient;

  constructor(responses: MockHarnessJobResponse[]) {
    this._inner = new MockHarnessClient(responses);
  }

  get callCount(): number {
    return this._inner.callCount;
  }

  get calls(): ReadonlyArray<{
    roleId: string;
    resolvedRole: ResolvedRoleDefinition;
    role: string;
    task: string;
    projectDir: string;
    config: Record<string, unknown>;
    tools?: ToolDeclaration[];
  }> {
    return this._inner.calls;
  }

  async runJob(params: {
    sessionId?: string;
    roleId: string;
    resolvedRole: ResolvedRoleDefinition;
    task: string;
    projectDir: string;
    config: { autoYes?: boolean; format?: string };
    tools?: ToolDeclaration[];
    onToolApproval?: ToolApprovalCallback;
  }): Promise<{
    success: boolean;
    sessionId: string;
    sessionDir: string;
    result?: Record<string, unknown>;
    events: Array<Record<string, unknown>>;
    error?: string;
  }> {
    // If the step has tools requiring approval and an onToolApproval
    // callback is provided, invoke it for the first requiring-approval tool.
    // This simulates what the real harness's tool loop does.
    if (params.tools && params.onToolApproval) {
      const toolsNeedingApproval = params.tools.filter(
        (t) => t.requires_approval,
      );

      if (toolsNeedingApproval.length > 0) {
        const toolDecl = toolsNeedingApproval[0]!;

        // The tool field from ToolDeclaration may include delegateToSubagent,
        // but ToolApprovalRequest only accepts readFile|writeFile|executeShell.
        // We filter to safe tools; other tools don't go through human gate.
        const toolName = toolDecl.tool as "readFile" | "writeFile" | "executeShell";

        const approvalResponse: ToolApprovalResponse =
          await params.onToolApproval({
            tool: toolName,
            args: { path: "src/test.ts", content: "// fix" },
            reason: `The LLM wants to ${toolDecl.tool} to complete step "${params.roleId}"`,
            stepId: params.roleId,
            sessionId: params.sessionId ?? randomUUID(),
          });

        if (approvalResponse.decision === "reject") {
          return {
            success: false,
            sessionId: params.sessionId ?? randomUUID(),
            sessionDir: `/tmp/mo-approval-test-session`,
            events: [],
            error: approvalResponse.feedback ?? "Denied by user",
          };
        }
        // approve/modify → proceed to the mock response
      }
    }

    // Delegate to inner mock
    return this._inner.runJob(params);
  }
}

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

// ── TEST-1: Approval callback invoked for tools requiring approval ──

describe("tool approval flow — approval path", () => {
  test("onToolApproval invoked when step has tools requiring approval", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiledPkg = makeFlowWithApprovalTools();

    const mockHarness = new ApprovalAwareMockHarness([
      successResponse(),
    ]);

    const mockApproval = createMockToolApproval([
      { decision: "approve" },
    ]);

    const result = await execute({
      task: "Fix the bug",
      projectDir,
      harnessClient: mockHarness,
      onToolApproval: mockApproval,
      _compiledPackage: compiledPkg,
    });

    // Step should succeed — approval was granted
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.status).toBe("success");

    // The approval callback should have been called
    expect(mockApproval.calls.length).toBeGreaterThanOrEqual(1);
    const approvalCall = mockApproval.calls[0]!;
    expect(approvalCall.tool).toBe("writeFile");
    expect(approvalCall.args).toBeDefined();
    expect(approvalCall.reason).toBeTruthy();
    expect(approvalCall.stepId).toBe("developer");
  });

  test("approval callback called with correct tool name for the first requiring tool", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiledPkg = makeFlowWithApprovalTools();

    const mockHarness = new ApprovalAwareMockHarness([
      successResponse(),
    ]);

    const mockApproval = createMockToolApproval([
      { decision: "approve" },
    ]);

    await execute({
      task: "Fix the bug",
      projectDir,
      harnessClient: mockHarness,
      onToolApproval: mockApproval,
      _compiledPackage: compiledPkg,
    });

    expect(mockApproval.calls.length).toBe(1);
    const call = mockApproval.calls[0]!;
    
    // The first tool requiring approval in the fixture is writeFile
    expect(call.tool).toBe("writeFile");
    expect(call.sessionId).toBeTruthy();
  });
});

// ── TEST-2: Rejection fails the step ───────────────────────────────

describe("tool approval flow — rejection path", () => {
  test("rejection of tool → step fails with denied message", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiledPkg = makeFlowWithApprovalTools();

    const mockHarness = new ApprovalAwareMockHarness([
      successResponse(),
    ]);

    const mockApproval = createMockToolApproval([
      { decision: "reject", feedback: "This change looks dangerous" },
    ]);

    const result = await execute({
      task: "Fix the bug",
      projectDir,
      harnessClient: mockHarness,
      onToolApproval: mockApproval,
      _compiledPackage: compiledPkg,
    });

    // Step should fail — approval was rejected
    expect(result.success).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.status).toBe("failed");
    // The error is on the result object, not individual steps
    expect(result.error).toContain("dangerous");

    // Approval callback should have been called once
    expect(mockApproval.calls.length).toBe(1);
    expect(mockApproval.calls[0]!.tool).toBe("writeFile");
  });

  test("rejection with default message → step fails with 'Denied by user'", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiledPkg = makeFlowWithApprovalTools();

    const mockHarness = new ApprovalAwareMockHarness([
      successResponse(),
    ]);

    const mockApproval = createMockToolApproval([
      { decision: "reject" }, // no feedback → defaults to "Denied by user"
    ]);

    const result = await execute({
      task: "Fix the bug",
      projectDir,
      harnessClient: mockHarness,
      onToolApproval: mockApproval,
      _compiledPackage: compiledPkg,
    });

    expect(result.success).toBe(false);
    expect(result.steps[0]!.status).toBe("failed");
    expect(result.error).toContain("Denied by user");
  });
});

// ── TEST-3: No approval needed when tools don't require it ─────────

describe("tool approval flow — no approval needed", () => {
  test("step without requiring-approval tools does not invoke onToolApproval", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    // Flow with tools that DON'T require approval
    const flowYaml = `
schema_version: "0.2.0"
steps:
  - id: read
    role: developer
    task: "Read the file"
    tools:
      - tool: readFile
        scope: agent_decides
  `;

    const raw = parseYaml(flowYaml);
    const flow = FlowSchema.parse(raw) as Flow;

    const loaded: LoadedFlowPackage = {
      packageId: "test-no-approval",
      packageVersion: "0.0.0",
      packageDir: "/tmp/test-no-approval",
      flow,
      roles: TEST_ROLES,
      rawFlow: flow as unknown as Record<string, unknown>,
      rawRoles: TEST_ROLES as unknown as Record<string, unknown>,
    };

    const compiledPkg = compileFlowPackage(loaded);

    const mockHarness = new ApprovalAwareMockHarness([
      successResponse(),
    ]);

    const mockApproval = createMockToolApproval([
      { decision: "reject" }, // should never be called
    ]);

    const result = await execute({
      task: "Read the file",
      projectDir,
      harnessClient: mockHarness,
      onToolApproval: mockApproval,
      _compiledPackage: compiledPkg,
    });

    // Step should succeed — no approval needed
    expect(result.success).toBe(true);
    expect(result.steps[0]!.status).toBe("success");

    // Approval callback should NOT have been called (readFile doesn't require approval)
    expect(mockApproval.calls.length).toBe(0);
  });
});

// ── TEST-4: ToolApprovalCallback type compatibility ────────────────

describe("ToolApprovalCallback type compatibility", () => {
  test("createMockToolApproval satisfies ToolApprovalCallback", async () => {
    const mock: ToolApprovalCallback = createMockToolApproval([
      { decision: "approve" },
    ]);

    const result = await mock({
      tool: "writeFile",
      args: { path: "f.ts" },
      reason: "r",
      stepId: "s1",
      sessionId: "ss1",
    });

    expect(result.decision).toBe("approve");
  });
});

// ── TEST-5: onToolApproval parameter passed to harness ─────────────

describe("onToolApproval parameter wiring", () => {
  test("onToolApproval is passed through execute → harnessClient.runJob", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const compiledPkg = makeFlowWithApprovalTools();

    // Use standard MockHarnessClient to verify parameter passing
    const mockHarness = new MockHarnessClient([
      successResponse(),
    ]);

    const mockApproval = createMockToolApproval([
      { decision: "approve" },
    ]);

    await execute({
      task: "Fix the bug",
      projectDir,
      harnessClient: mockHarness,
      onToolApproval: mockApproval,
      _compiledPackage: compiledPkg,
    });

    // Verify the onToolApproval callback was passed to the harness
    expect(mockHarness.calls.length).toBe(1);
    expect(mockHarness.calls[0]!.onToolApproval).toBe(mockApproval);
  });
});
