/**
 * CLI tests — R-006B MED-002.
 *
 * Covers argument parsing and pre-dispatch validation for the `--blueprint`
 * flag:
 * - parseArgs: `--blueprint <id>` with `--task` selects blueprint mode;
 *   `--flow <id>` with `--task` selects flow mode (task optional).
 * - validateArgs: `--blueprint` + `--flow` mutual exclusivity (HIGH-001),
 *   required `--task` for blueprint mode, mode-selection requirement.
 * - Subprocess: real exit codes through the actual CLI entry point
 *   (mutual exclusivity error, invalid blueprint id → validation failure).
 *
 * @module cli.test
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseArgs, validateArgs } from "../src/cli.ts";

const PACKAGE_ROOT = join(import.meta.dir, "..");

// ── Temp store root for subprocess tests ──────────────────────────

let testStoreRoot: string;

beforeAll(async () => {
  testStoreRoot = join("/tmp", `zao-test-cli-${randomUUID()}`);
  await mkdir(testStoreRoot, { recursive: true });
});

afterAll(async () => {
  try {
    await rm(testStoreRoot, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

// ── parseArgs ─────────────────────────────────────────────────────

describe("parseArgs", () => {
  test("--blueprint <id> with --task selects blueprint mode", () => {
    const parsed = parseArgs([
      "run",
      "--blueprint",
      "feature-development",
      "--task",
      "test task",
    ]);

    expect(parsed.blueprint).toBe("feature-development");
    expect(parsed.task).toBe("test task");
    expect(parsed.flow).toBeUndefined();
  });

  test("-b short flag also selects blueprint mode", () => {
    const parsed = parseArgs(["run", "-b", "bug-fix", "-t", "Fix crash"]);

    expect(parsed.blueprint).toBe("bug-fix");
    expect(parsed.task).toBe("Fix crash");
  });

  test("--flow <id> with --task selects flow mode (task optional)", () => {
    const parsed = parseArgs(["run", "--flow", "default", "--task", "Refactor auth"]);

    expect(parsed.flow).toBe("default");
    expect(parsed.task).toBe("Refactor auth");
    expect(parsed.blueprint).toBeUndefined();
  });

  test("--flow <id> without --task still selects flow mode", () => {
    const parsed = parseArgs(["run", "--flow", "default"]);

    expect(parsed.flow).toBe("default");
    expect(parsed.task).toBeUndefined();
  });

  test("value flag at end of argv leaves the field undefined", () => {
    const parsed = parseArgs(["run", "--blueprint"]);

    expect(parsed.blueprint).toBeUndefined();
  });
});

// ── validateArgs ──────────────────────────────────────────────────

describe("validateArgs", () => {
  test("--blueprint + --flow together → mutual exclusivity error (HIGH-001)", () => {
    const err = validateArgs(
      parseArgs([
        "run",
        "--blueprint",
        "feature-development",
        "--flow",
        "default",
        "--task",
        "x",
      ]),
    );

    expect(err).toBe("--blueprint and --flow are mutually exclusive.");
  });

  test("--blueprint without --task → task-required error", () => {
    const err = validateArgs(parseArgs(["run", "--blueprint", "feature-development"]));

    expect(err).toBe("--task is required when using --blueprint.");
  });

  test("no mode flag → mode-required error", () => {
    const err = validateArgs(parseArgs(["run", "--task", "x"]));

    expect(err).toBe("--flow or --blueprint is required.");
  });

  test("--blueprint with --task is valid", () => {
    const err = validateArgs(
      parseArgs(["run", "--blueprint", "feature-development", "--task", "x"]),
    );

    expect(err).toBeNull();
  });

  test("--flow with --task is valid", () => {
    const err = validateArgs(parseArgs(["run", "--flow", "default", "--task", "x"]));

    expect(err).toBeNull();
  });

  test("--flow without --task is valid (task optional for flow)", () => {
    const err = validateArgs(parseArgs(["run", "--flow", "default"]));

    expect(err).toBeNull();
  });
});

// ── Subprocess behavior ───────────────────────────────────────────

interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the real CLI as a child process with the given arguments.
 * The store root is pointed at a temp dir so executions cannot touch
 * the real `~/.zao` store.
 */
function runCli(args: string[]): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ["run", "src/cli.ts", "--", ...args],
      {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, ZAO_HOME: testStoreRoot },
      },
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("CLI subprocess behavior", () => {
  test("--blueprint + --flow exits 3 with mutual exclusivity error (HIGH-001)", async () => {
    const { code, stderr } = await runCli([
      "run",
      "--blueprint",
      "feature-development",
      "--flow",
      "default",
      "--task",
      "probe",
    ]);

    // ADR-008 Decision 4: validation=3.
    expect(code).toBe(3);
    expect(stderr).toContain(
      "Error: --blueprint and --flow are mutually exclusive.",
    );
    expect(stderr).toContain("Run with --help for usage.");
  });

  test("--blueprint without --task exits 3 with task-required error", async () => {
    const { code, stderr } = await runCli([
      "run",
      "--blueprint",
      "feature-development",
    ]);

    // ADR-008 Decision 4: validation=3.
    expect(code).toBe(3);
    expect(stderr).toContain(
      "Error: --task is required when using --blueprint.",
    );
  });

  test("invalid blueprint id → validation failure exit code 3", async () => {
    const { code, stdout } = await runCli([
      "run",
      "--blueprint",
      "no-such-blueprint-xyz",
      "--task",
      "probe",
    ]);

    // ADR-008 Decision 4: validation=3 (isValidationFailure from execute).
    expect(code).toBe(3);
    expect(stdout).toContain("Execution failed");
    expect(stdout).toContain("no-such-blueprint-xyz");
  });
});

// ── Verbosity Flag Tests ───────────────────────────────────────────

describe("parseArgs — verbosity flags", () => {
  test("--verbose sets logLevel to debug", () => {
    const parsed = parseArgs(["run", "--verbose", "--flow", "default"]);
    expect(parsed.logLevel).toBe("debug");
  });

  test("-v short flag sets logLevel to debug", () => {
    const parsed = parseArgs(["run", "-v", "--flow", "default"]);
    expect(parsed.logLevel).toBe("debug");
  });

  test("--quiet sets logLevel to error", () => {
    const parsed = parseArgs(["run", "--quiet", "--flow", "default"]);
    expect(parsed.logLevel).toBe("error");
  });

  test("-q short flag sets logLevel to error", () => {
    const parsed = parseArgs(["run", "-q", "--flow", "default"]);
    expect(parsed.logLevel).toBe("error");
  });

  test("default logLevel is info when no flag specified", () => {
    const parsed = parseArgs(["run", "--flow", "default"]);
    expect(parsed.logLevel).toBe("info");
  });
});
