/**
 * Execution Store tests — TD-029-A.
 *
 * Covers:
 * - TEST-1: initExecution creates directory with execution.json, index.jsonl, events.jsonl
 * - TEST-2: appendExecutionIndexLine and readExecutionIndex round-trip
 * - TEST-3: appendExecutionEvent writes controller events
 * - Manifest write/read with schema validation
 * - Edge cases: empty reads, truncation tolerance, fail-closed validation
 *
 * @module execution-store.test
 */

import { describe, expect, test, afterAll } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  resolveExecutionStoreRoot,
  initExecution,
  appendExecutionIndexLine,
  readExecutionIndex,
  writeExecutionManifest,
  readExecutionManifest,
  appendExecutionEvent,
} from "../src/execution-store.ts";
import type {
  ExecutionManifest,
  ExecutionIndexLine,
} from "../src/execution-store.ts";

// ── Temp Directories ─────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-exec-${randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
});

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Creates a fresh execution directory with a unique id.
 * Returns both the directory path and the params used to create it.
 */
async function createTestExecution(overrides?: {
  execution_id?: string;
  task?: string;
  repo_root?: string;
}): Promise<{ executionDir: string; executionId: string }> {
  const executionId = overrides?.execution_id ?? randomUUID();
  const { executionDir } = await initExecution({
    execution_id: executionId,
    task: overrides?.task ?? "Test task for execution store",
    repo_root: overrides?.repo_root ?? "/tmp/test-repo",
  });
  return { executionDir, executionId };
}

// ── TEST-1: Execution directory creation ──────────────────────

describe("Execution Store — TEST-1: initExecution creates directory", () => {
  test("creates execution directory with execution.json", async () => {
    const executionId = randomUUID();
    const { executionDir } = await createTestExecution({ execution_id: executionId });

    // Verify directory exists
    const { stat } = await import("node:fs/promises");
    const dirStat = await stat(executionDir);
    expect(dirStat.isDirectory()).toBe(true);

    // Verify execution.json exists and is valid
    const manifest = await readExecutionManifest(executionDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.execution_id).toBe(executionId);
    expect(manifest!.status).toBe("active");
    expect(manifest!.task).toBe("Test task for execution store");
    expect(manifest!.repo_root).toBe("/tmp/test-repo");
    expect(manifest!.schema_version).toBe("0.2.0");
    expect(typeof manifest!.created_at).toBe("string");
    // Verify index.jsonl exists as an empty file (ADR-008 layout contract)
    const { readFile } = await import("node:fs/promises");
    const indexPath = join(executionDir, "index.jsonl");
    const indexContent = await readFile(indexPath, "utf-8");
    expect(indexContent).toBe("");

    // Read index — should return empty array
    const indexEntries = await readExecutionIndex(executionDir);
    expect(indexEntries).toEqual([]);
  });

  test("execution.json manifest is valid JSON with all required fields", async () => {
    const executionId = randomUUID();
    const { executionDir } = await createTestExecution({
      execution_id: executionId,
      task: "Build the spaceship",
      repo_root: "/home/user/repo",
    });

    const manifest = await readExecutionManifest(executionDir);

    expect(manifest).not.toBeNull();
    expect(manifest!.execution_id).toBe(executionId);
    expect(manifest!.status).toBe("active");
    expect(manifest!.task).toBe("Build the spaceship");
    expect(manifest!.repo_root).toBe("/home/user/repo");
    expect(manifest!.schema_version).toBe("0.2.0");
    // created_at should be a valid ISO-8601 timestamp
    expect(Date.parse(manifest!.created_at)).not.toBeNaN();
  });

  test("execution_created event is appended to events.jsonl", async () => {
    const executionId = randomUUID();
    const { executionDir } = await createTestExecution({ execution_id: executionId });

    // Read events.jsonl
    const { readFile } = await import("node:fs/promises");
    const eventsPath = join(executionDir, "events.jsonl");
    const raw = await readFile(eventsPath, "utf-8");
    const lines = raw.trim().split("\n");

    expect(lines.length).toBeGreaterThanOrEqual(1);

    const firstEvent = JSON.parse(lines[0]!);
    expect(firstEvent.type).toBe("execution_created");
    expect(firstEvent.execution_id).toBe(executionId);
    expect(typeof firstEvent.timestamp).toBe("string");
  });
});

// ── TEST-2: Index append/read round-trip ──────────────────────

describe("Execution Store — TEST-2: Index append/read", () => {
  test("appends index lines and reads them back in order", async () => {
    const { executionDir } = await createTestExecution();

    // Append two session index lines
    const line1: ExecutionIndexLine = {
      session_id: randomUUID(),
      status: "active",
      started_at: new Date().toISOString(),
      completed_at: null,
    };
    const line2: ExecutionIndexLine = {
      session_id: randomUUID(),
      status: "complete",
      started_at: new Date(Date.now() - 60000).toISOString(),
      completed_at: new Date().toISOString(),
    };

    await appendExecutionIndexLine(executionDir, line1);
    await appendExecutionIndexLine(executionDir, line2);

    // Read back
    const entries = await readExecutionIndex(executionDir);

    expect(entries.length).toBe(2);
    expect(entries[0]!.session_id).toBe(line1.session_id);
    expect(entries[0]!.status).toBe("active");
    expect(entries[1]!.session_id).toBe(line2.session_id);
    expect(entries[1]!.status).toBe("complete");
  });

  test("last-line-wins: completion line overrides creation line for same session_id", async () => {
    const { executionDir } = await createTestExecution();
    const sessionId = randomUUID();

    // Creation line
    await appendExecutionIndexLine(executionDir, {
      session_id: sessionId,
      status: "active",
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: null,
    });

    // Completion line (same session_id)
    await appendExecutionIndexLine(executionDir, {
      session_id: sessionId,
      status: "complete",
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: "2026-01-01T01:00:00.000Z",
    });

    const entries = await readExecutionIndex(executionDir);

    // Should have only one resolved entry (last-line-wins)
    expect(entries.length).toBe(1);
    expect(entries[0]!.session_id).toBe(sessionId);
    expect(entries[0]!.status).toBe("complete");
    expect(entries[0]!.completed_at).toBe("2026-01-01T01:00:00.000Z");
  });

  test("readExecutionIndex returns empty array for new execution", async () => {
    const { executionDir } = await createTestExecution();
    const entries = await readExecutionIndex(executionDir);
    expect(entries).toEqual([]);
  });

  test("readExecutionIndex returns empty array for non-existent directory", async () => {
    const nonExistentDir = join("/tmp", `zao-test-noexist-${randomUUID()}`);
    const entries = await readExecutionIndex(nonExistentDir);
    expect(entries).toEqual([]);
  });

  test("readExecutionIndex handles multiple sessions with interleaved creation/completion", async () => {
    const { executionDir } = await createTestExecution();
    const sid1 = randomUUID();
    const sid2 = randomUUID();

    // Session 1 created
    await appendExecutionIndexLine(executionDir, {
      session_id: sid1,
      status: "active",
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: null,
    });

    // Session 2 created
    await appendExecutionIndexLine(executionDir, {
      session_id: sid2,
      status: "active",
      started_at: "2026-01-01T00:01:00.000Z",
      completed_at: null,
    });

    // Session 1 completed
    await appendExecutionIndexLine(executionDir, {
      session_id: sid1,
      status: "complete",
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: "2026-01-01T01:00:00.000Z",
    });

    const entries = await readExecutionIndex(executionDir);

    // Two resolved entries
    expect(entries.length).toBe(2);

    const entry1 = entries.find((e) => e.session_id === sid1);
    const entry2 = entries.find((e) => e.session_id === sid2);

    expect(entry1!.status).toBe("complete");
    expect(entry1!.completed_at).toBe("2026-01-01T01:00:00.000Z");
    expect(entry2!.status).toBe("active");
    expect(entry2!.completed_at).toBeNull();
  });
});

// ── TEST-3: Event logging ────────────────────────────────────

describe("Execution Store — TEST-3: Event logging", () => {
  test("appends multiple events and they accumulate in events.jsonl", async () => {
    const executionId = randomUUID();
    const { executionDir } = await createTestExecution({ execution_id: executionId });

    // Append additional events
    await appendExecutionEvent(executionDir, {
      type: "execution_resumed",
      execution_id: executionId,
      timestamp: new Date().toISOString(),
      detail: { resumed_from: "step-3" },
    });

    await appendExecutionEvent(executionDir, {
      type: "execution_completed",
      execution_id: executionId,
      timestamp: new Date().toISOString(),
    });

    // Read events.jsonl
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(executionDir, "events.jsonl"), "utf-8");
    const lines = raw.trim().split("\n");

    // Should have 3 events: created (from init), resumed, completed
    expect(lines.length).toBe(3);

    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toContain("execution_created");
    expect(types).toContain("execution_resumed");
    expect(types).toContain("execution_completed");
  });

  test("execution_failed event is appended correctly", async () => {
    const executionId = randomUUID();
    const { executionDir } = await createTestExecution({ execution_id: executionId });

    await appendExecutionEvent(executionDir, {
      type: "execution_failed",
      execution_id: executionId,
      timestamp: new Date().toISOString(),
      detail: { error: "Something went wrong", step: "step-2" },
    });

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(executionDir, "events.jsonl"), "utf-8");
    const lines = raw.trim().split("\n");

    const failedEvent = JSON.parse(lines[1]!); // line 0 is execution_created
    expect(failedEvent.type).toBe("execution_failed");
    expect(failedEvent.detail.error).toBe("Something went wrong");
    expect(failedEvent.detail.step).toBe("step-2");
  });

  test("event validation rejects invalid event types", async () => {
    const { executionDir } = await createTestExecution();

    await expect(
      appendExecutionEvent(executionDir, {
        type: "invalid_event_type" as never,
        execution_id: "test",
        timestamp: new Date().toISOString(),
      }),
    ).rejects.toThrow(/validation/i);
  });
});

// ── Manifest Write/Read ───────────────────────────────────────

describe("Execution Store — Manifest operations", () => {
  test("writeExecutionManifest with valid manifest succeeds", async () => {
    const dir = makeTempDir();
    await mkdir(dir, { recursive: true });

    const manifest: ExecutionManifest = {
      execution_id: randomUUID(),
      status: "active",
      created_at: new Date().toISOString(),
      repo_root: "/tmp/test-repo",
      task: "Test manifest write",
      schema_version: "0.2.0",
    };

    await writeExecutionManifest(dir, manifest);

    // Read it back
    const read = await readExecutionManifest(dir);
    expect(read).not.toBeNull();
    expect(read!.execution_id).toBe(manifest.execution_id);
    expect(read!.status).toBe("active");
    expect(read!.task).toBe("Test manifest write");
  });

  test("writeExecutionManifest rejects manifest with missing required field", async () => {
    const dir = makeTempDir();
    await mkdir(dir, { recursive: true });

    // Missing schema_version
    const invalid = {
      execution_id: randomUUID(),
      status: "active",
      created_at: new Date().toISOString(),
      repo_root: "/tmp/test-repo",
      task: "Bad manifest",
      // schema_version intentionally missing
    };

    await expect(
      writeExecutionManifest(dir, invalid as ExecutionManifest),
    ).rejects.toThrow(/validation/i);
  });

  test("writeExecutionManifest rejects manifest with invalid status", async () => {
    const dir = makeTempDir();
    await mkdir(dir, { recursive: true });

    const invalid = {
      execution_id: randomUUID(),
      status: "unknown_status" as "active",
      created_at: new Date().toISOString(),
      repo_root: "/tmp/test-repo",
      task: "Bad status",
      schema_version: "0.2.0" as const,
    };

    await expect(
      writeExecutionManifest(dir, invalid),
    ).rejects.toThrow(/validation/i);
  });

  test("readExecutionManifest returns null for non-existent file", async () => {
    const dir = makeTempDir();
    await mkdir(dir, { recursive: true });

    const manifest = await readExecutionManifest(dir);
    expect(manifest).toBeNull();
  });

  test("readExecutionManifest throws on invalid JSON", async () => {
    const dir = makeTempDir();
    await mkdir(dir, { recursive: true });

    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "execution.json"), "not valid json {{{");

    await expect(readExecutionManifest(dir)).rejects.toThrow(/Invalid JSON/i);
  });

  test("readExecutionManifest throws on empty file", async () => {
    const dir = makeTempDir();
    await mkdir(dir, { recursive: true });

    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "execution.json"), "");

    await expect(readExecutionManifest(dir)).rejects.toThrow(/empty/i);
  });

  test("manifest updates: writing a new status is reflected on read", async () => {
    const dir = makeTempDir();
    await mkdir(dir, { recursive: true });

    const manifest: ExecutionManifest = {
      execution_id: randomUUID(),
      status: "active",
      created_at: new Date().toISOString(),
      repo_root: "/tmp/test-repo",
      task: "Will be completed",
      schema_version: "0.2.0",
    };

    await writeExecutionManifest(dir, manifest);

    // Update status
    const updated: ExecutionManifest = { ...manifest, status: "complete" };
    await writeExecutionManifest(dir, updated);

    const read = await readExecutionManifest(dir);
    expect(read!.status).toBe("complete");
  });
});

// ── Store Root Resolution ─────────────────────────────────────

describe("Execution Store — Store root resolution", () => {
  test("resolveExecutionStoreRoot resolves to a path under .mo", async () => {
    // Use a temp ZAO_HOME to avoid creating ~/.zao in the real home directory
    const customBase = makeTempDir();
    const savedMoHome = process.env["ZAO_HOME"];
    const savedXdg = process.env["XDG_DATA_HOME"];
    process.env["ZAO_HOME"] = customBase;
    delete process.env["XDG_DATA_HOME"];

    try {
      const root = await resolveExecutionStoreRoot();
      // Should end with .zao/executions under the custom base
      expect(root).toBe(join(customBase, "executions"));
    } finally {
      if (savedMoHome) process.env["ZAO_HOME"] = savedMoHome;
      else delete process.env["ZAO_HOME"];
      if (savedXdg) process.env["XDG_DATA_HOME"] = savedXdg;
    }
  });

  test("resolveExecutionStoreRoot respects ZAO_HOME", async () => {
    const customBase = makeTempDir();
    const savedMoHome = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = customBase;

    try {
      const root = await resolveExecutionStoreRoot();
      expect(root).toBe(join(customBase, "executions"));
    } finally {
      if (savedMoHome) process.env["ZAO_HOME"] = savedMoHome;
      else delete process.env["ZAO_HOME"];
    }
  });
});

// ── Edge Cases ────────────────────────────────────────────────

describe("Execution Store — Edge cases", () => {
  test("initExecution is idempotent — calling twice with same id doesn't crash", async () => {
    const executionId = randomUUID();
    const { executionDir } = await createTestExecution({ execution_id: executionId });

    // Call init again with the same execution_id
    const { executionDir: dir2 } = await initExecution({
      execution_id: executionId,
      task: "Same task, second init",
      repo_root: "/tmp/test-repo",
    });

    expect(dir2).toBe(executionDir);

    // Manifest should still be readable
    const manifest = await readExecutionManifest(executionDir);
    expect(manifest).not.toBeNull();
  });

  test("appendExecutionIndexLine handles special characters in session_id", async () => {
    const { executionDir } = await createTestExecution();

    const line: ExecutionIndexLine = {
      session_id: "session-with-dashes_and_underscores",
      status: "active",
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: null,
    };

    await appendExecutionIndexLine(executionDir, line);

    const entries = await readExecutionIndex(executionDir);
    expect(entries.length).toBe(1);
    expect(entries[0]!.session_id).toBe(line.session_id);
  });

  test("index.jsonl survives truncation — unparseable last line is skipped", async () => {
    const dir = makeTempDir();
    await mkdir(dir, { recursive: true });

    // Write a valid line followed by truncated content
    const { writeFile } = await import("node:fs/promises");
    const validLine = JSON.stringify({
      session_id: "valid-session",
      status: "active",
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: null,
    }) + "\n";
    // Truncated JSON (missing closing brace)
    await writeFile(join(dir, "index.jsonl"), validLine + '{"session_id": "incomplete');

    const entries = await readExecutionIndex(dir);
    // Should only have the valid line
    expect(entries.length).toBe(1);
    expect(entries[0]!.session_id).toBe("valid-session");
  });
});
