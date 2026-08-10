/**
 * REQ-1: Tool Call Schema tests.
 *
 * Validates:
 * - ToolCallSchema accepts valid tool calls
 * - ToolCallSchema rejects invalid tool calls (missing fields, wrong types, extra fields)
 * - HandoffWithToolsSchema validates tool_call and final variants
 * - Schema version is "0.2.0" (bumped from "0.1.0")
 * - reason is required (human gate depends on it)
 */

import { describe, expect, test } from "bun:test";
import {
  ToolCallSchema,
  HandoffWithToolsSchema,
  TOOL_NAMES,
} from "../src/schemas/tool-call.ts";

// ── ToolCallSchema ──────────────────────────────────────────────────

describe("REQ-1: ToolCallSchema", () => {
  const validReadFile = {
    tool: "readFile" as const,
    args: { path: "src/auth.ts" },
    reason: "Read the auth module to understand the bug",
  };

  const validWriteFile = {
    tool: "writeFile" as const,
    args: { path: "src/auth.ts", content: "export function validate() { return true; }" },
    reason: "Fix the null check in validate()",
  };

  const validExecuteShell = {
    tool: "executeShell" as const,
    args: { command: "bun test" },
    reason: "Run the test suite to verify the fix",
  };

  // ── Valid tool calls ──────────────────────────────────────────

  test("accepts valid readFile tool call", () => {
    const result = ToolCallSchema.safeParse(validReadFile);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool).toBe("readFile");
      expect(result.data.args.path).toBe("src/auth.ts");
      expect(result.data.reason).toBe("Read the auth module to understand the bug");
    }
  });

  test("accepts valid writeFile tool call", () => {
    const result = ToolCallSchema.safeParse(validWriteFile);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool).toBe("writeFile");
      expect(result.data.args.path).toBe("src/auth.ts");
      expect(result.data.args.content).toBe("export function validate() { return true; }");
      expect(result.data.reason).toBe("Fix the null check in validate()");
    }
  });

  test("accepts valid executeShell tool call", () => {
    const result = ToolCallSchema.safeParse(validExecuteShell);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool).toBe("executeShell");
      expect(result.data.args.command).toBe("bun test");
      expect(result.data.reason).toBe("Run the test suite to verify the fix");
    }
  });

  test("TOOL_NAMES covers all three expected tools", () => {
    expect(TOOL_NAMES).toEqual(["readFile", "writeFile", "executeShell"]);
  });

  // ── Invalid tool calls ────────────────────────────────────────

  test("rejects tool call with missing reason", () => {
    const result = ToolCallSchema.safeParse({
      tool: "readFile",
      args: { path: "src/auth.ts" },
      // reason missing
    });
    expect(result.success).toBe(false);
  });

  test("rejects tool call with empty reason", () => {
    const result = ToolCallSchema.safeParse({
      tool: "readFile",
      args: { path: "src/auth.ts" },
      reason: "",
    });
    expect(result.success).toBe(false);
  });

  test("rejects tool call with invalid tool name", () => {
    const result = ToolCallSchema.safeParse({
      tool: "deleteEverything",
      args: {},
      reason: "need to clean up",
    });
    expect(result.success).toBe(false);
  });

  test("rejects tool call with wrong arg type (path as number)", () => {
    const result = ToolCallSchema.safeParse({
      tool: "readFile",
      args: { path: 42 },
      reason: "read the file",
    });
    expect(result.success).toBe(false);
  });

  test("rejects tool call with extra unknown fields", () => {
    const result = ToolCallSchema.safeParse({
      tool: "readFile",
      args: { path: "src/auth.ts" },
      reason: "read the file",
      should_not_be_here: true,
    });
    expect(result.success).toBe(false);
  });

  test("rejects tool call with missing tool", () => {
    const result = ToolCallSchema.safeParse({
      args: { path: "src/auth.ts" },
      reason: "read the file",
    });
    expect(result.success).toBe(false);
  });

  test("rejects tool call with missing args", () => {
    const result = ToolCallSchema.safeParse({
      tool: "readFile",
      reason: "read the file",
    });
    expect(result.success).toBe(false);
  });
});

// ── HandoffWithToolsSchema ──────────────────────────────────────────

describe("REQ-1: HandoffWithToolsSchema", () => {
  // ── tool_call variant ─────────────────────────────────────────

  test("accepts valid tool_call response", () => {
    const result = HandoffWithToolsSchema.safeParse({
      schema_version: "0.2.0",
      type: "tool_call",
      tool_call: {
        tool: "readFile",
        args: { path: "src/auth.ts" },
        reason: "Read the auth module",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("tool_call");
      expect(result.data.schema_version).toBe("0.2.0");
    }
  });

  test("rejects tool_call with wrong schema_version", () => {
    const result = HandoffWithToolsSchema.safeParse({
      schema_version: "0.1.0",
      type: "tool_call",
      tool_call: {
        tool: "readFile",
        args: { path: "src/auth.ts" },
        reason: "Read the auth module",
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects tool_call with invalid tool_call field", () => {
    const result = HandoffWithToolsSchema.safeParse({
      schema_version: "0.2.0",
      type: "tool_call",
      tool_call: {
        tool: "readFile",
        args: { path: "src/auth.ts" },
        // reason missing
      },
    });
    expect(result.success).toBe(false);
  });

  // ── final variant ─────────────────────────────────────────────

  test("accepts valid final response", () => {
    const result = HandoffWithToolsSchema.safeParse({
      schema_version: "0.2.0",
      type: "final",
      status: "success",
      summary: "Fixed the auth bug",
      changes: [
        { file_path: "src/auth.ts", content: "export function validate() { return true; }" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "final") {
      expect(result.data.schema_version).toBe("0.2.0");
      expect(result.data.status).toBe("success");
      expect(result.data.summary).toBe("Fixed the auth bug");
    }
  });

  test("accepts final response without changes array", () => {
    const result = HandoffWithToolsSchema.safeParse({
      schema_version: "0.2.0",
      type: "final",
      status: "success",
      summary: "All good",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "final") {
      expect(result.data.changes).toBeUndefined();
    }
  });

  test("accepts final response with needs_clarification status", () => {
    const result = HandoffWithToolsSchema.safeParse({
      schema_version: "0.2.0",
      type: "final",
      status: "needs_clarification",
      summary: "Need more info",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "final") {
      expect(result.data.status).toBe("needs_clarification");
    }
  });

  test("accepts final response with failed status", () => {
    const result = HandoffWithToolsSchema.safeParse({
      schema_version: "0.2.0",
      type: "final",
      status: "failed",
      summary: "Could not fix the bug",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "final") {
      expect(result.data.status).toBe("failed");
    }
  });

  test("rejects final response without status", () => {
    const result = HandoffWithToolsSchema.safeParse({
      schema_version: "0.2.0",
      type: "final",
      summary: "Missing status field",
    });
    expect(result.success).toBe(false);
  });

  test("rejects final response with invalid status value", () => {
    const result = HandoffWithToolsSchema.safeParse({
      schema_version: "0.2.0",
      type: "final",
      status: "in_progress",
      summary: "Not a valid status",
    });
    expect(result.success).toBe(false);
  });

  // ── Ambiguity prevention ──────────────────────────────────────

  test("rejects response with both tool_call and final fields", () => {
    const result = HandoffWithToolsSchema.safeParse({
      schema_version: "0.2.0",
      type: "tool_call",
      tool_call: {
        tool: "readFile",
        args: { path: "src/auth.ts" },
        reason: "read",
      },
      status: "success", // shouldn't be here
      summary: "also shouldn't be here",
      changes: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects response with unknown type", () => {
    const result = HandoffWithToolsSchema.safeParse({
      schema_version: "0.2.0",
      type: "unknown_type",
      summary: "bad type",
    });
    expect(result.success).toBe(false);
  });
});
