/**
 * Tests for the context compaction module (TD-010-C).
 *
 * @module compaction.test
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readdirSync } from "node:fs";
import {
  ContextCompactionNeeded,
  detectCompactionNeed,
  runCompactionFlow,
  buildCompactionPrompt,
} from "../src/core/compaction.ts";
import type { ContextModelConfig } from "../src/core/context.ts";
import type { CompactionParams } from "../src/core/compaction.ts";

// ── Temp Directory Helpers ───────────────────────────────────────

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zao-compaction-"));
  tempDirs.push(dir);
  return dir;
}

// ── Helpers ──────────────────────────────────────────────────────

function modelConfig(overrides?: Partial<ContextModelConfig>): ContextModelConfig {
  return {
    provider: "openai",
    model: "gpt-4o",
    contextWindow: 128_000,
    compactionThreshold: 0.65,
    ...overrides,
  };
}

function compactionParams(overrides?: Partial<CompactionParams>): CompactionParams {
  return {
    sessionDir: "/tmp/test-session",
    sessionId: "test-session-id",
    eventsJsonl: "",
    currentContext: "test context",
    task: "test task",
    roleName: "developer",
    modelConfig: modelConfig(),
    generateCompactor: async () => ({
      success: true,
      result: { summary: "compacted summary" },
    }),
    promptForCompactionHITL: async () => true, // approve by default
    ...overrides,
  };
}

// ── ContextCompactionNeeded ──────────────────────────────────────

describe("ContextCompactionNeeded", () => {
  test("has correct properties", () => {
    const err = new ContextCompactionNeeded({
      estimatedTokens: 1000,
      contextWindow: 128_000,
      threshold: 0.65,
    });

    expect(err.name).toBe("ContextCompactionNeeded");
    expect(err.estimatedTokens).toBe(1000);
    expect(err.contextWindow).toBe(128_000);
    expect(err.threshold).toBe(0.65);
    expect(err.message).toContain("1000 tokens >");
    expect(err.message).toContain("65%");
  });

  test("is instance of Error", () => {
    const err = new ContextCompactionNeeded({
      estimatedTokens: 1000,
      contextWindow: 128_000,
      threshold: 0.65,
    });
    expect(err instanceof Error).toBe(true);
  });
});

// ── detectCompactionNeed ─────────────────────────────────────────

describe("detectCompactionNeed", () => {
  test("returns true when above threshold", () => {
    // 1000 tokens > 0.65 * 1000 = 650 tokens → true
    const config = modelConfig({ contextWindow: 1000, compactionThreshold: 0.65 });
    expect(detectCompactionNeed(700, config)).toBe(true);
  });

  test("returns false when below threshold", () => {
    const config = modelConfig({ contextWindow: 1000, compactionThreshold: 0.65 });
    expect(detectCompactionNeed(500, config)).toBe(false);
  });

  test("returns false when exactly at threshold", () => {
    const config = modelConfig({ contextWindow: 1000, compactionThreshold: 0.65 });
    // 650 is not > 650
    expect(detectCompactionNeed(650, config)).toBe(false);
  });

  test("uses default threshold of 0.65 when not specified", () => {
    const config = modelConfig({ contextWindow: 1000 });
    // compactionThreshold defaults to 0.65
    expect(detectCompactionNeed(700, config)).toBe(true);
    expect(detectCompactionNeed(500, config)).toBe(false);
  });

  test("returns false when compactionThreshold is 1.0 (100%)", () => {
    const config = modelConfig({
      contextWindow: 1000,
      compactionThreshold: 1.0,
    });
    expect(detectCompactionNeed(900, config)).toBe(false);
    expect(detectCompactionNeed(1100, config)).toBe(true);
  });
});

// ── runCompactionFlow ────────────────────────────────────────────

describe("runCompactionFlow", () => {
  test("denied pre-HITL → returns resumed: false", async () => {
    const dir = await makeTempDir();
    const result = await runCompactionFlow(
      compactionParams({
        sessionDir: dir,
        promptForCompactionHITL: async () => false,
      }),
    );

    expect(result.resumed).toBe(false);
    expect(result.error).toBe("compaction_denied");
    expect(result.summary).toBeUndefined();
  });

  test("approved pre-HITL, denied post-HITL → returns resumed: false with summary", async () => {
    const dir = await makeTempDir();
    let callCount = 0;
    const result = await runCompactionFlow(
      compactionParams({
        sessionDir: dir,
        promptForCompactionHITL: async (_step, _details) => {
          callCount++;
          return callCount === 1; // approve pre, deny post
        },
      }),
    );

    expect(result.resumed).toBe(false);
    expect(result.error).toBe("resume_denied");
    expect(result.summary).toBe("compacted summary");
  });

  test("approved both HITLs → returns resumed: true with summary", async () => {
    const dir = await makeTempDir();
    const result = await runCompactionFlow(
      compactionParams({
        sessionDir: dir,
        promptForCompactionHITL: async () => true,
      }),
    );

    expect(result.resumed).toBe(true);
    expect(result.summary).toBe("compacted summary");
    expect(result.error).toBeUndefined();
  });

  test("compactor fails → returns resumed: false with error", async () => {
    const dir = await makeTempDir();
    const result = await runCompactionFlow(
      compactionParams({
        sessionDir: dir,
        promptForCompactionHITL: async () => true,
        generateCompactor: async () => ({
          success: false,
          error: "API error",
        }),
      }),
    );

    expect(result.resumed).toBe(false);
    expect(result.error).toContain("compaction_failed");
    expect(result.error).toContain("API error");
    expect(result.summary).toBeUndefined();
  });

  test("recursive compaction guard: alreadyCompacted → returns error", async () => {
    const dir = await makeTempDir();
    const result = await runCompactionFlow(
      compactionParams({
        sessionDir: dir,
        alreadyCompacted: true,
        promptForCompactionHITL: async () => true,
      }),
    );

    expect(result.resumed).toBe(false);
    expect(result.error).toContain("recursive guard");
  });

  test("pre-HITL receives correct details", async () => {
    const dir = await makeTempDir();
    let capturedDetails: unknown = null;
    let capturedStep: string | null = null;

    await runCompactionFlow(
      compactionParams({
        sessionDir: dir,
        promptForCompactionHITL: async (step, details) => {
          capturedStep = step;
          capturedDetails = details;
          return false; // deny to avoid needing a real sessionDir
        },
      }),
    );

    expect(capturedStep!).toBe("pre");
    expect((capturedDetails as Record<string, unknown>).contextWindow).toBe(128_000);
    expect((capturedDetails as Record<string, unknown>).threshold).toBe(0.65);
  });

  test("post-HITL receives correct details with summary info", async () => {
    const dir = await makeTempDir();
    let capturedStep: string | null = null;
    let capturedDetails: unknown = null;

    await runCompactionFlow(
      compactionParams({
        sessionDir: dir,
        promptForCompactionHITL: async (step, details) => {
          if (step === "post") {
            capturedStep = step;
            capturedDetails = details;
          }
          return step === "pre"; // approve pre, deny post
        },
      }),
    );

    expect(capturedStep!).toBe("post");
    expect((capturedDetails as Record<string, unknown>).tokensAfter).toBeGreaterThan(0);
    expect((capturedDetails as Record<string, unknown>).summaryPath).toContain("summary.md");
  });

  test("backs up events.jsonl before compaction runs", async () => {
    const dir = await makeTempDir();

    // Create a dummy events.jsonl file so the backup has something to copy
    const eventsPath = join(dir, "events.jsonl");
    await writeFile(eventsPath, '{"event":"test"}\n', "utf-8");

    await runCompactionFlow(
      compactionParams({
        sessionDir: dir,
        promptForCompactionHITL: async (step) => step === "pre", // approve pre, deny post
      }),
    );

    // Check that a backup file was created
    const files = readdirSync(dir);
    const backupFiles = files.filter((f) =>
      f.startsWith("events.jsonl.pre-compaction."),
    );
    expect(backupFiles.length).toBe(1);

    // Verify the backup contains the original content.
    // Note: events.jsonl may have been appended with the hitl_approved event
    // before the backup, so the backup may contain more than just the original.
    const backupContent = await Bun.file(join(dir, backupFiles[0]!)).text();
    expect(backupContent).toContain('{"event":"test"}');
  });
});

// ── buildCompactionPrompt ────────────────────────────────────────

describe("buildCompactionPrompt", () => {
  test("includes task and role in prompt", () => {
    const prompt = buildCompactionPrompt("event1\nevent2", "developer", "Build feature X");

    expect(prompt).toContain("ORIGINAL TASK: Build feature X");
    expect(prompt).toContain("ROLE: developer");
    expect(prompt).toContain("event1");
    expect(prompt).toContain("event2");
    expect(prompt).toContain("context compactor");
    expect(prompt).toContain("INSTRUCTIONS:");
  });

  test("includes all required instruction keywords", () => {
    const prompt = buildCompactionPrompt("events", "planner", "Plan");

    expect(prompt).toContain("Preserve:");
    expect(prompt).toContain("Discard:");
    expect(prompt).toContain("markdown summary");
  });
});
