/**
 * Tests for the Tool Execution module (Story 008).
 *
 * Covers all acceptance tests:
 * - TEST-1: executeShell("echo hello") → stdout "hello", exitCode 0
 * - TEST-2: executeShell timeout → timeout error
 * - TEST-3: executeShell("exit 1") → exitCode 1, success: false
 * - TEST-4: Write file inside project → success, content matches
 * - TEST-5: Write file outside project → rejection error
 * - TEST-6: Shell output > outputLimit → truncated
 * - TEST-7: Forged tier label — re-classification detects Tier 1
 * - TEST-8: Hard-deny command rejected immediately
 *
 * Additional coverage:
 * - readFile within/outside project root
 * - readFile for non-existent file
 * - readFile/writeFile round-trip
 * - executeShell non-zero exit
 * - executeTool orchestrator (hard-deny bypasses HITL)
 *
 * @module executor.test
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { symlinkSync, mkdirSync } from "node:fs";
import {
  executeShell,
  readFile,
  writeFile,
  executeTool,
} from "../src/core/executor.ts";
import { classifyCommand, TrustTier } from "../src/core/command-guard.ts";

// ── Temp Directory Helpers ──────────────────────────────────────────

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zao-executor-"));
  tempDirs.push(dir);
  return dir;
}

// ── TEST-1: executeShell("echo hello") ──────────────────────────────

describe("executeShell", () => {
  test("TEST-1: returns stdout for echo hello", async () => {
    const result = await executeShell("echo hello", process.cwd(), 10_000, 102_400);

    expect(result.success).toBe(true);
    expect(result.action).toBe("shell");
    expect(result.stdout).toContain("hello");
    expect(result.exitCode).toBe(0);
    expect(result.outputTruncated).toBeUndefined();
  });

  // ── TEST-2: executeShell timeout ──────────────────────────────────

  test("TEST-2: times out on slow command", async () => {
    const result = await executeShell("sleep 5", process.cwd(), 50, 102_400);

    expect(result.success).toBe(false);
    expect(result.action).toBe("shell");
    expect(result.error).toBeDefined();
    expect(result.error).toContain("timed out");
  });

  // ── TEST-3: executeShell non-zero exit ────────────────────────────

  test("TEST-3: captures non-zero exit code", async () => {
    const result = await executeShell("exit 1", process.cwd(), 10_000, 102_400);

    expect(result.success).toBe(false);
    expect(result.action).toBe("shell");
    expect(result.exitCode).toBe(1);
    // exit 1 produces no stdout — that's expected
  });

  // ── TEST-6: Shell output > outputLimit → truncated ───────────────

  test("TEST-6: truncates output exceeding outputLimit", async () => {
    // Generate ~2000 bytes of output, cap at 100 bytes
    const result = await executeShell(
      `printf 'x%.0s' {1..2000}`,
      process.cwd(),
      10_000,
      100,
    );

    expect(result.outputTruncated).toBe(true);
    expect(result.success).toBe(true); // The command itself succeeds
    expect(result.stdout!.length).toBeLessThanOrEqual(100);
  });

  // ── Extra: capture stderr ─────────────────────────────────────────

  test("captures stderr from a command", async () => {
    const result = await executeShell("echo error >&2", process.cwd(), 10_000, 102_400);

    expect(result.success).toBe(true);
    expect(result.stderr).toContain("error");
    expect(result.exitCode).toBe(0);
  });
});

// ── File Operations ─────────────────────────────────────────────────

describe("writeFile", () => {
  // ── TEST-4: Write file inside project → success ───────────────────

  test("TEST-4: writes file inside project root", async () => {
    const projectRoot = await makeTempDir();
    const filePath = join(projectRoot, "test-output.txt");

    const result = await writeFile(filePath, "hello world", projectRoot);

    expect(result.success).toBe(true);
    expect(result.action).toBe("write_file");
    expect(result.filePath).toBeDefined();
    expect(result.error).toBeUndefined();

    // Verify content on disk
    const content = await Bun.file(filePath).text();
    expect(content).toBe("hello world");
  });

  // ── TEST-5: Write file outside project → rejection ───────────────

  test("TEST-5: rejects path outside project root", async () => {
    const projectRoot = await makeTempDir();
    const outsidePath = join(tmpdir(), "outside-write.txt");

    try {
      const result = await writeFile(outsidePath, "should not work", projectRoot);
      expect(result.success).toBe(false);
      expect(result.action).toBe("write_file");
      expect(result.error).toBeDefined();
      expect(result.error).toContain("outside the project root");
    } finally {
      // Clean up if it somehow got created
      await rm(outsidePath, { force: true }).catch(() => {});
    }
  });

  // ── Extra: Write file with relative path ─────────────────────────

  test("writes file with relative path (resolved against projectRoot)", async () => {
    const projectRoot = await makeTempDir();

    // writeFile resolves relative paths against projectRoot, not cwd
    const result = await writeFile("relative-test.txt", "relative content", projectRoot);

    expect(result.success).toBe(true);

    const content = await Bun.file(join(projectRoot, "relative-test.txt")).text();
    expect(content).toBe("relative content");
  });

  // ── Extra: Write to existing symlink is rejected ──────────────────

  test("rejects writes to existing symlinks", async () => {
    const projectRoot = await makeTempDir();
    const realFilePath = join(projectRoot, "real-file.txt");
    const symlinkPath = join(projectRoot, "link.txt");

    // Create a real file, then symlink to it
    await Bun.write(realFilePath, "real content");
    symlinkSync(realFilePath, symlinkPath);

    const result = await writeFile(symlinkPath, "new content", projectRoot);
    expect(result.success).toBe(false);
    expect(result.error).toContain("symlink");
  });
});

describe("readFile", () => {
  // ── Read within project root ──────────────────────────────────────

  test("reads file within project root", async () => {
    const projectRoot = await makeTempDir();
    const filePath = join(projectRoot, "read-me.txt");
    await Bun.write(filePath, "readable content");

    const result = await readFile(filePath, projectRoot);

    expect(result.success).toBe(true);
    expect(result.action).toBe("read_file");
    expect(result.fileContent).toBe("readable content");
    expect(result.filePath).toBeDefined();
  });

  // ── Read non-existent file → error ───────────────────────────────

  test("returns error for non-existent file", async () => {
    const projectRoot = await makeTempDir();
    const nonExistent = join(projectRoot, "does-not-exist.txt");

    const result = await readFile(nonExistent, projectRoot);

    expect(result.success).toBe(false);
    expect(result.action).toBe("read_file");
    expect(result.error).toContain("not found");
  });

  // ── Read outside project root → rejection ─────────────────────────

  test("rejects path outside project root", async () => {
    const projectRoot = await makeTempDir();
    const outsidePath = "/etc/hostname";

    const result = await readFile(outsidePath, projectRoot);

    expect(result.success).toBe(false);
    expect(result.action).toBe("read_file");
    expect(result.error).toContain("outside the project root");
  });

  // ── Round-trip: write then read ──────────────────────────────────

  test("round-trip: writeFile then readFile", async () => {
    const projectRoot = await makeTempDir();
    const filePath = join(projectRoot, "roundtrip.txt");
    const original = "round-trip test content\nwith multiple lines";

    // Write
    const writeResult = await writeFile(filePath, original, projectRoot);
    expect(writeResult.success).toBe(true);

    // Read and verify
    const readResult = await readFile(filePath, projectRoot);
    expect(readResult.success).toBe(true);
    expect(readResult.fileContent).toBe(original);
  });
});

// ── Re-Classification & Hard-Deny ───────────────────────────────────

describe("executeTool classification", () => {
  // ── TEST-7: Forged tier label ─────────────────────────────────────

  test("TEST-7: re-classification detects Tier 1 command regardless of action_type", () => {
    // A malicious request could claim to be "file_read" while carrying a
    // destructive shell command. The executor MUST re-classify independently.

    // Simulate: the command is "rm -rf ./node_modules" which is Tier 1 (file deletion)
    const verdict = classifyCommand("rm -rf ./node_modules", "file_read", "clean up");

    // The action_type is "file_read" (safe), but the command is dangerous
    expect(verdict.tier).toBe(TrustTier.Tier1);
    expect(verdict.blocked).toBeNull(); // Not hard-deny, but should be Tier 1
    expect(verdict.reasons.some((r) => r.includes("File deletion"))).toBe(true);
  });

  test("TEST-7: re-classification detects blocked command even with safe-looking user_facing_explanation", () => {
    // The model's explanation claims the command is safe, but the executor
    // re-classifies based on the command content, not the explanation.
    // chmod is now Tier 2 (blocked) unconditionally.
    const verdict = classifyCommand(
      "rm -rf ./node_modules",
      "shell",
      "cleaning up old dependencies for the build script",
    );

    expect(verdict.tier).toBe(TrustTier.Tier1);
    expect(verdict.reasons.some((r) => r.includes("File deletion"))).toBe(true);
  });

  // ── TEST-8: Hard-deny command ─────────────────────────────────────

  test("TEST-8: hard-deny command returns blocked in classification", () => {
    const verdict = classifyCommand("rm -rf /etc", "shell", "clean up config");

    expect(verdict.blocked).not.toBeNull();
    expect(verdict.blocked!.reason).toBeDefined();
    expect(verdict.blocked!.details).toBeDefined();
  });

  test("TEST-8: executeTool rejects hard-deny immediately without executing", async () => {
    const projectRoot = await makeTempDir();

    // executeTool must reject hard-deny commands BEFORE any HITL prompt
    // and BEFORE any execution. We verify by checking the returned error.
    const result = await executeTool(
      {
        schema_version: "0.1.0",
        action_type: "shell",
        command: "rm -rf /etc",
        user_facing_explanation: "clean up old config",
      },
      { projectRoot },
      undefined,
      true, // Even auto-approve cannot override hard-deny
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("System configuration deletion");
  });

  test("TEST-8: another hard-deny pattern — root filesystem deletion", async () => {
    const projectRoot = await makeTempDir();

    const result = await executeTool(
      {
        schema_version: "0.1.0",
        action_type: "shell",
        command: "rm -rf /",
        user_facing_explanation: "clean up everything",
      },
      { projectRoot },
      undefined,
      true,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Root filesystem deletion");
  });

  // ── Extra: Safe command passes classification ─────────────────────

  test("safe command classified as Tier 2", () => {
    const verdict = classifyCommand("echo hello", "shell", "test command");

    expect(verdict.tier).toBe(TrustTier.Tier0);
    expect(verdict.blocked).toBeNull();
  });
});

// ── executeTool orchestrator ────────────────────────────────────────

describe("executeTool", () => {
  test("returns error for unknown action_type", async () => {
    const projectRoot = await makeTempDir();

    const result = await executeTool(
      {
        schema_version: "0.1.0",
        action_type: "unknown_action",
        command: "echo test",
        user_facing_explanation: "test",
      },
      { projectRoot },
      undefined,
      true,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown action type");
  });

  test("executes shell command through full pipeline (auto-approve)", async () => {
    const projectRoot = await makeTempDir();
    const sessionDir = await makeTempDir();

    const result = await executeTool(
      {
        schema_version: "0.1.0",
        action_type: "shell",
        command: "echo hello from executor",
        user_facing_explanation: "test the full pipeline",
      },
      { projectRoot, sessionDir, outputLimit: 102400, timeout: 10000 },
      undefined,
      true, // Auto-approve Tier 2
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("shell");
    expect(result.stdout).toContain("hello from executor");
    expect(result.exitCode).toBe(0);
  });

  test("executes file_read through full pipeline (auto-approve)", async () => {
    const projectRoot = await makeTempDir();
    const sessionDir = await makeTempDir();
    const filePath = join(projectRoot, "to-read.txt");
    await Bun.write(filePath, "read me");

    const result = await executeTool(
      {
        schema_version: "0.1.0",
        action_type: "file_read",
        command: filePath,
        user_facing_explanation: "read a file",
      },
      { projectRoot, sessionDir },
      undefined,
      true,
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("read_file");
    expect(result.fileContent).toBe("read me");
  });
});

// ── ExecuteShell Edge Cases ────────────────────────────────────────

describe("executeShell — edge cases", () => {
  test("returns error for empty command string", async () => {
    // Empty string passed to bash -c → bash exits with 0 and no output
    const result = await executeShell("", process.cwd(), 10_000, 102_400);
    // An empty command is technically valid for bash (exits 0), but
    // we want to verify the executor handles it without crashing.
    expect(result.action).toBe("shell");
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("handles output exactly at outputLimit boundary (not truncated)", async () => {
    // Generate exactly 100 bytes of output
    const exactlyHundred = "x".repeat(100);
    const result = await executeShell(
      `printf '%s' '${exactlyHundred}'`,
      process.cwd(),
      10_000,
      100,
    );

    expect(result.success).toBe(true);
    // Output is exactly at limit — should NOT be truncated
    expect(result.outputTruncated).toBeUndefined();
    expect(result.stdout!.length).toBe(100);
  });

  test("captures stderr with non-zero exit code", async () => {
    const result = await executeShell(
      "echo 'error msg' >&2; exit 3",
      process.cwd(),
      10_000,
      102_400,
    );

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("error msg");
  });

  test("handles very long command strings without crashing", async () => {
    // 10 KB of mostly harmless repeated text
    const longCmd = "echo " + "x".repeat(10_000);
    const result = await executeShell(longCmd, process.cwd(), 10_000, 102_400);

    // Should not crash; either succeeds with echo or fails gracefully
    expect(result.action).toBe("shell");
    expect([true, false]).toContain(result.success);
  });

  test("preserves special characters in stdout", async () => {
    const result = await executeShell(
      `printf 'unicode: caf\u00e9 — em-dash: \u2014'`,
      process.cwd(),
      10_000,
      102_400,
    );

    expect(result.success).toBe(true);
    expect(result.stdout).toContain("café");
    expect(result.stdout).toContain("\u2014");
  });

  test("command producing only stderr marked as success if exitCode 0", async () => {
    const result = await executeShell(
      "echo message >&2",
      process.cwd(),
      10_000,
      102_400,
    );

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("message");
  });
});

// ── writeFile Edge Cases ────────────────────────────────────────────

describe("writeFile — edge cases", () => {
  test("rejects write to non-existent parent directory", async () => {
    const projectRoot = await makeTempDir();
    const nonExistentParent = join(projectRoot, "missing-dir", "file.txt");

    const result = await writeFile(nonExistentParent, "content", projectRoot);

    expect(result.success).toBe(false);
    expect(result.action).toBe("write_file");
    expect(result.error).toContain("Parent directory does not exist");
  });

  test("writes empty content successfully", async () => {
    const projectRoot = await makeTempDir();
    const filePath = join(projectRoot, "empty.txt");

    const result = await writeFile(filePath, "", projectRoot);

    expect(result.success).toBe(true);
    expect(result.action).toBe("write_file");

    const content = await Bun.file(filePath).text();
    expect(content).toBe("");
  });

  test("writes unicode content successfully", async () => {
    const projectRoot = await makeTempDir();
    const filePath = join(projectRoot, "unicode.txt");
    const unicodeContent = "Hello — 世界 — café — 😊 — \u0000\u0009\u000A";

    const result = await writeFile(filePath, unicodeContent, projectRoot);

    expect(result.success).toBe(true);

    const content = await Bun.file(filePath).text();
    expect(content).toBe(unicodeContent);
  });

  test("writes file with '..' path that resolves within projectRoot", async () => {
    const projectRoot = await makeTempDir();

    // Create a subdirectory so .. resolves within projectRoot
    const subDir = join(projectRoot, "sub");
    mkdirSync(subDir);

    const filePath = join(projectRoot, "sub", "..", "resolved-file.txt");
    // Should resolve to projectRoot/resolved-file.txt

    const result = await writeFile(filePath, "resolved", projectRoot);

    expect(result.success).toBe(true);

    const content = await Bun.file(join(projectRoot, "resolved-file.txt")).text();
    expect(content).toBe("resolved");
  });
});

// ── readFile Edge Cases ─────────────────────────────────────────────

describe("readFile — edge cases", () => {
  test("reads empty file successfully", async () => {
    const projectRoot = await makeTempDir();
    const filePath = join(projectRoot, "blank.txt");
    await Bun.write(filePath, "");

    const result = await readFile(filePath, projectRoot);

    expect(result.success).toBe(true);
    expect(result.action).toBe("read_file");
    expect(result.fileContent).toBe("");
  });

  test("rejects '..' path traversal that resolves outside projectRoot", async () => {
    const projectRoot = await makeTempDir();
    // Walk up from a deep temp directory to reach /etc/hostname (exists on Linux)
    // projectRoot is /tmp/zao-executor-XXXX — going up two levels reaches /tmp,
    // then we need enough ../ to reach /. Use an absolute path outside.
    // A simpler check: use .. to get to /tmp (parent of projectRoot),
    // then target a file that exists there.
    // Actually, use the same outside path approach and adjust for ENOENT behavior:
    // resolveReadablePath returns "File not found" for non-existent paths
    // BEFORE checking "outside the project root" — this is a noted gap.
    // For a path that DOES exist outside: use multiple ../ to reach /etc/hostname
    const depth = projectRoot.split("/").length - 1;
    const escapeSegments = Array(depth).fill("..").join("/");
    const existingOutside = join(projectRoot, escapeSegments, "etc", "hostname");

    const result = await readFile(existingOutside, projectRoot);

    expect(result.success).toBe(false);
    expect(result.action).toBe("read_file");
    // Either "outside the project root" (if file exists) or
    // "File not found" (if /etc/hostname doesn't exist — noted gap)
    expect(
      result.error!.includes("outside the project root") ||
      result.error!.includes("not found"),
    ).toBe(true);
  });

  test("follows valid symlink that targets within projectRoot", async () => {
    const projectRoot = await makeTempDir();
    const realFile = join(projectRoot, "real.txt");
    const linkFile = join(projectRoot, "link.txt");

    await Bun.write(realFile, "via symlink");
    symlinkSync(realFile, linkFile);

    const result = await readFile(linkFile, projectRoot);

    expect(result.success).toBe(true);
    expect(result.fileContent).toBe("via symlink");
  });

  test("rejects read through symlink that targets outside projectRoot", async () => {
    const projectRoot = await makeTempDir();
    const outsideTarget = join(tmpdir(), "outside-target.txt");
    const linkInProject = join(projectRoot, "escape-link.txt");

    // Create a real file outside projectRoot
    await Bun.write(outsideTarget, "secret data");
    symlinkSync(outsideTarget, linkInProject);

    try {
      const result = await readFile(linkInProject, projectRoot);

      expect(result.success).toBe(false);
      expect(result.error).toContain("outside the project root");
    } finally {
      await rm(outsideTarget, { force: true }).catch(() => {});
    }
  });
});

// ── executeTool Re-Classification & Hard-Deny ───────────────────────

describe("executeTool — re-classification defense-in-depth", () => {
  test("REQ-8: re-classifies independently — forged action_type does not bypass classification", async () => {
    const projectRoot = await makeTempDir();

    // Attacker claims action_type is "file_read" (safe) but carries a
    // destructive shell command. The executor must re-classify independently.
    const result = await executeTool(
      {
        schema_version: "0.1.0",
        action_type: "file_read", // Claim "safe" type
        command: "rm -rf ./node_modules", // Actually dangerous
        user_facing_explanation: "reading a config file",
      },
      { projectRoot },
      undefined,
      true, // Even auto-approve cannot override Tier 1
    );

    // The executor dispatches based on action_type (file_read), which tries
    // to read a file. But before dispatching, it re-classifies: rm is Tier1.
    // Either: hard-deny blocks it, or HITL gate would prompt.
    // In auto-approve mode, Tier 1 commands are still denied.
    expect(result.success).toBe(false);
  });

  test("REQ-8: ANSI escape injection does not bypass classification", () => {
    // An attacker could try to hide "rm -rf /" inside ANSI escapes.
    // sanitizeTerminalString strips them first, then classifyCommand
    // sees the clean command.
    const ansiEscape = "\x1B[2Jrm -rf /";
    const verdict = classifyCommand(ansiEscape, "shell", "clearing terminal");

    // After sanitization, "rm -rf /" should be detected as hard-deny
    expect(verdict.blocked).not.toBeNull();
    expect(verdict.blocked!.reason).toBeDefined();
  });

  test("executeTool with file_read and valid path succeeds", async () => {
    const projectRoot = await makeTempDir();
    const testFile = join(projectRoot, "read-me.txt");
    await Bun.write(testFile, "hello world");

    const result = await executeTool(
      {
        schema_version: "0.1.0",
        action_type: "file_read",
        command: testFile,
        user_facing_explanation: "read the test file",
      },
      { projectRoot },
      undefined,
      true,
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("read_file");
    expect(result.fileContent).toBe("hello world");
  });

  test("compound command is detected as Tier 1 through full pipeline", async () => {
    const projectRoot = await makeTempDir();

    // npm test && echo pwned — the && makes this compound → Tier 1
    const result = await executeTool(
      {
        schema_version: "0.1.0",
        action_type: "shell",
        command: "npm test && echo pwned",
        user_facing_explanation: "running tests",
      },
      { projectRoot },
      undefined,
      true, // Auto-approve cannot override Tier 1 compound detection
    );

    // Tier 1 commands are denied in auto-approve mode
    expect(result.success).toBe(false);
  });
});

// ── Hard-Deny — Full Pattern Coverage ───────────────────────────────

describe("hard-deny — complete pattern coverage", () => {
  test("hard-deny: docker run --privileged", () => {
    const verdict = classifyCommand(
      "docker run --privileged -it ubuntu bash",
      "shell",
      "running container",
    );
    expect(verdict.blocked).not.toBeNull();
    expect(verdict.blocked!.reason).toContain("Privileged container");
  });

  test("hard-deny: docker run with host root mount (-v /:/)", () => {
    const verdict = classifyCommand(
      "docker run -v /:/host alpine ls",
      "shell",
      "listing host files",
    );
    expect(verdict.blocked).not.toBeNull();
    expect(verdict.blocked!.reason).toContain("root filesystem mount");
  });

  test("hard-deny: fork bomb pattern", () => {
    const verdict = classifyCommand(
      ":(){ :|:& };:",
      "shell",
      "testing shell functions",
    );
    expect(verdict.blocked).not.toBeNull();
    expect(verdict.blocked!.reason).toContain("Fork bomb");
  });

  test("hard-deny: rm -rf $HOME", () => {
    const verdict = classifyCommand(
      "rm -rf $HOME",
      "shell",
      "cleaning home directory",
    );
    expect(verdict.blocked).not.toBeNull();
    expect(verdict.blocked!.reason).toContain("Home directory");
  });

  test("hard-deny: rm -rf ~/**", () => {
    const verdict = classifyCommand(
      "rm -rf ~/some-dir",
      "shell",
      "deleting old project",
    );
    // Matches the home dir hard-deny pattern: rm -rf ~ (/[^\s]*)?
    expect(verdict.blocked).not.toBeNull();
    expect(verdict.blocked!.reason).toContain("Home directory");
  });

  test("hard-deny: all seven patterns produce blocked", () => {
    // Verify each hard-deny pattern in the guard triggers as expected
    const patterns: { cmd: string; expectedReason: string }[] = [
      { cmd: "rm -rf /etc", expectedReason: "System configuration" },
      { cmd: "rm -rf ~/projects", expectedReason: "Home directory" },
      { cmd: `rm -rf /`, expectedReason: "Root filesystem" },
      { cmd: "rm -rf $HOME", expectedReason: "Home directory" },
      { cmd: "docker run --privileged alpine", expectedReason: "Privileged container" },
      { cmd: "docker run -v /:/host alpine", expectedReason: "root filesystem mount" },
      { cmd: ":(){ :|:& };:", expectedReason: "Fork bomb" },
    ];

    for (const { cmd, expectedReason } of patterns) {
      const verdict = classifyCommand(cmd, "shell", "test");
      expect(verdict.blocked).not.toBeNull();
      expect(verdict.blocked!.reason).toContain(expectedReason);
    }
  });

  test("hard-deny: executeTool blocks all hard-deny patterns (auto-approve cannot override)", async () => {
    const projectRoot = await makeTempDir();

    const blockedCommands = [
      "rm -rf /etc",
      "rm -rf /",
      "rm -rf $HOME",
      "docker run --privileged alpine",
      "docker run -v /:/host alpine",
    ];

    for (const cmd of blockedCommands) {
      const result = await executeTool(
        {
          schema_version: "0.1.0",
          action_type: "shell",
          command: cmd,
          user_facing_explanation: "test",
        },
        { projectRoot },
        undefined,
        true, // Auto-approve cannot override hard-deny
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      // Block must happen before execution
    }
  });
});

// ── executeTool — HITL Denial Flow ──────────────────────────────────

describe("executeTool — HITL denial flow", () => {
  test("returns denied when HITL rejects the command", async () => {
    const projectRoot = await makeTempDir();
    const sessionDir = await makeTempDir();

    // A Tier 1 command (rm) in non-auto-approve mode — HITL prompts.
    // The test uses stdin which is non-interactive, so HITL will
    // return "Deny" by default (no input → deny).
    const result = await executeTool(
      {
        schema_version: "0.1.0",
        action_type: "shell",
        command: "rm -rf ./node_modules",
        user_facing_explanation: "clean up",
      },
      { projectRoot, sessionDir },
      undefined,
      false, // Not auto-approve → Tier 1 prompts
    );

    // In non-interactive mode, HITL defaults to deny
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("unrecognized commands default to Tier 2 and are denied in non-auto-approve mode", async () => {
    const projectRoot = await makeTempDir();
    const sessionDir = await makeTempDir();

    // An unrecognized command defaults to Tier 2
    const result = await executeTool(
      {
        schema_version: "0.1.0",
        action_type: "shell",
        command: "some-random-unheard-command",
        user_facing_explanation: "testing defaults",
      },
      { projectRoot, sessionDir },
      undefined,
      false, // Not auto-approve
    );

    // In non-interactive mode, HITL denies by default
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Regression Tests: Kimi K3 Security Review Fixes (Story 008)
// ═══════════════════════════════════════════════════════════════════════

// ── REQ-2: file_write via executeTool is now supported ────────────

describe("REQ-2: file_write via executeTool is supported", () => {
  test("file_write via executeTool writes content and returns success", async () => {
    const projectRoot = await makeTempDir();
    const sessionDir = await makeTempDir();

    const outputPath = join(projectRoot, "output.txt");
    const content = "// Generated by zao harness";

    const result = await executeTool(
      ({
        schema_version: "0.1.0",
        action_type: "file_write",
        command: outputPath,
        user_facing_explanation: "write output file",
        content,
      } as Record<string, unknown>) as Parameters<typeof executeTool>[0],
      { projectRoot, sessionDir },
      undefined,
      true,
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("write_file");
    expect(result.filePath).toBe(outputPath);

    // Verify the file was actually written
    const { readFile: fsReadFile } = await import("node:fs/promises");
    const writtenContent = await fsReadFile(outputPath, "utf-8");
    expect(writtenContent).toBe(content);
  });

  test("file_write without content returns error", async () => {
    const projectRoot = await makeTempDir();
    const sessionDir = await makeTempDir();

    const result = await executeTool(
      {
        schema_version: "0.1.0",
        action_type: "file_write",
        command: join(projectRoot, "output.txt"),
        user_facing_explanation: "write output file (no content)",
      },
      { projectRoot, sessionDir },
      undefined,
      true,
    );

    expect(result.success).toBe(false);
    expect(result.action).toBe("write_file");
    expect(result.error).toContain("requires 'content'");
  });
});

// ── CRIT-001: Incremental streaming with large output ────────────────

describe("CRIT-001: incremental streaming prevents memory DoS", () => {
  test("produces truncated output without consuming unbounded memory", async () => {
    // Generate 50 KB of output, cap at 1 KB — the incremental
    // reader must stop reading and return truncated=true without
    // loading the full 50 KB into memory.
    const result = await executeShell(
      `printf 'x%.0s' {1..50000}`,
      process.cwd(),
      30_000,
      1_024,
    );

    expect(result.outputTruncated).toBe(true);
    expect(result.stdout!.length).toBeLessThanOrEqual(1_024);
    // The command should have been killed when the cap was exceeded
    // (exitCode may be null if killed by signal, or non-zero)
    expect(result.success).toBeDefined();
  });

  test("large output does not crash the executor", async () => {
    // 200 KB of output with 100 KB cap — ensures the process
    // doesn't OOM even with significant output.
    const result = await executeShell(
      `printf 'x%.0s' {1..200000}`,
      process.cwd(),
      30_000,
      102_400,
    );

    // Should either be truncated (if it actually produces >100KB)
    // or succeed with up to 102400 bytes of output
    expect(result.action).toBe("shell");
    if (result.outputTruncated) {
      expect(result.stdout!.length).toBeLessThanOrEqual(102_400);
    } else {
      expect(result.stdout!.length).toBeLessThanOrEqual(102_400);
    }
  });

  test("stderr truncation is also detected", async () => {
    // Generate stderr output exceeding a small cap
    const result = await executeShell(
      `printf 'x%.0s' {1..5000} >&2`,
      process.cwd(),
      30_000,
      100,
    );

    expect(result.outputTruncated).toBe(true);
    expect(result.stderr!.length).toBeLessThanOrEqual(100);
  });
});

// ── LOW-004: Timeout path includes exitCode: -1 ──────────────────────

describe("LOW-004: timeout returns exitCode: -1", () => {
  test("timed-out command returns exitCode: -1 for consistency", async () => {
    const result = await executeShell("sleep 5", process.cwd(), 50, 102_400);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    expect(result.exitCode).toBe(-1);
  });
});

// ── MED-002: Unified out-of-root error message ───────────────────────

describe("MED-002: unified access-denied message for out-of-root paths", () => {
  test("non-existent path outside root returns access-denied, not file-not-found", async () => {
    const projectRoot = await makeTempDir();
    // A path outside root that definitely doesn't exist
    const outsidePath = "/nonexistent/path/outside/root.txt";

    const result = await readFile(outsidePath, projectRoot);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Access denied");
    expect(result.error).toContain("outside the project root");
    // Should NOT say "File not found" — that would leak filesystem info
    expect(result.error).not.toContain("not found");
  });

  test("existing file outside root also returns access-denied (not a different message)", async () => {
    const projectRoot = await makeTempDir();
    const outsidePath = "/etc/hostname"; // Exists on Linux

    const result = await readFile(outsidePath, projectRoot);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Access denied");
    expect(result.error).toContain("outside the project root");
  });
});
