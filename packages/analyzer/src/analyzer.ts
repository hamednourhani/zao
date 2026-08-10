/**
 * Pattern analyzer — identifies patterns in session data.
 *
 * Detects recurring patterns from {@link SessionSummary} arrays:
 * - high_failure_rate: >50% of sessions failed
 * - frequent_compaction: placeholder (v1 returns empty)
 * - tool_timeouts: sessions with errorCount > 3
 * - quick_wins: successful sessions completed in < 30 seconds
 *
 * @module analyzer
 */

import type { SessionSummary } from "./ingest.ts";

// ── Types ──────────────────────────────────────────────────────────

/** A detected pattern from session analysis. */
export interface Pattern {
  /** Unique pattern name. */
  name: string;
  /** Confidence score (0.0–1.0). */
  confidence: number;
  /** Session IDs supporting this pattern. */
  evidence: string[];
  /** Human-readable description of the pattern. */
  description: string;
  /** Suggested action or remediation. */
  suggestion: string;
}

// ── Pattern Detection ─────────────────────────────────────────────

/**
 * Analyzes session summaries and identifies known patterns.
 *
 * @param sessions - Array of {@link SessionSummary} from {@link ingestSessions}.
 * @returns Array of detected {@link Pattern} objects.
 */
export function analyzePatterns(sessions: SessionSummary[]): Pattern[] {
  const patterns: Pattern[] = [];

  if (sessions.length === 0) return patterns;

  // 1. High failure rate
  patterns.push(...detectHighFailureRate(sessions));

  // 2. Frequent compaction (placeholder — needs event data)
  patterns.push(...detectFrequentCompaction(sessions));

  // 3. Tool timeouts (errorCount > 3)
  patterns.push(...detectToolTimeouts(sessions));

  // 4. Quick wins (success + duration < 30s)
  patterns.push(...detectQuickWins(sessions));

  return patterns;
}

// ── Individual Detectors ───────────────────────────────────────────

/**
 * Detects high failure rate pattern.
 *
 * Triggered when >50% of sessions have status "failed".
 */
function detectHighFailureRate(sessions: SessionSummary[]): Pattern[] {
  const failedSessions = sessions.filter((s) => s.status === "failed");
  const failureRate = failedSessions.length / sessions.length;

  if (failureRate <= 0.5) return [];

  return [
    {
      name: "high_failure_rate",
      confidence: Math.min(failureRate, 1.0),
      evidence: failedSessions.map((s) => s.sessionId),
      description: `${(failureRate * 100).toFixed(0)}% of sessions (${
        failedSessions.length
      }/${sessions.length}) failed.`,
      suggestion:
        "Review common failure patterns. Consider adjusting blueprint steps or increasing model temperature for creative tasks.",
    },
  ];
}

/**
 * Placeholder detector for frequent compaction pattern.
 *
 * v1: Returns empty — requires event-level data not available in summaries.
 *
 * TODO: Implement when event-level data is available (TD-010-E).
 */
function detectFrequentCompaction(
  _sessions: SessionSummary[],
): Pattern[] {
  // Placeholder — requires event data (context_compaction events)
  // Not implemented in v1.
  return [];
}

/**
 * Detects tool timeout pattern.
 *
 * Triggered when sessions have errorCount > 3.
 */
function detectToolTimeouts(sessions: SessionSummary[]): Pattern[] {
  const highErrorSessions = sessions.filter((s) => s.errorCount > 3);

  if (highErrorSessions.length === 0) return [];

  const avgErrors =
    highErrorSessions.reduce((sum, s) => sum + s.errorCount, 0) /
    highErrorSessions.length;

  return [
    {
      name: "tool_timeouts",
      confidence: Math.min(highErrorSessions.length / sessions.length, 1.0),
      evidence: highErrorSessions.map((s) => s.sessionId),
      description: `${highErrorSessions.length} sessions have high error counts (>3). Average errors: ${avgErrors.toFixed(1)}.`,
      suggestion:
        "Consider increasing tool timeout values or simplifying tool commands. Check network latency and system load.",
    },
  ];
}

/**
 * Detects quick wins pattern.
 *
 * Triggered when sessions are successful AND complete in < 30 seconds.
 */
function detectQuickWins(sessions: SessionSummary[]): Pattern[] {
  const quickWins = sessions.filter(
    (s) => s.status === "success" && s.duration < 30000,
  );

  if (quickWins.length === 0) return [];

  return [
    {
      name: "quick_wins",
      confidence: Math.min(quickWins.length / sessions.length, 1.0),
      evidence: quickWins.map((s) => s.sessionId),
      description: `${quickWins.length} sessions completed successfully in under 30 seconds.`,
      suggestion:
        "Consider templating this pattern as a reusable blueprint. Fast, successful sessions indicate well-understood workflows.",
    },
  ];
}
