/**
 * Compaction fallback strategies — what happens when compaction fails (TD-010-G).
 *
 * When the compactor model fails (network error, rate limit, invalid output),
 * the fallback strategy determines the next action.
 *
 * @module compaction-fallback
 */

/**
 * Available fallback behaviors when compaction fails.
 */
export enum FallbackStrategy {
  /** Stop the session with status `compaction_failed`. The user must resolve. */
  Halt = "halt",
  /** Remove oldest non-essential events and warn. Always HITL-gated. */
  Truncate = "truncate",
  /** Retry compaction with a simpler prompt or fallback model. */
  Retry = "retry",
}

/**
 * Resolves a fallback strategy name to its enum value.
 *
 * Unknown values fall back to `halt` (fail-closed).
 *
 * @param name - The fallback strategy name from config.
 * @returns The resolved FallbackStrategy enum value.
 */
export function resolveFallbackStrategy(name: string): FallbackStrategy {
  switch (name) {
    case "halt":
      return FallbackStrategy.Halt;
    case "truncate":
      return FallbackStrategy.Truncate;
    case "retry":
      return FallbackStrategy.Retry;
    default:
      // Unknown fallback: halt (fail-closed — never silently discard)
      return FallbackStrategy.Halt;
  }
}

/**
 * Result of applying a fallback strategy after compaction failure.
 */
export interface FallbackResult {
  /** Whether execution should continue after the fallback. */
  shouldContinue: boolean;
  /** Human-readable action taken. */
  action: string;
  /** For truncate: number of events removed. */
  eventsRemoved?: number;
  /** Whether HITL approval is required before proceeding. */
  requiresHitl: boolean;
  /** The approval question to present to the user (if requiresHitl). */
  hitlQuestion?: string;
}

/**
 * Applies the configured fallback strategy after a compaction failure.
 *
 * - `halt`: Returns `{ shouldContinue: false }`.
 * - `truncate`: Marks oldest non-essential events for removal.
 *   Requires HITL approval before the removal is executed.
 * - `retry`: Returns `{ shouldContinue: true }` — the caller should
 *   retry compaction with retry-specific options.
 *
 * @param strategy - The fallback strategy to apply.
 * @param eventCount - The current number of events.
 * @param error - The error that caused compaction to fail.
 * @returns A FallbackResult indicating what to do next.
 */
export function applyFallback(
  strategy: FallbackStrategy,
  eventCount: number,
  error: string,
): FallbackResult {
  switch (strategy) {
    case FallbackStrategy.Halt:
      return {
        shouldContinue: false,
        action: `Compaction halted — session stopped. Error: ${error}`,
        requiresHitl: false,
      };

    case FallbackStrategy.Truncate: {
      // Remove oldest 50% of non-essential events
      const toRemove = Math.floor(eventCount * 0.5);
      return {
        shouldContinue: true,
        action: `Truncating ${toRemove} oldest events`,
        eventsRemoved: toRemove,
        requiresHitl: true,
        hitlQuestion: `Compactor failed: ${error}. Truncate oldest ${toRemove} events to continue? This is lossy — key decisions will be preserved. [y/N]`,
      };
    }

    case FallbackStrategy.Retry:
      return {
        shouldContinue: true,
        action: `Retrying compaction after failure: ${error}`,
        requiresHitl: false,
      };

    default:
      return {
        shouldContinue: false,
        action: `Unknown fallback — halting. Error: ${error}`,
        requiresHitl: false,
      };
  }
}
