import { describe, test, expect } from "bun:test";
import { analyzePatterns } from "../src/analyzer.ts";
import type { SessionSummary } from "../src/ingest.ts";

function makeSession(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    sessionId: "sess-test",
    status: "success",
    task: "Test task",
    model: "test:mock",
    duration: 5000,
    errorCount: 0,
    toolCallCount: 2,
    ...overrides,
  };
}

describe("analyzePatterns", () => {
  test("detects high failure rate (>50%)", () => {
    const sessions: SessionSummary[] = [
      makeSession({ sessionId: "s1", status: "failed" }),
      makeSession({ sessionId: "s2", status: "failed" }),
      makeSession({ sessionId: "s3", status: "success" }),
    ];

    const patterns = analyzePatterns(sessions);

    const failurePattern = patterns.find((p) => p.name === "high_failure_rate");
    expect(failurePattern).toBeDefined();
    if (failurePattern) {
      expect(failurePattern.confidence).toBeCloseTo(2 / 3, 1);
      expect(failurePattern.evidence).toContain("s1");
      expect(failurePattern.evidence).toContain("s2");
    }
  });

  test("returns empty for all-success sessions", () => {
    const sessions: SessionSummary[] = [
      makeSession({ sessionId: "s1", status: "success" }),
      makeSession({ sessionId: "s2", status: "success" }),
      makeSession({ sessionId: "s3", status: "success" }),
    ];

    const patterns = analyzePatterns(sessions);
    const failurePattern = patterns.find((p) => p.name === "high_failure_rate");
    expect(failurePattern).toBeUndefined();
  });

  test("detects tool timeouts (errorCount > 3)", () => {
    const sessions: SessionSummary[] = [
      makeSession({ sessionId: "s1", errorCount: 5, status: "failed" }),
      makeSession({ sessionId: "s2", errorCount: 0, status: "success" }),
    ];

    const patterns = analyzePatterns(sessions);

    const timeoutPattern = patterns.find((p) => p.name === "tool_timeouts");
    expect(timeoutPattern).toBeDefined();
    if (timeoutPattern) {
      expect(timeoutPattern.evidence).toContain("s1");
      expect(timeoutPattern.evidence).not.toContain("s2");
    }
  });

  test("detects quick wins (success + duration < 30s)", () => {
    const sessions: SessionSummary[] = [
      makeSession({ sessionId: "s1", status: "success", duration: 5000 }),
      makeSession({ sessionId: "s2", status: "success", duration: 60000 }), // too slow
      makeSession({ sessionId: "s3", status: "failed", duration: 5000 }),   // not success
    ];

    const patterns = analyzePatterns(sessions);

    const quickWinPattern = patterns.find((p) => p.name === "quick_wins");
    expect(quickWinPattern).toBeDefined();
    if (quickWinPattern) {
      expect(quickWinPattern.evidence).toContain("s1");
      expect(quickWinPattern.evidence).not.toContain("s2");
      expect(quickWinPattern.evidence).not.toContain("s3");
    }
  });

  test("returns empty array for empty sessions", () => {
    const patterns = analyzePatterns([]);
    expect(patterns).toEqual([]);
  });

  test("no high_failure_rate when exactly 50% fail", () => {
    const sessions: SessionSummary[] = [
      makeSession({ sessionId: "s1", status: "failed" }),
      makeSession({ sessionId: "s2", status: "success" }),
    ];

    const patterns = analyzePatterns(sessions);
    const failurePattern = patterns.find((p) => p.name === "high_failure_rate");
    expect(failurePattern).toBeUndefined();
  });

  test("high_failure_rate when 51%+ fail", () => {
    const sessions: SessionSummary[] = [
      makeSession({ sessionId: "s1", status: "failed" }),
      makeSession({ sessionId: "s2", status: "failed" }),
      makeSession({ sessionId: "s3", status: "success" }),
      makeSession({ sessionId: "s4", status: "success" }),
    ];
    // 2/4 = 50% → no pattern
    let patterns = analyzePatterns(sessions);
    let failurePattern = patterns.find((p) => p.name === "high_failure_rate");
    expect(failurePattern).toBeUndefined();

    // Add one more failed → 3/5 = 60%
    const moreSessions = [
      ...sessions,
      makeSession({ sessionId: "s5", status: "failed" }),
    ];
    patterns = analyzePatterns(moreSessions);
    failurePattern = patterns.find((p) => p.name === "high_failure_rate");
    expect(failurePattern).toBeDefined();
    if (failurePattern) {
      expect(failurePattern.confidence).toBe(0.6);
    }
  });
});
