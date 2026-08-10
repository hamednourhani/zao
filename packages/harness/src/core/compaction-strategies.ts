/**
 * Compaction strategies — pluggable compaction behaviors (TD-010-G).
 *
 * Each strategy defines how conversation history is compacted when the
 * context window threshold is breached. Strategies are selected via
 * config and can be extended with new implementations.
 *
 * @module compaction-strategies
 */

import type { EventLogEntry } from "../schemas/event-log.ts";
import { logger } from "./logger.ts";

// ── Strategy Interface ──────────────────────────────────────────────

/** Input to a compaction strategy. */
export interface CompactionInput {
  /** The original task description. */
  task: string;
  /** The agent role name. */
  role: string;
  /** The model's context window size in tokens. */
  contextWindow: number;
  /** Estimated current token count. */
  estimatedTokens: number;
  /** The compaction threshold fraction (0–1). */
  threshold: number;
  /** The current summary (may be from a previous compaction). */
  summary?: string;
  /** The conversation events to compact. */
  events: EventLogEntry[];
}

/** Output from a compaction strategy. */
export interface CompactionResult {
  /** The generated summary string. */
  summary: string;
  /** Events preserved verbatim (empty for abstractive strategies). */
  preservedEvents: EventLogEntry[];
  /** Estimated token count after compaction. */
  estimatedTokensAfter: number;
  /** Strategy name used. */
  strategy: string;
}

/**
 * Pluggable compaction strategy.
 *
 * Implementations define how conversation history is compacted
 * when the context window threshold is breached.
 */
export interface CompactionStrategy {
  /** Unique strategy identifier. */
  name: string;
  /**
   * Performs compaction on the given input.
   *
   * @param input - The compaction input (task, events, config).
   * @returns A CompactionResult with summary and metadata.
   */
  compact(input: CompactionInput): Promise<CompactionResult>;
  /** Whether this strategy requires human-in-the-loop approval. */
  requiresHitl: boolean;
}

// ── Abstractive Strategy (default, matches TD-010-C) ────────────────

/** Injectable LLM generate function for abstractive compaction. */
export type CompactorGenerateFn = (
  prompt: string,
) => Promise<{ success: boolean; result?: { summary: string }; error?: string }>;

/**
 * Abstractive compaction: delegates to an LLM to produce a prose
 * summary of the conversation history. This is the default strategy
 * from TD-010-C.
 *
 * The LLM is called with a prompt that instructs it to preserve key
 * decisions, files modified, errors, and HITL approvals while
 * discarding retry loops, dead-ends, and verbose tool output.
 */
export class AbstractiveStrategy implements CompactionStrategy {
  name = "abstractive-llm";
  requiresHitl = false; // HITL is handled by the compaction flow, not the strategy

  private generate: CompactorGenerateFn;

  constructor(generate: CompactorGenerateFn) {
    this.generate = generate;
  }

  async compact(input: CompactionInput): Promise<CompactionResult> {
    const prompt = this.buildPrompt(input);

    const result = await this.generate(prompt);

    if (!result.success || !result.result) {
      throw new Error(
        `Abstractive compaction failed: ${result.error ?? "Unknown error"}`,
      );
    }

    const summary = result.result.summary;
    const tokensAfter = Math.ceil(summary.length / 4); // Heuristic estimate

    return {
      summary,
      preservedEvents: [],
      estimatedTokensAfter: tokensAfter,
      strategy: this.name,
    };
  }

  /**
   * Builds the compactor prompt from the conversation history.
   * Exported for testing.
   */
  private buildPrompt(input: CompactionInput): string {
    const eventsText = input.events
      .map((e) => `[${e.action}] ${e.timestamp}: ${typeof e === "object" ? JSON.stringify(e).slice(0, 500) : String(e)}`)
      .join("\n");

    return [
      "You are a context compactor. Summarize the following conversation history.",
      "",
      `ORIGINAL TASK: ${input.task}`,
      `ROLE: ${input.role}`,
      "",
      "INSTRUCTIONS:",
      "- Preserve: the user's original objective, key decisions, files modified, errors and resolutions, HITL approvals, and the current plan/next steps.",
      "- Discard: retry loops, dead-end attempts, verbose tool output now reflected in files, intermediate reasoning.",
      "- Output a concise markdown summary (no more than 2-3 paragraphs).",
      "",
      "CONVERSATION HISTORY:",
      eventsText,
    ].join("\n");
  }
}

// ── Extractive Strategy ─────────────────────────────────────────────

/**
 * Extractive compaction: selects the most important events verbatim
 * without using an LLM. No summarization — events are kept as-is.
 *
 * Selection heuristic:
 * - Always keep the first event (task description)
 * - Always keep the last N events (most recent context)
 * - Keep events with actions that indicate decisions: HITL approvals,
 *   file writes, errors, completions
 * - Discard intermediate reasoning, retry loops, redundant tool output
 *
 * This strategy is useful for debugging/trace-heavy sessions where
 * exact event content matters more than concise summaries.
 */
export class ExtractiveStrategy implements CompactionStrategy {
  name = "extractive-events";
  requiresHitl = false;

  /** Number of most recent events to always preserve. */
  private recentCount: number;

  constructor(recentCount = 20) {
    this.recentCount = recentCount;
  }

  async compact(input: CompactionInput): Promise<CompactionResult> {
    const events = input.events;
    if (events.length === 0) {
      return {
        summary: "(no events to compact)",
        preservedEvents: [],
        estimatedTokensAfter: 0,
        strategy: this.name,
      };
    }

    const preserved = new Set<number>();

    // Always keep first event
    preserved.add(0);

    // Always keep last N events
    const startRecent = Math.max(0, events.length - this.recentCount);
    for (let i = startRecent; i < events.length; i++) {
      preserved.add(i);
    }

    // Keep decision-relevant events
    const importantActions = new Set([
      "hitl_approved",
      "hitl_denied",
      "context_compaction_completed",
      "context_compaction_hitl_approved",
      "context_compaction_hitl_denied",
      "file_write",
      "error",
      "task_complete",
      "task_failed",
      "session_branched",
      "resume_context_approved",
      "resume_context_denied",
    ]);

    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      const action = typeof event.action === "string" ? event.action : "";
      if (importantActions.has(action)) {
        preserved.add(i);
      }
    }

    // Collect preserved events in order
    const preservedEvents = events.filter((_, i) => preserved.has(i));

    // Create a simple summary
    const discardedCount = events.length - preservedEvents.length;
    const summary = [
      `# Extractive Compaction Summary`,
      ``,
      `- Total events: ${events.length}`,
      `- Preserved: ${preservedEvents.length}`,
      `- Discarded: ${discardedCount}`,
      `- Strategy: extractive-events (kept ${this.recentCount} most recent + decision-relevant events)`,
      ``,
      `## Preserved Events`,
      ``,
      ...preservedEvents.map((e) =>
        `- [${e.timestamp}] ${e.action} (agent: ${e.agent_role})`,
      ),
    ].join("\n");

    // Estimate tokens after: count chars in preserved events
    const totalChars = preservedEvents.reduce(
      (sum, e) => sum + JSON.stringify(e).length,
      0,
    );
    const tokensAfter = Math.ceil(totalChars / 4);

    return {
      summary,
      preservedEvents,
      estimatedTokensAfter: tokensAfter,
      strategy: this.name,
    };
  }
}

// ── Hierarchical Strategy ───────────────────────────────────────────

/**
 * Hierarchical compaction: produces a multi-level summary with
 * high-level overview + detailed bullets for each topic.
 *
 * Uses the LLM to generate:
 * 1. A one-sentence executive summary
 * 2. Topic-level summaries for each major area of work
 * 3. Preserved critical events at the end
 *
 * This strategy is useful for long planning sessions where the
 * user needs to quickly grasp the overall direction but can drill
 * into specific areas if needed.
 */
export class HierarchicalStrategy implements CompactionStrategy {
  name = "hierarchical-summary";
  requiresHitl = false;

  private generate: CompactorGenerateFn;

  constructor(generate: CompactorGenerateFn) {
    this.generate = generate;
  }

  async compact(input: CompactionInput): Promise<CompactionResult> {
    const eventsText = input.events
      .map((e) => `[${e.action}] ${e.agent_role}: ${JSON.stringify(e).slice(0, 300)}`)
      .join("\n");

    const prompt = [
      "You are a context compactor. Create a hierarchical summary of the following conversation history.",
      "",
      `ORIGINAL TASK: ${input.task}`,
      `ROLE: ${input.role}`,
      "",
      "STRUCTURE your response as:",
      "1. EXECUTIVE SUMMARY (one sentence — the overall outcome so far)",
      "2. TOPICS (2-5 bullet points, each covering a major area of work)",
      "3. CRITICAL DECISIONS (all irreversible decisions made)",
      "4. CURRENT STATE (what step we're on, what remains)",
      "",
      "CONVERSATION HISTORY:",
      eventsText,
    ].join("\n");

    const result = await this.generate(prompt);

    if (!result.success || !result.result) {
      throw new Error(
        `Hierarchical compaction failed: ${result.error ?? "Unknown error"}`,
      );
    }

    const summary = result.result.summary;
    const tokensAfter = Math.ceil(summary.length / 4);

    return {
      summary,
      preservedEvents: [],
      estimatedTokensAfter: tokensAfter,
      strategy: this.name,
    };
  }
}

// ── Strategy Registry ────────────────────────────────────────────────

/**
 * Resolves a strategy name to its implementation.
 *
 * Unknown strategy names fall back to `abstractive-llm` with a warning
 * logged (but does not throw).
 *
 * @param name - The strategy name from config.
 * @param generate - The injectable LLM generate function.
 * @returns A CompactionStrategy instance.
 */
export function resolveCompactionStrategy(
  name: string,
  generate: CompactorGenerateFn,
): CompactionStrategy {
  switch (name) {
    case "abstractive-llm":
      return new AbstractiveStrategy(generate);
    case "extractive-events":
      return new ExtractiveStrategy();
    case "hierarchical-summary":
      return new HierarchicalStrategy(generate);
    default:
      // Unknown strategy: warn and fall back to abstractive
      logger.warn(
        `Unknown compaction strategy "${name}" — falling back to abstractive-llm.`,
      );
      return new AbstractiveStrategy(generate);
  }
}
