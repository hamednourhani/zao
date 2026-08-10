/**
 * Tests for the zao CLI entry point.
 *
 * Tests cover:
 * - TEST-1: Binary compiles without errors (manual — verified in build step)
 * - TEST-2: `mo run "test"` parses the argument correctly
 * - TEST-3: `mo` with no arguments prints usage help (fail-closed)
 *
 * Note: Since Story 006, the `run` command executes the full pipeline
 * (session init → context build → LLM call). Without a configured API key,
 * the pipeline fails with exit code 1. These tests verify that the CLI
 * correctly parses and forwards arguments regardless of pipeline outcome.
 *
 * @module index.test
 */

import { describe, expect, test, afterEach } from "bun:test";
import { $ } from "bun";

/**
 * Helper that runs the CLI entry point with the given arguments and captures
 * stdout, stderr, and the exit code.
 *
 * @param args - CLI arguments to pass to the script.
 * @returns An object with stdout, stderr, and exitCode.
 */
async function runMo(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await $`bun run src/index.ts ${args}`.cwd(`${import.meta.dir}/..`).quiet().nothrow();
    return {
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      exitCode: result.exitCode,
    };
  } catch (e) {
    // Bun shell throws even with .nothrow() in some edge cases
    // Catch and extract what we can
    const err = e as { stdout?: Buffer; stderr?: Buffer; exitCode?: number };
    return {
      stdout: err.stdout?.toString().trim() ?? "",
      stderr: err.stderr?.toString().trim() ?? "",
      exitCode: err.exitCode ?? 1,
    };
  }
}

describe("zao CLI", () => {
  // afterEach hook — reserved for future test cleanup (temp files, env vars, etc.).
  // Currently a no-op since tests spawn isolated subprocesses via Bun shell.
  afterEach(() => {});

  // ── Happy path (run command forwards arguments correctly) ───

  describe("run command", () => {
    test('parses task argument correctly for "zao run \\"test\\""', async () => {
      const { stderr, exitCode } = await runMo("run", "test");

      // Without real API keys, the pipeline fails with exit code 1.
      // The test verifies correct argument parsing, not pipeline success.
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Running task: test");
    });

    test('parses multi-word task for "zao run \\"hello world\\""', async () => {
      const { stderr, exitCode } = await runMo("run", "hello", "world");

      expect(exitCode).toBe(1);
      expect(stderr).toContain("Running task: hello world");
    });
  });

  // ── Failure paths (fail-closed) ────────────────────────────

  describe("fail-closed behavior", () => {
    test("exits with error and usage when no arguments provided", async () => {
      const { stdout, stderr, exitCode } = await runMo();

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Usage:");
      expect(stdout).toBe("");
    });

    test('exits with error when "run" has no task argument', async () => {
      const { stdout, stderr, exitCode } = await runMo("run");

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Missing task description");
      expect(stderr).toContain("Usage:");
      expect(stdout).toBe("");
    });

    test("exits with error for unknown commands", async () => {
      const { stdout, stderr, exitCode } = await runMo("unknown", "arg");

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Unknown command");
      expect(stderr).toContain("unknown");
      expect(stdout).toBe("");
    });
  });

  // ── Edge cases ─────────────────────────────────────────────

  describe("edge cases", () => {
    test("handles task with special characters", async () => {
      const { stderr } = await runMo(
        "run",
        'task with ; special & chars'
      );

      expect(stderr).toContain("task with ; special & chars");
    });

    test('handles empty string task ""', async () => {
      const { stderr } = await runMo("run", "");

      expect(stderr).toContain("Running task:");
    });

    test("handles task with unicode and emoji", async () => {
      const task = "Add login page ✅ with French: éàç and Chinese: 你好";
      const { stderr } = await runMo("run", task);

      expect(stderr).toContain("Running task:");
      expect(stderr).toContain("✅");
      expect(stderr).toContain("éàç");
      expect(stderr).toContain("你好");
    });

    test("handles task containing flag-like strings (treated as text, not flags)", async () => {
      const task = "--help --verbose -f task";
      const { stderr } = await runMo("run", task);

      expect(stderr).toContain("Running task: --help --verbose -f task");
    });
  });
});
