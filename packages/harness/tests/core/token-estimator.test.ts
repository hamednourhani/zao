/**
 * Token estimator tests — verifies accurate token counting.
 *
 * Tests:
 * - Heuristic estimator (chars/4)
 * - GPT tokenizer estimator
 * - estimateTokens helper with provider fallback
 *
 * @module token-estimator.test
 */

import { describe, test, expect } from "bun:test";
import { createTokenEstimator, estimateTokens } from "../../src/core/token-estimator.ts";

describe("token-estimator", () => {
  describe("createTokenEstimator", () => {
    test("heuristic estimator uses chars/4", () => {
      const estimator = createTokenEstimator("heuristic");
      expect(estimator.name).toBe("heuristic");
      expect(estimator.estimate("")).toBe(0);
      expect(estimator.estimate("abcd")).toBe(1);
      expect(estimator.estimate("abcdefgh")).toBe(2);
      expect(estimator.estimate("Hello, world!")).toBe(4); // 13/4 = 3.25 → ceil = 4
    });

    test("gpt-tokenizer estimator returns non-zero counts", () => {
      const estimator = createTokenEstimator("gpt-tokenizer");
      expect(estimator.name).toBe("gpt-tokenizer");
      const count = estimator.estimate("Hello, world!");
      expect(count).toBeGreaterThan(0);
      // GPT tokenizer should be more accurate than chars/4
      expect(typeof count).toBe("number");
    });

    test("auto strategy returns gpt-tokenizer by default", () => {
      const estimator = createTokenEstimator("auto");
      expect(estimator.name).toBe("gpt-tokenizer");
    });

    test("estimator.supportsProvider returns true for openai", () => {
      const estimator = createTokenEstimator("gpt-tokenizer");
      expect(estimator.supportsProvider("openai")).toBe(true);
      expect(estimator.supportsProvider("deepseek")).toBe(true);
      expect(estimator.supportsProvider("anthropic")).toBe(false);
    });

    test("heuristic estimator supports all providers", () => {
      const estimator = createTokenEstimator("heuristic");
      expect(estimator.supportsProvider("openai")).toBe(true);
      expect(estimator.supportsProvider("anthropic")).toBe(true);
      expect(estimator.supportsProvider("unknown")).toBe(true);
    });

    test("gpt-tokenizer handles code-heavy text", () => {
      const estimator = createTokenEstimator("gpt-tokenizer");
      const code = `
        export function foo(): number {
          const x = 42;
          return x * 2;
        }
      `;
      const count = estimator.estimate(code);
      expect(count).toBeGreaterThan(0);
    });

    test("gpt-tokenizer handles empty string", () => {
      const estimator = createTokenEstimator("gpt-tokenizer");
      expect(estimator.estimate("")).toBe(0);
    });
  });

  describe("estimateTokens helper", () => {
    test("uses gpt-tokenizer for openai provider", () => {
      const text = "Hello, world! This is a test.";
      const count = estimateTokens(text, "openai", "auto");
      expect(count).toBeGreaterThan(0);
      // GPT tokenizer should produce different count than chars/4
      const heuristicCount = Math.ceil(text.length / 4);
      expect(count).not.toBe(heuristicCount); // Different algorithms
    });

    test("uses gpt-tokenizer for deepseek provider", () => {
      const text = "The quick brown fox jumps over the lazy dog.";
      const count = estimateTokens(text, "deepseek", "auto");
      expect(count).toBeGreaterThan(0);
    });

    test("falls back to heuristic for unsupported provider", () => {
      const text = "Hello, world!";
      const count = estimateTokens(text, "anthropic", "auto");
      expect(count).toBe(Math.ceil(text.length / 4));
    });

    test("heuristic strategy always uses chars/4", () => {
      const text = "Hello, world! This is a test.";
      const count = estimateTokens(text, "openai", "heuristic");
      expect(count).toBe(Math.ceil(text.length / 4));
    });
  });
});
