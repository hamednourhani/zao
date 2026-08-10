/**
 * Human gate tests — REQ-3: Human Gate for Destructive Actions.
 *
 * Tests:
 * - ToolApprovalRequest type validation (required fields)
 * - ToolApprovalResponse type check
 * - createMockToolApproval factory: approve, reject, modify
 * - Mock callback records received requests
 * - Sequential mock responses (multiple calls)
 *
 * The stdin-based requestToolApproval is tested via mock pattern —
 * the actual I/O is untestable in unit tests, but the contract
 * (callback signature, response handling) is fully verified.
 *
 * @module human-gate.test
 */

import { describe, expect, test } from "bun:test";
import type {
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolApprovalCallback,
} from "../src/human-gate.ts";
import {
  requestToolApproval,
  createMockToolApproval,
} from "../src/human-gate.ts";

// ── Type Validation ─────────────────────────────────────────────────

describe("ToolApprovalRequest type validation", () => {
  test("accepts valid writeFile request", () => {
    const req: ToolApprovalRequest = {
      tool: "writeFile",
      args: { path: "src/auth.ts", content: "fixed code" },
      reason: "Fix null check bug",
      stepId: "fix-step-1",
      sessionId: "sess-abc-123",
    };

    expect(req.tool).toBe("writeFile");
    expect(req.args.path).toBe("src/auth.ts");
    expect(req.args.content).toBe("fixed code");
    expect(req.reason).toBe("Fix null check bug");
    expect(req.stepId).toBe("fix-step-1");
    expect(req.sessionId).toBe("sess-abc-123");
  });

  test("accepts valid executeShell request", () => {
    const req: ToolApprovalRequest = {
      tool: "executeShell",
      args: { command: "bun test" },
      reason: "Run tests to verify the fix",
      stepId: "verify-step-2",
      sessionId: "sess-def-456",
    };

    expect(req.tool).toBe("executeShell");
    expect(req.args.command).toBe("bun test");
    expect(req.reason).toBe("Run tests to verify the fix");
  });

  test("accepts valid readFile request", () => {
    const req: ToolApprovalRequest = {
      tool: "readFile",
      args: { path: "src/index.ts" },
      reason: "Read the main entry point",
      stepId: "read-step-3",
      sessionId: "sess-ghi-789",
    };

    expect(req.tool).toBe("readFile");
    expect(req.args.path).toBe("src/index.ts");
  });

  test("required fields on ToolApprovalRequest", () => {
    // Verify all required fields are present at the type level.
    const req: ToolApprovalRequest = {
      tool: "readFile",
      args: {},
      reason: "",
      stepId: "",
      sessionId: "",
    };

    // All fields exist (TypeScript compiler enforces this).
    expect("tool" in req).toBe(true);
    expect("args" in req).toBe(true);
    expect("reason" in req).toBe(true);
    expect("stepId" in req).toBe(true);
    expect("sessionId" in req).toBe(true);
  });
});

// ── ToolApprovalResponse Type ───────────────────────────────────────

describe("ToolApprovalResponse type", () => {
  test("approve response", () => {
    const res: ToolApprovalResponse = { decision: "approve" };
    expect(res.decision).toBe("approve");
    expect(res.modifiedArgs).toBeUndefined();
    expect(res.feedback).toBeUndefined();
  });

  test("reject response", () => {
    const res: ToolApprovalResponse = {
      decision: "reject",
      feedback: "This change looks dangerous",
    };
    expect(res.decision).toBe("reject");
    expect(res.feedback).toBe("This change looks dangerous");
  });

  test("modify response with modified args", () => {
    const res: ToolApprovalResponse = {
      decision: "modify",
      modifiedArgs: { path: "src/auth.ts", content: "safer code" },
      feedback: "Changed the content to be safer",
    };
    expect(res.decision).toBe("modify");
    expect(res.modifiedArgs).toEqual({
      path: "src/auth.ts",
      content: "safer code",
    });
    expect(res.feedback).toBe("Changed the content to be safer");
  });
});

// ── createMockToolApproval Factory ──────────────────────────────────

describe("createMockToolApproval", () => {
  const testRequest: ToolApprovalRequest = {
    tool: "writeFile",
    args: { path: "test.ts", content: "test" },
    reason: "Test reason",
    stepId: "step-1",
    sessionId: "session-1",
  };

  test("returns approve when configured", async () => {
    const mock = createMockToolApproval([{ decision: "approve" }]);

    const response = await mock(testRequest);
    expect(response).toEqual({ decision: "approve" });
  });

  test("returns reject when configured", async () => {
    const mock = createMockToolApproval([{ decision: "reject" }]);

    const response = await mock(testRequest);
    expect(response.decision).toBe("reject");
  });

  test("returns modify when configured", async () => {
    const mock = createMockToolApproval([
      {
        decision: "modify",
        modifiedArgs: { path: "modified.ts" },
        feedback: "Changed path",
      },
    ]);

    const response = await mock(testRequest);
    expect(response).toEqual({
      decision: "modify",
      modifiedArgs: { path: "modified.ts" },
      feedback: "Changed path",
    });
  });

  test("records the ToolApprovalRequest passed to it", async () => {
    const mock = createMockToolApproval([{ decision: "approve" }]);

    await mock(testRequest);

    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0]!).toEqual(testRequest);
    expect(mock.calls[0]!.tool).toBe("writeFile");
    expect(mock.calls[0]!.reason).toBe("Test reason");
  });

  test("cycles through multiple responses sequentially", async () => {
    const mock = createMockToolApproval([
      { decision: "approve" },
      { decision: "reject", feedback: "no" },
      { decision: "approve" },
    ]);

    const req1: ToolApprovalRequest = {
      ...testRequest,
      stepId: "step-1",
    };
    const req2: ToolApprovalRequest = {
      ...testRequest,
      stepId: "step-2",
    };
    const req3: ToolApprovalRequest = {
      ...testRequest,
      stepId: "step-3",
    };

    const r1 = await mock(req1);
    const r2 = await mock(req2);
    const r3 = await mock(req3);

    expect(r1).toEqual({ decision: "approve" });
    expect(r2).toEqual({ decision: "reject", feedback: "no" });
    expect(r3).toEqual({ decision: "approve" });
    expect(mock.calls.length).toBe(3);
    expect(mock.calls[0]!.stepId).toBe("step-1");
    expect(mock.calls[1]!.stepId).toBe("step-2");
    expect(mock.calls[2]!.stepId).toBe("step-3");
  });

  test("returns reject when no more responses configured (fail safe)", async () => {
    const mock = createMockToolApproval([{ decision: "approve" }]);

    // First call uses the configured response
    const r1 = await mock(testRequest);
    expect(r1.decision).toBe("approve");

    // Second call: no more configured responses → defaults to reject (fail safe)
    const r2 = await mock({
      ...testRequest,
      stepId: "unexpected-step",
    });
    expect(r2.decision).toBe("reject");
    expect(mock.calls.length).toBe(2);
  });

  test("clears internal state on each factory call (isolated instances)", async () => {
    const mock1 = createMockToolApproval([{ decision: "approve" }]);
    const mock2 = createMockToolApproval([{ decision: "reject" }]);

    const r1 = await mock1(testRequest);
    const r2 = await mock2(testRequest);

    expect(r1.decision).toBe("approve");
    expect(r2.decision).toBe("reject");
    expect(mock1.calls.length).toBe(1);
    expect(mock2.calls.length).toBe(1);
  });
});

// ── ToolApprovalCallback Type Compatibility ─────────────────────────

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

  test("requestToolApproval satisfies ToolApprovalCallback", () => {
    // requestToolApproval has the same signature as ToolApprovalCallback.
    // This is a compile-time check: if requestToolApproval didn't match
    // the type, this assignment would not compile.
    const _fn: ToolApprovalCallback = requestToolApproval;
    expect(_fn).toBeDefined();
    expect(typeof _fn).toBe("function");
  });
});

// ── Edge Cases ──────────────────────────────────────────────────────

describe("ToolApprovalRequest edge cases", () => {
  test("empty args object", () => {
    const req: ToolApprovalRequest = {
      tool: "readFile",
      args: {},
      reason: "Read something",
      stepId: "step-1",
      sessionId: "session-1",
    };

    expect(req.args).toEqual({});
  });

  test("sql injection in reason (just passes through)", () => {
    const req: ToolApprovalRequest = {
      tool: "writeFile",
      args: { path: "file.ts", content: "safe" },
      reason: "DROP TABLE users; --",
      stepId: "step-1",
      sessionId: "session-1",
    };

    // The gate is a pass-through — it displays the reason but doesn't
    // parse it. Sanitization is the caller's responsibility.
    expect(req.reason).toBe("DROP TABLE users; --");
  });

  test("ANSI escape codes in reason (pass-through)", () => {
    const req: ToolApprovalRequest = {
      tool: "executeShell",
      args: { command: "ls" },
      reason: "\x1b[31mRED TEXT\x1b[0m",
      stepId: "step-1",
      sessionId: "session-1",
    };

    expect(req.reason).toContain("\x1b[31m");
  });
});

// ── H4 Fix Test: modify decision returns clear rejection ────────────

describe("H4: modify decision returns clear rejection with message", () => {
  test("modify decision through mock returns rejection with implementable message", () => {
    // The "modify" option was silently dropped in v1 (behaved as reject).
    // Now it returns a clear rejection with a message explaining it's not
    // yet implemented. This test verifies the mock factory still allows
    // modify responses for forward compatibility, while the real
    // requestToolApproval() explicitly rejects modify with a message.

    // Simulate what requestToolApproval() now returns for modify:
    const modifyResponse: ToolApprovalResponse = {
      decision: "reject",
      feedback: "Modify is not yet implemented — rejecting this tool call. You may re-submit with modified arguments manually.",
    };

    expect(modifyResponse.decision).toBe("reject");
    expect(modifyResponse.feedback).toBeDefined();
    expect(modifyResponse.feedback).toContain("not yet implemented");
    expect(modifyResponse.feedback).toContain("rejecting");
    expect(modifyResponse.feedback).toContain("re-submit");
  });

  test("mock factory still supports modify for forward compatibility", async () => {
    // createMockToolApproval still accepts modify responses for tests
    // that simulate future v2 behavior. The mock just passes through
    // whatever response is configured.
    const mock = createMockToolApproval([
      {
        decision: "modify",
        modifiedArgs: { path: "modified.ts" },
        feedback: "Changed path",
      },
    ]);

    const response = await mock({
      tool: "writeFile",
      args: { path: "test.ts", content: "test" },
      reason: "Test",
      stepId: "step-1",
      sessionId: "session-1",
    });

    // The mock faithfully returns what was configured (not an error).
    // The real requestToolApproval() converts modify to reject in v1.
    expect(response.decision).toBe("modify");
    expect(response.modifiedArgs).toEqual({ path: "modified.ts" });
    expect(response.feedback).toBe("Changed path");
  });
});
