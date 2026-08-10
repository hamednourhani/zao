/**
 * Public API for `@zao/analyzer` — the learning engine.
 *
 * Reads zao session data from the store, identifies patterns,
 * produces actionable learnings, and persists them to disk.
 *
 * ## Quick start
 *
 * ```typescript
 * import { ingestSessions, analyzePatterns, produceLearnings, storeLearnings } from "@zao/analyzer";
 *
 * const sessions = ingestSessions("~/.zao");
 * const patterns = analyzePatterns(sessions);
 * const learnings = produceLearnings(patterns);
 * storeLearnings(learnings, "~/.zao/learnings.json");
 * ```
 *
 * @module analyzer
 */

// ── Ingest ─────────────────────────────────────────────────────────
export { ingestSessions, readSessionEvents } from "./ingest.ts";
export type { SessionSummary, EventLogEntry } from "./ingest.ts";

// ── Analyzer ───────────────────────────────────────────────────────
export { analyzePatterns } from "./analyzer.ts";
export type { Pattern } from "./analyzer.ts";

// ── Learner ────────────────────────────────────────────────────────
export { produceLearnings, suggestBlueprintImprovements } from "./learner.ts";
export type { Learning, BlueprintSuggestion } from "./learner.ts";

// ── Store ─────────────────────────────────────────────────────────
export { storeLearnings } from "./store.ts";
