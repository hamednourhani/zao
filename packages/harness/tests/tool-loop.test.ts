/**
 * REQ-2: Tool Execution Loop tests.
 *
 * Validates:
 * - LLM calls tool → tool executed → result sent to LLM → LLM responds final
 * - LLM calls multiple tools in sequence
 * - Max turns limit prevents infinite loops
 * - Tool failure → error sent to LLM → LLM continues
 * - Tool approval rejected → "Denied by user" error
 * - Tool loop with no tools → backwards compatible (single call)
 *
 * Uses dependency injection (`_generateObjectFn`) to mock LLM responses.
 * Tool execution uses real file operations in temp directories.
 *
 * @module tool-loop.test
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runToolLoop } from "../src/core/tool-loop.ts";
import type { ToolLoopParams, ToolApprovalResult } from "../src/core/tool-loop.ts";
import type { ToolCall } from "../src/schemas/tool-call.ts";
import type { HandoffWithTools } from "../src/schemas/tool-call.ts";
import { createMockLlmClient } from "./fixtures/mock-llm-client.ts";

// ── Constants ──────────────────────────────────────────────────────

const MOCK_LLM_CLIENT = createMockLlmClient({
  llmId: "deepseek:deepseek-chat",
  providerId: "deepseek",
  modelSlug: "deepseek-chat",
  apiModelId: "deepseek-chat",
});

// ── Temp Directory Management ──────────────────────────────────────

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-tool-loop-${crypto.randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
  tempDirs = [];
});

// ── Mock Helpers ───────────────────────────────────────────────────

/**
 * Creates a mock generateObject result for a tool_call response.
 * The LLM wants to call a tool.
 */
function mockToolCall(tool: string, args: Record<string, unknown>, reason: string) {
  return {
    object: {
      schema_version: "0.2.0" as const,
      type: "tool_call" as const,
      tool_call: {
        tool,
        args,
        reason,
      },
    },
    finishReason: "stop" as const,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 50, reasoningTokens: 0 },
    },
    warnings: undefined,
    request: { body: undefined, headers: undefined },
    response: {
      id: "mock-tc-id",
      timestamp: new Date(),
      modelId: "deepseek-chat",
      headers: {},
    },
    providerMetadata: undefined,
    toJsonResponse: () => new Response(),
  };
}

/**
 * Creates a mock generateObject result for a final response.
 * The LLM has completed its task.
 */
function mockFinal(status: "success" | "needs_clarification" | "failed" = "success", summary = "Done") {
  return {
    object: {
      schema_version: "0.2.0" as const,
      type: "final" as const,
      status,
      summary,
      changes: [
        { file_path: "src/out.ts", content: "// fixed" },
      ],
    },
    finishReason: "stop" as const,
    usage: {
      inputTokens: 150,
      outputTokens: 75,
      totalTokens: 225,
      inputTokenDetails: { noCacheTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 75, reasoningTokens: 0 },
    },
    warnings: undefined,
    request: { body: undefined, headers: undefined },
    response: {
      id: "mock-final-id",
      timestamp: new Date(),
      modelId: "deepseek-chat",
      headers: {},
    },
    providerMetadata: undefined,
    toJsonResponse: () => new Response(),
  };
}

// ── Suite ───────────────────────────────────────────────────────────

describe("REQ-2: runToolLoop", () => {
  // ── TEST: Single tool call → readFile → final ─────────────────

  test("LLM calls readFile, receives file contents, responds with final", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    // Create a test file for the LLM to read
    const testFilePath = join(projectDir, "src", "auth.ts");
    await mkdir(join(projectDir, "src"), { recursive: true });
    await writeFile(testFilePath, "export function validate() { return true; }");

    // Session directory
    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    // Mock: first call → tool_call (readFile), second call → final
    const mockGenObj = mock()
      .mockResolvedValueOnce(mockToolCall("readFile", { path: "src/auth.ts" }, "Read the auth module"))
      .mockResolvedValueOnce(mockFinal("success", "Auth module read and analyzed"));

    const result = await runToolLoop({
      prompt: "Analyze the auth module",
      projectRoot: projectDir,
      sessionDir,
      sessionId: "test-session-1",
      tools: [{ tool: "readFile", scope: "agent_decides" }],
      llmClient: MOCK_LLM_CLIENT,
      maxTurns: 10,
      _generateObjectFn: mockGenObj as unknown as ToolLoopParams["_generateObjectFn"],
      agentRole: "developer",
    });

    // ── Assert: loop succeeded ──
    expect(result.success).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result!.type).toBe("final");
    expect((result.result as HandoffWithTools & { status?: string }).status).toBe("success");
    expect(result.totalTurns).toBe(2); // One tool call + one final

    // ── Assert: events were logged ──
    expect(result.events.length).toBeGreaterThanOrEqual(2);
  });

  // ── TEST: Multiple tools in sequence ──────────────────────────

  test("LLM calls multiple tools in sequence: readFile → writeFile → final", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    // Create a test file
    const testFilePath = join(projectDir, "src", "input.ts");
    await mkdir(join(projectDir, "src"), { recursive: true });
    await writeFile(testFilePath, "// original content");

    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    // Mock: readFile → writeFile → final
    const mockGenObj = mock()
      .mockResolvedValueOnce(mockToolCall("readFile", { path: "src/input.ts" }, "Read input file"))
      .mockResolvedValueOnce(mockToolCall("writeFile", {
        path: "src/output.ts",
        content: "// modified content",
      }, "Write the modified file"))
      .mockResolvedValueOnce(mockFinal("success", "File processed"));

    const result = await runToolLoop({
      prompt: "Process the input file",
      projectRoot: projectDir,
      sessionDir,
      sessionId: "test-session-2",
      tools: [
        { tool: "readFile", scope: "agent_decides" },
        { tool: "writeFile", scope: "agent_decides" },
      ],
      llmClient: MOCK_LLM_CLIENT,
      maxTurns: 10,
      _generateObjectFn: mockGenObj as unknown as ToolLoopParams["_generateObjectFn"],
      agentRole: "developer",
    });

    // ── Assert: loop succeeded ──
    expect(result.success).toBe(true);
    expect(result.result!.type).toBe("final");
    expect(result.totalTurns).toBe(3);

    // ── Assert: the written file exists with correct content ──
    const outputPath = join(projectDir, "src", "output.ts");
    const outputContent = await readFile(outputPath, "utf-8");
    expect(outputContent).toBe("// modified content");
  });

  // ── TEST: Max turns limit ─────────────────────────────────────

  test("returns error after maxTurns when LLM never responds with final", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const testFilePath = join(projectDir, "data.txt");
    await writeFile(testFilePath, "sample data");

    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    // Mock: always return tool_call (infinite loop)
    const alwaysToolCall = mockToolCall("readFile", { path: "data.txt" }, "Read data");
    const mockGenObj = mock(() => Promise.resolve(alwaysToolCall));

    const result = await runToolLoop({
      prompt: "Keep reading data",
      projectRoot: projectDir,
      sessionDir,
      sessionId: "test-session-3",
      tools: [{ tool: "readFile", scope: "agent_decides" }],
      llmClient: MOCK_LLM_CLIENT,
      maxTurns: 5,
      _generateObjectFn: mockGenObj as unknown as ToolLoopParams["_generateObjectFn"],
      agentRole: "developer",
    });

    // ── Assert: loop failed with max turns error ──
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Max turns exceeded");
    expect(result.error).toContain("5");
    expect(result.totalTurns).toBe(5);
  });

  // ── TEST: Default maxTurns = 10 ───────────────────────────────

  test("default maxTurns is 10 when not specified", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const testFilePath = join(projectDir, "data.txt");
    await writeFile(testFilePath, "sample data");

    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    // Mock: always return tool_call (infinite loop)
    const alwaysToolCall = mockToolCall("readFile", { path: "data.txt" }, "Read data");
    const mockGenObj = mock(() => Promise.resolve(alwaysToolCall));

    const result = await runToolLoop({
      prompt: "Keep reading",
      projectRoot: projectDir,
      sessionDir,
      sessionId: "test-session-3b",
      tools: [{ tool: "readFile", scope: "agent_decides" }],
      llmClient: MOCK_LLM_CLIENT,
      _generateObjectFn: mockGenObj as unknown as ToolLoopParams["_generateObjectFn"],
      agentRole: "developer",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Max turns exceeded");
    expect(result.error).toContain("10");
  });

  // ── TEST: Tool failure → error sent to LLM → LLM continues ────

  test("tool failure sends error to LLM, LLM recovers with final response", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    // Mock: first call → tool_call (invalid shell command), second → final
    const mockGenObj = mock()
      .mockResolvedValueOnce(mockToolCall("executeShell", { command: "exit 1" }, "Run failing test"))
      .mockResolvedValueOnce(mockFinal("success", "Test failed but I adapted"));

    const result = await runToolLoop({
      prompt: "Run the test suite",
      projectRoot: projectDir,
      sessionDir,
      sessionId: "test-session-4",
      tools: [{ tool: "executeShell", scope: "agent_decides" }],
      llmClient: MOCK_LLM_CLIENT,
      maxTurns: 10,
      _generateObjectFn: mockGenObj as unknown as ToolLoopParams["_generateObjectFn"],
      agentRole: "developer",
    });

    // ── Assert: loop recovered and succeeded ──
    expect(result.success).toBe(true);
    expect(result.result!.type).toBe("final");
    expect(result.totalTurns).toBe(2);

    // ── Assert: events exist for both attempts ──
    expect(result.events.length).toBeGreaterThanOrEqual(2);
  });

  // ── TEST: Tool approval rejected → error ──────────────────────

  test("tool approval rejected returns Denied by user error", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    // Mock: tool_call for writeFile (requires approval)
    const mockGenObj = mock()
      .mockResolvedValueOnce(mockToolCall("writeFile", {
        path: "src/auth.ts",
        content: "// new code",
      }, "Fix the auth module"));

    // Approval callback that always rejects (no custom reason → defaults to "Denied by user")
    const onToolApproval = mock(async (_toolCall: ToolCall): Promise<ToolApprovalResult> => {
      return { approved: false };
    });

    const result = await runToolLoop({
      prompt: "Fix the auth module",
      projectRoot: projectDir,
      sessionDir,
      sessionId: "test-session-5",
      tools: [{ tool: "writeFile", scope: "agent_decides", requires_approval: true }],
      llmClient: MOCK_LLM_CLIENT,
      maxTurns: 10,
      onToolApproval,
      _generateObjectFn: mockGenObj as unknown as ToolLoopParams["_generateObjectFn"],
      agentRole: "developer",
    });

    // ── Assert: loop failed with Denied by user ──
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Denied by user");
    expect(onToolApproval).toHaveBeenCalledTimes(1);
  });

  // ── TEST: Tool approval approved executes the tool ────────────

  test("tool approval approved executes the tool and continues", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    await mkdir(join(projectDir, "src"), { recursive: true });

    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    // Mock: tool_call for writeFile → final
    const mockGenObj = mock()
      .mockResolvedValueOnce(mockToolCall("writeFile", {
        path: "src/auth.ts",
        content: "// approved code",
      }, "Fix the auth bug"))
      .mockResolvedValueOnce(mockFinal("success", "File written and verified"));

    // Approval callback that always approves
    const onToolApproval = mock(async (_toolCall: ToolCall): Promise<ToolApprovalResult> => {
      return { approved: true };
    });

    const result = await runToolLoop({
      prompt: "Fix the auth bug",
      projectRoot: projectDir,
      sessionDir,
      sessionId: "test-session-5b",
      tools: [{ tool: "writeFile", scope: "agent_decides", requires_approval: true }],
      llmClient: MOCK_LLM_CLIENT,
      maxTurns: 10,
      onToolApproval,
      _generateObjectFn: mockGenObj as unknown as ToolLoopParams["_generateObjectFn"],
      agentRole: "developer",
    });

    expect(result.success).toBe(true);
    expect(result.result!.type).toBe("final");
    expect(onToolApproval).toHaveBeenCalledTimes(1);

    // File was actually written
    const fileContent = await readFile(join(projectDir, "src", "auth.ts"), "utf-8");
    expect(fileContent).toBe("// approved code");
  });

  // ── TEST: Backwards compat — no tools → single call ───────────

  test("tool loop with no tools calls LLM once and returns final", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    // Mock: single final response
    const mockGenObj = mock()
      .mockResolvedValueOnce(mockFinal("success", "Task done without tools"));

    const result = await runToolLoop({
      prompt: "Do something simple",
      projectRoot: projectDir,
      sessionDir,
      sessionId: "test-session-6",
      tools: [],
      llmClient: MOCK_LLM_CLIENT,
      maxTurns: 10,
      _generateObjectFn: mockGenObj as unknown as ToolLoopParams["_generateObjectFn"],
      agentRole: "developer",
    });

    expect(result.success).toBe(true);
    expect(result.result!.type).toBe("final");
    expect(result.totalTurns).toBe(1);
  });

  // ── TEST: Tool not in allowed list → error ────────────────────

  test("LLM calling a tool not in the allowed list returns error", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    // Mock: tool_call for writeFile but only readFile allowed
    const mockGenObj = mock()
      .mockResolvedValueOnce(mockToolCall("writeFile", {
        path: "src/auth.ts",
        content: "// unauthorized write",
      }, "Try to write a file not in allowed list"));

    const result = await runToolLoop({
      prompt: "Write to auth file",
      projectRoot: projectDir,
      sessionDir,
      sessionId: "test-session-7",
      tools: [{ tool: "readFile", scope: "agent_decides" }],
      llmClient: MOCK_LLM_CLIENT,
      maxTurns: 10,
      _generateObjectFn: mockGenObj as unknown as ToolLoopParams["_generateObjectFn"],
      agentRole: "developer",
    });

    // ── Assert: failed with tool not allowed error ──
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("not allowed");
    expect(result.error).toContain("writeFile");
    expect(result.totalTurns).toBe(1);
  });

  // ── TEST: Path outside projectRoot is caught BEFORE execution ──
  // With validateToolAccess (R-012), path escapes are caught at the
  // security gate before tool execution. The loop fails immediately
  // with a BANNED ACTION error — no recovery.

  test("LLM requesting path outside projectRoot returns BANNED ACTION error", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    // Mock: tool_call for readFile with path outside project
    // validateToolAccess catches this BEFORE execution, so only
    // one LLM call is made (no recovery turn).
    const mockGenObj = mock()
      .mockResolvedValueOnce(mockToolCall("readFile", {
        path: "../../../etc/passwd",
      }, "Try to read a sensitive file"));

    const result = await runToolLoop({
      prompt: "Read the password file",
      projectRoot: projectDir,
      sessionDir,
      sessionId: "test-session-8",
      tools: [{ tool: "readFile", scope: "agent_decides" }],
      llmClient: MOCK_LLM_CLIENT,
      maxTurns: 10,
      _generateObjectFn: mockGenObj as unknown as ToolLoopParams["_generateObjectFn"],
      agentRole: "developer",
    });

    // ── Assert: BANNED ACTION — path escape caught at security gate ──
    expect(result.success).toBe(false);
    expect(result.error).toContain("BANNED ACTION");
    expect(result.error).toContain("outside project root");
    expect(result.totalTurns).toBe(1);
  });

  // ── TEST: executeShell tool execution works ───────────────────

  test("executeShell tool runs a command and returns output to LLM", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    // Mock: shell tool call → final
    const mockGenObj = mock()
      .mockResolvedValueOnce(mockToolCall("executeShell", {
        command: "echo hello world",
      }, "Run a test command"))
      .mockResolvedValueOnce(mockFinal("success", "Command executed"));

    const result = await runToolLoop({
      prompt: "Run a test command",
      projectRoot: projectDir,
      sessionDir,
      sessionId: "test-session-9",
      tools: [{ tool: "executeShell", scope: "agent_decides" }],
      llmClient: MOCK_LLM_CLIENT,
      maxTurns: 10,
      _generateObjectFn: mockGenObj as unknown as ToolLoopParams["_generateObjectFn"],
      agentRole: "developer",
    });

    expect(result.success).toBe(true);
    expect(result.result!.type).toBe("final");
    expect(result.totalTurns).toBe(2);
  });

  // ── TEST: LLM returns final immediately (no tools needed) ─────

  test("LLM responds with final immediately without calling any tools", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    const mockGenObj = mock()
      .mockResolvedValueOnce(mockFinal("success", "Simple task done"));

    const result = await runToolLoop({
      prompt: "Do a simple task",
      projectRoot: projectDir,
      sessionDir,
      sessionId: "test-session-10",
      tools: [{ tool: "readFile", scope: "agent_decides" }],
      llmClient: MOCK_LLM_CLIENT,
      maxTurns: 10,
      _generateObjectFn: mockGenObj as unknown as ToolLoopParams["_generateObjectFn"],
      agentRole: "developer",
    });

    expect(result.success).toBe(true);
    expect(result.totalTurns).toBe(1);
    expect(result.result!.type).toBe("final");
  });

  // ── TEST: Invalid tool call args → tool fails → LLM recovers ──

  test("tool with invalid args fails gracefully and LLM can recover", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    // Mock: tool_call with no path → tool fails → LLM adapts with final
    const mockGenObj = mock()
      // Invalid: no path for readFile
      .mockResolvedValueOnce(mockToolCall("readFile", {}, "Read a file without specifying path"))
      .mockResolvedValueOnce(mockFinal("needs_clarification", "Please specify which file to read"));

    const result = await runToolLoop({
      prompt: "Read a file",
      projectRoot: projectDir,
      sessionDir,
      sessionId: "test-session-11",
      tools: [{ tool: "readFile", scope: "agent_decides" }],
      llmClient: MOCK_LLM_CLIENT,
      maxTurns: 10,
      _generateObjectFn: mockGenObj as unknown as ToolLoopParams["_generateObjectFn"],
      agentRole: "developer",
    });

    // Should succeed because the LLM recovers
    expect(result.success).toBe(true);
    expect(result.result!.type).toBe("final");
    expect((result.result as HandoffWithTools & { status?: string }).status).toBe("needs_clarification");
    expect(result.totalTurns).toBe(2);
  });

  // ── TEST: Tool approval not required for tools without requires_approval ──

  test("tools without requires_approval do not trigger onToolApproval callback", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const testFilePath = join(projectDir, "data.txt");
    await writeFile(testFilePath, "sample data");

    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    const mockGenObj = mock()
      .mockResolvedValueOnce(mockToolCall("readFile", { path: "data.txt" }, "Read data"))
      .mockResolvedValueOnce(mockFinal("success", "Done"));

    const onToolApproval = mock(async (_toolCall: ToolCall): Promise<ToolApprovalResult> => {
      return { approved: true };
    });

    const result = await runToolLoop({
      prompt: "Read data file",
      projectRoot: projectDir,
      sessionDir,
      sessionId: "test-session-12",
      tools: [{ tool: "readFile", scope: "agent_decides" }], // No requires_approval
      llmClient: MOCK_LLM_CLIENT,
      maxTurns: 10,
      onToolApproval,
      _generateObjectFn: mockGenObj as unknown as ToolLoopParams["_generateObjectFn"],
      agentRole: "developer",
    });

    expect(result.success).toBe(true);
    // onToolApproval should NOT have been called because readFile doesn't require approval
    expect(onToolApproval).toHaveBeenCalledTimes(0);
  });

  // ── TEST (H1 fix): requires_approval without callback fails closed ──

  test("tool requiring approval without callback returns error (fail-closed)", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    // Mock: tool_call for writeFile (requires approval, but no callback provided)
    const mockGenObj = mock()
      .mockResolvedValueOnce(mockToolCall("writeFile", {
        path: "src/auth.ts",
        content: "// fixed code",
      }, "Fix the auth module"));

    const result = await runToolLoop({
      prompt: "Fix auth",
      projectRoot: projectDir,
      sessionDir,
      sessionId: "test-session-h1",
      // writeFile requires approval, but NO onToolApproval callback is provided
      tools: [{ tool: "writeFile", scope: "agent_decides", requires_approval: true }],
      llmClient: MOCK_LLM_CLIENT,
      maxTurns: 10,
      // NOTE: onToolApproval is intentionally NOT provided
      _generateObjectFn: mockGenObj as unknown as ToolLoopParams["_generateObjectFn"],
      agentRole: "developer",
    });

    // ── Assert: fail-closed — tool requiring approval without callback returns error ──
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("requires human approval");
    expect(result.error).toContain("no approval callback was provided");
    expect(result.totalTurns).toBe(1); // Blocked before execution
  });
});
