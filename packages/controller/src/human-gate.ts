/**
 * Human Gate — interactive approval for destructive tool actions.
 *
 * ## REQ-3: Human Gate for Destructive Actions
 *
 * When the LLM wants to call `writeFile` or `executeShell`, the
 * controller pauses and asks the human for approval. The human sees
 * the tool, args, and LLM's reason, then approves or rejects.
 *
 * ## Design
 *
 * v1: simple CLI prompts using `node:readline`, following the same
 * pattern as {@link promptLoopClose} in `cli.ts`. No TUI dependency.
 * The "modify" option is a v2 placeholder (same as reject for now).
 *
 * ## Testability
 *
 * The stdin-based {@link requestToolApproval} is hard to test directly.
 * Instead, export:
 * - {@link ToolApprovalCallback} — the function signature contract
 * - {@link createMockToolApproval} — a factory that returns a mock
 *   callback with configurable responses and a `.calls` audit trail
 *
 * Tests import the mock factory and verify the callback contract
 * without touching stdin.
 *
 * @module human-gate
 */

import { createInterface } from "node:readline";
import { stdout } from "node:process";

// ── Types ────────────────────────────────────────────────────────────

/** A request from the LLM to execute a tool that requires human approval. */
export interface ToolApprovalRequest {
  /** The tool being requested. */
  tool: "readFile" | "writeFile" | "executeShell";
  /** Tool arguments (path, content, command, etc.). */
  args: Record<string, unknown>;
  /** The LLM's stated reason for making this tool call. */
  reason: string;
  /** The step ID within the flow that triggered this request. */
  stepId: string;
  /** The harness session ID for audit correlation. */
  sessionId: string;
}

/** The human's response to a tool approval request. */
export interface ToolApprovalResponse {
  /** The human's decision. */
  decision: "approve" | "reject" | "modify";
  /** Modified arguments (only used with `decision: "modify"`). */
  modifiedArgs?: Record<string, unknown>;
  /** Optional human-readable feedback (shown to LLM on rejection). */
  feedback?: string;
}

/**
 * Signature for a tool approval callback.
 *
 * The controller (execution-runner) calls this before executing any
 * tool that has `requires_approval: true`. In production, this is
 * {@link requestToolApproval} (stdin-based CLI prompt). In tests,
 * this is {@link createMockToolApproval} (pre-configured responses).
 */
export type ToolApprovalCallback = (
  request: ToolApprovalRequest,
) => Promise<ToolApprovalResponse>;

// ── Mock Factory ─────────────────────────────────────────────────────

/**
 * Mock approval callback with an exposed {@link calls} audit trail.
 *
 * Resolves each call with the next configured {@link ToolApprovalResponse}.
 * Defaults to `{ decision: "reject" }` (fail safe) when exhausted.
 * Each call to the factory creates an isolated instance.
 *
 * @param responses - Pre-configured responses in call order.
 * @returns A mock approval callback with a `.calls` property.
 *
 * @example
 * ```typescript
 * const mock = createMockToolApproval([{ decision: "approve" }]);
 * const result = await mock({ tool: "writeFile", args: {}, reason: "r", stepId: "s1", sessionId: "ss1" });
 * expect(result.decision).toBe("approve");
 * expect(mock.calls.length).toBe(1);
 * ```
 */
export function createMockToolApproval(
  responses: ReadonlyArray<ToolApprovalResponse>,
): ToolApprovalCallback & { calls: ToolApprovalRequest[] } {
  let index = 0;
  const calls: ToolApprovalRequest[] = [];

  const fn = async (
    request: ToolApprovalRequest,
  ): Promise<ToolApprovalResponse> => {
    calls.push(request);
    const response = responses[index];
    index++;

    // Fail safe: when no more configured responses, default to reject.
    return response ?? { decision: "reject" };
  };

  return Object.assign(fn, { calls });
}

// ── CLI Prompt ───────────────────────────────────────────────────────

/**
 * Box-drawing characters for the approval prompt.
 */
const BOX = {
  TOP_LEFT: "┌",
  TOP_RIGHT: "┐",
  BOTTOM_LEFT: "└",
  BOTTOM_RIGHT: "┘",
  HORIZONTAL: "─",
  VERTICAL: "│",
  TEE_LEFT: "├",
  TEE_RIGHT: "┤",
} as const;

const BOX_WIDTH = 61;
const INNER_WIDTH = BOX_WIDTH - 4; // space for "│ " + " │"

/**
 * Pads a string to the exact column width, appending spaces if
 * shorter or truncating with "…" if longer.
 */
function padInline(text: string, width: number): string {
  if (text.length > width) {
    return text.slice(0, width - 1) + "…";
  }
  return text.padEnd(width);
}

/**
 * Writes a box line with the given content (pre-padded).
 */
function boxLine(content: string): void {
  stdout.write(`${BOX.VERTICAL} ${content} ${BOX.VERTICAL}\n`);
}

/**
 * Writes a horizontal separator line.
 */
function boxSeparator(): void {
  stdout.write(`${BOX.TEE_LEFT}${BOX.HORIZONTAL.repeat(INNER_WIDTH + 2)}${BOX.TEE_RIGHT}\n`);
}

/**
 * Writes a full-width horizontal line (top or bottom).
 */
function boxBorder(top: boolean): void {
  const left = top ? BOX.TOP_LEFT : BOX.BOTTOM_LEFT;
  const right = top ? BOX.TOP_RIGHT : BOX.BOTTOM_RIGHT;
  stdout.write(`${left}${BOX.HORIZONTAL.repeat(INNER_WIDTH + 2)}${right}\n`);
}

/**
 * Renders the tool approval prompt box and reads the human's decision.
 *
 * Follows the same `readline` pattern as {@link promptLoopClose} in
 * `cli.ts`. Displays the tool name, relevant args (path/command), the
 * LLM's reason, and three options: approve, reject, view details.
 *
 * On "view", prints the full args JSON and re-prompts. On invalid
 * input, prints an error and re-prompts. Recursive until valid.
 *
 * @param request - The tool approval request from the LLM.
 * @returns The human's decision.
 */
export async function requestToolApproval(
  request: ToolApprovalRequest,
): Promise<ToolApprovalResponse> {
  stdout.write("\n");
  boxBorder(true);
  boxLine("Tool Approval Required".padEnd(INNER_WIDTH));
  boxSeparator();

  // Tool name
  boxLine(`Tool: ${padInline(request.tool, INNER_WIDTH - 6)}`);

  // Tool-specific details
  if (request.tool === "writeFile") {
    const path = typeof request.args.path === "string" ? request.args.path : "(unknown)";
    boxLine(`Path: ${padInline(path, INNER_WIDTH - 6)}`);
    boxLine("");
    boxLine("The LLM wants to overwrite this file.".padEnd(INNER_WIDTH));
  } else if (request.tool === "executeShell") {
    const cmd = typeof request.args.command === "string" ? request.args.command : "(unknown)";
    boxLine(`Command: ${padInline(cmd, INNER_WIDTH - 9)}`);
    boxLine("");
    boxLine("The LLM wants to run this shell command.".padEnd(INNER_WIDTH));
  } else {
    // readFile
    const path = typeof request.args.path === "string" ? request.args.path : "(unknown)";
    boxLine(`Path: ${padInline(path, INNER_WIDTH - 6)}`);
  }

  // Reason (truncated) — sanitize ANSI escape codes from LLM output.
  // L2 fix: expanded regex to handle all CSI sequences, not just SGR codes.
  // The pattern /\x1b\[[0-9;?]*[A-Za-z]/g covers cursor movement (A-H),
  // erase (J, K), mode changes (h, l), and all SGR codes (m).
  const sanitizedReason = request.reason.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const reasonLine = `Reason: ${sanitizedReason}`;
  if (reasonLine.length > INNER_WIDTH) {
    boxLine(`Reason: ${padInline(sanitizedReason, INNER_WIDTH - 8)}`);
  } else {
    boxLine(reasonLine.padEnd(INNER_WIDTH));
  }

  boxLine("");
  boxLine("[a]pprove  [r]eject  [v]iew details".padEnd(INNER_WIDTH));
  boxBorder(false);

  return promptForDecision(request);
}

/**
 * Internal: reads a single line from stdin and dispatches the decision.
 *
 * Recursive: on "v" (view) or invalid input, calls itself after
 * displaying the relevant information.
 */
async function promptForDecision(
  request: ToolApprovalRequest,
): Promise<ToolApprovalResponse> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question("Decision: ", (input: string) => {
        resolve(input.trim());
      });
    });

    switch (answer.toLowerCase()) {
      case "a":
      case "approve":
        return { decision: "approve" };

      case "r":
      case "reject":
        return { decision: "reject" };

      case "m":
      case "modify":
        // v1 limitation: user modifications are not yet implemented.
        // The "modify" option will be fully supported in v2 (R-004).
        // Until then, reject the tool call explicitly so the caller
        // knows the modification was seen but cannot be applied.
        return {
          decision: "reject",
          feedback: "Modify is not yet implemented — rejecting this tool call. You may re-submit with modified arguments manually.",
        };

      case "v":
      case "view":
        stdout.write("\n--- Full Tool Arguments ---\n");
        stdout.write(JSON.stringify(request.args, null, 2) + "\n");
        stdout.write("---\n\n");
        return promptForDecision(request);

      default:
        stdout.write(`Invalid option "${answer}". Please choose a, r, or v.\n`);
        return promptForDecision(request);
    }
  } finally {
    rl.close();
  }
}
