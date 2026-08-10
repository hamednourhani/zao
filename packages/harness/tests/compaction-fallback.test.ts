/**
 * Compaction fallback tests — TEST-5 through TEST-7 from TD-010-G.
 *
 * @module compaction-fallback.test
 */

import { describe, expect, test } from "bun:test";
import {
  FallbackStrategy,
  resolveFallbackStrategy,
  applyFallback,
} from "../src/core/compaction-fallback.ts";

// ── Strategy Resolution ─────────────────────────────────────────────

describe("resolveFallbackStrategy", () => {
  test("resolves halt correctly", () => {
    expect(resolveFallbackStrategy("halt")).toBe(FallbackStrategy.Halt);
  });

  test("resolves truncate correctly", () => {
    expect(resolveFallbackStrategy("truncate")).toBe(FallbackStrategy.Truncate);
  });

  test("resolves retry correctly", () => {
    expect(resolveFallbackStrategy("retry")).toBe(FallbackStrategy.Retry);
  });

  test("defaults to halt for unknown strategy", () => {
    expect(resolveFallbackStrategy("unknown-fallback")).toBe(FallbackStrategy.Halt);
  });

  test("defaults to halt for empty string", () => {
    expect(resolveFallbackStrategy("")).toBe(FallbackStrategy.Halt);
  });
});

// ── TEST-5: halt fallback ───────────────────────────────────────────

describe("applyFallback — halt", () => {
  test("returns shouldContinue: false", () => {
    const result = applyFallback(
      FallbackStrategy.Halt,
      100,
      "LLM rate limit exceeded",
    );

    expect(result.shouldContinue).toBe(false);
    expect(result.requiresHitl).toBe(false);
    expect(result.action).toContain("halted");
    expect(result.action).toContain("LLM rate limit exceeded");
  });
});

// ── TEST-6: truncate fallback ───────────────────────────────────────

describe("applyFallback — truncate", () => {
  test("returns shouldContinue: true with HITL required", () => {
    const result = applyFallback(
      FallbackStrategy.Truncate,
      100,
      "Compactor model timeout",
    );

    expect(result.shouldContinue).toBe(true);
    expect(result.requiresHitl).toBe(true);
    expect(result.hitlQuestion).toBeDefined();
    expect(result.hitlQuestion).toContain("Compactor failed");
    expect(result.hitlQuestion).toContain("Truncate oldest");
    expect(result.eventsRemoved).toBe(50); // 50% of 100
  });

  test("calculates correct truncation amount for odd counts", () => {
    const result = applyFallback(
      FallbackStrategy.Truncate,
      75,
      "Error",
    );

    expect(result.eventsRemoved).toBe(37); // Math.floor(75 * 0.5)
  });

  test("HITL question mentions lossiness", () => {
    const result = applyFallback(
      FallbackStrategy.Truncate,
      10,
      "Error",
    );

    expect(result.hitlQuestion).toContain("lossy");
    expect(result.hitlQuestion).toContain("key decisions will be preserved");
  });
});

// ── TEST-7: retry fallback ─────────────────────────────────────────

describe("applyFallback — retry", () => {
  test("returns shouldContinue: true without HITL", () => {
    const result = applyFallback(
      FallbackStrategy.Retry,
      50,
      "Network error during compaction",
    );

    expect(result.shouldContinue).toBe(true);
    expect(result.requiresHitl).toBe(false);
    expect(result.action).toContain("Retrying");
    expect(result.action).toContain("Network error during compaction");
  });
});

// ── Edge cases ──────────────────────────────────────────────────────

describe("applyFallback edge cases", () => {
  test("truncate with 0 events removes 0", () => {
    const result = applyFallback(
      FallbackStrategy.Truncate,
      0,
      "Error",
    );

    expect(result.eventsRemoved).toBe(0);
  });

  test("truncate with 1 event removes 0 (floor of 0.5)", () => {
    const result = applyFallback(
      FallbackStrategy.Truncate,
      1,
      "Error",
    );

    expect(result.eventsRemoved).toBe(0);
  });

  test("halt preserves error message", () => {
    const longError = "Very detailed error message with context about what went wrong during LLM compaction";
    const result = applyFallback(FallbackStrategy.Halt, 10, longError);

    expect(result.action).toContain(longError);
  });
});
