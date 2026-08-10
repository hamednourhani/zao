/**
 * Escalation — timeout and security violation user interface.
 *
 * ## REQ-5: No Stuck States — Timeout and Escalation
 *
 * mo must never hang or loop forever without escalating to the user.
 * This module provides the escalation UI for:
 * - **Timeouts**: step or loop timeout exceeded
 * - **Security violations**: path out of scope or tool not allowed
 * - **Loop exceeded**: max iterations exhausted (plumbing for future use)
 *
 * ## Design
 *
 * v1: simple CLI prompts using `node:readline`, following the same
 * box-drawing pattern as `human-gate.ts` and `cli.ts`. No TUI dependency.
 * The "view full log" option prints event details and re-prompts.
 *
 * ## Testability
 *
 * The stdin-based {@link promptEscalation} is hard to test directly.
 * Instead, export:
 * - {@link EscalationCallback} — the function signature contract
 * - {@link createMockEscalation} — a factory that returns a mock
 *   callback with configurable responses and a `.calls` audit trail
 * - Render functions accept an optional `out` target for output capture
 *
 * Tests import the mock factory and verify the callback contract
 * without touching stdin.
 *
 * @module escalation
 */

import { createInterface } from "node:readline";
import { stdout } from "node:process";

// ── Types ────────────────────────────────────────────────────────────

/** Type of escalation being presented to the user. */
export const EscalationTypes = {
  Timeout: "timeout",
  SecurityViolation: "security_violation",
  LoopExceeded: "loop_exceeded",
} as const;

export type EscalationType = (typeof EscalationTypes)[keyof typeof EscalationTypes];

/** A single logged event shown in the escalation UI. */
export interface EventRecord {
  /** ISO-8601 timestamp of the event. */
  timestamp: string;
  /** The action/tool name (e.g. "readFile", "executeShell"). */
  action: string;
  /** Human-readable details (e.g. file path, shell command). */
  details: string;
  /** The outcome of the event. */
  status: "success" | "failed" | "pending";
}

/** A request to escalate to the user (timeout, security violation, etc.). */
export interface EscalationRequest {
  /** The type of escalation. */
  type: EscalationType;
  /** Human-readable reason or violation type. */
  reason: string;
  /** The last N events before the escalation was triggered. */
  events: EventRecord[];
  /** The execution ID for log correlation. */
  executionId: string;
  /** The step ID that was executing (if applicable). */
  stepId?: string;
  /** For security violations: what the LLM attempted (e.g. 'readFile("../../../etc/passwd")'). */
  attemptedAction?: string;
  /** For security violations: the resolved absolute path. */
  resolvedPath?: string;
  /** For security violations: the project root directory. */
  projectRoot?: string;
}

/** The user's response to an escalation prompt. */
export interface EscalationResponse {
  /** The action the user chose. */
  action: "continue" | "abort" | "view_log";
}

/**
 * Signature for an escalation callback.
 *
 * The controller (execution-runner) calls this when a timeout or
 * security violation occurs. In production, this is
 * {@link escalateToUser} (stdin-based CLI prompt). In tests,
 * this is {@link createMockEscalation} (pre-configured responses).
 */
export type EscalationCallback = (
  request: EscalationRequest,
) => Promise<EscalationResponse>;

// ── Output Target Interface ──────────────────────────────────────────

/**
 * Minimal writable interface for render output capture.
 * `process.stdout` and test buffers both satisfy this.
 */
interface OutputTarget {
  write(s: string): void;
}

// ── Mock Factory ─────────────────────────────────────────────────────

/**
 * Mock escalation callback with an exposed {@link calls} audit trail.
 *
 * Resolves each call with the next configured {@link EscalationResponse}.
 * Defaults to `{ action: "abort" }` (fail safe) when exhausted.
 * Each call to the factory creates an isolated instance.
 *
 * @param responses - Pre-configured responses in call order.
 * @returns A mock escalation callback with a `.calls` property.
 *
 * @example
 * ```typescript
 * const mock = createMockEscalation([{ action: "continue" }]);
 * const result = await mock({ type: "timeout", reason: "r", events: [], executionId: "e1" });
 * expect(result.action).toBe("continue");
 * expect(mock.calls.length).toBe(1);
 * ```
 */
export function createMockEscalation(
  responses: ReadonlyArray<EscalationResponse>,
): EscalationCallback & { calls: EscalationRequest[] } {
  let index = 0;
  const calls: EscalationRequest[] = [];

  const fn = async (
    request: EscalationRequest,
  ): Promise<EscalationResponse> => {
    calls.push(request);
    const response = responses[index];
    index++;

    // Fail safe: when no more configured responses, default to abort.
    return response ?? { action: "abort" };
  };

  return Object.assign(fn, { calls });
}

// ── Box Drawing Helpers ──────────────────────────────────────────────

/**
 * Box-drawing characters for the escalation prompt.
 * Same style as `human-gate.ts`.
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
  DOUBLE_HORIZONTAL: "═",
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
function boxLine(content: string, out: OutputTarget = stdout): void {
  out.write(`${BOX.VERTICAL} ${content} ${BOX.VERTICAL}\n`);
}

/**
 * Writes a horizontal separator line.
 */
function boxSeparator(out: OutputTarget = stdout): void {
  out.write(
    `${BOX.TEE_LEFT}${BOX.HORIZONTAL.repeat(INNER_WIDTH + 2)}${BOX.TEE_RIGHT}\n`,
  );
}

/**
 * Writes a full-width horizontal line (top or bottom border).
 */
function boxBorder(top: boolean, out: OutputTarget = stdout): void {
  const left = top ? BOX.TOP_LEFT : BOX.BOTTOM_LEFT;
  const right = top ? BOX.TOP_RIGHT : BOX.BOTTOM_RIGHT;
  out.write(
    `${left}${BOX.HORIZONTAL.repeat(INNER_WIDTH + 2)}${right}\n`,
  );
}

/**
 * Writes a blank line inside the box.
 */
function boxBlank(out: OutputTarget = stdout): void {
  out.write(`${BOX.VERTICAL}${" ".repeat(INNER_WIDTH + 2)}${BOX.VERTICAL}\n`);
}

// ── Event Formatting Helpers ──────────────────────────────────────────

/**
 * Formats an ISO-8601 timestamp to a `HH:MM:SS` string.
 */
function formatTime(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) {
      return "--:--:--";
    }
    return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "--:--:--";
  }
}

/**
 * Formats a single event for display in the events list.
 */
function formatEvent(event: EventRecord, index: number): string {
  const time = formatTime(event.timestamp);
  const statusText =
    event.status === "success"
      ? "success"
      : event.status === "failed"
        ? "failed"
        : "(no response)";
  return `  ${index}. [${time}] ${event.action} ${event.details} \u2192 ${statusText}`;
}

/**
 * Formats a single event for the "full log" view (JSON style).
 */
function formatEventFull(event: EventRecord, index: number): string {
  const time = formatTime(event.timestamp);
  let result = `  Event #${index + 1}:\n`;
  result += `    Timestamp: ${event.timestamp}\n`;
  result += `    Local:     ${time}\n`;
  result += `    Action:    ${event.action}\n`;
  result += `    Details:   ${event.details}\n`;
  result += `    Status:    ${event.status}\n`;
  return result;
}

// ── Render Functions ──────────────────────────────────────────────────

/**
 * Renders the timeout escalation prompt box.
 *
 * Displays the escalation header, reason, last events summary,
 * and user options.
 *
 * @param request - The escalation request.
 * @param out - Optional output target (defaults to `process.stdout`).
 */
export function renderTimeoutEscalation(
  request: EscalationRequest,
  out: OutputTarget = stdout,
): void {
  out.write("\n");
  boxBorder(true, out);
  boxLine("Execution Escalation".padEnd(INNER_WIDTH), out);
  boxSeparator(out);

  // Reason line
  boxLine(`Reason: ${padInline(request.reason, INNER_WIDTH - 8)}`, out);
  boxBlank(out);

  // Explanation
  boxLine("The LLM may be stuck. Last 3 events:".padEnd(INNER_WIDTH), out);

  // Events (up to last 3)
  const lastEvents = request.events.slice(-3);
  if (lastEvents.length > 0) {
    for (let i = 0; i < lastEvents.length; i++) {
      const event = lastEvents[i]!;
      const eventLine = formatEvent(event, i + 1);
      boxLine(padInline(eventLine, INNER_WIDTH), out);
    }
  } else {
    boxLine("  (no events recorded)".padEnd(INNER_WIDTH), out);
  }

  boxBlank(out);
  boxLine("[c]ontinue  [a]bort  [v]iew full log".padEnd(INNER_WIDTH), out);
  boxBorder(false, out);
}

/**
 * Renders the security violation escalation prompt box.
 *
 * Displays the security violation header, type, attempted action details,
 * and user options. No "continue" option for security violations.
 *
 * @param request - The escalation request.
 * @param out - Optional output target (defaults to `process.stdout`).
 */
export function renderSecurityViolation(
  request: EscalationRequest,
  out: OutputTarget = stdout,
): void {
  out.write("\n");
  boxBorder(true, out);
  boxLine("SECURITY VIOLATION \u2014 BANNED ACTION".padEnd(INNER_WIDTH), out);
  boxSeparator(out);

  // Violation type
  boxLine(`Type: ${padInline(request.reason, INNER_WIDTH - 6)}`, out);
  boxBlank(out);

  // Attempted action details
  if (request.attemptedAction) {
    boxLine(
      `LLM attempted: ${padInline(request.attemptedAction, INNER_WIDTH - 15)}`,
      out,
    );
  } else if (request.events.length > 0) {
    const evt = request.events[0]!;
    const attempted = `${evt.action}(${evt.details})`;
    boxLine(
      `LLM attempted: ${padInline(attempted, INNER_WIDTH - 15)}`,
      out,
    );
  }

  // Resolved path (path out of scope violations)
  if (request.resolvedPath) {
    boxLine(
      `Resolved to: ${padInline(request.resolvedPath, INNER_WIDTH - 13)}`,
      out,
    );
  }

  // Project root
  if (request.projectRoot) {
    boxLine(
      `Project root: ${padInline(request.projectRoot, INNER_WIDTH - 14)}`,
      out,
    );
  }

  boxBlank(out);
  boxLine("This is a BANNED action. Execution stopped.".padEnd(INNER_WIDTH), out);
  boxBlank(out);
  boxLine("[v]iew full log  [a]bort".padEnd(INNER_WIDTH), out);
  boxBorder(false, out);
}

// ── Interactive Prompt ───────────────────────────────────────────────

/**
 * Internal: reads a single line from stdin and dispatches the user
 * response.
 *
 * Recursive: on "v" (view full log) or invalid input, calls itself
 * after displaying the relevant information.
 *
 * @param request - The escalation request (for full log display).
 * @returns The user's decision.
 */
async function promptForDecision(
  request: EscalationRequest,
): Promise<EscalationResponse> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question("Choice: ", (input: string) => {
        resolve(input.trim());
      });
    });

    switch (answer.toLowerCase()) {
      case "c":
      case "continue":
        // Security violations never offer "continue" — the UI only
        // shows [v]iew and [a]bort. If this path is reached (e.g.,
        // future UI changes), treat as an invalid choice.
        if (request.type === EscalationTypes.SecurityViolation) {
          stdout.write("Continue is not available for security violations. Please choose a or v.\n");
          return promptForDecision(request);
        }
        return { action: "continue" };

      case "a":
      case "abort":
        return { action: "abort" };

      case "v":
      case "view":
      case "view_log":
        // Print full event details
        stdout.write("\n--- Full Event Log ---\n");
        if (request.events.length > 0) {
          for (let i = 0; i < request.events.length; i++) {
            const event = request.events[i]!;
            stdout.write(formatEventFull(event, i));
          }
        } else {
          stdout.write("  (no events)\n");
        }
        stdout.write(`\nExecution ID: ${request.executionId}\n`);
        if (request.stepId) {
          stdout.write(`Step ID:      ${request.stepId}\n`);
        }
        if (request.attemptedAction) {
          stdout.write(`Attempted:    ${request.attemptedAction}\n`);
        }
        if (request.resolvedPath) {
          stdout.write(`Resolved:     ${request.resolvedPath}\n`);
        }
        if (request.projectRoot) {
          stdout.write(`Project Root: ${request.projectRoot}\n`);
        }
        stdout.write("---\n\n");
        return promptForDecision(request);

      default:
        stdout.write(`Invalid option "${answer}". Please choose c, a, or v.\n`);
        return promptForDecision(request);
    }
  } finally {
    rl.close();
  }
}

/**
 * Prompts the user for a decision after an escalation event.
 *
 * Writes "Escalation: " prefix before reading input. This is the
 * interactive portion called by {@link escalateToUser} after rendering.
 *
 * @param request - The escalation request.
 * @returns The user's decision.
 */
export async function promptEscalation(
  request: EscalationRequest,
): Promise<EscalationResponse> {
  // Write a short prompt prefix before reading
  stdout.write("Escalation: ");
  return promptForDecision(request);
}

/**
 * Full escalation flow: renders the appropriate UI based on request
 * type, then prompts the user for a decision. Continues to re-prompt
 * until a conclusive response (continue or abort) is received.
 *
 * @param request - The escalation request.
 * @returns The user's final decision.
 */
export async function escalateToUser(
  request: EscalationRequest,
): Promise<EscalationResponse> {
  // Render the appropriate UI
  if (request.type === EscalationTypes.SecurityViolation) {
    renderSecurityViolation(request);
  } else {
    renderTimeoutEscalation(request);
  }

  // Prompt for user decision.
  // promptEscalation handles view_log internally via recursive promptForDecision,
  // so a "view_log" response should never reach the caller.
  const response = await promptEscalation(request);

  return response;
}
