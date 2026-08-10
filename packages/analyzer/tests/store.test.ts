import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { storeLearnings } from "../src/store.ts";
import type { Learning } from "../src/learner.ts";

let tempDir: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "analyzer-store-"));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  return {
    pattern: "test_pattern",
    action: "warn",
    payload: { message: "Test message." },
    ...overrides,
  };
}

describe("storeLearnings", () => {
  test("writes JSON to file", () => {
    const outputFile = path.join(tempDir, "learnings.json");
    const learnings: Learning[] = [
      makeLearning({ pattern: "high_failure_rate", action: "warn" }),
      makeLearning({ pattern: "quick_wins", action: "create_blueprint" }),
    ];

    storeLearnings(learnings, outputFile);

    expect(fs.existsSync(outputFile)).toBe(true);

    const content = fs.readFileSync(outputFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].pattern).toBe("high_failure_rate");
    expect(parsed[1].action).toBe("create_blueprint");
  });

  test("creates parent directories", () => {
    const deepPath = path.join(tempDir, "deep", "nested", "dir", "output.json");
    const learnings: Learning[] = [makeLearning()];

    // Parent directories should not exist yet
    expect(fs.existsSync(path.dirname(deepPath))).toBe(false);

    storeLearnings(learnings, deepPath);

    expect(fs.existsSync(deepPath)).toBe(true);

    const content = fs.readFileSync(deepPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.length).toBe(1);
  });

  test("overwrites existing file", () => {
    const outputFile = path.join(tempDir, "overwrite-test.json");

    // Write initial content
    const initial: Learning[] = [makeLearning({ pattern: "initial" })];
    storeLearnings(initial, outputFile);

    // Overwrite with new content
    const updated: Learning[] = [
      makeLearning({ pattern: "updated_1" }),
      makeLearning({ pattern: "updated_2" }),
      makeLearning({ pattern: "updated_3" }),
    ];
    storeLearnings(updated, outputFile);

    const content = fs.readFileSync(outputFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.length).toBe(3);
    expect(parsed[0].pattern).toBe("updated_1");
  });

  test("writes empty array", () => {
    const outputFile = path.join(tempDir, "empty.json");
    storeLearnings([], outputFile);

    const content = fs.readFileSync(outputFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed).toEqual([]);
  });
});
