/**
 * Unified-diff computation and terminal rendering (TD-025).
 *
 * Produces human-readable diffs for file_write HITL prompts. The diff
 * is computed in the executor (which has both old and new content) and
 * passed through `HITLContext.diff` to the prompt renderer.
 *
 * ## ANSI safety
 *
 * ANSI color codes are only emitted in `renderDiffForTerminal()`, which
 * is called from the table-mode path in `hitl.ts`. In JSON mode, the
 * diff is a plain string without escape codes — preserving stdout purity.
 *
 * @module diff-renderer
 */

// ── ANSI Color Constants ──────────────────────────────────────────

const ANSI_RED = "\x1b[31m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_RESET = "\x1b[0m";

// ── Core Functions ────────────────────────────────────────────────

/**
 * Computes a unified diff between old and new file content.
 *
 * Returns `null` for new files (oldContent is null) or for identical
 * content. The diff is formatted with standard unified-diff markers:
 * `---` / `+++` headers, `-` for removed lines, `+` for added lines,
 * space-prefixed for context lines.
 *
 * @param oldContent - The existing file content (null for new files).
 * @param newContent - The proposed new content to write.
 * @param filePath   - The file path for diff headers.
 * @param maxChars   - Optional character cap. Diff is truncated with a
 *                     summary note if exceeded.
 * @returns A unified-diff string, or null if no diff to show.
 */
export function computeUnifiedDiff(
  oldContent: string | null,
  newContent: string,
  filePath: string,
  maxChars?: number,
): string | null {
  if (oldContent === null) return null; // new file — no diff to show

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // Simple line-by-line diff — produce unified format
  const result: string[] = [];
  result.push(`--- a/${filePath}`);
  result.push(`+++ b/${filePath}`);

  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (
      i < oldLines.length &&
      j < newLines.length &&
      oldLines[i] === newLines[j]
    ) {
      result.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else {
      // Determine if it's a removal, addition, or change
      if (
        i < oldLines.length &&
        (j >= newLines.length || oldLines[i] !== newLines[j])
      ) {
        result.push(`-${oldLines[i]}`);
        i++;
      }
      if (
        j < newLines.length &&
        (i >= oldLines.length || oldLines[i] !== newLines[j])
      ) {
        result.push(`+${newLines[j]}`);
        j++;
      }
    }
  }

  const diff = result.join("\n");

  // If no actual changes (no + or - lines, excluding headers), return null.
  const hasChanges = result.some(
    (line) =>
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---")),
  );
  if (!hasChanges) return null;

  if (maxChars && diff.length > maxChars) {
    return (
      diff.slice(0, maxChars) +
      `\n[...truncated, ${diff.length - maxChars} more chars]`
    );
  }
  return diff;
}

/**
 * Renders a diff string for terminal display with ANSI colors.
 *
 * Red (`\x1b[31m`) for removed lines, green (`\x1b[32m`) for added
 * lines. Header lines (`---`/`+++`) and context lines are left as-is.
 *
 * @param diff     - The diff string from {@link computeUnifiedDiff}.
 * @param maxLines - Optional line cap. Diff is truncated with a summary
 *                   note if exceeded.
 * @returns The colorized diff string, or "(new file)" if diff is null.
 */
export function renderDiffForTerminal(
  diff: string | null,
  maxLines?: number,
): string {
  if (!diff) return "(new file)";

  const lines = diff.split("\n");
  const capped = maxLines ? lines.slice(0, maxLines) : lines;

  const colored = capped.map((line) => {
    if (line.startsWith("---") || line.startsWith("+++")) return line;
    if (line.startsWith("-")) return `${ANSI_RED}${line}${ANSI_RESET}`;
    if (line.startsWith("+")) return `${ANSI_GREEN}${line}${ANSI_RESET}`;
    return line;
  });

  if (maxLines && lines.length > maxLines) {
    colored.push(
      `[...truncated, ${lines.length - maxLines} more lines]`,
    );
  }

  return colored.join("\n");
}

/**
 * Caps a diff string at `maxChars`, appending a truncation marker.
 *
 * This is a convenience wrapper around the truncation logic in
 * {@link computeUnifiedDiff} for cases where the diff is already
 * computed and just needs capping.
 *
 * @param diff     - The diff string to cap.
 * @param maxChars - Maximum characters to keep.
 * @returns The capped diff string.
 */
export function capDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  return (
    diff.slice(0, maxChars) +
    `\n[...truncated, ${diff.length - maxChars} more chars]`
  );
}
