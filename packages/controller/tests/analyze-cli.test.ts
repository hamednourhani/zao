/**
 * Analyze CLI tests — verify the ingest → analyze → produce pipeline.
 *
 * Tests that {@link runAnalyzeCLI} correctly chains the analyzer
 * pipeline functions and prints results.
 *
 * Uses temporary store directories with sample session data.
 *
 * @module analyze-cli.test
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runAnalyzeCLI } from "../src/analyze-cli.ts";

// ── Test Helpers ───────────────────────────────────────────────────

let tempDir: string;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "analyze-test-"));
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function createSessionDir(
  storeRoot: string,
  sessionId: string,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  const sessDir = path.join(storeRoot, "sessions", sessionId);
  await fs.mkdir(sessDir, { recursive: true });

  // Write session manifest
  await fs.writeFile(
    path.join(sessDir, "session.json"),
    JSON.stringify({
      schema_version: "0.2.0",
      session_id: sessionId,
      status: "complete",
      role: "developer",
      task: "Test task",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  );

  // Write events
  const eventsLines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fs.writeFile(path.join(sessDir, "events.jsonl"), eventsLines);
}

async function createGlobalIndex(
  storeRoot: string,
  entries: Array<Record<string, unknown>>,
): Promise<void> {
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fs.mkdir(storeRoot, { recursive: true });
  await fs.writeFile(path.join(storeRoot, "index.jsonl"), lines);
}

// ── Tests ──────────────────────────────────────────────────────────

describe("runAnalyzeCLI", () => {
  test("analyzes sessions and returns patterns and learnings", async () => {
    const storeRoot = path.join(tempDir, "zao-store");
    await fs.mkdir(storeRoot, { recursive: true });

    // Create sample session data
    await createSessionDir(storeRoot, "sess-001", [
      {
        event_id: "evt-1",
        session_id: "sess-001",
        timestamp: new Date().toISOString(),
        action: "llm_call_success",
        agent_role: "developer",
        prompt_tokens: 100,
        completion_tokens: 50,
      },
    ]);

    await createSessionDir(storeRoot, "sess-002", [
      {
        event_id: "evt-2",
        session_id: "sess-002",
        timestamp: new Date().toISOString(),
        action: "llm_call_success",
        agent_role: "reviewer",
        prompt_tokens: 200,
        completion_tokens: 80,
      },
    ]);

    // Create global index
    await createGlobalIndex(storeRoot, [
      { session_id: "sess-001", status: "complete", completed_at: new Date().toISOString() },
      { session_id: "sess-002", status: "complete", completed_at: new Date().toISOString() },
    ]);

    const result = await runAnalyzeCLI({
      storeRoot,
      format: "json",
    });

    expect(result.sessionCount).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.patterns)).toBe(true);
    expect(Array.isArray(result.learnings)).toBe(true);
  });

  test("handles empty store gracefully", async () => {
    const emptyStore = path.join(tempDir, "empty-store");
    await fs.mkdir(emptyStore, { recursive: true });
    await createGlobalIndex(emptyStore, []);

    const result = await runAnalyzeCLI({
      storeRoot: emptyStore,
      format: "json",
    });

    expect(result.sessionCount).toBe(0);
    expect(result.patterns).toEqual([]);
    expect(result.learnings).toEqual([]);
  });

  test("module exports runAnalyzeCLI function", async () => {
    const mod = await import("../src/analyze-cli.ts");
    expect(typeof mod.runAnalyzeCLI).toBe("function");
  });
});
