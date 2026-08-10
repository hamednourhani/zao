/**
 * @clack/prompts wrapper for mo's HITL permission prompt.
 *
 * Replaces the raw stdin `Bun.prompt()` interaction in `hitl.ts`'s Tier 1
 * interactive path with a color-coded, arrow-key-navigable prompt when
 * stderr/stdin are TTYs. Falls back to the existing raw-stdin path when
 * TTY is not available (CI, piped input).
 *
 * ## TTY Guard
 *
 * `@clack/prompts` uses ANSI escape sequences and arrow-key navigation,
 * which hang on non-TTY stdin. We detect TTY via `process.stdin.isTTY`
 * and `process.stdout.isTTY`; if either is false, the caller falls back
 * to the raw stdin path.
 *
 * ## Progress Coordination
 *
 * Before showing the prompt, `progress.pause()` is called to clear the
 * progress line. After the prompt resolves, `progress.resume()` rewrites
 * the progress line.
 *
 * @module clack-hitl
 */

import * as p from "@clack/prompts";
import type { ClassificationVerdict } from "./command-guard.ts";
import { renderDiffForTerminal } from "./diff-renderer.ts";

/** Result of the @clack/prompts HITL interaction. */
export interface ClackResult {
  response: "approve" | "deny" | "modify" | "chat";
  modifiedCommand?: string;
}

/**
 * Checks whether `@clack/prompts` can be used in the current environment.
 *
 * Returns `true` only when both stdin and stdout are TTYs — the minimum
 * requirement for arrow-key navigation to work.
 */
export function isClackAvailable(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

/**
 * Displays the HITL permission prompt using `@clack/prompts`.
 *
 * Callers MUST check {@link isClackAvailable} before calling this function.
 *
 * @param command - The sanitized command to display.
 * @param explanation - The model's explanation for the action.
 * @param verdict - The pre-computed classification verdict.
 * @returns A {@link ClackResult} with the user's decision.
 */
export async function showClackPrompt(
  command: string,
  explanation: string,
  verdict: ClassificationVerdict,
  diff?: string | null,
): Promise<ClackResult> {
  // Display command and explanation.
  // NOTE: tier-based color theming (red for hard-deny, yellow for Tier 2)
  // is deferred to post-MVP. The emoji labels (✅❌✏️💬) are functional.
  p.note(command, "Command to execute");

  // TD-025: Show diff for file_write actions
  if (diff && diff !== null) {
    const rendered = renderDiffForTerminal(diff, 50);
    p.note(rendered, "Proposed changes (diff)");
  }

  if (verdict.reasons.length > 0) {
    p.note(verdict.reasons.join("\n"), "Why this needs approval");
  }

  if (explanation) {
    p.note(`Model's reasoning: ${explanation}`);
  }

  const choice = await p.select({
    message: "Approve this action?",
    options: [
      { value: "approve", label: "✅ Approve — run the command" },
      { value: "deny", label: "❌ Deny — skip this action" },
      { value: "modify", label: "✏️  Modify — edit the command first" },
      { value: "chat", label: "💬 Chat — discuss with the agent" },
    ],
  });

  // Handle cancel (Ctrl+C or Escape)
  if (p.isCancel(choice)) {
    return { response: "deny" };
  }

  if (choice === "modify") {
    const modified = await p.text({
      message: "Edit the command:",
      initialValue: command,
      validate(value) {
        if (!value || value.trim().length === 0) {
          return "Command cannot be empty";
        }
      },
    });

    if (p.isCancel(modified) || !modified) {
      return { response: "deny" };
    }

    return { response: "modify", modifiedCommand: modified };
  }

  return { response: choice as "approve" | "deny" | "chat" };
}
