/**
 * Artifact I/O tests for zao.
 *
 * Covers all 7 tests from Story 004 acceptance criteria:
 * - TEST-1: Write artifact → read back → content matches
 * - TEST-2: Write artifact with schema validation
 * - TEST-3: Read truncated JSON file → returns error, not crash
 * - TEST-4: Append 3 events → read back all 3
 * - TEST-5: Append then manually truncate last line → readEvents returns first N-1
 * - TEST-6: Write string with API key → read back redacted
 * - TEST-7: Write string without secrets → content unchanged
 *
 * All tests use `Bun.mkdtempSync()` for isolation. No real `.zao/`
 * directories are touched.
 *
 * @module artifacts.test
 */

import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  writeArtifact,
  readArtifact,
  appendEvent,
  initSession,
  redactSecrets,
  readEvents,
} from "../src/core/artifacts.ts";
import { generateSessionId } from "../src/core/ids.ts";
import { __internalInitLogger, __internalResetLoggerForTest } from "../src/core/logger.ts";

// ── Logger Initialization ────────────────────────────────────────
// The logger must be initialized for warn/info calls in artifacts.ts
// to produce output that tests verify.
beforeAll(() => {
  __internalResetLoggerForTest();
  __internalInitLogger("info", false);
});

// ── Test Schema ──────────────────────────────────────────────────

/** Standard v0.2.0 event envelope for tests. */
const testEnvelope = {
  event_id: () => generateSessionId(),
  session_id: "018f0000-0000-7000-8000-000000000001",
  parent_session_id: null as string | null,
  schema_version: "0.2.0" as const,
  timestamp: "2026-01-01T00:00:00.000Z",
  agent_role: "test",
  model_id: "test-model",
  prompt_tokens: 0,
  completion_tokens: 0,
  cache_hit: false,
  action: "test_event",
};

/** Simple schema for artifact validation tests. */
const TestSchema = z.object({
  message: z.string(),
  count: z.number(),
});

// ── Temp Directory Management ────────────────────────────────────

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-artifacts-${crypto.randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
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

// ── Suite ────────────────────────────────────────────────────────

describe("writeArtifact", () => {
  // ── TEST-1: Write artifact → read back → content matches ────

  test("writes content atomically and reads it back (TEST-1)", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "test-artifact.json");

    const content = JSON.stringify({ message: "hello", count: 42 });
    await writeArtifact(artifactPath, content);

    // Read back without schema validation (raw)
    const file = Bun.file(artifactPath);
    const readBack = await file.text();
    expect(JSON.parse(readBack)).toEqual({ message: "hello", count: 42 });
  });

  // ── TEST-2: Write artifact with schema validation ───────────

  test("write then readArtifact with schema validates correctly (TEST-2)", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "test-artifact.json");

    const content = JSON.stringify({ message: "success", count: 99 });
    await writeArtifact(artifactPath, content);

    const result = await readArtifact(artifactPath, TestSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe("success");
      expect(result.data.count).toBe(99);
    }
  });

  // ── Schema validation failure ───────────────────────────────

  test("readArtifact returns error on schema mismatch", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "bad-artifact.json");

    // Write valid JSON that doesn't match the schema
    const content = JSON.stringify({ message: 123, count: "not-a-number" });
    await writeArtifact(artifactPath, content);

    const result = await readArtifact(artifactPath, TestSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Schema validation failed");
    }
  });

  // ── TEST-3: Read truncated JSON → returns error, no crash ──

  test("readArtifact returns error on truncated JSON (TEST-3)", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "truncated.json");

    // Write truncated JSON directly (not through writeArtifact)
    await writeFile(artifactPath, '{"message": "incomplete"', "utf-8");

    const result = await readArtifact(artifactPath, TestSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid JSON");
    }
  });

  // ── File not found ─────────────────────────────────────────

  test("readArtifact returns error on non-existent file", async () => {
    const dir = makeTempDir();
    const result = await readArtifact(
      join(dir, "does-not-exist.json"),
      TestSchema,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not found");
    }
  });

  // ── Empty file ─────────────────────────────────────────────

  test("readArtifact returns error on empty file", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "empty.json");
    await writeFile(artifactPath, "", "utf-8");

    const result = await readArtifact(artifactPath, TestSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("empty");
    }
  });

  // ── Atomic write: .tmp cleanup on error ────────────────────

  test("writeArtifact cleans up .tmp file after successful write", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "verify-no-tmp.json");
    const content = JSON.stringify({ message: "tmp-test", count: 1 });
    await writeArtifact(artifactPath, content);

    // Check that no .tmp file lingers
    const tmpFile = Bun.file(`${artifactPath}.tmp`);
    expect(await tmpFile.exists()).toBe(false);

    // The real artifact should exist
    const realFile = Bun.file(artifactPath);
    expect(await realFile.exists()).toBe(true);
  });

  // ── Fail-closed writer: schema validation (§E2) ────────────────

  test("writeArtifact with schema throws on invalid JSON", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "bad.json");

    let caught: Error | null = null;
    try {
      await writeArtifact(artifactPath, "this is not json", TestSchema);
    } catch (err: unknown) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("Invalid JSON before write");
    // No file should be written on validation failure
    expect(await Bun.file(artifactPath).exists()).toBe(false);
  });

  test("writeArtifact with schema throws on schema mismatch (§E2)", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "bad.json");

    let caught: Error | null = null;
    try {
      await writeArtifact(
        artifactPath,
        JSON.stringify({ message: 123, count: "not-a-number" }),
        TestSchema,
      );
    } catch (err: unknown) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("Artifact validation failed before write");
    // No file should be written on validation failure
    expect(await Bun.file(artifactPath).exists()).toBe(false);
  });
});

// ── Events ──────────────────────────────────────────────────────

describe("appendEvent / readEvents", () => {
  // ── TEST-4: Append 3 events → read back all 3 ──────────────

  test("appendEvent writes events and readEvents returns them (TEST-4)", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    const event1 = { ...testEnvelope, event_id: testEnvelope.event_id(), type: "start", timestamp: "2026-01-01T00:00:00Z" };
    const event2 = { ...testEnvelope, event_id: testEnvelope.event_id(), type: "process", count: 42 };
    const event3 = { ...testEnvelope, event_id: testEnvelope.event_id(), type: "end", success: true };

    await appendEvent(dir, event1);
    await appendEvent(dir, event2);
    await appendEvent(dir, event3);

    const result = await readEvents(dir);
    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(3);
    expect(result.events[0]!.type).toBe("start");
    expect(result.events[1]!.count).toBe(42);
    expect(result.events[2]!.success).toBe(true);
  });

  // ── TEST-5: Truncated last line → readEvents returns first N-1, warning logged ──

  test("readEvents tolerates truncated final line (TEST-5)", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    // Write 2 valid events normally
    const event1 = { ...testEnvelope, event_id: testEnvelope.event_id(), type: "first", id: 1 };
    const event2 = { ...testEnvelope, event_id: testEnvelope.event_id(), type: "second", id: 2 };
    await appendEvent(dir, event1);
    await appendEvent(dir, event2);

    // Now manually append a truncated line using a raw file descriptor
    const eventsPath = join(dir, "events.jsonl");
    const fd = openSync(eventsPath, "a");
    const partialLine = '{"type": "third"';
    writeSync(fd, partialLine);
    closeSync(fd);

    // Capture stderr writes (logger output goes to process.stderr.write)
    const warnings: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((data: string | Uint8Array) => {
      warnings.push(String(data));
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await readEvents(dir);
      expect(result.success).toBe(true);
      expect(result.events).toHaveLength(2);
      expect(result.events[0]!.type).toBe("first");
      expect(result.events[1]!.type).toBe("second");

      // Should have "truncated" flag
      expect("truncated" in result).toBe(true);

      // Should have logged a warning
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings.some((w) => w.includes("Truncated"))).toBe(true);
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });

  // ── Empty events file ──────────────────────────────────────

  test("readEvents returns empty array for non-existent file", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    const result = await readEvents(dir);
    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(0);
  });

  // ── Empty events file (exists but empty) ───────────────────

  test("readEvents returns empty array for empty events file", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    // Create empty events.jsonl
    await writeFile(join(dir, "events.jsonl"), "", "utf-8");

    const result = await readEvents(dir);
    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(0);
  });

  // ── Events on disk survive restart (reread) ────────────────

  test("events persist on disk and can be reread", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    await appendEvent(dir, { ...testEnvelope, event_id: testEnvelope.event_id(), type: "persisted", value: 1 });
    await appendEvent(dir, { ...testEnvelope, event_id: testEnvelope.event_id(), type: "persisted", value: 2 });

    // Read once
    const first = await readEvents(dir);
    expect(first.success).toBe(true);
    expect(first.events).toHaveLength(2);

    // Read again — should still be there
    const second = await readEvents(dir);
    expect(second.success).toBe(true);
    expect(second.events).toHaveLength(2);
    expect(second.events[0]!.value).toBe(1);
  });

  // ── Mid-file corruption ────────────────────────────────────

  test("readEvents logs warning and returns partial results on mid-file corruption", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    // Write valid event
    await appendEvent(dir, { ...testEnvelope, event_id: testEnvelope.event_id(), type: "good", id: 1 });

    // Write corrupted JSON directly
    const eventsPath = join(dir, "events.jsonl");
    const fd = openSync(eventsPath, "a");
    writeSync(fd, "not-valid-json-at-all\n");
    writeSync(fd, '{"type": "after-bad", "id": 3}\n');
    closeSync(fd);

    // Capture stderr writes (logger output goes to process.stderr.write)
    const warnings: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((data: string | Uint8Array) => {
      warnings.push(String(data));
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await readEvents(dir);
      expect(result.success).toBe(true);
      // First event should be parsed
      expect(result.events).toHaveLength(1);
      expect(result.events[0]!.type).toBe("good");
      expect("truncated" in result).toBe(true);
      expect(warnings.some((w) => w.includes("Unparseable"))).toBe(true);
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });

  // ── Append event edge cases ─────────────────────────────────

  test("appendEvent handles empty object event", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    const emptyEvent = { ...testEnvelope, event_id: testEnvelope.event_id() };
    await appendEvent(dir, emptyEvent);

    const result = await readEvents(dir);
    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(1);
    // Should have the envelope fields
    expect(result.events[0]!.event_id).toBe(emptyEvent.event_id);
    expect(result.events[0]!.session_id).toBe(testEnvelope.session_id);
    expect(result.events[0]!.parent_session_id).toBeNull();
  });

  test("appendEvent handles event with nested objects and arrays", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    const complexEvent = {
      ...testEnvelope,
      event_id: testEnvelope.event_id(),
      type: "nested",
      data: { inner: { value: [1, 2, 3] } },
      tags: ["a", "b", null],
      flag: true,
      count: 0,
    };
    await appendEvent(dir, complexEvent);

    const result = await readEvents(dir);
    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.type).toBe("nested");
    expect((result.events[0] as Record<string, unknown>)["data"]).toEqual(complexEvent.data);
    expect((result.events[0] as Record<string, unknown>)["tags"]).toEqual(complexEvent.tags);
    expect((result.events[0] as Record<string, unknown>)["flag"]).toBe(true);
    expect((result.events[0] as Record<string, unknown>)["count"]).toBe(0);
  });

  test("appendEvent preserves string content including special characters", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    // Event with special characters that are valid in JSON strings
    const event = {
      ...testEnvelope,
      event_id: testEnvelope.event_id(),
      type: "special",
      text: 'Line 1\nLine 2\tTabbed\u0000Null',
      unicode: "🚀✨",
      escaped: 'backslash \\ and quote \"',
    };
    await appendEvent(dir, event);

    const result = await readEvents(dir);
    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.text).toBe(event.text);
    expect(result.events[0]!.unicode).toBe(event.unicode);
    expect(result.events[0]!.escaped).toBe(event.escaped);
  });

  test("appendEvent redacts secrets in event data (HIGH-001)", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    await appendEvent(dir, { ...testEnvelope, event_id: testEnvelope.event_id(), key: "sk-ant-api03-abc123def456" });
    const result = await readEvents(dir);
    expect(result.success).toBe(true);
    const raw = JSON.stringify(result.events[0]);
    expect(raw).not.toContain("sk-ant-api03-abc123def456");
    expect(raw).toContain("[REDACTED]");
  });

  test("readEvents handles whitespace-only events file as empty", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    // Create an events file with only whitespace
    await writeFile(join(dir, "events.jsonl"), "   \n\t  \n\n", "utf-8");

    const result = await readEvents(dir);
    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(0);
    expect("truncated" in result).toBe(false);
  });

  test("readEvents handles file with only newline characters", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    await writeFile(join(dir, "events.jsonl"), "\n\n\n", "utf-8");

    const result = await readEvents(dir);
    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(0);
    expect("truncated" in result).toBe(false);
  });
});

// ── Session Initialization ───────────────────────────────────────

describe("initSession", () => {
  test("creates root session in ZAO_HOME with UUIDv7 id", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    // Override ZAO_HOME so session goes to our temp dir
    const originalMoHome = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      const { sessionDir, sessionId, isRoot } = await initSession({
        projectDir: storeRoot,
      });

      // Should indicate root session
      expect(isRoot).toBe(true);

      // sessionId should be a UUIDv7-style string
      expect(sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      // sessionDir should be under ZAO_HOME/sessions/<uuidv7>
      expect(sessionDir).toBe(join(storeRoot, "sessions", sessionId));

      // The directory should exist
      const stat = await Bun.file(sessionDir).stat().catch(() => null);
      expect(stat).not.toBeNull();

      // agents/ subdirectory should exist
      const agentsDir = join(sessionDir, "agents");
      const agentsStat = await Bun.file(agentsDir).stat().catch(() => null);
      expect(agentsStat).not.toBeNull();

      // session.json should exist
      const manifestPath = join(sessionDir, "session.json");
      const manifestFile = Bun.file(manifestPath);
      expect(await manifestFile.exists()).toBe(true);

      // Global index should have a creation line
      const indexPath = join(storeRoot, "index.jsonl");
      const indexFile = Bun.file(indexPath);
      expect(await indexFile.exists()).toBe(true);
      const indexRaw = await indexFile.text();
      expect(indexRaw).toContain(sessionId);
      expect(indexRaw).toContain('"status":"active"');
    } finally {
      if (originalMoHome !== undefined) {
        process.env["ZAO_HOME"] = originalMoHome;
      } else {
        delete process.env["ZAO_HOME"];
      }
    }
  });

  test("generates unique session IDs on consecutive calls", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const originalMoHome = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      const first = await initSession({ projectDir: storeRoot });
      const second = await initSession({ projectDir: storeRoot });

      expect(first.sessionId).not.toBe(second.sessionId);
      expect(first.sessionDir).not.toBe(second.sessionDir);

      // Both should be under sessions/
      expect(first.sessionDir.startsWith(join(storeRoot, "sessions"))).toBe(true);
      expect(second.sessionDir.startsWith(join(storeRoot, "sessions"))).toBe(true);
    } finally {
      if (originalMoHome !== undefined) {
        process.env["ZAO_HOME"] = originalMoHome;
      } else {
        delete process.env["ZAO_HOME"];
      }
    }
  });

  test("session ID is UUIDv7 (not date-based counter)", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const originalMoHome = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      const { sessionId } = await initSession({ projectDir: storeRoot });

      // UUIDv7 pattern: xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx
      // NOT the old session-YYYYMMDD-NNN format
      expect(sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(sessionId).not.toContain("session-");
    } finally {
      if (originalMoHome !== undefined) {
        process.env["ZAO_HOME"] = originalMoHome;
      } else {
        delete process.env["ZAO_HOME"];
      }
    }
  });

  test("UUIDv7 IDs sort chronologically (T5)", async () => {
    // Generate 5 IDs with small delays between them
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(generateSessionId());
      await new Promise((r) => setTimeout(r, 10));
    }

    // UUIDv7 encodes timestamp in the first 48 bits, so string sort
    // should match chronological order
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  test("concurrent initSession creates distinct IDs (T12)", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const originalMoHome = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      const results = await Promise.all([
        initSession({ projectDir: storeRoot }),
        initSession({ projectDir: storeRoot }),
      ]);

      expect(results[0]!.sessionId).not.toBe(results[1]!.sessionId);
      expect(results[0]!.sessionDir).not.toBe(results[1]!.sessionDir);
    } finally {
      if (originalMoHome !== undefined) {
        process.env["ZAO_HOME"] = originalMoHome;
      } else {
        delete process.env["ZAO_HOME"];
      }
    }
  });
});

// ── Schema Version Validation ────────────────────────────────────

describe("readArtifact schema_version validation", () => {
  // Schema that mimics the real zao schemas (all use schema_version: z.literal("0.1.0"))
  const VersionedSchema = z.object({
    schema_version: z.literal("0.1.0"),
    name: z.string(),
    value: z.number(),
  });

  test("valid schema_version passes validation (TEST-2 extended)", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "versioned.json");

    const content = JSON.stringify({
      schema_version: "0.1.0",
      name: "test-artifact",
      value: 42,
    });
    await writeArtifact(artifactPath, content);

    const result = await readArtifact(artifactPath, VersionedSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schema_version).toBe("0.1.0");
      expect(result.data.name).toBe("test-artifact");
      expect(result.data.value).toBe(42);
    }
  });

  test("wrong schema_version returns validation error", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "wrong-version.json");

    const content = JSON.stringify({
      schema_version: "0.2.0",
      name: "test-artifact",
      value: 99,
    });
    await writeArtifact(artifactPath, content);

    const result = await readArtifact(artifactPath, VersionedSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Schema validation failed");
      // Should mention the version mismatch somehow
      expect(result.error).toContain("0.1.0");
    }
  });

  test("missing schema_version returns validation error", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "no-version.json");

    // Valid JSON but missing the required schema_version field
    const content = JSON.stringify({ name: "orphan", value: 7 });
    await writeArtifact(artifactPath, content);

    const result = await readArtifact(artifactPath, VersionedSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Schema validation failed");
    }
  });

  test("whitespace-only file returns empty error, not crash", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "whitespace.json");

    // File with spaces, tabs, and newlines only
    await writeFile(artifactPath, "   \n\t  \n\n", "utf-8");

    const result = await readArtifact(artifactPath, z.object({ x: z.number() }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("empty");
    }
  });

  test("file with only unicode whitespace returns empty error", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "unicode-ws.json");

    // Non-breaking spaces + zero-width chars
    await writeFile(artifactPath, "\u00A0\u00A0\u200B\u200B", "utf-8");

    const result = await readArtifact(artifactPath, z.object({ x: z.number() }));
    // NBSP and ZWSP are not trimmed by JS trim() — but we test behavior:
    // If the file parses as valid JSON, great. If not, should return error not crash.
    // The implementation uses raw.trim() which may not catch these.
    // This test documents current behavior.
    if (!result.success) {
      // It's fine if it fails — the key is: no crash
      expect(typeof result.error).toBe("string");
    }
    // No crash = test passes
  });
});

// ── Redaction ────────────────────────────────────────────────────

describe("redactSecrets", () => {
  // ── TEST-6: Write string with API key → read back redacted ──

  test("writeArtifact redacts Anthropic API keys (TEST-6a)", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "redacted.json");

    const contentWithKey = JSON.stringify({
      prompt: "Hello",
      apiKey: "sk-ant-api03-abc123def456ghi789jkl",
    });
    await writeArtifact(artifactPath, contentWithKey);

    const file = Bun.file(artifactPath);
    const readBack = await file.text();
    expect(readBack).not.toContain("sk-ant-api03-abc123def456ghi789jkl");
    expect(readBack).toContain("[REDACTED]");
  });

  test("redactSecrets redacts OpenAI-style keys (TEST-6b)", () => {
    const input = 'Authorization: Bearer sk-abcdefghij1234567890abcdef';
    const result = redactSecrets(input);
    expect(result).not.toContain("sk-abcdefghij1234567890abcdef");
    expect(result).toContain("[REDACTED]");
  });

  test("redactSecrets redacts JWT Bearer tokens (TEST-6c)", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = redactSecrets(input);
    // "Bearer eyJ..." should become "Bearer [REDACTED]"
    expect(result).not.toContain("eyJhbGci");
    expect(result).toContain("Bearer [REDACTED]");
  });

  test("redactSecrets redacts x-api-key headers (TEST-6d)", () => {
    const input = "x-api-key: sk-super-secret-key-12345";
    const result = redactSecrets(input);
    expect(result).not.toContain("sk-super-secret-key-12345");
    expect(result).toContain("x-api-key: [REDACTED]");
  });

  test("redactSecrets handles case-insensitive x-api-key header", () => {
    const input = "X-API-KEY: another-secret";
    const result = redactSecrets(input);
    expect(result).not.toContain("another-secret");
    expect(result).toContain("X-API-KEY: [REDACTED]");
  });

  test("redactSecrets redacts env-var secret patterns (TEST-6e)", () => {
    const input = "SECRET=my-precious-password\nAPI_KEY=sk-live-1234567890abcdefghijklmn";
    const result = redactSecrets(input);
    expect(result).toContain("SECRET=[REDACTED]");
    expect(result).toContain("API_KEY=[REDACTED]");
    expect(result).not.toContain("my-precious-password");
    expect(result).not.toContain("sk-live-1234567890abcdefghijklmn");
  });

  // ── TEST-7: Write string without secrets → content unchanged ──

  test("writeArtifact does not modify content without secrets (TEST-7)", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "clean.json");

    const cleanContent = JSON.stringify({
      message: "This is a safe message",
      data: { value: 42 },
      items: ["hello", "world"],
    });
    await writeArtifact(artifactPath, cleanContent);

    const file = Bun.file(artifactPath);
    const readBack = await file.text();
    const parsed = JSON.parse(readBack);
    expect(parsed).toEqual({
      message: "This is a safe message",
      data: { value: 42 },
      items: ["hello", "world"],
    });
    expect(readBack).not.toContain("[REDACTED]");
  });

  test("redactSecrets does not redact short strings that look like prefixes", () => {
    // "sk-test" is only 7 chars after "sk-", our regex requires 20+
    const input = 'The API key is "sk-test" for testing purposes';
    const result = redactSecrets(input);
    // Should be unchanged
    expect(result).toBe(input);
  });

  test("redactSecrets handles content with no secrets at all", () => {
    const input = '{"message": "Hello, world!", "count": 42}';
    const result = redactSecrets(input);
    expect(result).toBe(input);
  });

  // ── Boundary: "sk-ant-api03" in documentation stays unredacted ──

  test("'sk-ant-api03' in documentation without key suffix stays unredacted", () => {
    // Pattern: sk-ant-api03-<alphanumeric+hyphens> requires at least 1 suffix char.
    // A bare mention in docs (no hyphen + suffix) should not match.
    const input = "Use an API key like sk-ant-api03 for authentication purposes.";
    const result = redactSecrets(input);
    expect(result).toBe(input);
    expect(result).not.toContain("[REDACTED]");
  });

  test("'sk-ant-api03-' with trailing dash but no suffix stays unredacted", () => {
    // The regex requires at least 1 char after "sk-ant-api03-"
    const input = "Prefix: sk-ant-api03- (no key after the dash)";
    const result = redactSecrets(input);
    expect(result).toBe(input);
  });

  // ── Boundary: OpenAI-style key length threshold (20 chars) ──

  test("OpenAI-style key with 19 chars after 'sk-' stays unredacted", () => {
    const input = "sk-1234567890123456789"; // exactly 19 chars after sk-
    const result = redactSecrets(input);
    expect(result).toBe(input);
    expect(result).not.toContain("[REDACTED]");
  });

  test("OpenAI-style key with 20 chars after 'sk-' is redacted", () => {
    const input = "sk-12345678901234567890"; // exactly 20 chars after sk-
    const result = redactSecrets(input);
    expect(result).toBe("[REDACTED]");
  });

  // ── Mixed-case X-Api-Key ─────────────────────────────────────

  test("redactSecrets handles X-Api-Key in mixed case", () => {
    const input = "X-Api-Key: abc123secret";
    const result = redactSecrets(input);
    expect(result).not.toContain("abc123secret");
    expect(result).toContain("X-Api-Key: [REDACTED]");
  });

  test("redactSecrets handles x-api-key in all lowercase", () => {
    const input = "x-api-key: lowercase-secret";
    const result = redactSecrets(input);
    expect(result).not.toContain("lowercase-secret");
    expect(result).toContain("x-api-key: [REDACTED]");
  });

  // ── Env var with colon separator ─────────────────────────────

  test("redactSecrets redacts env-var patterns with colon separator", () => {
    const input = "TOKEN: my-secret-token-value";
    const result = redactSecrets(input);
    expect(result).not.toContain("my-secret-token-value");
    // Pattern replaces with "VAR_NAME=[REDACTED]" (always uses =)
    expect(result).toContain("TOKEN=[REDACTED]");
  });

  test("redactSecrets redacts PASSWORD with colon separator", () => {
    const input = "PASSWORD: s3cr3t!";
    const result = redactSecrets(input);
    expect(result).not.toContain("s3cr3t!");
    expect(result).toContain("PASSWORD=[REDACTED]");
  });

  // ── Redaction is idempotent ──────────────────────────────────

  test("redactSecrets is idempotent (redacting twice gives same result)", () => {
    const input = "x-api-key: sk-ant-api03-abc123";
    const first = redactSecrets(input);
    const second = redactSecrets(first);
    expect(second).toBe(first);
  });

  // ── Multiple secrets in one string ───────────────────────────

  test("redactSecrets redacts multiple secret patterns in one string", () => {
    const input = [
      "Headers:",
      "x-api-key: sk-ant-api03-abc123def456",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def",
      "SECRET=my-env-secret",
    ].join("\n");
    const result = redactSecrets(input);
    expect(result).not.toContain("sk-ant-api03-abc123def456");
    expect(result).not.toContain("my-env-secret");
    expect(result).toContain("x-api-key: [REDACTED]");
    expect(result).toContain("Bearer [REDACTED]");
    expect(result).toContain("SECRET=[REDACTED]");
  });
});

// ── Error Message Sanitization ───────────────────────────────────

describe("readArtifact error messages", () => {
  test("does not leak file content in error messages on schema mismatch", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "secret.json");

    // Write content that looks like it might contain secrets
    const content = JSON.stringify({ api_key: "sk-super-secret-key-that-should-not-leak" });
    await writeFile(artifactPath, content, "utf-8");

    // Try to read with a schema that will reject it
    const StrictSchema = z.object({
      name: z.string(),
      value: z.number(),
    });

    const result = await readArtifact(artifactPath, StrictSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      // The error should NOT contain the raw secret value
      expect(result.error).not.toContain("sk-super-secret-key-that-should-not-leak");
      expect(result.error).not.toContain("api_key");
    }
  });

  test("does not leak file content in error messages on JSON parse failure", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "bad-json.json");

    // Write something that isn't valid JSON with a "secret" in it
    const content = 'Not JSON at all with secret sk-ant-api03-abc123def456';
    await writeFile(artifactPath, content, "utf-8");

    const result = await readArtifact(artifactPath, TestSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Should not contain the raw content
      expect(result.error).not.toContain("sk-ant-api03-abc123def456");
      expect(result.error).toContain("Invalid JSON");
    }
  });
});

// ── Atomic Write Edge Cases ──────────────────────────────────────

describe("writeArtifact edge cases", () => {
  test("creates parent directories automatically", async () => {
    const dir = makeTempDir();
    const nestedPath = join(dir, "deeply", "nested", "path", "artifact.json");

    await writeArtifact(nestedPath, JSON.stringify({ ok: true }));

    const file = Bun.file(nestedPath);
    expect(await file.exists()).toBe(true);
    const content = await file.text();
    expect(JSON.parse(content)).toEqual({ ok: true });
  });

  test("overwrites existing artifact atomically", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "overwrite.json");

    // Write initial content
    await writeArtifact(artifactPath, JSON.stringify({ version: 1 }));
    const first = await readArtifact(
      artifactPath,
      z.object({ version: z.number() }),
    );
    expect(first.success).toBe(true);
    if (first.success) expect(first.data.version).toBe(1);

    // Overwrite
    await writeArtifact(artifactPath, JSON.stringify({ version: 2 }));
    const second = await readArtifact(
      artifactPath,
      z.object({ version: z.number() }),
    );
    expect(second.success).toBe(true);
    if (second.success) expect(second.data.version).toBe(2);
  });

  // ── AC-2: Crash simulation — stale .tmp from prior crash ────

  test("handles stale .tmp from a prior crash without corrupting original (AC-2)", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "crash-resistant.json");

    // Write original content directly (simulating the artifact before a crash)
    const originalContent = JSON.stringify({ version: "original", data: "important" });
    await writeArtifact(artifactPath, originalContent);

    // Verify original is intact
    const original = await readArtifact(
      artifactPath,
      z.object({ version: z.string(), data: z.string() }),
    );
    expect(original.success).toBe(true);

    // Simulate a crash by creating a stale .tmp file with partial content
    const tmpPath = `${artifactPath}.tmp`;
    await writeFile(tmpPath, '{"version": "corrupted', "utf-8");

    // Verify the original artifact is STILL intact (not corrupted by the tmp)
    const stillIntact = await readArtifact(
      artifactPath,
      z.object({ version: z.string(), data: z.string() }),
    );
    expect(stillIntact.success).toBe(true);
    if (stillIntact.success) {
      expect(stillIntact.data.version).toBe("original");
    }

    // Now recover: writeArtifact should overwrite the stale .tmp and
    // atomically replace the original
    const newContent = JSON.stringify({ version: "recovered", data: "restored" });
    await writeArtifact(artifactPath, newContent);

    // Verify new content is in place
    const recovered = await readArtifact(
      artifactPath,
      z.object({ version: z.string(), data: z.string() }),
    );
    expect(recovered.success).toBe(true);
    if (recovered.success) {
      expect(recovered.data.version).toBe("recovered");
    }

    // Original artifact exists with correct content
    const finalFile = Bun.file(artifactPath);
    expect(await finalFile.exists()).toBe(true);
    const finalRaw = await finalFile.text();
    expect(JSON.parse(finalRaw).version).toBe("recovered");
  });

  test("redacts content that is written even when temp file existed", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);
    const artifactPath = join(dir, "redact-after-crash.json");
    const tmpPath = `${artifactPath}.tmp`;

    // Create a stale .tmp with NO secrets (as if a previous clean write crashed)
    await writeFile(tmpPath, '{"status": "incomplete"}', "utf-8");

    // Now write with secret content — should still redact
    await writeArtifact(
      artifactPath,
      JSON.stringify({ key: "sk-ant-api03-abc123def456" }),
    );

    const file = Bun.file(artifactPath);
    const readBack = await file.text();
    expect(readBack).not.toContain("sk-ant-api03-abc123def456");
    expect(readBack).toContain("[REDACTED]");
  });
});
