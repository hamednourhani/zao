/**
 * Tests for the model context-window registry (TD-010-D).
 *
 * @module model-registry.test
 */

import { describe, expect, test } from "bun:test";
import { resolveContextWindow, supportsCaching } from "../src/core/model-registry.ts";

describe("supportsCaching", () => {
  test("returns true for deepseek:deepseek-chat", () => {
    expect(supportsCaching("deepseek", "deepseek-chat")).toBe(true);
  });

  test("returns true for openai:gpt-4o", () => {
    expect(supportsCaching("openai", "gpt-4o")).toBe(true);
  });

  test("returns true for anthropic:claude-sonnet-4", () => {
    expect(supportsCaching("anthropic", "claude-sonnet-4")).toBe(true);
  });

  test("returns true for google:gemini-2.5-pro", () => {
    expect(supportsCaching("google", "gemini-2.5-pro")).toBe(true);
  });

  test("returns false for unsupported model (deepseek:deepseek-reasoner)", () => {
    expect(supportsCaching("deepseek", "deepseek-reasoner")).toBe(false);
  });

  test("returns false for unknown model", () => {
    expect(supportsCaching("unknown", "unknown-model")).toBe(false);
  });

  test("returns false for case-sensitive mismatch", () => {
    expect(supportsCaching("DeepSeek", "deepseek-chat")).toBe(false);
    expect(supportsCaching("deepseek", "DeepSeek-Chat")).toBe(false);
  });
});

describe("resolveContextWindow", () => {
  test("returns 128K for deepseek:deepseek-chat from registry", () => {
    const result = resolveContextWindow("deepseek", "deepseek-chat");
    expect(result.contextWindow).toBe(128_000);
    expect(result.source).toBe("registry");
  });

  test("returns 200K for anthropic:claude-sonnet-4 from registry", () => {
    const result = resolveContextWindow("anthropic", "claude-sonnet-4");
    expect(result.contextWindow).toBe(200_000);
    expect(result.source).toBe("registry");
  });

  test("returns 1M for openai:gpt-4.1 from registry", () => {
    const result = resolveContextWindow("openai", "gpt-4.1");
    expect(result.contextWindow).toBe(1_000_000);
    expect(result.source).toBe("registry");
  });

  test("returns 2M for google:gemini-1.5-pro from registry", () => {
    const result = resolveContextWindow("google", "gemini-1.5-pro");
    expect(result.contextWindow).toBe(2_000_000);
    expect(result.source).toBe("registry");
  });

  test("override value wins over registry", () => {
    const result = resolveContextWindow("deepseek", "deepseek-chat", 64_000);
    expect(result.contextWindow).toBe(64_000);
    expect(result.source).toBe("override");
  });

  test("override 0 throws an error", () => {
    expect(() => resolveContextWindow("deepseek", "deepseek-chat", 0)).toThrow(
      "Invalid context_window override: 0. Must be a positive integer.",
    );
  });

  test("override negative throws an error", () => {
    expect(() =>
      resolveContextWindow("deepseek", "deepseek-chat", -1),
    ).toThrow(
      "Invalid context_window override: -1. Must be a positive integer.",
    );
  });

  test("override non-integer throws an error", () => {
    expect(() =>
      resolveContextWindow("deepseek", "deepseek-chat", 3.14),
    ).toThrow("Must be a positive integer");
  });

  test("unknown model returns default 128K and emits warning", () => {
    // Capture console.warn
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const result = resolveContextWindow("unknown", "model");
      expect(result.contextWindow).toBe(128_000);
      expect(result.source).toBe("default");
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('Unknown llm_id "unknown:model"');
      expect(warnings[0]).toContain("128,000");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("override of 0 with unknown model still throws (override checked first)", () => {
    expect(() => resolveContextWindow("unknown", "model", 0)).toThrow(
      "Invalid context_window override",
    );
  });
});
