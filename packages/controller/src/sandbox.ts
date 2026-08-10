/**
 * Git worktree sandboxing — isolates LLM-side changes from the real
 * working tree until the human approves.
 *
 * ## Design
 *
 * Before the controller executes any steps, a git worktree is created
 * at `/tmp/mo-sandbox-<executionId>`. All harness operations
 * (readFile, writeFile, executeShell) then operate inside the worktree.
 *
 * On approval: the diff from the worktree is applied to the original
 * repo via `git apply`. On denial (or failure): the worktree is force-
 * removed, discarding all changes.
 *
 * ## Test injection
 *
 * The {@link SandboxOptions.gitCommand} option replaces the `git` binary
 * path for testing without real git operations. All functions are pure
 * wrappers around `node:child_process.exec`.
 *
 * @module sandbox
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { realpath, writeFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { logger } from "../../harness/src/core/logger.ts";

const execAsync = promisify(exec);

// ── Types ──────────────────────────────────────────────────────────

/** Handle returned by {@link createSandbox}. */
export interface SandboxHandle {
  /** Absolute path to the git worktree. */
  worktreePath: string;
  /** Absolute path to the original project directory. */
  originalDir: string;
  /** The execution ID this sandbox was created for. */
  executionId: string;
}

/** Result of {@link applySandboxChanges}. */
export interface ApplyResult {
  /** List of relative file paths that were changed in the worktree. */
  appliedFiles: string[];
  /** Git diff summary (first 2000 chars). */
  diffSummary: string;
}

/** Options for sandbox operations, including test injection. */
export interface SandboxOptions {
  /**
   * Override the git binary path for test injection.
   * @default "git"
   */
  gitCommand?: string;
}

// ── Constants ──────────────────────────────────────────────────────

/** Prefix for sandbox worktree directories. */
const SANDBOX_PREFIX = join(tmpdir(), "mo-sandbox-");

// ── Helpers ────────────────────────────────────────────────────────

function git(options: SandboxOptions = {}): string {
  return options.gitCommand ?? "git";
}

/**
 * Checks whether the `git` binary is available on the system.
 * Returns `true` if `git --version` succeeds, `false` otherwise.
 */
async function isGitAvailable(options?: SandboxOptions): Promise<boolean> {
  try {
    await execAsync(`${git(options)} --version`, { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether the given directory is inside a git work tree.
 * Returns the top-level directory if so, null otherwise.
 */
async function isGitRepo(
  dir: string,
  options?: SandboxOptions,
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `${git(options)} -C "${dir}" rev-parse --show-toplevel`,
      { encoding: "utf-8" },
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Auto-initializes a git repository in the given directory.
 * Runs `git init && git add -A && git commit --allow-empty -m "mo sandbox init"`.
 * Returns `true` on success, `false` on failure.
 */
async function initGitRepo(
  dir: string,
  options?: SandboxOptions,
): Promise<boolean> {
  // Warn before acting
  logger.warn(
    `[zao] Not a git repo — auto-initializing git in "${dir}" for sandboxing. ` +
    `Use --no-sandbox to skip.`,
  );

  try {
    await execAsync(
      `${git(options)} init && ${git(options)} add -A && ${git(options)} commit --allow-empty -m "mo sandbox init"`,
      { encoding: "utf-8", cwd: dir },
    );
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to auto-initialize git repo in "${dir}": ${message}`);
    return false;
  }
}

// ── Core Functions ─────────────────────────────────────────────────

/**
 * Creates a detached git worktree at `/tmp/mo-sandbox-<executionId>`.
 *
 * The worktree is a checked-out copy of the HEAD commit (detached),
 * so the LLM can modify files freely without touching the real tree.
 *
 * If `projectDir` is not a git repo, this function auto-initializes one
 * (`git init && git add -A && git commit -m "mo sandbox init"`) and then
 * creates the worktree. If git is not available at all, a warning is
 * logged and `null` is returned (sandbox skipped).
 *
 * @param projectDir - The project directory.
 * @param executionId - Unique execution ID used for the worktree name.
 * @param options - Optional git binary override for testing.
 * @returns A {@link SandboxHandle} with the worktree path, or `null` if
 *          sandboxing is not possible (no git available).
 * @throws If `projectDir` does not exist, or if the worktree path
 *         already exists (stale sandbox).
 */
export async function createSandbox(
  projectDir: string,
  executionId: string,
  options?: SandboxOptions,
): Promise<SandboxHandle | null> {
  // Resolve the real path first to handle symlinks
  let resolvedDir: string;
  try {
    resolvedDir = await realpath(projectDir);
  } catch {
    throw new Error(
      `Sandbox creation failed: project directory "${projectDir}" does not exist or is inaccessible.`,
    );
  }

  // Check if it's a git repo; if not, try auto-init
  let topLevel = await isGitRepo(resolvedDir, options);
  if (!topLevel) {
    // Git not available at all — warn and skip sandbox
    if (!(await isGitAvailable(options))) {
      logger.warn(
        `[zao] Git not available — sandboxing disabled for this execution. ` +
        `Directory "${resolvedDir}" is not a git repo and git is not installed.`,
      );
      return null;
    }

    // Auto-initialize git repo
    const initOk = await initGitRepo(resolvedDir, options);
    if (!initOk) {
      logger.warn(
        `[zao] Failed to auto-initialize git repo in "${resolvedDir}" — ` +
        `sandboxing disabled for this execution.`,
      );
      return null;
    }

    // Re-verify after init
    topLevel = await isGitRepo(resolvedDir, options);
    if (!topLevel) {
      logger.warn(
        `[zao] Git repo auto-init completed but "${resolvedDir}" is still not ` +
        `recognized as a git repo — sandboxing disabled.`,
      );
      return null;
    }
  }

  const worktreePath = `${SANDBOX_PREFIX}${executionId}`;

  // Fail-closed: if the worktree path already exists, that's an error state
  if (existsSync(worktreePath)) {
    throw new Error(
      `Sandbox creation failed: worktree path "${worktreePath}" already exists. ` +
      `A previous sandbox for execution "${executionId}" may not have been cleaned up.`,
    );
  }

  try {
    await execAsync(
      `${git(options)} -C "${resolvedDir}" worktree add --detach "${worktreePath}"`,
      { encoding: "utf-8" },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[zao] Sandbox creation failed: git worktree add error: ${message} — ` +
      `sandboxing disabled for this execution.`,
    );
    return null;
  }

  return {
    worktreePath,
    originalDir: resolvedDir,
    executionId,
  };
}

/**
 * Applies the diff from the sandbox worktree to the original repo.
 *
 * Runs `git diff` inside the worktree, then `git apply` in the original
 * directory. Returns the list of changed files and a diff summary.
 *
 * @param sandbox - The sandbox handle from {@link createSandbox}.
 * @param options - Optional git binary override for testing.
 * @returns An {@link ApplyResult} with changed files and diff summary.
 * @throws If the diff cannot be generated or applied.
 */
export async function applySandboxChanges(
  sandbox: SandboxHandle,
  options?: SandboxOptions,
): Promise<ApplyResult> {
  // Step 1: Generate the diff from the worktree
  let diff: string;
  try {
    const { stdout } = await execAsync(
      `${git(options)} -C "${sandbox.worktreePath}" diff HEAD`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
    );
    diff = stdout;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to generate sandbox diff: ${message}`,
    );
  }

  // Step 2: Extract changed file paths from the diff
  const appliedFiles = extractChangedFiles(diff);

  // Step 3: Apply the diff to the original repo (if non-empty)
  if (diff.trim().length > 0) {
    // Write diff to temp file for git apply (stdin piping varies across
    // exec implementations — temp file is portable).
    let patchFile: string;
    try {
      const tmpDir = await mkdtemp(join(tmpdir(), "mo-sandbox-patch-"));
      patchFile = join(tmpDir, "sandbox.patch");
      await writeFile(patchFile, diff, "utf-8");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to write sandbox diff to temp file: ${message}`,
      );
    }

    try {
      await execAsync(
        `${git(options)} -C "${sandbox.originalDir}" apply "${patchFile}"`,
        { encoding: "utf-8" },
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to apply sandbox diff: ${message}`,
      );
    } finally {
      // Clean up temp patch directory
      try { await rm(dirname(patchFile), { recursive: true, force: true }); } catch {}
    }
  }

  return {
    appliedFiles,
    diffSummary: diff.substring(0, 2000),
  };
}

/**
 * Extracts relative file paths from a git diff output.
 *
 * Parses `diff --git a/<path> b/<path>` and `+++ b/<path>` lines.
 */
function extractChangedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- a/") || line.startsWith("+++ b/")) {
      const trimmed = line.startsWith("--- a/")
        ? line.slice(6)
        : line.slice(6);
      if (trimmed && trimmed !== "/dev/null") {
        files.add(trimmed);
      }
    }
  }
  return [...files];
}

/**
 * Discards the sandbox worktree, removing it from disk and from git's
 * worktree list.
 *
 * Uses `--force` to ensure cleanup even if the worktree has changes.
 * Always succeeds — errors are logged but not thrown (best-effort
 * cleanup).
 *
 * @param sandbox - The sandbox handle from {@link createSandbox}.
 * @param options - Optional git binary override for testing.
 */
export async function discardSandbox(
  sandbox: SandboxHandle,
  options?: SandboxOptions,
): Promise<void> {
  try {
    await execAsync(
      `${git(options)} -C "${sandbox.originalDir}" worktree remove --force "${sandbox.worktreePath}"`,
      { encoding: "utf-8" },
    );
  } catch {
    // If git worktree remove fails, try rm -rf as a fallback
    try {
      await execAsync(`rm -rf "${sandbox.worktreePath}"`, { encoding: "utf-8" });
    } catch {
      // Best-effort: cannot clean up, log and move on
    }
  }
}


