/**
 * Tool Execution Layer — executes shell commands and file operations
 * on behalf of the LLM, gated by the HITL permission system (Story 007).
 *
 * ## Core guarantees
 *
 * - **Re-classification (REQ-8)**: Every command is independently
 *   re-classified via {@link classifyCommand}; the request's `action_type`
 *   is never trusted as a tier indicator.
 * - **Hard-deny enforcement (REQ-9)**: Commands matching the hard-deny
 *   list are rejected immediately, even with human approval.
 * - **Path confinement (REQ-6)**: File reads and writes are confined to
 *   the project root directory via `realpath()` resolution.
 * - **Output capping (REQ-5)**: Shell output is capped at a configurable
 *   limit (default 100 KB) to prevent memory DoS.
 * - **Atomic writes**: File writes use {@link writeArtifact} for atomic
 *   write-to-temp-then-rename semantics (Story 004).
 *
 * @module executor
 */

import type { ToolExecutionRequest } from "../schemas/tool-execution.ts";
import { sanitizeTerminalString, classifyCommand, TrustTier } from "./command-guard.ts";
import { promptForPermission, PermissionSession, HITLResponse } from "./hitl.ts";
import { writeArtifact, appendEvent } from "./artifacts.ts";
import { generateSessionId } from "./ids.ts";
import { logger } from "./logger.ts";
import { progress } from "./progress.ts";
import { realpathSync, existsSync, lstatSync } from "node:fs";
import { resolve, isAbsolute, dirname } from "node:path";
import { computeUnifiedDiff } from "./diff-renderer.ts";

// ── Types ───────────────────────────────────────────────────────────

/** Result of a tool execution, returned to the caller. */
export interface ToolResult {
  success: boolean;
  action: "shell" | "read_file" | "write_file";
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  fileContent?: string;
  filePath?: string;
  error?: string;
  outputTruncated?: boolean;
}

/** Configuration for tool execution. */
export interface ExecutorConfig {
  /** Absolute path to the project root (for path confinement). */
  projectRoot: string;
  /** Maximum bytes of stdout/stderr to capture (default: 100 KB). */
  outputLimit?: number;
  /** Shell command timeout in milliseconds (default: 60 s). */
  timeout?: number;
  /** Optional session directory for event logging (best-effort). */
  sessionDir?: string;
  /**
   * UUIDv7 session identifier for v0.2.0 event envelope.
   * Threaded through from the caller (loop/delegation).
   */
  sessionId?: string;
  /**
   * UUIDv7 parent session identifier for v0.2.0 event envelope.
   * Null for root sessions.
   */
  parentSessionId?: string | null;
  /**
   * The owning session's model_id for executor events (v0.3.0).
   * Forwarded from the caller's resolved model.
   */
  modelId?: string;
  /**
   * Output format (TD-020). When "json", HITL uses the
   * pending_interaction relay instead of TUI prompt.
   */
  format?: "table" | "json";
  /**
   * Current flow step info for session_state in pending_interaction.
   * Threaded from the caller (controller loop) → executor → HITLContext.
   */
  stepInfo?: {
    currentStep: string;
    stepIndex: number;
    totalSteps: number;
  };
}

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_OUTPUT_LIMIT = 102_400; // 100 KB
const DEFAULT_TIMEOUT = 60_000; // 60 seconds

// ── Path Confinement Helpers ────────────────────────────────────────

/**
 * Checks whether an absolute path is contained within `projectRoot`.
 *
 * Uses trailing-slash comparison to prevent prefix-matching attacks
 * (e.g., `/project` matching `/project-evil`).
 *
 * @param absolutePath - The resolved absolute path to check.
 * @param projectRoot - The absolute project root.
 * @returns `true` if the path is within the project root.
 */
function isPathWithinRoot(absolutePath: string, projectRoot: string): boolean {
  const normalizedRoot = resolve(projectRoot) + "/";
  const normalizedPath = absolutePath + "/";
  return normalizedPath.startsWith(normalizedRoot);
}

/**
 * Resolves a potentially relative path against `projectRoot` and
 * follows symlinks via `realpathSync()`.
 *
 * On reads, the resolved (symlink-followed) path must stay within
 * the project root.
 *
 * ## MED-002: File existence oracle fix
 *
 * Lexical confinement check runs BEFORE realpathSync. This ensures all
 * out-of-root paths get the same unified error message ("Access denied:
 * path is outside the project root") regardless of whether the file
 * exists. Previously, non-existent out-of-root paths returned a
 * different error ("File not found") which leaked information about
 * the filesystem.
 *
 * @param rawPath - The raw file path from the request.
 * @param projectRoot - The absolute project root.
 * @returns An object with either the `resolvedPath` or an `error` string.
 */
function resolveReadablePath(
  rawPath: string,
  projectRoot: string,
): { resolvedPath: string } | { error: string; filePath: string } {
  const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(projectRoot, rawPath);

  // MED-002: Lexical confinement check BEFORE realpathSync.
  // This prevents the file-existence oracle: all out-of-root paths
  // get the same error message regardless of whether the file exists.
  if (!isPathWithinRoot(absolutePath, projectRoot)) {
    return {
      error: "Access denied: path is outside the project root",
      filePath: absolutePath,
    };
  }

  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(absolutePath);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") {
      return { error: `File not found: ${absolutePath}`, filePath: absolutePath };
    }
    return {
      error: `Failed to resolve path: ${err instanceof Error ? err.message : String(err)}`,
      filePath: absolutePath,
    };
  }

  // realpathSync may resolve symlinks that point outside the root.
  // Re-check the resolved (symlink-followed) path.
  if (!isPathWithinRoot(resolvedPath, projectRoot)) {
    return {
      error: "Access denied: path is outside the project root",
      filePath: resolvedPath,
    };
  }

  return { resolvedPath };
}

/**
 * Resolves the parent directory of a write target, following symlinks
 * on the parent only (not the file itself, which may not exist yet).
 * Verifies the parent is within `projectRoot`.
 *
 * If the file already exists and is a symlink, the write is rejected
 * (symlink policy: writes never follow symlinks).
 *
 * @param rawPath - The raw file path from the request.
 * @param projectRoot - The absolute project root.
 * @returns An object with either the `resolvedPath` (final write target)
 *          or an `error` string.
 */
function resolveWritablePath(
  rawPath: string,
  projectRoot: string,
): { resolvedPath: string } | { error: string; filePath: string } {
  const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(projectRoot, rawPath);
  const parentDir = dirname(absolutePath);

  // Resolve the parent directory (follows symlinks on the parent)
  let resolvedParent: string;
  try {
    resolvedParent = realpathSync(parentDir);
  } catch {
    return {
      error: `Parent directory does not exist or is inaccessible: ${parentDir}`,
      filePath: absolutePath,
    };
  }

  if (!isPathWithinRoot(resolvedParent, projectRoot)) {
    return {
      error: `Access denied: path is outside the project root`,
      filePath: absolutePath,
    };
  }

  // If the file already exists and is a symlink, reject the write
  if (existsSync(absolutePath)) {
    try {
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        return {
          error: "Cannot write to a symlink — file write targets must be regular files",
          filePath: absolutePath,
        };
      }
    } catch {
      // lstat may fail if the file is deleted between existsSync and lstatSync
      // Fall through to the write attempt
    }
  }

  // Construct the final path using the resolved parent
  const fileName = absolutePath.split("/").pop()!;
  const finalPath = resolve(resolvedParent, fileName);

  // Double-check the final path is within projectRoot
  if (!isPathWithinRoot(finalPath, projectRoot)) {
    return {
      error: `Access denied: path is outside the project root`,
      filePath: finalPath,
    };
  }

  return { resolvedPath: finalPath };
}

// ── Incremental Stream Reader ───────────────────────────────────────

/**
 * Reads a {@link ReadableStream} incrementally, capping the total bytes
 * collected at `limit`. If the limit is exceeded, the reader is cancelled
 * and the text accumulated up to that point is returned with `truncated: true`.
 *
 * ## CRIT-001: Incremental stream cap
 *
 * This replaces `Bun.readableStreamToText` + post-slice which loaded the
 * entire stream into memory before capping, enabling memory DoS via large
 * command output.
 *
 * @param stream - The readable stream of bytes.
 * @param limit - Maximum total bytes to collect.
 * @returns The accumulated text and a truncation flag.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      // CRIT-001: The current chunk may be much larger than the limit.
      // Slice out only the bytes we have room for to avoid returning
      // an empty string when the first chunk alone exceeds the cap.
      const overflow = total - limit;
      const keepBytes = value.byteLength - overflow;
      if (keepBytes > 0) {
        chunks.push(value.slice(0, keepBytes));
      }
      return {
        text: new TextDecoder().decode(await new Blob(chunks).arrayBuffer()),
        truncated: true,
      };
    }
    chunks.push(value);
  }

  return {
    text: new TextDecoder().decode(await new Blob(chunks).arrayBuffer()),
    truncated: false,
  };
}

// ── Shell Execution ─────────────────────────────────────────────────

/**
 * Executes a shell command via `bash -c` and captures stdout, stderr,
 * and exit code.
 *
 * ## Behavior
 *
 * - Output is capped at `outputLimit` bytes; if exceeded,
 *   `outputTruncated` is set to `true` and the process is killed (CRIT-001).
 * - The command times out after `timeout` milliseconds; the process
 *   receives SIGTERM, followed by SIGKILL after a 250 ms grace period
 *   (HIGH-001).
 * - Non-zero exit codes set `success: false` with the exit code and
 *   stderr content.
 *
 * ## Process cleanup (HIGH-002)
 *
 * Bun on Linux spawns child processes in the same process group,
 * providing basic process-tree termination via SIGKILL. However,
 * unsandboxed shell execution has a known limitation: deeply nested
 * grandchild processes spawned by the command may not be terminated.
 * Future sandboxing (containers/cgroups) will address this.
 *
 * @param command - The shell command to execute (passed to `bash -c`).
 * @param cwd - The working directory for the command.
 * @param timeout - Timeout in milliseconds (must be > 0).
 * @param outputLimit - Maximum bytes to capture from stdout/stderr (must be > 0).
 * @returns A {@link ToolResult} with the execution outcome.
 */
export async function executeShell(
  command: string,
  cwd: string,
  timeout: number,
  outputLimit: number,
): Promise<ToolResult> {
  // LOW-003: Validate inputs
  if (timeout <= 0) {
    return {
      success: false,
      action: "shell",
      error: `Invalid timeout: ${timeout}. Timeout must be > 0.`,
    };
  }
  if (outputLimit <= 0) {
    return {
      success: false,
      action: "shell",
      error: `Invalid outputLimit: ${outputLimit}. outputLimit must be > 0.`,
    };
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["bash", "-c", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err: unknown) {
    // Spawn itself can fail (e.g., bash not found)
    return {
      success: false,
      action: "shell",
      error: `Failed to spawn command: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // CRIT-001: Start reading stdout and stderr incrementally with caps.
  // These read in the background while we wait for the process exit.
  // If either exceeds the cap, the reader cancels and returns early.
  const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
  const stderrStream = proc.stderr as ReadableStream<Uint8Array>;
  const readPromise = Promise.all([
    readCapped(stdoutStream, outputLimit),
    readCapped(stderrStream, outputLimit),
  ]);

  // HIGH-001: Timeout with SIGKILL escalation.
  // After SIGTERM, wait 250ms grace period then escalate to SIGKILL.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(); // SIGTERM
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 250);
  }, timeout);

  // Wait for process exit (streams are being read concurrently)
  let exitCode: number | null = null;
  try {
    exitCode = await proc.exited;
    clearTimeout(timer);
  } catch {
    // Process may have been force-killed by timeout — the streams
    // will close, and the background readPromise will complete.
    if (!timedOut) timedOut = true;
    clearTimeout(timer);
  }

  // Collect stream results (already read incrementally in background);
  // if the process was killed, the streams closed and reads finished.
  const [stdoutResult, stderrResult] = await readPromise;
  const truncated = stdoutResult.truncated || stderrResult.truncated;

  // CRIT-001: If output was truncated, ensure the process is dead
  if (truncated) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Process may already be dead
    }
  }

  // HIGH-002: Ensure cleanup — best-effort SIGKILL to reap any orphans
  try {
    proc.kill("SIGKILL");
  } catch {
    // Process already dead — expected
  }

  if (timedOut) {
    return {
      success: false,
      action: "shell",
      ...(stdoutResult.text !== undefined ? { stdout: stdoutResult.text } : {}),
      ...(stderrResult.text !== undefined ? { stderr: stderrResult.text } : {}),
      exitCode: -1, // LOW-004: Consistent exit code for timeout
      error: `Command timed out after ${timeout}ms`,
      ...(truncated ? { outputTruncated: true } : {}),
    };
  }

  // Non-zero exit code → failure (REQ-3)
  if (exitCode !== 0) {
    return {
      success: false,
      action: "shell",
      ...(stdoutResult.text !== undefined ? { stdout: stdoutResult.text } : {}),
      ...(stderrResult.text !== undefined ? { stderr: stderrResult.text } : {}),
      exitCode: exitCode ?? undefined,
      ...(truncated ? { outputTruncated: true } : {}),
    };
  }

  return {
    success: true,
    action: "shell",
    ...(stdoutResult.text !== undefined ? { stdout: stdoutResult.text } : {}),
    ...(stderrResult.text !== undefined ? { stderr: stderrResult.text } : {}),
    exitCode: exitCode ?? 0,
    ...(truncated ? { outputTruncated: true } : {}),
  };
}

// ── File Read ───────────────────────────────────────────────────────

/**
 * Reads a file's content with path confinement.
 *
 * ## Path confinement
 *
 * The file path is resolved via `realpathSync()` (which follows symlinks)
 * and verified to be within `projectRoot`. Reads outside the project are
 * rejected with an error.
 *
 * ## Symlink policy (OQ-1 resolved)
 *
 * For **reads**: symlinks are followed via `realpath()`. The resolved
 * target must stay within the project root.
 *
 * ## TOCTOU warning (MED-003)
 *
 * There is a time-of-check-time-of-use window between the `realpathSync`
 * confinement check and the subsequent `Bun.file().text()` open. A
 * concurrent process could replace the path with a symlink after the
 * check. Writes are protected by atomic rename (`writeArtifact`);
 * reads accept this residual risk until Bun exposes fd-relative opens
 * (`openat`). The window is small and requires a local attacker with
 * filesystem write access.
 *
 * @param rawPath - The file path (absolute or relative to projectRoot).
 * @param projectRoot - The absolute project root for path confinement.
 * @returns A {@link ToolResult} with `fileContent` on success.
 */
export async function readFile(
  rawPath: string,
  projectRoot: string,
): Promise<ToolResult> {
  // MED-001: Canonicalize projectRoot once at entry
  const root = realpathSync(resolve(projectRoot));

  const resolved = resolveReadablePath(rawPath, root);
  if ("error" in resolved) {
    return {
      success: false,
      action: "read_file",
      filePath: resolved.filePath,
      error: resolved.error,
    };
  }

  try {
    const file = Bun.file(resolved.resolvedPath);
    const content = await file.text();
    return {
      success: true,
      action: "read_file",
      filePath: resolved.resolvedPath,
      fileContent: content,
    };
  } catch (err: unknown) {
    return {
      success: false,
      action: "read_file",
      filePath: resolved.resolvedPath,
      error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── File Write (Atomic) ─────────────────────────────────────────────

/**
 * Writes content to a file atomically using the {@link writeArtifact}
 * function (Story 004).
 *
 * ## Path confinement
 *
 * The parent directory is resolved via `realpathSync()` (symlinks
 * followed). The resulting write target is verified to stay within
 * `projectRoot`. Writes outside the project are rejected.
 *
 * ## Symlink policy (OQ-1 resolved)
 *
 * For **writes**: symlinks are **rejected**. The parent directory
 * resolution follows symlinks, but if the target file already exists
 * and is a symlink, the write is blocked. New files are created in
 * the resolved parent directory.
 *
 * ## Secret redaction note (MED-004)
 *
 * `writeFile` delegates to {@link writeArtifact}, which applies
 * `redactSecrets` before writing. This means secrets (API keys,
 * tokens, passwords) detected in the content are redacted in the
 * written artifact. For non-artifact files where redaction is
 * undesirable, use a direct `Bun.write` with path-confinement checks
 * instead.
 *
 * @param rawPath - The file path (absolute or relative to projectRoot).
 * @param content - The content to write to the file.
 * @param projectRoot - The absolute project root for path confinement.
 * @returns A {@link ToolResult} with the outcome.
 */
export async function writeFile(
  rawPath: string,
  content: string,
  projectRoot: string,
): Promise<ToolResult> {
  // MED-001: Canonicalize projectRoot once at entry
  const root = realpathSync(resolve(projectRoot));

  const resolved = resolveWritablePath(rawPath, root);
  if ("error" in resolved) {
    return {
      success: false,
      action: "write_file",
      filePath: resolved.filePath,
      error: resolved.error,
    };
  }

  try {
    await writeArtifact(resolved.resolvedPath, content);
    return {
      success: true,
      action: "write_file",
      filePath: resolved.resolvedPath,
    };
  } catch (err: unknown) {
    return {
      success: false,
      action: "write_file",
      filePath: resolved.resolvedPath,
      error: `Failed to write file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Tool Execution Orchestrator ─────────────────────────────────────

/**
 * Executes a tool request through the full security pipeline.
 *
 * ## Flow
 *
 * 1. **Sanitize** the command via {@link sanitizeTerminalString}
 * 2. **Re-classify independently** via {@link classifyCommand} (REQ-8)
 * 3. **Blocked check** — if `verdict.blocked`, return immediately (REQ-9)
 * 4. **HITL gate** — if not Tier 0, call {@link promptForPermission}
 * 5. **Dispatch** — route to `executeShell`, `readFile`, or `writeFile`
 * 6. **Log** the execution event via {@link appendEvent} (best-effort)
 *
 * ## Action type dispatch
 *
 * - `"shell"` → {@link executeShell}
 * - `"file_read"` → {@link readFile}
 * - `"file_write"` → {@link writeFile}
 *
 * @param request - The validated tool execution request from the LLM.
 * @param config - Execution configuration (projectRoot, outputLimit, timeout, etc.).
 * @param session - Optional {@link PermissionSession} for Tier 2 session memory.
 * @param autoApprove - Whether the `--yes` flag is active (auto-approves Tier 2).
 * @returns A {@link ToolResult} with the execution outcome.
 */
export async function executeTool(
  request: ToolExecutionRequest,
  config: ExecutorConfig,
  session?: PermissionSession,
  autoApprove?: boolean,
): Promise<ToolResult> {
  const { action_type, command, user_facing_explanation } = request;
  const {
    projectRoot,
    outputLimit = DEFAULT_OUTPUT_LIMIT,
    timeout = DEFAULT_TIMEOUT,
    sessionDir,
  } = config;

  // MED-001: Canonicalize projectRoot once at entry
  const root = realpathSync(resolve(projectRoot));

  // 1. Sanitize the command (strip terminal escapes, control chars)
  const safeCommand = sanitizeTerminalString(command);

  // 2. Re-classify independently — never trust the request's action_type (REQ-8)
  // For file operations (read/write), skip shell classification — they are
  // confined to the project directory by path confinement checks elsewhere.
  progress.update({ phase: "thinking" });
  const isFileOperation = action_type === "file_read" || action_type === "file_write";
  const verdict = isFileOperation
    ? { tier: TrustTier.Tier0, blocked: null, reasons: ["File operation — Tier 0 (path-confined)."] }
    : classifyCommand(safeCommand, action_type, user_facing_explanation);

  // 3. Blocked check (REQ-9): unconditionally blocked commands
  if (verdict.blocked) {
    // Log the denial event (best-effort) — fail closed: skip if missing id
    if (sessionDir && config.sessionId) {
      try {
        await appendEvent(sessionDir, {
          schema_version: "0.2.0",
          event_id: generateSessionId(),
          session_id: config.sessionId,
          parent_session_id: config.parentSessionId ?? null,
          timestamp: new Date().toISOString(),
          agent_role: "executor",
          model_id: config.modelId ?? "",
          prompt_tokens: 0,
          completion_tokens: 0,
          cache_hit: false,
          action: "blocked",
          hitl_tier: verdict.tier,
          hitl_command: safeCommand,
          hitl_reasons: verdict.reasons,
          blocked_reason: verdict.blocked.reason,
        });
      } catch {
        // Best-effort logging
      }
    } else if (sessionDir) {
      logger.warn("[zao] Cannot log executor event: missing sessionId");
    }

    return {
      success: false,
      action: mapActionType(action_type),
      error: `${verdict.blocked.reason}: ${verdict.blocked.details}`,
    };
  }

  // 4. HITL gate — prompt for permission (unless Tier 0 auto-approve)
  progress.update({ phase: "waiting" });

  // TD-025: Compute unified diff for file_write before HITL prompt.
  // diff is `string` (computed diff), `null` (new file or identical),
  // or `undefined` (not a file_write — diff not computed at all).
  // The undefined vs null distinction matters: `undefined` means "don't
  // show a diff section", `null` means "show that it's a new file."
  let diff: string | null | undefined;
  if (action_type === "file_write" && request.content !== undefined) {
    // Run path confinement FIRST before reading for the diff.
    // Use realpathSync to resolve symlinks and verify the resolved
    // target is within the project root. If the path escapes the root
    // (symlink attack), skip the diff rather than leaking file content.
    try {
      const absolutePath = isAbsolute(safeCommand)
        ? safeCommand
        : resolve(root, safeCommand);
      const resolvedFile = realpathSync(absolutePath);
      if (!isPathWithinRoot(resolvedFile, root)) {
        diff = null; // path escapes project root — skip diff
      } else {
        const file = Bun.file(resolvedFile);
        const exists = await file.exists();
        if (!exists) {
          diff = null; // new file — no diff
        } else {
          const oldContent = await file.text();
          // Skip diff for files > 1MB
          if (oldContent.length <= 1_000_000) {
            diff = computeUnifiedDiff(oldContent, request.content, safeCommand, 2000);
          }
        }
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "ENOENT") {
        diff = null; // file doesn't exist — new file, no diff
      } else {
        diff = null; // can't resolve path — skip diff
      }
    }
  }

  const effectiveSession = session ?? new PermissionSession();
  const hitlResult = await promptForPermission({
    actionType: action_type,
    command: safeCommand,
    explanation: user_facing_explanation,
    verdict,
    session: effectiveSession,
    autoYes: autoApprove ?? false,
    sessionDir,
    sessionId: config.sessionId,
    parentSessionId: config.parentSessionId,
    modelId: config.modelId,
    format: config.format,
    stepInfo: config.stepInfo,
    diff,
  });

  // 5. If denied (or chat/modify — currently only approve proceeds)
  if (hitlResult.response !== HITLResponse.Approve) {
    return {
      success: false,
      action: mapActionType(action_type),
      error:
        hitlResult.response === HITLResponse.Deny
          ? "Denied by user"
          : `Action not executed (user responded: ${hitlResult.response})`,
    };
  }

  // 6. Dispatch to the appropriate operation
  let result: ToolResult;

  if (action_type === "shell") {
    result = await executeShell(safeCommand, root, timeout, outputLimit);
  } else if (action_type === "file_read") {
    result = await readFile(safeCommand, root);
  } else if (action_type === "file_write") {
    // REQ-2: file_write is now supported via executeTool.
    // Content is passed as an optional field on ToolExecutionRequest
    // (validated by Zod when present, added to schema for C1/M5 fixes).
    const writeContent = request.content;
    if (writeContent === undefined) {
      result = {
        success: false,
        action: "write_file",
        error: "file_write requires 'content' in the tool execution request",
      };
    } else {
      result = await writeFile(safeCommand, writeContent, root);
    }
  } else {
    result = {
      success: false,
      action: mapActionType(action_type),
      // LOW-002: Include raw action_type in error for debugging
      error: `Unknown action type: ${action_type}`,
    };
  }

  progress.update({ phase: "writing" });

  // 7. Log the execution event (best-effort) — fail closed
  if (sessionDir && config.sessionId) {
    try {
      await appendEvent(sessionDir, {
        schema_version: "0.2.0",
        event_id: generateSessionId(),
        session_id: config.sessionId,
        parent_session_id: config.parentSessionId ?? null,
        timestamp: new Date().toISOString(),
        agent_role: "executor",
        model_id: config.modelId ?? "",
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_hit: false,
        action: `tool_${action_type}`,
        tool_result_success: result.success,
        tool_command: safeCommand,
        tool_error: result.error ?? null,
        tool_exit_code: result.exitCode ?? null,
      });
    } catch {
      // Best-effort logging
    }
  } else if (sessionDir) {
    logger.warn("[zao] Cannot log executor event: missing sessionId");
  }

  return result;
}

// ── Internal Helpers ────────────────────────────────────────────────

/**
 * Maps a `ToolExecutionRequest` action_type string to the
 * {@link ToolResult} action discriminant.
 *
 * Unknown action types fall back to `"shell"`.
 *
 * @param actionType - The raw action_type from the request.
 * @returns A valid {@link ToolResult.action} value.
 */
function mapActionType(actionType: string): ToolResult["action"] {
  switch (actionType) {
    case "shell":
      return "shell";
    case "file_read":
      return "read_file";
    case "file_write":
      return "write_file";
    default:
      return "shell";
  }
}
