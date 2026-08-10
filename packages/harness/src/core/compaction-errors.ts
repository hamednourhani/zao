/**
 * Compaction error types — shared by context.ts and compaction.ts
 * without creating a circular import.
 *
 * @module compaction-errors
 */

/**
 * Thrown by `buildContext()` when the estimated token count exceeds
 * the compaction threshold. Caught by `runLoop()` to trigger the
 * compaction flow.
 */
export class ContextCompactionNeeded extends Error {
  /** The estimated token count at the time of breach. */
  public readonly estimatedTokens: number;
  /** The resolved context window size in tokens. */
  public readonly contextWindow: number;
  /** The compaction threshold fraction (0–1). */
  public readonly threshold: number;

  constructor(opts: {
    estimatedTokens: number;
    contextWindow: number;
    threshold: number;
  }) {
    const pct = Math.round(opts.threshold * 100);
    super(
      `Context compaction needed: ${opts.estimatedTokens} tokens > ` +
        `${opts.contextWindow * opts.threshold} (${pct}% of ${opts.contextWindow})`,
    );
    this.name = "ContextCompactionNeeded";
    this.estimatedTokens = opts.estimatedTokens;
    this.contextWindow = opts.contextWindow;
    this.threshold = opts.threshold;
  }
}
