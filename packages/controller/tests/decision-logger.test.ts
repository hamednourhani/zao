/**
 * Decision Logger tests — REQ-7.
 *
 * Covers:
 * - Log entries written to decisions.jsonl as valid JSONL
 * - All required fields present (schema_version, event_id, timestamp,
 *   execution_id, session_id, step_id, actor, action, data)
 * - Violations also written to violations.jsonl (and decisions.jsonl)
 * - Multiple entries appended correctly
 * - Schema version is "0.1.0"
 * - All four actor types work (llm, harness, controller, user)
 * - All action types work (tool_call, tool_result, gate_decision,
 *   escalation, approval, rejection)
 * - initializeDecisionLog creates the decisions.jsonl file
 * - createDecisionLogger returns a bound logger
 *
 * @module decision-logger.test
 */

import { describe, expect, test, afterAll } from "bun:test";
import { rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createDecisionLogger,
  initializeDecisionLog,
} from "../src/decision-logger.ts";
import type { DecisionLogEntry } from "../src/decision-logger.ts";

// ── Temp Directories ─────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-decision-${randomUUID()}`);
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
 * Creates a minimal valid decision log entry with the given overrides.
 */
function makeEntry(
  overrides?: Partial<DecisionLogEntry>,
): DecisionLogEntry {
  return {
    schema_version: "0.1.0",
    event_id: randomUUID(),
    timestamp: new Date().toISOString(),
    execution_id: randomUUID(),
    session_id: randomUUID(),
    step_id: "test",
    actor: "harness",
    action: "tool_call",
    data: {},
    ...overrides,
  };
}

/**
 * Sets up a temp execution directory with an initialized decision log.
 * Returns the execution dir, a bound logger, and a helper to read log lines.
 */
async function setupLogger(): Promise<{
  executionDir: string;
  logger: ReturnType<typeof createDecisionLogger>;
  readDecisions: () => Promise<string[]>;
  readViolations: () => Promise<string[]>;
}> {
  const executionDir = makeTempDir();
  await mkdir(executionDir, { recursive: true });
  await initializeDecisionLog(executionDir);
  const logger = createDecisionLogger(executionDir);

  const readDecisions = async (): Promise<string[]> => {
    try {
      const raw = await readFile(join(executionDir, "decisions.jsonl"), "utf-8");
      return raw.split("\n").filter((l) => l.trim().length > 0);
    } catch {
      return [];
    }
  };

  const readViolations = async (): Promise<string[]> => {
    try {
      const raw = await readFile(
        join(executionDir, "violations.jsonl"),
        "utf-8",
      );
      return raw.split("\n").filter((l) => l.trim().length > 0);
    } catch {
      return [];
    }
  };

  return { executionDir, logger, readDecisions, readViolations };
}

// ── Core Logging Tests ───────────────────────────────────────────

describe("Decision Logger — logDecision writes valid JSONL", () => {
  test("single entry written to decisions.jsonl", async () => {
    const { logger, readDecisions } = await setupLogger();

    const entry = makeEntry();
    await logger.logDecision(entry);

    const lines = await readDecisions();
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.event_id).toBe(entry.event_id);
    expect(parsed.schema_version).toBe("0.1.0");
    expect(parsed.timestamp).toBe(entry.timestamp);
    expect(parsed.execution_id).toBe(entry.execution_id);
    expect(parsed.session_id).toBe(entry.session_id);
    expect(parsed.step_id).toBe("test");
    expect(parsed.actor).toBe("harness");
    expect(parsed.action).toBe("tool_call");
  });

  test("entries are valid JSONL — one object per line", async () => {
    const { logger, readDecisions } = await setupLogger();

    await logger.logDecision(makeEntry());
    await logger.logDecision(makeEntry());
    await logger.logDecision(makeEntry());

    const lines = await readDecisions();
    expect(lines.length).toBe(3);

    // Every line must be parseable JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line);
      expect(typeof parsed).toBe("object");
      expect(Array.isArray(parsed)).toBe(false);
    }
  });

  test("all required fields are present in each entry", async () => {
    const { logger, readDecisions } = await setupLogger();

    const requiredFields = [
      "schema_version",
      "event_id",
      "timestamp",
      "execution_id",
      "session_id",
      "step_id",
      "actor",
      "action",
      "data",
    ] as const;

    for (const field of requiredFields) {
      const entry = makeEntry();
      await logger.logDecision(entry);

      const lines = await readDecisions();
      const lastLine = lines[lines.length - 1]!;
      const parsed = JSON.parse(lastLine);

      expect(
        parsed,
        `Field "${field}" should be present in entry`,
      ).toHaveProperty(field);
    }
  });

  test("schema_version is always 0.1.0", async () => {
    const { logger, readDecisions } = await setupLogger();

    await logger.logDecision(makeEntry());
    await logger.logDecision(makeEntry({ actor: "llm" }));
    await logger.logDecision(makeEntry({ action: "gate_decision" }));

    const lines = await readDecisions();
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.schema_version).toBe("0.1.0");
    }
  });

  test("event_id is a valid UUID for every entry", async () => {
    const { logger, readDecisions } = await setupLogger();

    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    await logger.logDecision(makeEntry());
    await logger.logDecision(makeEntry());

    const lines = await readDecisions();
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.event_id).toMatch(uuidRegex);
    }
  });

  test("timestamp is a valid ISO-8601 string", async () => {
    const { logger, readDecisions } = await setupLogger();

    await logger.logDecision(makeEntry());

    const lines = await readDecisions();
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.timestamp).toBeString();
    expect(Date.parse(parsed.timestamp as string)).not.toBeNaN();
  });

  test("schema validation rejects entry missing required fields", async () => {
    const { logger } = await setupLogger();

    // Missing event_id
    const badEntry = {
      schema_version: "0.1.0",
      timestamp: new Date().toISOString(),
      execution_id: randomUUID(),
      session_id: randomUUID(),
      step_id: "test",
      actor: "harness",
      action: "tool_call",
      data: {},
    };

    await expect(
      logger.logDecision(badEntry as DecisionLogEntry),
    ).rejects.toThrow(/validation/i);
  });

  test("schema validation rejects invalid actor", async () => {
    const { logger } = await setupLogger();

    const badEntry = makeEntry({ actor: "alien" as "llm" });

    await expect(logger.logDecision(badEntry)).rejects.toThrow(/validation/i);
  });

  test("schema validation rejects invalid action", async () => {
    const { logger } = await setupLogger();

    const badEntry = makeEntry({
      action: "dance_party" as "tool_call",
    });

    await expect(logger.logDecision(badEntry)).rejects.toThrow(/validation/i);
  });
});

// ── Actor Type Tests ─────────────────────────────────────────────

describe("Decision Logger — actor types", () => {
  test("actor: llm", async () => {
    const { logger, readDecisions } = await setupLogger();
    await logger.logDecision(makeEntry({ actor: "llm" }));
    const lines = await readDecisions();
    expect(JSON.parse(lines[0]!).actor).toBe("llm");
  });

  test("actor: harness", async () => {
    const { logger, readDecisions } = await setupLogger();
    await logger.logDecision(makeEntry({ actor: "harness" }));
    const lines = await readDecisions();
    expect(JSON.parse(lines[0]!).actor).toBe("harness");
  });

  test("actor: controller", async () => {
    const { logger, readDecisions } = await setupLogger();
    await logger.logDecision(makeEntry({ actor: "controller" }));
    const lines = await readDecisions();
    expect(JSON.parse(lines[0]!).actor).toBe("controller");
  });

  test("actor: user", async () => {
    const { logger, readDecisions } = await setupLogger();
    await logger.logDecision(makeEntry({ actor: "user" }));
    const lines = await readDecisions();
    expect(JSON.parse(lines[0]!).actor).toBe("user");
  });
});

// ── Action Type Tests ────────────────────────────────────────────

describe("Decision Logger — action types", () => {
  const actions = [
    "tool_call",
    "tool_result",
    "gate_decision",
    "escalation",
    "approval",
    "rejection",
  ] as const;

  for (const action of actions) {
    test(`action: ${action}`, async () => {
      const { logger, readDecisions } = await setupLogger();
      await logger.logDecision(makeEntry({ action }));
      const lines = await readDecisions();
      expect(JSON.parse(lines[0]!).action).toBe(action);
    });
  }
});

// ── Data Field Tests ─────────────────────────────────────────────

describe("Decision Logger — data field", () => {
  test("data field preserves complex nested objects", async () => {
    const { logger, readDecisions } = await setupLogger();

    const entry = makeEntry({
      data: {
        tool_name: "read_file",
        args: { path: "/tmp/test.txt", maxLines: 100 },
        nested: { deep: { value: true } },
        array: [1, 2, 3],
      },
    });

    await logger.logDecision(entry);

    const lines = await readDecisions();
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.data.tool_name).toBe("read_file");
    expect(parsed.data.args.path).toBe("/tmp/test.txt");
    expect(parsed.data.nested.deep.value).toBe(true);
    expect(parsed.data.array).toEqual([1, 2, 3]);
  });

  test("data field can be empty object", async () => {
    const { logger, readDecisions } = await setupLogger();

    await logger.logDecision(makeEntry({ data: {} }));

    const lines = await readDecisions();
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.data).toEqual({});
  });
});

// ── Multiple Entry Tests ─────────────────────────────────────────

describe("Decision Logger — multiple entries", () => {
  test("multiple entries append in order", async () => {
    const { logger, readDecisions } = await setupLogger();

    const entry1 = makeEntry({ actor: "llm", action: "tool_call" });
    const entry2 = makeEntry({ actor: "harness", action: "tool_result" });
    const entry3 = makeEntry({ actor: "user", action: "approval" });

    await logger.logDecision(entry1);
    await logger.logDecision(entry2);
    await logger.logDecision(entry3);

    const lines = await readDecisions();
    expect(lines.length).toBe(3);

    expect(JSON.parse(lines[0]!).event_id).toBe(entry1.event_id);
    expect(JSON.parse(lines[1]!).event_id).toBe(entry2.event_id);
    expect(JSON.parse(lines[2]!).event_id).toBe(entry3.event_id);
  });

  test("20 entries all append correctly", async () => {
    const { logger, readDecisions } = await setupLogger();

    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const entry = makeEntry();
      ids.push(entry.event_id);
      await logger.logDecision(entry);
    }

    const lines = await readDecisions();
    expect(lines.length).toBe(20);

    for (let i = 0; i < 20; i++) {
      expect(JSON.parse(lines[i]!).event_id).toBe(ids[i]);
    }
  });
});

// ── Violation Logging Tests ──────────────────────────────────────

describe("Decision Logger — logViolation", () => {
  test("violations written to violations.jsonl", async () => {
    const { logger, readViolations } = await setupLogger();

    const entry = makeEntry({
      actor: "harness",
      action: "gate_decision",
      data: { reason: "blocked destructive action" },
    });

    await logger.logViolation(entry);

    const lines = await readViolations();
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.event_id).toBe(entry.event_id);
    expect(parsed.actor).toBe("harness");
    expect(parsed.action).toBe("gate_decision");
    expect(parsed.data.reason).toBe("blocked destructive action");
  });

  test("violations are also written to decisions.jsonl", async () => {
    const { logger, readDecisions, readViolations } = await setupLogger();

    const entry = makeEntry({
      actor: "llm",
      action: "escalation",
      data: { message: "attempted banned operation" },
    });

    await logger.logViolation(entry);

    const violationLines = await readViolations();
    expect(violationLines.length).toBe(1);

    const decisionLines = await readDecisions();
    expect(decisionLines.length).toBe(1);

    // Same event_id in both files
    const violationParsed = JSON.parse(violationLines[0]!);
    const decisionParsed = JSON.parse(decisionLines[0]!);
    expect(violationParsed.event_id).toBe(decisionParsed.event_id);
  });

  test("multiple violations append correctly", async () => {
    const { logger, readViolations } = await setupLogger();

    const v1 = makeEntry({ action: "escalation", data: { v: 1 } });
    const v2 = makeEntry({ action: "escalation", data: { v: 2 } });
    const v3 = makeEntry({ action: "escalation", data: { v: 3 } });

    await logger.logViolation(v1);
    await logger.logViolation(v2);
    await logger.logViolation(v3);

    const lines = await readViolations();
    expect(lines.length).toBe(3);

    expect(JSON.parse(lines[0]!).event_id).toBe(v1.event_id);
    expect(JSON.parse(lines[1]!).event_id).toBe(v2.event_id);
    expect(JSON.parse(lines[2]!).event_id).toBe(v3.event_id);
  });

  test("mix of logDecision and logViolation interleaves correctly in decisions.jsonl", async () => {
    const { logger, readDecisions, readViolations } = await setupLogger();

    const d1 = makeEntry({ action: "tool_call" });
    const v1 = makeEntry({ action: "escalation" });
    const d2 = makeEntry({ action: "approval" });
    const v2 = makeEntry({ action: "rejection" });

    await logger.logDecision(d1);
    await logger.logViolation(v1);
    await logger.logDecision(d2);
    await logger.logViolation(v2);

    // decisions.jsonl should have all 4 entries
    const decisionLines = await readDecisions();
    expect(decisionLines.length).toBe(4);

    // violations.jsonl should have only the 2 violations
    const violationLines = await readViolations();
    expect(violationLines.length).toBe(2);

    // Verify order in decisions.jsonl
    expect(JSON.parse(decisionLines[0]!).event_id).toBe(d1.event_id);
    expect(JSON.parse(decisionLines[1]!).event_id).toBe(v1.event_id);
    expect(JSON.parse(decisionLines[2]!).event_id).toBe(d2.event_id);
    expect(JSON.parse(decisionLines[3]!).event_id).toBe(v2.event_id);
  });
});

// ── Initialization Tests ─────────────────────────────────────────

describe("Decision Logger — initializeDecisionLog", () => {
  test("initializeDecisionLog creates decisions.jsonl file", async () => {
    const executionDir = makeTempDir();
    await mkdir(executionDir, { recursive: true });

    await initializeDecisionLog(executionDir);

    // Verify decisions.jsonl exists
    const { stat } = await import("node:fs/promises");
    const fileStat = await stat(join(executionDir, "decisions.jsonl"));
    expect(fileStat.isFile()).toBe(true);
  });

  test("initializeDecisionLog is idempotent", async () => {
    const executionDir = makeTempDir();
    await mkdir(executionDir, { recursive: true });

    // Call twice — should not throw
    await initializeDecisionLog(executionDir);
    await initializeDecisionLog(executionDir);

    // File should still exist
    const { stat } = await import("node:fs/promises");
    const fileStat = await stat(join(executionDir, "decisions.jsonl"));
    expect(fileStat.isFile()).toBe(true);
  });

  test("initializeDecisionLog creates the execution directory if it doesn't exist", async () => {
    const executionDir = makeTempDir();
    // Do NOT mkdir first — let initializeDecisionLog create it

    await initializeDecisionLog(executionDir);

    const { stat } = await import("node:fs/promises");
    const dirStat = await stat(executionDir);
    expect(dirStat.isDirectory()).toBe(true);

    const fileStat = await stat(join(executionDir, "decisions.jsonl"));
    expect(fileStat.isFile()).toBe(true);
  });

  test("createDecisionLogger also initializes the log if not already done", async () => {
    const executionDir = makeTempDir();
    // Don't call initializeDecisionLog — createDecisionLogger should handle it

    const logger = createDecisionLogger(executionDir);

    // Logging should work without prior initialization
    await logger.logDecision(makeEntry());

    const { stat } = await import("node:fs/promises");
    const fileStat = await stat(join(executionDir, "decisions.jsonl"));
    expect(fileStat.isFile()).toBe(true);

    // Entry should be readable
    const raw = await readFile(join(executionDir, "decisions.jsonl"), "utf-8");
    expect(raw.trim().length).toBeGreaterThan(0);
  });
});

// ── Edge Cases ───────────────────────────────────────────────────

describe("Decision Logger — edge cases", () => {
  test("entry with special characters in data field", async () => {
    const { logger, readDecisions } = await setupLogger();

    await logger.logDecision(
      makeEntry({
        data: {
          message: 'Special chars: "quotes", \n newlines escaped, \\ backslashes',
          emoji: "🚀",
        },
      }),
    );

    const lines = await readDecisions();
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.data.message).toContain("quotes");
    expect(parsed.data.emoji).toBe("🚀");
  });

  test("entry with null and boolean values in data", async () => {
    const { logger, readDecisions } = await setupLogger();

    await logger.logDecision(
      makeEntry({
        data: {
          isError: false,
          count: 0,
          label: null,
          enabled: true,
        },
      }),
    );

    const lines = await readDecisions();
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.data.isError).toBe(false);
    expect(parsed.data.count).toBe(0);
    expect(parsed.data.label).toBeNull();
    expect(parsed.data.enabled).toBe(true);
  });
});
