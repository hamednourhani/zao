/**
 * Tests for the guard.ts script (TD-032).
 *
 * Verifies:
 * - Clean files produce no violations
 * - R1 (eval) catches forbidden patterns
 * - R4 (hardcoded roles) is excluded from tests/, defaults/, scripts/, guard files
 * - R5 (silent skip) only applies to state-writer files
 *
 * @module guard.test
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { scanDirectory, RULES } from "../scripts/guard.ts";

// ── Temp fixture helpers ───────────────────────────────────────────

let tempDir: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "guard-test-"));
});

afterAll(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * Write a file inside tempDir, creating parent directories as needed.
 */
function writeFixture(relativePath: string, content: string): void {
  const fullPath = path.join(tempDir, relativePath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fullPath, content, "utf-8");
}

// Helper: scan and filter findings for a specific file
function findingsForFile(filePattern: string): ReturnType<typeof scanDirectory>["findings"] {
  const { findings } = scanDirectory(tempDir, RULES);
  return findings.filter((f) => f.file.includes(filePattern));
}

// ── Tests ───────────────────────────────────────────────────────────

describe("guard.ts", () => {
  // Test 1: Clean file — no violations
  test("returns no violations for a clean TypeScript file", () => {
    writeFixture("clean.ts", 'export const x = 42;\nfunction hello() { return "world"; }\n');
    const findings = findingsForFile("clean.ts");
    expect(findings.length).toBe(0);
  });

  // Test 2: eval() triggers R1
  test("detects eval() as R1 violation", () => {
    writeFixture("has-eval.ts", 'export function run() {\n  eval("console.log(1)");\n}\n');
    const r1 = findingsForFile("has-eval.ts").filter((f) => f.rule === "R1-no-eval");
    expect(r1.length).toBeGreaterThan(0);
  });

  // Test 3: R4 is skipped for files under tests/
  test("skips R4 for files in tests/ directory", () => {
    writeFixture("tests/my-test.ts", 'const role = "developer";\n');
    const r4 = findingsForFile("tests/my-test.ts").filter(
      (f) => f.rule === "R4-no-hardcoded-roles",
    );
    expect(r4.length).toBe(0);
  });

  // Test 4: R5 is NOT applied to non-state-writer files
  test("does not apply R5 to non-state-writer files", () => {
    writeFixture(
      "random-util.ts",
      'export function check(result: { success: boolean }) {\n  if (result.success) { console.log("ok"); }\n}\n',
    );
    const r5 = findingsForFile("random-util.ts").filter(
      (f) => f.rule === "R5-no-silent-skip-on-state-write",
    );
    expect(r5.length).toBe(0);
  });

  // Test 5: R5 triggers on state-writer files with silent skip pattern
  test("detects silent skip-on-invalid in state-writer files (R5)", () => {
    writeFixture(
      "core/artifacts.ts",
      'export function process(result: { success: boolean }) {\n  if (result.success) { writeState(); }\n}\nfunction writeState() {}\n',
    );
    const r5 = findingsForFile("core/artifacts.ts").filter(
      (f) => f.rule === "R5-no-silent-skip-on-state-write",
    );
    expect(r5.length).toBeGreaterThan(0);
  });

  // Test 6: R4 skipped for scripts/ directory
  test("skips R4 for files in scripts/ directory", () => {
    writeFixture("scripts/something.ts", 'const role = "planner";\n');
    const r4 = findingsForFile("scripts/something.ts").filter(
      (f) => f.rule === "R4-no-hardcoded-roles",
    );
    expect(r4.length).toBe(0);
  });

  // Test 7: R4 skipped for defaults/ directory
  test("skips R4 for files in defaults/ directory", () => {
    writeFixture("defaults/my-default.ts", 'const role = "architect";\n');
    const r4 = findingsForFile("defaults/my-default.ts").filter(
      (f) => f.rule === "R4-no-hardcoded-roles",
    );
    expect(r4.length).toBe(0);
  });
});
