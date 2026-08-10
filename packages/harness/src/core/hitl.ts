/**
 * Human-in-the-Loop (HITL) permission prompt system.
 *
 * Renders a formatted TUI permission prompt, waits for user input, and
 * logs every decision to the session's `events.jsonl` audit trail.
 *
 * ## UX Principles
 *
 * - **Raw command verbatim**: The command is displayed exactly as the model
 *   produced it, in a visually distinct section. It is never paraphrased.
 * - **Model's reasoning labeled**: The explanation is clearly marked as the
 *   model's *claim* — not a verified fact (GUARDRAILS Rule 4 / REQ-1).
 * - **Verdict reasons visible**: Users see WHY a command is Tier 1 (REQ-9).
 * - **Four responses**: Approve [Y], Deny [N], Modify [M], Chat [C] (REQ-2).
 *
 * ## Session Memory
 *
 * `PermissionSession` provides an in-memory session API for tracking
 * command-class approvals and request timestamps. Under the R-011 design,
 * Tier 1 commands always require human approval — the session memory
 * API (`approveTier2`, `isTier2Approved`, `recordTimestamp`,
 * `shouldReescalate`) is available for callers but not wired into the
 * default `promptForPermission` flow.
 *
 * @module hitl
 */

import type { ClassificationVerdict } from "./command-guard.ts";
import { sanitizeTerminalString, TrustTier } from "./command-guard.ts";
import { appendEvent } from "./artifacts.ts";
import { generateSessionId } from "./ids.ts";
import { isClackAvailable, showClackPrompt } from "./clack-hitl.ts";
import { progress } from "./progress.ts";
import { logger } from "./logger.ts";

// ── HITL Response Enum ─────────────────────────────────────────────

/** The four possible user responses to a permission prompt. */
export enum HITLResponse {
  Approve = "approve",
  Deny = "deny",
  Modify = "modify",
  Chat = "chat",
}

// ── Permission Session ─────────────────────────────────────────────

/**
 * In-memory session that tracks command-class approvals and request
 * timestamps. Available for callers that need per-session command memory.
 *
 * Under the R-011 design, the default `promptForPermission` flow does NOT
 * consult session memory — Tier 1 commands always prompt. The methods
 * below are maintained as public API for external consumers that may
 * integrate session memory into custom approval flows.
 *
 * ## Re-escalation (Friction Re-escalation)
 *
 * If the same command class is requested more than 3 times within
 * 60 seconds, `shouldReescalate()` returns `true`. Callers can use
 * this to force a re-prompt and prevent rubber-stamping fatigue.
 */
export class PermissionSession {
  /** Set of command classes approved at Tier 2 for this session. */
  private approvedClasses: Set<string> = new Set();

  /** Timestamps (ms since epoch) of requests per command class. */
  private requestTimestamps: Map<string, number[]> = new Map();

  /** Maximum Tier 2 auto-approvals within the re-escalation window before
   *  forcing a re-prompt. Triggers when count > this limit. */
  private readonly REESCALATION_LIMIT = 3;

  /** Re-escalation time window in milliseconds (60 seconds). */
  private readonly REESCALATION_WINDOW_MS = 60_000;

  /**
   * Records a Tier 2 approval for the given command class.
   *
   * Note: does NOT record a separate timestamp for re-escalation;
   * that is handled by {@link recordTimestamp} called independently
   * at the top of {@link promptForPermission}.
   *
   * @param commandClass - The command class label (e.g., "npm", "git").
   */
  approveTier2(commandClass: string): void {
    this.approvedClasses.add(commandClass);
  }

  /**
   * Checks whether a command class has been approved at Tier 2 this session.
   *
   * @param commandClass - The command class label.
   * @returns `true` if previously approved.
   */
  isTier2Approved(commandClass: string): boolean {
    return this.approvedClasses.has(commandClass);
  }

  /**
   * Checks whether re-escalation should trigger for a command class.
   *
   * Re-escalation fires when the same class has been requested >3 times
   * within the last 60 seconds.
   *
   * @param commandClass - The command class label.
   * @returns `true` if the user should be re-prompted.
   */
  shouldReescalate(commandClass: string): boolean {
    const timestamps = this.requestTimestamps.get(commandClass);
    if (!timestamps || timestamps.length < this.REESCALATION_LIMIT) {
      return false;
    }

    const now = Date.now();
    const windowStart = now - this.REESCALATION_WINDOW_MS;

    // Count requests within the window
    const recentCount = timestamps.filter((ts) => ts >= windowStart).length;

    return recentCount > this.REESCALATION_LIMIT;
  }

  /**
   * Prunes request timestamps older than the re-escalation window.
   *
   * @param commandClass - The command class label.
   */
  private pruneTimestamps(commandClass: string): void {
    const timestamps = this.requestTimestamps.get(commandClass);
    if (!timestamps) return;

    const now = Date.now();
    const windowStart = now - this.REESCALATION_WINDOW_MS;
    const pruned = timestamps.filter((ts) => ts >= windowStart);
    this.requestTimestamps.set(commandClass, pruned);
  }

  /**
   * Records a request timestamp for re-escalation tracking without
   * granting Tier 2 approval. Use this for tracking requests that
   * are still pending user input.
   *
   * @param commandClass - The command class label.
   */
  recordTimestamp(commandClass: string): void {
    const timestamps = this.requestTimestamps.get(commandClass);
    if (timestamps) {
      timestamps.push(Date.now());
    } else {
      this.requestTimestamps.set(commandClass, [Date.now()]);
    }
    this.pruneTimestamps(commandClass);
  }

  /**
   * Resets the session state. Intended for testing and session teardown.
   */
  reset(): void {
    this.approvedClasses.clear();
    this.requestTimestamps.clear();
  }
}

// ── HITL Context ───────────────────────────────────────────────────

/** Input parameters for the HITL permission prompt. */
export interface HITLContext {
  /** The action type (e.g., "shell", "file_write"). */
  actionType: string;
  /** The raw command (sanitized before display). */
  command: string;
  /** The model's explanation (labeled as DATA, never instructions). */
  explanation: string;
  /** Pre-computed classification verdict. */
  verdict: ClassificationVerdict;
  /** Session tracker for Tier 2 memory and re-escalation.
   * Reserved for future use — not consulted by the default promptForPermission
   * flow which always prompts for Tier 1. Callers create and pass a session
   * for forward compatibility. */
  session: PermissionSession;
  /** Whether the `--yes` flag is active.
   * Reserved for future use — not read by promptForPermission because
   * Tier 1 commands always require human approval per the R-011 design
   * decision. Passed by callers for forward compatibility. */
  autoYes: boolean;
  /** Optional session directory for event logging. */
  sessionDir?: string;
  /** UUIDv7 session identifier for v0.2.0 event envelope. */
  sessionId?: string;
  /** UUIDv7 parent session identifier for v0.2.0 event envelope. */
  parentSessionId?: string | null;
  /** The owning session's model_id for HITL events (v0.3.0). */
  modelId?: string;
  /**
   * Output format (TD-020). When "json", the HITL relay protocol
   * is used instead of the TUI prompt.
   */
  format?: "table" | "json";
  /** Current flow step info for session_state in pending_interaction. */
  stepInfo?: {
    currentStep: string;
    stepIndex: number;
    totalSteps: number;
  };
  /**
   * Optional unified diff for file_write HITL prompts (TD-025).
   * Populated by the executor before calling promptForPermission.
   * `null` means the file is new (no diff to show).
   * `undefined` means diff was not computed (backward compat).
   */
  diff?: string | null;
}

// ── Input Reader Type ──────────────────────────────────────────────

/** Type for the input reader function — injectable for testing. */
export type InputReader = (promptText: string) => Promise<string | null>;

/** Default stdin reader using Bun's built-in prompt facility. */
async function defaultInputReader(promptText: string): Promise<string | null> {
  // Bun provides a global `prompt()` for synchronous TUI input.
  // We wrap it in a promise for consistency with the injectable interface.
  return prompt(promptText) ?? null;
}

// ── Event Logging ──────────────────────────────────────────────────

/**
 * Logs a HITL decision to the session's `events.jsonl`.
 *
 * Uses {@link appendEvent} for atomic append with secret redaction.
 * Logging is best-effort: failures are warned but never thrown, because
 * the user's decision has already been made by the time we log it.
 *
 * @param sessionDir - The session directory.
 * @param response - The user's response.
 * @param tier - The trust tier of the command.
 * @param sanitizedCommand - The sanitized command (escapes stripped).
 * @param reasons - The classification reasons.
 */
async function logHITLEvent(
  sessionDir: string,
  response: HITLResponse,
  tier: TrustTier,
  sanitizedCommand: string,
  reasons: string[],
  sessionId?: string,
  parentSessionId?: string | null,
  modelId?: string,
): Promise<void> {
  try {
    await appendEvent(sessionDir, {
      schema_version: "0.2.0",
      event_id: generateSessionId(),
      session_id: sessionId ?? "",
      parent_session_id: parentSessionId ?? null,
      timestamp: new Date().toISOString(),
      agent_role: "human",
      model_id: modelId ?? "",
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_hit: false,
      action: `hitl_${response}`,
      hitl_tier: tier,
      hitl_command: sanitizedCommand,
      hitl_reasons: reasons,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to log HITL event: ${message}`);
  }
}

// ── Prompt Formatting ──────────────────────────────────────────────

/**
 * Builds the tier label string for display.
 *
 * @param tier - The trust tier.
 * @returns Human-readable tier label.
 */
function tierLabel(tier: TrustTier): string {
  switch (tier) {
    case TrustTier.Tier0:
      return "Tier 0 — Auto-Approved";
    case TrustTier.Tier1:
      return "Tier 1 — Human Gate Required";
    case TrustTier.Tier2:
      return "Tier 2 — Blocked";
  }
}

/**
 * Formats the permission prompt as a plain-text string for display.
 *
 * The raw command is visually distinct (boxed) from the model's
 * explanation (labeled as "Model's reasoning"). Verdict reasons
 * are shown so the user understands the classification.
 *
 * ## Display escaping (LOW-018)
 *
 * Newline, tab, and carriage return characters in the command are
 * replaced with visible escape sequences (\n, \t, \r) so the user
 * sees the exact content without hidden control characters.
 *
 * ## CJK/emoji width (LOW-022)
 *
 * `Array.from()` counts Unicode code points (not UTF-16 code units),
 * giving correct visual width for CJK characters, emoji, and other
 * multi-byte glyphs.
 *
 * Layout:
 * ```
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║ ⚠ PERMISSION REQUIRED — Tier 1 — Always Ask                  ║
 * ║ Reason: File deletion                                         ║
 * ╠═══════════════════════════════════════════════════════════════╣
 * ║ Action: shell                                                 ║
 * ║                                                               ║
 * ║ Command:                                                      ║
 * ║ ┌─────────────────────────────────────────────────────────┐   ║
 * ║ │ rm -rf ./node_modules                                   │   ║
 * ║ └─────────────────────────────────────────────────────────┘   ║
 * ║                                                               ║
 * ║ Model's reasoning:                                            ║
 * ║ "Clean up dependencies before reinstalling"                   ║
 * ║                                                               ║
 * ╠═══════════════════════════════════════════════════════════════╣
 * ║ [Y] Approve  [N] Deny  [M] Modify  [C] Chat                  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 * ```
 *
 * @param ctx - The HITL context.
 * @returns Formatted plain-text prompt string.
 */
export function formatPermissionPrompt(ctx: HITLContext): string {
  const safeCommand = sanitizeTerminalString(ctx.command)
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r");
  const safeExplanation = sanitizeTerminalString(ctx.explanation);
  const tierStr = tierLabel(ctx.verdict.tier);

  const lines: string[] = [];

  // ── Header ──
  const headerText = `⚠ PERMISSION REQUIRED — ${tierStr}`;
  lines.push(`╔${"═".repeat(63)}╗`);
  lines.push(`║ ${headerText.padEnd(61)} ║`);

  // ── Reasons ──
  for (const reason of ctx.verdict.reasons) {
    const reasonLine = `Reason: ${reason}`;
    if (reasonLine.length <= 61) {
      lines.push(`║ ${reasonLine.padEnd(61)} ║`);
    } else {
      // Wrap long reasons
      let remaining = reasonLine;
      while (remaining.length > 0) {
        const chunk = remaining.slice(0, 61);
        remaining = remaining.slice(61);
        lines.push(`║ ${chunk.padEnd(61)} ║`);
      }
    }
  }

  // ── Blocked warning ──
  if (ctx.verdict.blocked) {
    lines.push(`║ ${"⚠ UNCONDITIONALLY BLOCKED".padEnd(61)} ║`);
    const detail = ctx.verdict.blocked.details;
    // LOW-021: Wrap hard-deny details that exceed 61 chars, don't drop
    if (detail.length <= 61) {
      lines.push(`║ ${detail.padEnd(61)} ║`);
    } else {
      let remaining = detail;
      while (remaining.length > 0) {
        const chunk = remaining.slice(0, 61);
        remaining = remaining.slice(61);
        lines.push(`║ ${chunk.padEnd(61)} ║`);
      }
    }
  }

  // ── Separator ──
  lines.push(`╠${"═".repeat(63)}╣`);

  // ── Action type ──
  const action = `Action: ${ctx.actionType}`;
  lines.push(`║ ${action.padEnd(61)} ║`);
  lines.push(`║ ${"".padEnd(61)} ║`);

  // ── Command (boxed) — HIGH-004: Never truncate, always wrap ──
  lines.push(`║ Command:${"".padEnd(52)} ║`);
  const cmdMaxWidth = 53; // max width for command text inside box (61 - "║ " - " ║")
  const cmdTopLen = Math.min(Array.from(safeCommand).length + 2, cmdMaxWidth + 2);
  const cmdBoxTop = `┌${"─".repeat(Math.max(cmdTopLen, 1))}┐`;

  // Command wrapping: if the command exceeds the box width, wrap it
  const cmdChars = Array.from(safeCommand);
  if (cmdChars.length <= cmdMaxWidth) {
    const cmdBoxCmd = `│ ${safeCommand}${" ".repeat(Math.max(0, cmdMaxWidth - cmdChars.length))} │`;
    const cmdBoxBottom = `└${"─".repeat(Math.max(Array.from(safeCommand).length, 1))}┘`;
    lines.push(`║ ${cmdBoxTop.padEnd(61)} ║`);
    lines.push(`║ ${cmdBoxCmd.padEnd(61)} ║`);
    lines.push(`║ ${cmdBoxBottom.padEnd(61)} ║`);
  } else {
    // Multi-line command wrapping
    lines.push(`║ ${cmdBoxTop.padEnd(61)} ║`);
    let remaining = safeCommand;
    while (remaining.length > 0) {
      const chunk = remaining.slice(0, cmdMaxWidth);
      remaining = remaining.slice(cmdMaxWidth);
      const padded = chunk.padEnd(cmdMaxWidth);
      lines.push(`║ │ ${padded} │${" ".repeat(Math.max(0, 61 - cmdMaxWidth - 5))} ║`);
    }
    const cmdCharsCount = Array.from(safeCommand).length;
    const cmdBoxBottom = `└${"─".repeat(Math.min(cmdCharsCount + 2, cmdMaxWidth + 2))}┘`;
    lines.push(`║ ${cmdBoxBottom.padEnd(61)} ║`);
  }

  lines.push(`║ ${"".padEnd(61)} ║`);

  // ── Model's reasoning ──
  lines.push(`║ Model's reasoning:${"".padEnd(42)} ║`);

  // Wrap the explanation text
  const quotePrefix = '"';
  const maxReasonWidth = 55;
  const explanationText = quotePrefix + safeExplanation + '"';
  if (explanationText.length <= maxReasonWidth) {
    lines.push(`║ ${explanationText.padEnd(61)} ║`);
  } else {
    let remaining = explanationText;
    while (remaining.length > 0) {
      const chunk = remaining.slice(0, maxReasonWidth);
      remaining = remaining.slice(maxReasonWidth);
      lines.push(`║ ${chunk.padEnd(61)} ║`);
    }
  }

  lines.push(`║ ${"".padEnd(61)} ║`);

  // ── Choices ──
  lines.push(`╠${"═".repeat(63)}╣`);
  lines.push(`║ [Y] Approve  [N] Deny  [M] Modify  [C] Chat          ║`);
  lines.push(`╚${"═".repeat(63)}╝`);

  return lines.join("\n");
}

// ── Core HITL Function ─────────────────────────────────────────────

/**
 * Result of the HITL permission interaction.
 */
export interface HITLResult {
  /** The user's response. */
  response: HITLResponse;
  /** When response is Modify, the user-provided modified command. */
  modifiedCommand?: string;
  /** When the decision was auto-made (Tier 0 auto-approve or Tier 2 blocked auto-deny). */
  autoDecision?: boolean;
}

/**
 * Runs the HITL permission flow for a tool-execution request.
 *
 * ## Decision Flow
 *
 * 1. **Blocked (Tier 2)** → auto-rejects (logged, never prompts).
 * 2. **Tier 0** → auto-approves (logged, never prompts).
 * 3. **Tier 1** → displays the formatted permission prompt and
 *    waits for user input. Always prompts — no auto-approve.
 *
 * ## EOF / Input Exhaustion (HIGH-003)
 *
 * If the input reader returns `null` or an empty string, or if the user
 * exceeds 10 invalid attempts, the function fail-closed with a HITL Deny
 * response. A null/EOL input is treated as a deny to prevent unaudited
 * execution when stdin is closed or the mock reader is exhausted.
 *
 * @param ctx - The HITL context (command, verdict, session state, etc.).
 * @param readInput - Injectable input reader for testing (defaults to Bun's prompt()).
 * @returns A {@link HITLResult} with the user's decision.
 */
export async function promptForPermission(
  ctx: HITLContext,
  readInput: InputReader = defaultInputReader,
): Promise<HITLResult> {
  const { verdict, sessionDir, command, sessionId, parentSessionId, modelId } = ctx;
  const sanitizedCommand = sanitizeTerminalString(command);

  // ── 1. Blocked → auto-reject ─────────────────────────────────
  if (verdict.blocked) {
    if (sessionDir) {
      await logHITLEvent(
        sessionDir,
        HITLResponse.Deny,
        verdict.tier,
        sanitizedCommand,
        verdict.reasons,
        sessionId,
        parentSessionId,
        modelId,
      );
    } else {
      logger.warn("[zao] Cannot log HITL event: no session directory available");
    }
    logger.error(`\n✗ BLOCKED: ${verdict.blocked.reason}`);
    logger.error(`  ${verdict.blocked.details}\n`);
    return { response: HITLResponse.Deny, autoDecision: true };
  }

  // ── 2. Tier 0 → auto-approve (log only) ────────────────────────
  if (verdict.tier === TrustTier.Tier0) {
    if (sessionDir) {
      await logHITLEvent(
        sessionDir,
        HITLResponse.Approve,
        verdict.tier,
        sanitizedCommand,
        verdict.reasons,
        sessionId,
        parentSessionId,
        modelId,
      );
    }
    return { response: HITLResponse.Approve, autoDecision: true };
  }

  // ── Tier 1: always prompt for human gate ──────────────────────
  // Tier 1 commands always require human approval — no auto-approve
  // via --yes or session memory. The user must explicitly approve.

  // ── 5. JSON mode HITL relay (TD-020) ──────────────────────────
  if (ctx.format === "json") {
    // Emit pending_interaction, block on stdin, validate reply
    const interactionId = generateSessionId();
    const { readHITLDecisionFromStdin } = await import("../cli/output.ts");

    // L6: stepInfo should be threaded from the controller's executor via
    // delegateToSubagent → executor → HITLContext. Warn if it's
    // not set (indicates a code path where threading is incomplete).
    const effectiveStepInfo = ctx.stepInfo ?? {
      currentStep: "",
      stepIndex: 0,
      totalSteps: 1,
    };
    if (!ctx.stepInfo) {
      logger.warn(
        "HITL relay: stepInfo not threaded — using empty fallback",
      );
    }

    const result = await readHITLDecisionFromStdin({
      sessionId: ctx.sessionId ?? "",
      interactionId,
      tier: verdict.tier,
      actionType: ctx.actionType,
      command: sanitizedCommand,
      reasons: verdict.reasons,
      diff: ctx.diff ?? null,
      sessionState: effectiveStepInfo,
    });

    if (!result.ok) {
      // Invalid decision → validation error, deny
      if (sessionDir) {
        await logHITLEvent(
          sessionDir,
          HITLResponse.Deny,
          verdict.tier,
          sanitizedCommand,
          verdict.reasons,
          sessionId,
          parentSessionId,
          modelId,
        );
      }
      logger.error(`HITL relay failed: ${result.error}`);
      return { response: HITLResponse.Deny };
    }

    const decision = result.decision;

    if (decision.decision === "deny") {
      if (sessionDir) {
        await logHITLEvent(
          sessionDir,
          HITLResponse.Deny,
          verdict.tier,
          sanitizedCommand,
          verdict.reasons,
          sessionId,
          parentSessionId,
          modelId,
        );
      }
      return { response: HITLResponse.Deny };
    }

    if (decision.decision === "modify") {
      // L3: modify without modified_command is meaningless — reject
      if (!decision.modified_command) {
        logger.warn(
          "HITL relay: modify decision missing modified_command",
        );
        if (sessionDir) {
          await logHITLEvent(
            sessionDir,
            HITLResponse.Deny,
            verdict.tier,
            sanitizedCommand,
            verdict.reasons,
            sessionId,
            parentSessionId,
            modelId,
          );
        }
        return { response: HITLResponse.Deny };
      }
      if (sessionDir) {
        await logHITLEvent(
          sessionDir,
          HITLResponse.Modify,
          verdict.tier,
          sanitizedCommand,
          verdict.reasons,
          sessionId,
          parentSessionId,
          modelId,
        );
      }
      return {
        response: HITLResponse.Modify,
        modifiedCommand: decision.modified_command ?? undefined,
      };
    }

    // approve
    if (sessionDir) {
      await logHITLEvent(
        sessionDir,
        HITLResponse.Approve,
        verdict.tier,
        sanitizedCommand,
        verdict.reasons,
        sessionId,
        parentSessionId,
        modelId,
      );
    }
    return { response: HITLResponse.Approve };
  }

  // ── 6. Interactive TUI prompt (table mode) ──────────────────────
  // Try @clack/prompts first (TTY mode); fall back to raw stdin (CI/piped).
  if (isClackAvailable()) {
    progress.pause();

    const clackResult = await showClackPrompt(
      sanitizedCommand,
      ctx.explanation,
      verdict,
      ctx.diff,
    );

    progress.resume();

    // Map clack result to HITLResult
    switch (clackResult.response) {
      case "approve": {
        if (sessionDir) {
          await logHITLEvent(
            sessionDir,
            HITLResponse.Approve,
            verdict.tier,
            sanitizedCommand,
            verdict.reasons,
            sessionId,
            parentSessionId,
            modelId,
          );
        }
        return { response: HITLResponse.Approve };
      }
      case "deny": {
        if (sessionDir) {
          await logHITLEvent(
            sessionDir,
            HITLResponse.Deny,
            verdict.tier,
            sanitizedCommand,
            verdict.reasons,
            sessionId,
            parentSessionId,
            modelId,
          );
        }
        return { response: HITLResponse.Deny };
      }
      case "modify": {
        const modifiedCmd = clackResult.modifiedCommand?.trim();
        if (modifiedCmd && modifiedCmd.length > 0) {
          if (sessionDir) {
            await logHITLEvent(
              sessionDir,
              HITLResponse.Modify,
              verdict.tier,
              sanitizedCommand,
              verdict.reasons,
              sessionId,
              parentSessionId,
              modelId,
            );
          }
          return { response: HITLResponse.Modify, modifiedCommand: modifiedCmd };
        }
        // Empty modify → deny
        return { response: HITLResponse.Deny };
      }
      case "chat": {
        if (sessionDir) {
          await logHITLEvent(
            sessionDir,
            HITLResponse.Chat,
            verdict.tier,
            sanitizedCommand,
            verdict.reasons,
            sessionId,
            parentSessionId,
            modelId,
          );
        }
        return { response: HITLResponse.Chat };
      }
      default: {
        return { response: HITLResponse.Deny };
      }
    }
  }

  // ── Fallback: raw stdin prompt (non-TTY) ───────────────────────
  const promptText = formatPermissionPrompt(ctx);
  logger.info("\n" + promptText);

  let invalidAttempts = 0;
  const MAX_INVALID_ATTEMPTS = 10;

  while (true) {
    const rawInput = await readInput("Choice [Y/N/M/C]: ");

    // HIGH-003: Handle null/empty input as deny (fail-closed)
    if (rawInput === null || rawInput.trim().length === 0) {
      logger.info("No input received — denying by default.");
      if (sessionDir) {
        await logHITLEvent(
          sessionDir,
          HITLResponse.Deny,
          verdict.tier,
          sanitizedCommand,
          verdict.reasons,
          sessionId,
          parentSessionId,
          modelId,
        );
      }
      return { response: HITLResponse.Deny };
    }

    const input = rawInput.trim().toUpperCase();

    switch (input) {
      case "Y": {
        if (sessionDir) {
          await logHITLEvent(
            sessionDir,
            HITLResponse.Approve,
            verdict.tier,
            sanitizedCommand,
            verdict.reasons,
            sessionId,
            parentSessionId,
            modelId,
          );
        }
        return { response: HITLResponse.Approve };
      }
      case "N": {
        if (sessionDir) {
          await logHITLEvent(
            sessionDir,
            HITLResponse.Deny,
            verdict.tier,
            sanitizedCommand,
            verdict.reasons,
            sessionId,
            parentSessionId,
            modelId,
          );
        }
        return { response: HITLResponse.Deny };
      }
      case "M": {
        const modified = await readInput("Enter modified command: ");
        if (modified && modified.trim().length > 0) {
          if (sessionDir) {
            await logHITLEvent(
              sessionDir,
              HITLResponse.Modify,
              verdict.tier,
              sanitizedCommand,
              verdict.reasons,
              sessionId,
              parentSessionId,
              modelId,
            );
          }
          return { response: HITLResponse.Modify, modifiedCommand: modified.trim() };
        }
        logger.info("Modified command cannot be empty. Please try again.");
        break;
      }
      case "C": {
        if (sessionDir) {
          await logHITLEvent(
            sessionDir,
            HITLResponse.Chat,
            verdict.tier,
            sanitizedCommand,
            verdict.reasons,
            sessionId,
            parentSessionId,
            modelId,
          );
        }
        return { response: HITLResponse.Chat };
      }
      default: {
        invalidAttempts++;
        if (invalidAttempts >= MAX_INVALID_ATTEMPTS) {
          logger.info("Too many invalid attempts — denying by default.");
          if (sessionDir) {
            await logHITLEvent(
              sessionDir,
              HITLResponse.Deny,
              verdict.tier,
              sanitizedCommand,
              verdict.reasons,
              sessionId,
              parentSessionId,
              modelId,
            );
          }
          return { response: HITLResponse.Deny };
        }
        logger.info("Invalid choice. Please enter Y, N, M, or C.");
      }
    }
  }
}

// ── Internal Helpers ───────────────────────────────────────────────

