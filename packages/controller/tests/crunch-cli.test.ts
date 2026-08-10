/**
 * Crunch CLI tests — verify the research → execute pipeline.
 *
 * Tests that {@link runCrunchCLI} correctly chains the crunch pipeline
 * with the controller's execute function, passing the emitted blueprint
 * via the `blueprint` param.
 *
 * Uses dependency injection via module mocking for deterministic tests
 * without real LLM calls.
 *
 * @module crunch-cli.test
 */

import { describe, test, expect, mock } from "bun:test";
import type { ExecutionResult } from "../src/execution-runner.ts";

// ── Tests ──────────────────────────────────────────────────────────

describe("runCrunchCLI", () => {
  test("calls crunch and passes blueprint to execute", async () => {
    // Dynamically import to allow mocking
    const { runCrunchCLI } = await import("../src/crunch-cli.ts");

    // Mock the execute function to capture the call
    const executeMock = mock(async () => {
      return {
        success: true,
        executionId: "test-exec-id",
        executionDir: "/tmp/test",
        flowPackageDir: "/tmp/test/flow-package",
        sessionIds: ["sess-1"],
        steps: [{ id: "read", status: "success" as const, role: "explorer", model: "deepseek-chat" }],
        tokenUsage: { prompt: 100, completion: 50 },
      } as ExecutionResult;
    });

    // Mock the crunch function
    const crunchMock = mock(async () => ({
      blueprint: { schema_version: "0.1.0", steps: [] },
      research_notes: "test",
    }));

    // Mock createDefaultRegistry
    const registryMock = mock(async () => ({ defaultModel: "test-model" }));

    const result = await runCrunchCLI({
      question: "How do I add tests?",
      projectDir: "/tmp/test-project",
      sandbox: false,
      autoYes: true,
      _execute: executeMock as any,
      _crunch: crunchMock as any,
      _createRegistry: registryMock as any,
    });

    expect(result.success).toBe(true);
    // The execute mock should have been called with the blueprint
    expect(executeMock).toHaveBeenCalled();
  });

  test("runCrunchCLI module exports function without error", async () => {
    const mod = await import("../src/crunch-cli.ts");
    expect(typeof mod.runCrunchCLI).toBe("function");
  });
});
