/**
 * Compaction strategies tests — TEST-1 through TEST-4 from TD-010-G.
 *
 * @module compaction-strategies.test
 */

import { describe, expect, test } from "bun:test";
import {
  AbstractiveStrategy,
  ExtractiveStrategy,
  HierarchicalStrategy,
  resolveCompactionStrategy,
} from "../src/core/compaction-strategies.ts";
import type {
  CompactionInput,
  CompactorGenerateFn,
} from "../src/core/compaction-strategies.ts";
import type { EventLogEntry } from "../src/schemas/event-log.ts";
import { generateSessionId } from "../src/core/ids.ts";

// ── Test Helpers ────────────────────────────────────────────────────

function makeEvent(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    schema_version: "0.2.0",
    event_id: generateSessionId(),
    session_id: generateSessionId(),
    parent_session_id: null,
    timestamp: new Date().toISOString(),
    agent_role: "developer",
    model_id: "deepseek-chat",
    prompt_tokens: 100,
    completion_tokens: 50,
    cache_hit: false,
    action: "tool_output",
    ...overrides,
  } as EventLogEntry;
}

function makeMockGenerate(
  summary: string,
  shouldSucceed = true,
): CompactorGenerateFn {
  return async (_prompt: string) => {
    if (!shouldSucceed) {
      return { success: false, error: "LLM error during compaction" };
    }
    return { success: true, result: { summary } };
  };
}

function makeInput(overrides: Partial<CompactionInput> = {}): CompactionInput {
  return {
    task: "Test compaction task",
    role: "developer",
    contextWindow: 128000,
    estimatedTokens: 100000,
    threshold: 0.65,
    events: [
      makeEvent({ action: "task_start" }),
      makeEvent({ action: "tool_output" }),
      makeEvent({ action: "tool_output" }),
      makeEvent({ action: "hitl_approved" }),
      makeEvent({ action: "file_write" }),
    ],
    ...overrides,
  };
}

// ── TEST-1: Abstractive strategy produces summary ───────────────────

describe("AbstractiveStrategy", () => {
  test("produces a summary via LLM", async () => {
    const mockGenerate = makeMockGenerate("This is a compacted summary of the session.");
    const strategy = new AbstractiveStrategy(mockGenerate);
    const input = makeInput();

    const result = await strategy.compact(input);

    expect(result.summary).toBe("This is a compacted summary of the session.");
    expect(result.preservedEvents).toHaveLength(0);
    expect(result.estimatedTokensAfter).toBeGreaterThan(0);
    expect(result.strategy).toBe("abstractive-llm");
    expect(strategy.name).toBe("abstractive-llm");
    expect(strategy.requiresHitl).toBe(false);
  });

  test("throws when LLM call fails", async () => {
    const mockGenerate = makeMockGenerate("", false);
    const strategy = new AbstractiveStrategy(mockGenerate);
    const input = makeInput();

    await expect(strategy.compact(input)).rejects.toThrow("Abstractive compaction failed");
  });

  test("returns strategy name correctly", () => {
    const strategy = new AbstractiveStrategy(makeMockGenerate("test"));
    expect(strategy.name).toBe("abstractive-llm");
  });
});

// ── TEST-2: Extractive strategy preserves critical events ───────────

describe("ExtractiveStrategy", () => {
  test("preserves decision-relevant events", async () => {
    const events: EventLogEntry[] = [
      makeEvent({ action: "task_start" }),
      makeEvent({ action: "tool_output" }),
      makeEvent({ action: "tool_output" }),
      makeEvent({ action: "hitl_approved" }),
      makeEvent({ action: "file_write" }),
      makeEvent({ action: "tool_output" }),
      makeEvent({ action: "task_complete" }),
    ];

    const strategy = new ExtractiveStrategy(3);
    const input = makeInput({ events });

    const result = await strategy.compact(input);

    expect(result.summary).toContain("Extractive Compaction Summary");
    expect(result.summary).toContain("Preserved:");
    expect(result.preservedEvents.length).toBeGreaterThan(0);
    expect(result.strategy).toBe("extractive-events");

    // First event should always be preserved
    expect(result.preservedEvents.some(e => e.action === "task_start")).toBe(true);

    // Decision-relevant events should be preserved
    expect(result.preservedEvents.some(e => e.action === "hitl_approved")).toBe(true);
    expect(result.preservedEvents.some(e => e.action === "file_write")).toBe(true);
    expect(result.preservedEvents.some(e => e.action === "task_complete")).toBe(true);
  });

  test("handles empty events gracefully", async () => {
    const strategy = new ExtractiveStrategy();
    const input = makeInput({ events: [] });

    const result = await strategy.compact(input);

    expect(result.preservedEvents).toHaveLength(0);
    expect(result.estimatedTokensAfter).toBe(0);
  });

  test("preserves last N events", async () => {
    const events: EventLogEntry[] = [];
    for (let i = 0; i < 50; i++) {
      events.push(makeEvent({ action: `step_${i}` }));
    }

    const strategy = new ExtractiveStrategy(5);
    const input = makeInput({ events });

    const result = await strategy.compact(input);

    // Last 5 events should be in preserved
    const lastEventActions = result.preservedEvents.map(e => e.action);
    expect(lastEventActions).toContain("step_49");
    expect(lastEventActions).toContain("step_48");
    expect(lastEventActions).toContain("step_47");
    expect(lastEventActions).toContain("step_46");
    expect(lastEventActions).toContain("step_45");
  });
});

// ── TEST-3: Hierarchical strategy produces nested summary ───────────

describe("HierarchicalStrategy", () => {
  test("produces hierarchical summary via LLM", async () => {
    const hierarchicalSummary = [
      "EXECUTIVE SUMMARY: The session made progress on the task.",
      "TOPICS:",
      "- Architecture: Decided on service-based approach",
      "- Testing: Added unit tests for core modules",
      "CRITICAL DECISIONS: Use service pattern, keep file-based state",
      "CURRENT STATE: Implementing the service layer.",
    ].join("\n");

    const mockGenerate = makeMockGenerate(hierarchicalSummary);
    const strategy = new HierarchicalStrategy(mockGenerate);
    const input = makeInput();

    const result = await strategy.compact(input);

    expect(result.summary).toContain("EXECUTIVE SUMMARY");
    expect(result.summary).toContain("TOPICS:");
    expect(result.summary).toContain("CRITICAL DECISIONS");
    expect(result.strategy).toBe("hierarchical-summary");
    expect(strategy.name).toBe("hierarchical-summary");
  });

  test("throws when LLM call fails", async () => {
    const mockGenerate = makeMockGenerate("", false);
    const strategy = new HierarchicalStrategy(mockGenerate);
    const input = makeInput();

    await expect(strategy.compact(input)).rejects.toThrow("Hierarchical compaction failed");
  });
});

// ── TEST-4: Strategy resolution ────────────────────────────────────

describe("resolveCompactionStrategy", () => {
  const mockGen = makeMockGenerate("test");

  test("resolves abstractive-llm correctly", () => {
    const strategy = resolveCompactionStrategy("abstractive-llm", mockGen);
    expect(strategy.name).toBe("abstractive-llm");
    expect(strategy).toBeInstanceOf(AbstractiveStrategy);
  });

  test("resolves extractive-events correctly", () => {
    const strategy = resolveCompactionStrategy("extractive-events", mockGen);
    expect(strategy.name).toBe("extractive-events");
    expect(strategy).toBeInstanceOf(ExtractiveStrategy);
  });

  test("resolves hierarchical-summary correctly", () => {
    const strategy = resolveCompactionStrategy("hierarchical-summary", mockGen);
    expect(strategy.name).toBe("hierarchical-summary");
    expect(strategy).toBeInstanceOf(HierarchicalStrategy);
  });

  test("falls back to abstractive for unknown strategy", () => {
    const strategy = resolveCompactionStrategy("unknown-strategy", mockGen);
    expect(strategy.name).toBe("abstractive-llm");
    expect(strategy).toBeInstanceOf(AbstractiveStrategy);
  });
});
