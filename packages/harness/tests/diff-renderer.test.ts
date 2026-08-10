/**
 * Tests for the unified-diff renderer (TD-025).
 *
 * @module diff-renderer.test
 */

import { describe, expect, test } from "bun:test";
import {
  computeUnifiedDiff,
  renderDiffForTerminal,
  capDiff,
} from "../src/core/diff-renderer.ts";

describe("computeUnifiedDiff", () => {
  test("returns null for null oldContent (new file)", () => {
    const diff = computeUnifiedDiff(null, "new content", "file.txt");
    expect(diff).toBeNull();
  });

  test("produces correct diff for modified file", () => {
    const oldContent = "line1\nline2\nline3\n";
    const newContent = "line1\nline2-modified\nline3\nline4\n";
    const diff = computeUnifiedDiff(oldContent, newContent, "test.txt");

    expect(diff).not.toBeNull();
    expect(diff!).toContain("--- a/test.txt");
    expect(diff!).toContain("+++ b/test.txt");
    expect(diff!).toContain(" line1");
    expect(diff!).toContain("-line2");
    expect(diff!).toContain("+line2-modified");
    expect(diff!).toContain(" line3");
    expect(diff!).toContain("+line4");
  });

  test("returns null for identical content", () => {
    const content = "line1\nline2\nline3\n";
    const diff = computeUnifiedDiff(content, content, "test.txt");

    // Identical content should return null — no changes to show.
    expect(diff).toBeNull();
  });

  test("cap at maxChars", () => {
    const oldContent = "a\n".repeat(100);
    const newContent = "b\n".repeat(100);
    const diff = computeUnifiedDiff(oldContent, newContent, "test.txt", 50);

    expect(diff).not.toBeNull();
    expect(diff!.length).toBeGreaterThanOrEqual(50);
    expect(diff!).toContain("[...truncated,");
    expect(diff!).toContain("more chars]");
  });

  test("handles empty old content", () => {
    const diff = computeUnifiedDiff("", "new line\n", "test.txt");
    expect(diff).not.toBeNull();
    expect(diff!).toContain("+new line");
  });

  test("handles empty new content", () => {
    const diff = computeUnifiedDiff("old line\n", "", "test.txt");
    expect(diff).not.toBeNull();
    expect(diff!).toContain("-old line");
  });
});

describe("renderDiffForTerminal", () => {
  test("returns (new file) for null diff", () => {
    const rendered = renderDiffForTerminal(null);
    expect(rendered).toBe("(new file)");
  });

  test("adds ANSI red for removed lines", () => {
    const diff = "--- a/file.txt\n+++ b/file.txt\n-old line\n+new line";
    const rendered = renderDiffForTerminal(diff);

    expect(rendered).toContain("\x1b[31m-old line\x1b[0m");
  });

  test("adds ANSI green for added lines", () => {
    const diff = "--- a/file.txt\n+++ b/file.txt\n old line\n+new line";
    const rendered = renderDiffForTerminal(diff);

    expect(rendered).toContain("\x1b[32m+new line\x1b[0m");
  });

  test("does not color header lines", () => {
    const diff = "--- a/file.txt\n+++ b/file.txt";
    const rendered = renderDiffForTerminal(diff);

    expect(rendered).toContain("--- a/file.txt");
    expect(rendered).not.toContain("\x1b[31m--- a/file.txt");
  });

  test("caps at maxLines", () => {
    const diffLines = ["--- a/file.txt", "+++ b/file.txt"];
    for (let i = 0; i < 100; i++) {
      diffLines.push(` line${i}`);
    }
    const diff = diffLines.join("\n");

    const rendered = renderDiffForTerminal(diff, 10);
    const lines = rendered.split("\n");

    // Should have 10 content + 1 truncation note
    expect(lines.length).toBeGreaterThanOrEqual(10);
    expect(lines.length).toBeLessThanOrEqual(11);
    expect(rendered).toContain("[...truncated,");
    expect(rendered).toContain("more lines]");
  });

  test("handles empty diff string", () => {
    const rendered = renderDiffForTerminal("");
    // Empty string is falsy, so renderDiffForTerminal returns "(new file)"
    expect(rendered).toBe("(new file)");
  });
});

describe("capDiff", () => {
  test("returns unchanged if under maxChars", () => {
    const result = capDiff("short diff", 100);
    expect(result).toBe("short diff");
  });

  test("caps and adds truncation marker if over maxChars", () => {
    const longString = "x".repeat(100);
    const result = capDiff(longString, 50);
    expect(result.length).toBeGreaterThanOrEqual(50);
    expect(result).toContain("[...truncated,");
    expect(result).toContain("more chars]");
  });
});
