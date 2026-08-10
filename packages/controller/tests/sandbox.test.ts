/**
 * Sandbox module tests — git worktree lifecycle.
 *
 * Tests the full create → apply → discard lifecycle, crash cleanup,
 * non-git-repo handling (auto-init, graceful null return), and
 * idempotent cleanup.
 *
 * Uses a mock `git` binary injected via `SandboxOptions.gitCommand`
 * to avoid real git operations.
 *
 * @module sandbox.test
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import { chmod } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createSandbox, applySandboxChanges, discardSandbox } from "../src/sandbox.ts";
import { __internalInitLogger, __internalResetLoggerForTest } from "../../harness/src/core/logger.ts";

// ── Test Helpers ───────────────────────────────────────────────────

let tempDir: string;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-test-"));
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

/**
 * Creates a mock git binary script that records calls and returns
 * predetermined outputs. Used to test sandbox operations without
 * real git.
 *
 * Each mock script writes to its own unique log file to prevent
 * cross-test contamination.
 */
async function createMockGitScript(
  callSequence: Array<{ exitCode: number; stdout: string; stderr?: string }>,
): Promise<{ scriptPath: string; logPath: string }> {
  const scriptId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const scriptPath = path.join(tempDir, `mock-git-${scriptId}.sh`);
  const logPath = path.join(tempDir, `git-calls-${scriptId}.log`);

  const scriptContent = `#!/bin/bash
# Mock git: records calls to a log file
echo "$@" >> "${logPath}"
CALL_INDEX=\$(wc -l < "${logPath}")
${callSequence.map((call, i) => {
  const idx = i + 1;
  return `if [ "\$CALL_INDEX" -eq ${idx} ]; then
  echo '${call.stdout.replace(/'/g, "'\\''")}'
  ${call.stderr ? `echo '${call.stderr.replace(/'/g, "'\\''")}' >&2` : ""}
  exit ${call.exitCode}
fi`;
}).join("\n")}
exit 0
`;
  await fs.writeFile(scriptPath, scriptContent);
  await chmod(scriptPath, 0o755);
  return { scriptPath, logPath };
}

async function readGitCalls(logPath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(logPath, "utf-8");
    return raw.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function createMockGitDir(dirPath: string): Promise<void> {
  // Create a minimal git repo structure that `git rev-parse --show-toplevel` recognizes
  await fs.mkdir(path.join(dirPath, ".git"), { recursive: true });
  await fs.writeFile(path.join(dirPath, ".git", "HEAD"), "ref: refs/heads/main\n");
}

// ── Tests ──────────────────────────────────────────────────────────

describe("createSandbox", () => {
  test("returns null for non-git directories (git available but repo init fails)", async () => {
    const { scriptPath: mockGit } = await createMockGitScript([
      // git --version: succeeds
      { exitCode: 0, stdout: "git version 2.43.0\n" },
      // rev-parse: fails (not a git repo)
      { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" },
    ]);
    // After rev-parse fails, the code tries: git init && git add -A && git commit
    // That's one execAsync call but three separate process invocations.
    // git init: call 3 → falls through to exit 0 (empty stdout)
    // git add -A: call 4 → falls through to exit 0
    // git commit: call 5 → falls through to exit 0
    // Then re-verifies with rev-parse: call 6 → falls through to exit 0 → returns "" not a repo
    // → warn + return null

    const nonGitDir = path.join(tempDir, "non-git-project");
    await fs.mkdir(nonGitDir, { recursive: true });

    const result = await createSandbox(nonGitDir, "test-exec-id", { gitCommand: mockGit });
    expect(result).toBeNull();
  });

  test("creates sandbox in valid git repo", async () => {
    const { scriptPath: mockGit, logPath } = await createMockGitScript([
      // rev-parse --show-toplevel: succeeds
      { exitCode: 0, stdout: tempDir + "\n" },
      // worktree add: succeeds
      { exitCode: 0, stdout: `Preparing worktree (detached HEAD)\nHEAD is now at abc123\n` },
    ]);

    const gitRepoDir = path.join(tempDir, "git-project");
    await createMockGitDir(gitRepoDir);

    const sandbox = await createSandbox(gitRepoDir, "test-exec-id", { gitCommand: mockGit });

    expect(sandbox).not.toBeNull();
    expect(sandbox!.executionId).toBe("test-exec-id");
    expect(sandbox!.worktreePath).toContain("/tmp/zao-sandbox-test-exec-id");
    expect(sandbox!.originalDir).toBe(gitRepoDir);

    const calls = await readGitCalls(logPath);
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain("rev-parse --show-toplevel");
    expect(calls[1]).toContain("worktree add --detach");
  });

  test("rejects non-existent directory", async () => {
    await expect(
      createSandbox("/nonexistent/path/12345", "test-id"),
    ).rejects.toThrow(/does not exist/);
  });

  test("fails when worktree already exists", async () => {
    // Create the worktree path first to simulate a stale sandbox
    const worktreePath = "/tmp/zao-sandbox-dup-test";
    try {
      await fs.mkdir(worktreePath, { recursive: true });
    } catch { /* ignore */ }

    const { scriptPath: mockGit } = await createMockGitScript([
      // rev-parse --show-toplevel: succeeds (it IS a git repo)
      { exitCode: 0, stdout: tempDir + "\n" },
    ]);

    const gitRepoDir = path.join(tempDir, "git-project-dup");
    await createMockGitDir(gitRepoDir);

    await expect(
      createSandbox(gitRepoDir, "dup-test", { gitCommand: mockGit }),
    ).rejects.toThrow(/already exists/);

    // cleanup
    try { await fs.rm(worktreePath, { recursive: true, force: true }); } catch {}
  });

  test("returns null when git is not available", async () => {
    const { scriptPath: mockGit } = await createMockGitScript([
      // git --version: fails (git not installed)
      { exitCode: 127, stdout: "", stderr: "command not found: git" },
    ]);

    const nonGitDir = path.join(tempDir, "no-git-project");
    await fs.mkdir(nonGitDir, { recursive: true });

    const result = await createSandbox(nonGitDir, "test-exec-id", { gitCommand: mockGit });
    expect(result).toBeNull();
  });

  test("warns before auto-git-init on non-git directories", async () => {
    // Reset singleton before init to avoid conflicts with other test suites
    __internalResetLoggerForTest();
    __internalInitLogger("warn", false);

    const stderrOutput: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const stderrSpy = (chunk: string | Uint8Array, _encoding?: string): boolean => {
      const str = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      stderrOutput.push(str);
      return true;
    };
    (process.stderr as { write: typeof process.stderr.write }).write = stderrSpy as typeof process.stderr.write;

    // Mock: first isGitRepo (rev-parse, fails), then isGitAvailable (--version, succeeds),
    // then initGitRepo (init + add + commit), then isGitRepo re-verify, then worktree add.
    // Call order matches createSandbox code: isGitRepo → isGitAvailable → initGitRepo → isGitRepo → worktree add
    const { scriptPath: mockGit, logPath } = await createMockGitScript([
      // rev-parse: fails (not a git repo) — isGitRepo check
      { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" },
      // git --version: succeeds — isGitAvailable check
      { exitCode: 0, stdout: "git version 2.43.0\n" },
      // git init: succeeds — initGitRepo
      { exitCode: 0, stdout: "Initialized empty Git repository\n" },
      // git add -A: succeeds
      { exitCode: 0, stdout: "" },
      // git commit: succeeds
      { exitCode: 0, stdout: "[main (root-commit)] zao sandbox init\n" },
      // rev-parse re-verify: succeeds — isGitRepo after init
      { exitCode: 0, stdout: tempDir + "\n" },
      // worktree add: succeeds
      { exitCode: 0, stdout: "Preparing worktree (detached HEAD)\n" },
    ]);

    const nonGitDir = path.join(tempDir, "warn-before-init-project");
    await fs.mkdir(nonGitDir, { recursive: true });

    try {
      const result = await createSandbox(nonGitDir, "warn-test-exec", { gitCommand: mockGit });
      expect(result).not.toBeNull();

      // Verify the warning was logged
      const warnMessages = stderrOutput.filter(
        (line) => line.includes("Not a git repo") && line.includes("auto-initializing"),
      );
      expect(warnMessages.length).toBeGreaterThanOrEqual(1);

      // Verify git calls — init should have been called
      const gitCalls = await readGitCalls(logPath);
      const initCalls = gitCalls.filter((c) => c.includes("init"));
      expect(initCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      // Restore stderr and reset logger
      process.stderr.write = originalStderrWrite;
      __internalResetLoggerForTest();
    }
  });

  test("no auto-git-init warning when already a git repo", async () => {
    // Reset singleton before init to avoid conflicts with other test suites
    __internalResetLoggerForTest();
    __internalInitLogger("warn", false);

    const stderrOutput: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const stderrSpy = (chunk: string | Uint8Array, _encoding?: string): boolean => {
      const str = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      stderrOutput.push(str);
      return true;
    };
    (process.stderr as { write: typeof process.stderr.write }).write = stderrSpy as typeof process.stderr.write;

    const { scriptPath: mockGit } = await createMockGitScript([
      // rev-parse --show-toplevel: succeeds (already a git repo)
      { exitCode: 0, stdout: tempDir + "\n" },
      // worktree add: succeeds
      { exitCode: 0, stdout: "Preparing worktree (detached HEAD)\n" },
    ]);

    const gitRepoDir = path.join(tempDir, "already-git-project");
    await createMockGitDir(gitRepoDir);

    try {
      const sandbox = await createSandbox(gitRepoDir, "no-warn-exec", { gitCommand: mockGit });
      expect(sandbox).not.toBeNull();

      // Verify NO warning about auto-init was logged
      const warnMessages = stderrOutput.filter(
        (line) => line.includes("Not a git repo") && line.includes("auto-initializing"),
      );
      expect(warnMessages.length).toBe(0);
    } finally {
      // Restore stderr and reset logger
      process.stderr.write = originalStderrWrite;
      __internalResetLoggerForTest();
    }
  });
});

describe("applySandboxChanges", () => {
  test("applies diff and returns changed files", async () => {
    const { scriptPath: mockGit } = await createMockGitScript([
      // git diff HEAD
      {
        exitCode: 0,
        stdout: [
          "diff --git a/src/file1.ts b/src/file1.ts",
          "--- a/src/file1.ts",
          "+++ b/src/file1.ts",
          "@@ -1,3 +1,4 @@",
          " console.log('hello');",
          "+console.log('new line');",
        ].join("\n"),
      },
      // git apply
      { exitCode: 0, stdout: "" },
    ]);

    const sandbox = {
      worktreePath: "/tmp/zao-sandbox-test",
      originalDir: tempDir,
      executionId: "test",
    };

    const result = await applySandboxChanges(sandbox, { gitCommand: mockGit });

    expect(result.appliedFiles).toContain("src/file1.ts");
    expect(result.diffSummary).toContain("diff --git");
    expect(result.diffSummary).toContain("+console.log('new line')");
  });

  test("handles empty diff without applying", async () => {
    const { scriptPath: mockGit } = await createMockGitScript([
      { exitCode: 0, stdout: "" },
    ]);

    const sandbox = {
      worktreePath: "/tmp/zao-sandbox-empty",
      originalDir: tempDir,
      executionId: "test",
    };

    const result = await applySandboxChanges(sandbox, { gitCommand: mockGit });

    expect(result.appliedFiles).toEqual([]);
    // echo '' in the mock outputs a newline, so diff is "\n"
    expect(result.diffSummary.trim()).toBe("");
  });

  test("throws when diff generation fails", async () => {
    const { scriptPath: mockGit } = await createMockGitScript([
      { exitCode: 128, stdout: "", stderr: "fatal: ambiguous argument 'HEAD': unknown revision" },
    ]);

    const sandbox = {
      worktreePath: "/tmp/zao-sandbox-fail",
      originalDir: tempDir,
      executionId: "test",
    };

    await expect(
      applySandboxChanges(sandbox, { gitCommand: mockGit }),
    ).rejects.toThrow(/Failed to generate sandbox diff/);
  });
});

describe("discardSandbox", () => {
  test("removes the worktree", async () => {
    const { scriptPath: mockGit, logPath } = await createMockGitScript([
      // worktree remove --force: succeeds
      { exitCode: 0, stdout: "" },
    ]);

    const sandbox = {
      worktreePath: "/tmp/zao-sandbox-remove",
      originalDir: tempDir,
      executionId: "test",
    };

    // Should not throw
    await discardSandbox(sandbox, { gitCommand: mockGit });

    const calls = await readGitCalls(logPath);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("worktree remove --force");
  });

  test("does not throw when git fails (best-effort)", async () => {
    const { scriptPath: mockGit } = await createMockGitScript([
      // worktree remove --force: fails (already removed)
      { exitCode: 128, stdout: "", stderr: "not a git repository" },
      // rm -rf: also fails? It shouldn't, but we test resilience
      // Actually the function uses rm -rf as fallback, which we can't mock easily.
      // Just test that git failure is handled gracefully.
    ]);

    const sandbox = {
      worktreePath: "/tmp/zao-sandbox-grace",
      originalDir: tempDir,
      executionId: "test",
    };

    // Should not throw — discard is best-effort
    await expect(
      discardSandbox(sandbox, { gitCommand: mockGit }),
    ).resolves.toBeUndefined();
  });
});
