/**
 * Analyze CLI — runs the learning engine and prints patterns/learnings.
 *
 * ## Flow
 *
 * 1. Ingest session data from the zao store.
 * 2. Analyze patterns from session events.
 * 3. Produce learnings from patterns.
 * 4. Store learnings to disk (optional).
 * 5. Print results to stdout.
 *
 * This is a read-only advisory plane command — it does not modify
 * project files or require a sandbox.
 *
 * @module analyze-cli
 */

import {
  ingestSessions,
  analyzePatterns,
  produceLearnings,
  storeLearnings,
} from "@zao/analyzer";
import type { Pattern } from "@zao/analyzer";
import type { Learning } from "@zao/analyzer";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Options for {@link runAnalyzeCLI}.
 */
export interface AnalyzeCLIOptions {
  /** Root of the zao store (e.g. "~/.zao"). @default "~/.zao" */
  storeRoot?: string;
  /** Output format. @default "table" */
  format?: "table" | "json";
}

/**
 * Result of the analyze command.
 */
export interface AnalyzeResult {
  /** Number of sessions ingested. */
  sessionCount: number;
  /** Patterns identified from session data. */
  patterns: Pattern[];
  /** Learnings produced from patterns. */
  learnings: Learning[];
  /** Path where learnings were stored (if any). */
  learningPath?: string;
}

/**
 * Runs the full analyze pipeline: ingest → analyze → produce → store → print.
 *
 * @param options - CLI options (storeRoot, format).
 * @returns The analyze result with patterns and learnings.
 */
export async function runAnalyzeCLI(
  options: AnalyzeCLIOptions,
): Promise<AnalyzeResult> {
  const storeRoot = options.storeRoot ?? join(homedir(), ".zao");
  const format = options.format ?? "table";

  // ── Step 1: Ingest sessions ──────────────────────────────────────
  const sessions = ingestSessions(storeRoot);

  // ── Step 2: Analyze patterns ─────────────────────────────────────
  const patterns = analyzePatterns(sessions);

  // ── Step 3: Produce learnings ────────────────────────────────────
  const learnings = produceLearnings(patterns);

  // ── Step 4: Store learnings (optional, best-effort) ──────────────
  let learningPath: string | undefined;
  try {
    learningPath = `${storeRoot}/learnings.json`;
    storeLearnings(learnings, learningPath);
  } catch {
    // Best-effort: learnings storage is diagnostic
    learningPath = undefined;
  }

  // ── Step 5: Print results ────────────────────────────────────────
  if (format === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          sessionCount: sessions.length,
          patterns,
          learnings,
          learningPath,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`\nAnalyzed ${sessions.length} sessions.\n`);
    process.stdout.write(`\n--- Patterns (${patterns.length}) ---\n`);
    for (const pattern of patterns) {
      process.stdout.write(`  • ${pattern.name}: ${pattern.description}\n`);
      process.stdout.write(`    Confidence: ${pattern.confidence}\n`);
      if (pattern.suggestion) {
        process.stdout.write(`    Suggestion: ${pattern.suggestion}\n`);
      }
    }
    process.stdout.write(`\n--- Learnings (${learnings.length}) ---\n`);
    for (const learning of learnings) {
      process.stdout.write(`  • [${learning.action}] ${learning.pattern}\n`);
      process.stdout.write(`    Payload: ${JSON.stringify(learning.payload)}\n`);
    }
  }

  return {
    sessionCount: sessions.length,
    patterns,
    learnings,
    learningPath,
  };
}
