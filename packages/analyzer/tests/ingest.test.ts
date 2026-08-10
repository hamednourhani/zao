import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ingestSessions, readSessionEvents } from "../src/ingest.ts";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures", "sample-session");

describe("ingestSessions", () => {
  test("reads index.jsonl correctly (3 sessions)", () => {
    const sessions = ingestSessions(FIXTURES_DIR);
    expect(sessions.length).toBe(3);
  });

  test("parses success session correctly", () => {
    const sessions = ingestSessions(FIXTURES_DIR);
    const success = sessions.find((s) => s.sessionId === "sess-001");
    expect(success).toBeDefined();
    if (success) {
      expect(success.status).toBe("success");
      expect(success.task).toBe("Implement rate limiting middleware");
      expect(success.model).toBe("deepseek:deepseek-chat");
      expect(success.duration).toBe(25000);
      expect(success.errorCount).toBe(0);
      expect(success.toolCallCount).toBe(5);
    }
  });

  test("parses failed session correctly", () => {
    const sessions = ingestSessions(FIXTURES_DIR);
    const failed = sessions.find((s) => s.sessionId === "sess-002");
    expect(failed).toBeDefined();
    if (failed) {
      expect(failed.status).toBe("failed");
      expect(failed.errorCount).toBe(7);
    }
  });

  test("parses awaiting_hitl session correctly", () => {
    const sessions = ingestSessions(FIXTURES_DIR);
    const hitl = sessions.find((s) => s.sessionId === "sess-003");
    expect(hitl).toBeDefined();
    if (hitl) {
      expect(hitl.status).toBe("awaiting_hitl");
      expect(hitl.model).toBe("openai:gpt-4o");
    }
  });

  test("returns empty array for missing directory", () => {
    const sessions = ingestSessions("/nonexistent/directory/xyz123");
    expect(sessions).toEqual([]);
  });

  test("returns empty array for missing index file", () => {
    // Use a temp dir that exists but has no index.jsonl
    const sessions = ingestSessions(import.meta.dir); // test dir, no index.jsonl
    expect(sessions).toEqual([]);
  });

  test("handles malformed JSON line (skip, don't crash)", () => {
    // Create a temp directory with a malformed index.jsonl
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "analyzer-malformed-"));
    const malformedContent = [
      '{"session_id": "good-1", "status": "success", "task": "T1", "model": "m", "duration": 100, "error_count": 0, "tool_call_count": 1}',
      "this is not json",
      '{"session_id": "good-2", "status": "failed", "task": "T2", "model": "m", "duration": 200, "error_count": 3, "tool_call_count": 2}',
    ].join("\n");
    fs.writeFileSync(path.join(tempDir, "index.jsonl"), malformedContent);

    try {
      const sessions = ingestSessions(tempDir);
      // Should have parsed 2 valid sessions, skipping the malformed line
      expect(sessions.length).toBe(2);
      expect(sessions[0]?.sessionId).toBe("good-1");
      expect(sessions[1]?.sessionId).toBe("good-2");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("SessionSummary fields are correctly populated", () => {
    const sessions = ingestSessions(FIXTURES_DIR);
    expect(sessions.length).toBe(3);

    for (const session of sessions) {
      expect(typeof session.sessionId).toBe("string");
      expect(session.sessionId.length).toBeGreaterThan(0);
      expect(["success", "failed", "awaiting_hitl", "unknown"]).toContain(session.status);
      expect(typeof session.task).toBe("string");
      expect(typeof session.model).toBe("string");
      expect(typeof session.duration).toBe("number");
      expect(typeof session.errorCount).toBe("number");
      expect(typeof session.toolCallCount).toBe("number");
    }
  });
});

describe("readSessionEvents", () => {
  test("reads events.jsonl from fixture directory", () => {
    const events = readSessionEvents(FIXTURES_DIR);
    expect(events.length).toBe(5);
  });

  test("extracts event actions", () => {
    const events = readSessionEvents(FIXTURES_DIR);
    const actions = events.map((e) => e.action).filter(Boolean);
    expect(actions).toContain("session_start");
    expect(actions).toContain("llm_call_success");
    expect(actions).toContain("tool_exec_success");
    expect(actions).toContain("session_complete");
  });

  test("returns empty array for missing directory", () => {
    const events = readSessionEvents("/nonexistent/directory/xyz456");
    expect(events).toEqual([]);
  });
});
