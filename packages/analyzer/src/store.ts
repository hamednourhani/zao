/**
 * Learning store — persists learnings to disk.
 *
 * Writes {@link Learning} arrays as JSON to a file path. Creates
 * parent directories if they don't exist. Overwrites existing files.
 *
 * @module store
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Learning } from "./learner.ts";

// ── Persistence ────────────────────────────────────────────────────

/**
 * Persists an array of learnings to a JSON file.
 *
 * Creates parent directories if they don't exist. Overwrites the
 * file if it already exists.
 *
 * @param learnings - Array of {@link Learning} objects to store.
 * @param outputPath - Path to write the JSON file.
 */
export function storeLearnings(
  learnings: Learning[],
  outputPath: string,
): void {
  const dir = path.dirname(outputPath);

  // Create parent directories if needed
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const json = JSON.stringify(learnings, null, 2);
  // Atomic write: write to temp file first, fsync, then rename (guardrail §6)
  const tmpPath = outputPath + ".tmp";
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, json, "utf-8");
    fs.fdatasyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, outputPath);
}
