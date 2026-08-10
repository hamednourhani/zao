/**
 * Learning producer — maps detected patterns to actionable learnings.
 *
 * Converts {@link Pattern} objects into {@link Learning} actions:
 * - high_failure_rate → action: "warn"
 * - tool_timeouts → action: "warn"
 * - quick_wins → action: "create_blueprint"
 *
 * @module learner
 */

import type { Pattern } from "./analyzer.ts";

// ── Types ──────────────────────────────────────────────────────────

/** A learning — an actionable improvement derived from a pattern. */
export interface Learning {
  /** The pattern that generated this learning. */
  pattern: string;
  /** The recommended action. */
  action: "create_blueprint" | "update_blueprint" | "add_guardrail" | "warn";
  /** Action-specific payload. */
  payload: Record<string, unknown>;
}

/** A blueprint improvement suggestion derived from learnings. */
export interface BlueprintSuggestion {
  /** Which blueprint to improve. */
  blueprintId: string;
  /** What kind of change to make. */
  action: "add_step" | "remove_step" | "modify_step" | "adjust_loop" | "adjust_model";
  /** Which step to change (if applicable). */
  stepId?: string;
  /** Human-readable description of the change. */
  description: string;
  /** Specific suggested change text. */
  suggestedChange: string;
}

// ── Pattern → Learning Mapping ─────────────────────────────────────

/** Maps patterns to learning actions and payloads. */
const PATTERN_ACTIONS: Record<
  string,
  { action: Learning["action"]; buildPayload: (pattern: Pattern) => Record<string, unknown> }
> = {
  high_failure_rate: {
    action: "warn",
    buildPayload: (p: Pattern) => ({
      message: p.description,
      failureRate: p.confidence,
      affectedSessions: p.evidence,
    }),
  },
  tool_timeouts: {
    action: "warn",
    buildPayload: (p: Pattern) => ({
      message: p.description,
      avgErrors: p.confidence,
      affectedSessions: p.evidence,
    }),
  },
  quick_wins: {
    action: "create_blueprint",
    buildPayload: (p: Pattern) => ({
      message: p.description,
      template: "Consider templating this pattern",
      affectedSessions: p.evidence,
    }),
  },
  frequent_compaction: {
    action: "warn",
    buildPayload: (p: Pattern) => ({
      message: p.description,
      suggestion: "Consider smaller tasks or fewer context files.",
    }),
  },
};

// ── Learning Production ────────────────────────────────────────────

/**
 * Converts detected patterns into actionable learnings.
 *
 * @param patterns - Array of detected {@link Pattern} objects.
 * @returns Array of {@link Learning} actions.
 */
export function produceLearnings(patterns: Pattern[]): Learning[] {
  const learnings: Learning[] = [];

  for (const pattern of patterns) {
    const mapping = PATTERN_ACTIONS[pattern.name];
    if (!mapping) continue;

    learnings.push({
      pattern: pattern.name,
      action: mapping.action,
      payload: mapping.buildPayload(pattern),
    });
  }

  return learnings;
}

// ── Blueprint Improvement Suggestions ───────────────────────────────

/**
 * Converts learnings into blueprint improvement suggestions.
 *
 * Maps detected patterns to concrete recommendations for improving
 * blueprint packages. These suggestions can be fed back to crunch
 * or presented to the human for review.
 *
 * @param learnings - Array of {@link Learning} objects from {@link produceLearnings}.
 * @returns Array of {@link BlueprintSuggestion} objects.
 */
export function suggestBlueprintImprovements(
  learnings: Learning[],
): BlueprintSuggestion[] {
  const suggestions: BlueprintSuggestion[] = [];

  for (const learning of learnings) {
    switch (learning.pattern) {
      case "high_failure_rate":
        suggestions.push({
          blueprintId: "dev-cycle",
          action: "adjust_loop",
          description:
            "High failure rate detected — consider increasing max_iterations or adjusting review criteria",
          suggestedChange:
            "Increase max_iterations from 5 to 7, or add a pre-review verification step",
        });
        break;
      case "tool_timeouts":
        suggestions.push({
          blueprintId: "dev-cycle",
          action: "modify_step",
          stepId: "implement",
          description:
            "Tool timeouts detected — consider adding timeout configuration",
          suggestedChange:
            "Add executeShell timeout parameter or split long-running commands into smaller steps",
        });
        break;
      case "quick_wins":
        suggestions.push({
          blueprintId: "dev-cycle",
          action: "add_step",
          description:
            "Quick wins detected — consider templating these fast patterns",
          suggestedChange:
            "Create a 'quick-fix' blueprint variant for fast, low-risk changes",
        });
        break;
    }
  }

  return suggestions;
}
