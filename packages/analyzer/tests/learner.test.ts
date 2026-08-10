import { describe, test, expect } from "bun:test";
import { produceLearnings, suggestBlueprintImprovements } from "../src/learner.ts";
import type { Pattern } from "../src/analyzer.ts";
import type { Learning } from "../src/learner.ts";

function makePattern(overrides: Partial<Pattern> = {}): Pattern {
  return {
    name: "test_pattern",
    confidence: 0.8,
    evidence: ["s1", "s2"],
    description: "Test description.",
    suggestion: "Test suggestion.",
    ...overrides,
  };
}

describe("produceLearnings", () => {
  test("maps high_failure_rate to warn", () => {
    const patterns: Pattern[] = [
      makePattern({
        name: "high_failure_rate",
        confidence: 0.75,
        evidence: ["s1", "s2", "s3"],
        description: "75% of sessions failed.",
        suggestion: "Review failure patterns.",
      }),
    ];

    const learnings = produceLearnings(patterns);
    expect(learnings.length).toBe(1);

    const learning = learnings[0];
    expect(learning).toBeDefined();
    if (learning) {
      expect(learning.pattern).toBe("high_failure_rate");
      expect(learning.action).toBe("warn");
      expect(learning.payload["message"]).toBe("75% of sessions failed.");
      expect(learning.payload["failureRate"]).toBe(0.75);
      expect(learning.payload["affectedSessions"]).toEqual(["s1", "s2", "s3"]);
    }
  });

  test("maps quick_wins to create_blueprint", () => {
    const patterns: Pattern[] = [
      makePattern({
        name: "quick_wins",
        confidence: 0.4,
        evidence: ["s5"],
        description: "4 sessions completed quickly.",
        suggestion: "Consider templating.",
      }),
    ];

    const learnings = produceLearnings(patterns);
    expect(learnings.length).toBe(1);

    const learning = learnings[0];
    expect(learning).toBeDefined();
    if (learning) {
      expect(learning.action).toBe("create_blueprint");
      expect(learning.payload["template"]).toBeDefined();
    }
  });

  test("maps tool_timeouts to warn", () => {
    const patterns: Pattern[] = [
      makePattern({
        name: "tool_timeouts",
        confidence: 0.3,
        evidence: ["s8"],
        description: "High error count sessions detected.",
        suggestion: "Increase timeout.",
      }),
    ];

    const learnings = produceLearnings(patterns);
    expect(learnings.length).toBe(1);

    const learning = learnings[0];
    expect(learning).toBeDefined();
    if (learning) {
      expect(learning.action).toBe("warn");
      expect(learning.payload["message"]).toBeDefined();
    }
  });

  test("returns empty for empty patterns", () => {
    const learnings = produceLearnings([]);
    expect(learnings).toEqual([]);
  });

  test("handles multiple patterns", () => {
    const patterns: Pattern[] = [
      makePattern({ name: "high_failure_rate", confidence: 0.6, evidence: ["s1"] }),
      makePattern({ name: "quick_wins", confidence: 0.3, evidence: ["s2"] }),
    ];

    const learnings = produceLearnings(patterns);
    expect(learnings.length).toBe(2);
  });

  test("ignores unknown pattern names", () => {
    const patterns: Pattern[] = [
      makePattern({ name: "unknown_pattern_xyz", confidence: 1.0, evidence: [] }),
    ];

    const learnings = produceLearnings(patterns);
    expect(learnings).toEqual([]);
  });

  test("frequent_compaction maps to warn", () => {
    const patterns: Pattern[] = [
      makePattern({
        name: "frequent_compaction",
        confidence: 0.5,
        evidence: ["s1"],
        description: "Compaction triggered often.",
        suggestion: "Use smaller tasks.",
      }),
    ];

    const learnings = produceLearnings(patterns);
    expect(learnings.length).toBe(1);

    const learning = learnings[0];
    expect(learning).toBeDefined();
    if (learning) {
      expect(learning.action).toBe("warn");
    }
  });
});

describe("suggestBlueprintImprovements", () => {
  test("returns suggestions for high_failure_rate", () => {
    const learnings: Learning[] = [
      {
        pattern: "high_failure_rate",
        action: "warn",
        payload: { message: "50% sessions failed." },
      },
    ];

    const suggestions = suggestBlueprintImprovements(learnings);
    expect(suggestions.length).toBe(1);

    const s = suggestions[0];
    expect(s).toBeDefined();
    if (s) {
      expect(s.blueprintId).toBe("dev-cycle");
      expect(s.action).toBe("adjust_loop");
      expect(s.description).toContain("High failure rate");
    }
  });

  test("returns suggestions for tool_timeouts", () => {
    const learnings: Learning[] = [
      {
        pattern: "tool_timeouts",
        action: "warn",
        payload: { message: "Tool timeouts detected." },
      },
    ];

    const suggestions = suggestBlueprintImprovements(learnings);
    expect(suggestions.length).toBe(1);

    const s = suggestions[0];
    expect(s).toBeDefined();
    if (s) {
      expect(s.blueprintId).toBe("dev-cycle");
      expect(s.action).toBe("modify_step");
      expect(s.stepId).toBe("implement");
      expect(s.description).toContain("Tool timeouts");
    }
  });

  test("returns suggestions for quick_wins", () => {
    const learnings: Learning[] = [
      {
        pattern: "quick_wins",
        action: "create_blueprint",
        payload: { message: "Quick wins detected." },
      },
    ];

    const suggestions = suggestBlueprintImprovements(learnings);
    expect(suggestions.length).toBe(1);

    const s = suggestions[0];
    expect(s).toBeDefined();
    if (s) {
      expect(s.blueprintId).toBe("dev-cycle");
      expect(s.action).toBe("add_step");
      expect(s.description).toContain("Quick wins");
    }
  });

  test("returns empty for empty learnings", () => {
    const suggestions = suggestBlueprintImprovements([]);
    expect(suggestions).toEqual([]);
  });

  test("handles multiple learnings", () => {
    const learnings: Learning[] = [
      {
        pattern: "high_failure_rate",
        action: "warn",
        payload: { message: "High failure." },
      },
      {
        pattern: "quick_wins",
        action: "create_blueprint",
        payload: { message: "Quick wins." },
      },
    ];

    const suggestions = suggestBlueprintImprovements(learnings);
    expect(suggestions.length).toBe(2);
  });

  test("ignores unknown pattern names", () => {
    const learnings: Learning[] = [
      {
        pattern: "frequent_compaction",
        action: "warn",
        payload: { message: "Unknown in suggestions." },
      },
    ];

    const suggestions = suggestBlueprintImprovements(learnings);
    expect(suggestions).toEqual([]);
  });
});
