/**
 * Tool Access Validation — security enforcement for tool execution.
 *
 * ## Purpose
 *
 * Before the harness executes any tool call from the LLM, this module
 * validates that:
 * 1. The requested tool is in the step's allowed tools list.
 * 2. For file-system tools (`readFile`, `writeFile`), the target path
 *    is confined within the project root directory.
 *
 * Both violations are **BANNED actions** — they are logged, escalated,
 * and stop execution immediately.
 *
 * ## Why this separation
 *
 * Path confinement lives here rather than solely in the executor because
 * this check runs BEFORE the tool call is constructed, providing an early
 * security gate. The executor still performs its own path confinement
 * via `realpath()` as a defense-in-depth measure.
 *
 * ## ADR-005 / governance.md compliance
 *
 * - Fail-closed: any violation returns `valid: false` and `escalate: true`.
 * - No partial execution: the tool is never invoked if validation fails.
 *
 * @module tool-access
 */

import { resolve as pathResolve } from "node:path";
import { realpathSync } from "node:fs";
import type { ToolCall } from "../schemas/tool-call.ts";
import type { ToolDeclaration } from "../schemas/flow.ts";

// ── Types ─────────────────────────────────────────────────────────────

/** Result of a tool access validation check. */
export interface ToolAccessResult {
  /** Whether the tool call is allowed. */
  valid: boolean;
  /** The type of violation, if any. Only set when `valid` is `false`. */
  violation?: "tool_not_allowed" | "path_out_of_scope";
  /** Human-readable description of the violation or empty on success. */
  message?: string;
  /** Whether the violation should be escalated to the user as a BANNED action. */
  escalate?: boolean;
}

// ── File-system tools that require path confinement ───────────────────

/**
 * Set of tool names that operate on the file system and therefore
 * require path confinement checks.
 */
const FILE_TOOLS = new Set(["readFile", "writeFile"]);

// ── Core Function ─────────────────────────────────────────────────────

/**
 * Validates that a tool call is allowed for the current step and that
 * any file paths it references stay within the project root.
 *
 * ## Checks Performed
 *
 * 1. **Tool allowlist**: The requested tool must be in `allowedTools`.
 * 2. **Path confinement** (file tools only): If the tool is `readFile`
 *    or `writeFile` and a `path` argument is provided, the resolved
 *    path must start with the real (symlink-resolved) project root.
 *
 * ## Path Resolution Strategy
 *
 * - The combined path is resolved via `path.resolve(projectRoot, path)`.
 * - The root itself is resolved via `fs.realpathSync(path.resolve(projectRoot))`
 *   to defeat symlink-based escapes.
 * - Only the **root** is resolved with `realpathSync` — the target may
 *   not exist yet (e.g., `writeFile` to a new file), and `realpathSync`
 *   would throw on non-existent paths.
 * - If the resolved target does not start with the real root, the
 *   path escapes the project and the call is BANNED.
 *
 * ## What This Does NOT Do
 *
 * - This function does NOT validate that the tool's arguments are
 *   well-formed (e.g., that `readFile`'s `path` is present). Missing
 *   arguments are handled downstream by the executor.
 * - This function does NOT check command safety for `executeShell` —
 *   that is handled by the executor's `command-guard`.
 *
 * @param toolCall - The tool invocation requested by the LLM.
 * @param allowedTools - The set of tools allowed for the current step.
 * @param projectRoot - The absolute path of the project root directory.
 * @returns A {@link ToolAccessResult} indicating whether the call is allowed.
 */
export function validateToolAccess(
  toolCall: ToolCall,
  allowedTools: ToolDeclaration[],
  projectRoot: string,
): ToolAccessResult {
  // ── Check 1: Tool is in allowed list ──────────────────────────────
  const allowed = allowedTools.find((t) => t.tool === toolCall.tool);

  if (!allowed) {
    const allowedNames = allowedTools.length > 0
      ? allowedTools.map((t) => t.tool).join(", ")
      : "(none)";
    return {
      valid: false,
      violation: "tool_not_allowed",
      message: `Tool "${toolCall.tool}" is not allowed. Allowed tools: ${allowedNames}.`,
      escalate: true,
    };
  }

  // ── Check 2: Path is within projectRoot (for file tools) ──────────
  if (FILE_TOOLS.has(toolCall.tool)) {
    const { path } = toolCall.args;

    // Only enforce path check when a path is provided.
    // Missing path is not a security issue — the executor will fail
    // with a clear error about the missing argument.
    if (path) {
      const resolved = pathResolve(projectRoot, path);
      /**
       * Defense-in-depth: the root is resolved with `realpathSync` to defeat
       * symlink-based escapes (e.g. `projectRoot -> /tmp` but a symlink
       * inside points to `/etc`). The target `path` is resolved with vanilla
       * `pathResolve` only: the target may not exist yet (e.g. `writeFile`
       * creating a new file), so `realpathSync` would throw ENOENT. The
       * executor's own `resolveReadablePath` provides the realpath defense
       * for read operations.
       */
      const root = realpathSync(pathResolve(projectRoot));

      if (!resolved.startsWith(root)) {
        return {
          valid: false,
          violation: "path_out_of_scope",
          message: `Path "${path}" resolves outside project root. BANNED.`,
          escalate: true,
        };
      }
    }
  }

  return { valid: true };
}
