/**
 * REQ-6: Security Enforcement — Banned Actions tests.
 *
 * Validates:
 * - Tool in allowed list → valid
 * - Tool NOT in allowed list → invalid, violation: "tool_not_allowed", escalate: true
 * - Path within projectRoot → valid
 * - Path outside projectRoot → invalid, violation: "path_out_of_scope", escalate: true
 * - Path traversal attempt (../../) → invalid
 * - Absolute path outside project → invalid
 * - readFile without path arg → valid (path is optional — let executor handle missing path)
 * - writeFile without path → valid (let executor handle it)
 * - executeShell with no path check needed → valid
 * - Empty allowedTools list → any tool request is invalid
 * - Multiple tools in allowed list → can use any of them
 *
 * Uses temp directories for path tests (pattern from executor.test.ts).
 *
 * @module tool-access.test
 */

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateToolAccess } from "../src/core/tool-access.ts";
import type { ToolDeclaration } from "../src/schemas/flow.ts";
import type { ToolCall } from "../src/schemas/tool-call.ts";

// ── Helpers ─────────────────────────────────────────────────────────

/** Build a minimal ToolCall for testing. Uses `as ToolCall` to allow testing
 * with invalid tool names (e.g., for tool_not_allowed violation tests). */
function makeToolCall(
  tool: string,
  args: { path?: string; content?: string; command?: string } = {},
  reason = "Test reason",
): ToolCall {
  return { tool, args, reason } as ToolCall;
}

/** Build a minimal ToolDeclaration for testing. */
function makeToolDecl(
  tool: string,
  scope: string = "agent_decides",
  requiresApproval?: boolean,
): ToolDeclaration {
  return { tool, scope, requires_approval: requiresApproval } as ToolDeclaration;
}

// ── Temp directory management ───────────────────────────────────────

let tempDirs: string[] = [];

afterAll(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zao-tool-access-"));
  tempDirs.push(dir);
  return dir;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("validateToolAccess — tool allowlist", () => {
  const allowedTools: ToolDeclaration[] = [
    makeToolDecl("readFile"),
    makeToolDecl("writeFile", "agent_decides", true),
    makeToolDecl("executeShell", "agent_decides", true),
  ];

  test("tool in allowed list → valid", () => {
    const result = validateToolAccess(
      makeToolCall("readFile", { path: "test.txt" }),
      allowedTools,
      "/tmp",
    );

    expect(result.valid).toBe(true);
    expect(result.violation).toBeUndefined();
    expect(result.escalate).toBeUndefined();
  });

  test("tool NOT in allowed list → invalid, violation tool_not_allowed, escalate true", () => {
    const result = validateToolAccess(
      makeToolCall("deleteEverything", { path: "test.txt" }),
      allowedTools,
      "/tmp",
    );

    expect(result.valid).toBe(false);
    expect(result.violation).toBe("tool_not_allowed");
    expect(result.message).toContain("deleteEverything");
    expect(result.message).toContain("not allowed");
    expect(result.escalate).toBe(true);
  });

  test("empty allowedTools → any tool request is invalid", () => {
    const result = validateToolAccess(
      makeToolCall("readFile", { path: "test.txt" }),
      [],
      "/tmp",
    );

    expect(result.valid).toBe(false);
    expect(result.violation).toBe("tool_not_allowed");
    expect(result.escalate).toBe(true);
    expect(result.message).toContain("(none)");
  });

  test("multiple tools in allowed list → can use any of them", () => {
    // readFile
    expect(
      validateToolAccess(
        makeToolCall("readFile", { path: "a.txt" }),
        allowedTools,
        "/tmp",
      ).valid,
    ).toBe(true);

    // writeFile
    expect(
      validateToolAccess(
        makeToolCall("writeFile", { path: "b.txt", content: "x" }),
        allowedTools,
        "/tmp",
      ).valid,
    ).toBe(true);

    // executeShell
    expect(
      validateToolAccess(
        makeToolCall("executeShell", { command: "echo hi" }),
        allowedTools,
        "/tmp",
      ).valid,
    ).toBe(true);
  });
});

describe("validateToolAccess — path confinement", () => {
  test("path within projectRoot → valid", async () => {
    const projectRoot = await makeTempDir();
    // create a file so the path resolves within the project root
    await writeFile(join(projectRoot, "inside.txt"), "hello");

    const result = validateToolAccess(
      makeToolCall("readFile", { path: "inside.txt" }),
      [makeToolDecl("readFile")],
      projectRoot,
    );

    expect(result.valid).toBe(true);
    expect(result.violation).toBeUndefined();
  });

  test("path outside projectRoot → invalid, violation path_out_of_scope, escalate true", async () => {
    const projectRoot = await makeTempDir();
    const outsideDir = await makeTempDir();

    const result = validateToolAccess(
      makeToolCall("readFile", { path: join(outsideDir, "secret.txt") }),
      [makeToolDecl("readFile")],
      projectRoot,
    );

    expect(result.valid).toBe(false);
    expect(result.violation).toBe("path_out_of_scope");
    expect(result.message).toContain("outside project root");
    expect(result.escalate).toBe(true);
  });

  test("path traversal attempt (../../) → invalid", async () => {
    const projectRoot = await makeTempDir();
    // ensure project root is deep enough for ../.. to escape
    // mkdtemp gives us something like /tmp/zao-tool-access-XXXXXX
    // which is already 2+ levels deep in a real temp dir

    const result = validateToolAccess(
      makeToolCall("readFile", { path: "../../etc/passwd" }),
      [makeToolDecl("readFile")],
      projectRoot,
    );

    expect(result.valid).toBe(false);
    expect(result.violation).toBe("path_out_of_scope");
    expect(result.escalate).toBe(true);
  });

  test("absolute path outside project → invalid", async () => {
    const projectRoot = await makeTempDir();

    const result = validateToolAccess(
      makeToolCall("readFile", { path: "/etc/passwd" }),
      [makeToolDecl("readFile")],
      projectRoot,
    );

    expect(result.valid).toBe(false);
    expect(result.violation).toBe("path_out_of_scope");
    expect(result.escalate).toBe(true);
  });

  test("readFile without path arg → valid (let executor handle missing path)", () => {
    const result = validateToolAccess(
      makeToolCall("readFile", {}),
      [makeToolDecl("readFile")],
      "/tmp",
    );

    expect(result.valid).toBe(true);
  });

  test("writeFile without path → valid (let executor handle it)", () => {
    const result = validateToolAccess(
      makeToolCall("writeFile", { content: "hello" }),
      [makeToolDecl("writeFile")],
      "/tmp",
    );

    expect(result.valid).toBe(true);
  });

  test("path is empty string → still resolves within root (valid)", async () => {
    const projectRoot = await makeTempDir();

    const result = validateToolAccess(
      makeToolCall("readFile", { path: "" }),
      [makeToolDecl("readFile")],
      projectRoot,
    );

    // path.resolve(projectRoot, "") === projectRoot, so it starts with root
    expect(result.valid).toBe(true);
  });
});

describe("validateToolAccess — tool type edge cases", () => {
  test("executeShell has no path check → valid when allowed", () => {
    const result = validateToolAccess(
      makeToolCall("executeShell", { command: "rm -rf /" }),
      [makeToolDecl("executeShell")],
      "/tmp",
    );

    // executeShell doesn't have path confinement at this layer
    // (the executor's command-guard handles command safety)
    expect(result.valid).toBe(true);
  });

  test("executeShell not in allowed list → invalid", () => {
    const result = validateToolAccess(
      makeToolCall("executeShell", { command: "echo hi" }),
      [makeToolDecl("readFile")],
      "/tmp",
    );

    expect(result.valid).toBe(false);
    expect(result.violation).toBe("tool_not_allowed");
  });

  test("tool_not_allowed message includes allowed tool names", () => {
    const result = validateToolAccess(
      makeToolCall("nuke", {}),
      [makeToolDecl("readFile"), makeToolDecl("writeFile")],
      "/tmp",
    );

    expect(result.message).toContain("readFile");
    expect(result.message).toContain("writeFile");
    expect(result.message).toContain("nuke");
  });

  test("path_out_of_scope message includes the offending path", async () => {
    const projectRoot = await makeTempDir();

    const result = validateToolAccess(
      makeToolCall("writeFile", { path: "/etc/shadow" }),
      [makeToolDecl("writeFile")],
      projectRoot,
    );

    expect(result.message).toContain("/etc/shadow");
    expect(result.message).toContain("BANNED");
  });
});
