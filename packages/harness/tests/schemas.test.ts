/**
 * Schema contract tests for zao.
 *
 * Covers all 5 test categories from Story 002 acceptance criteria:
 * - TEST-1: Happy path — valid JSON parses for each schema
 * - TEST-2: Missing required fields — throws with field-path in error
 * - TEST-3: Wrong types — string where number expected, throws with descriptive path
 * - TEST-4: Extra unknown fields — .strict() rejects them
 * - TEST-5: schema_version field present and valid ("0.1.0" only)
 *
 * @module schemas.test
 */

import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import {
  HandoffRequestSchema,
  HandoffResponseSchema,
  ToolExecutionRequestSchema,
  MemoryStateSchema,
  EventLogEntrySchema,
} from "../src/schemas/index.ts";

// ── Helpers ───────────────────────────────────────────────────

/** Load a JSON fixture from tests/fixtures/ relative to this test file */
async function loadFixture(name: string): Promise<unknown> {
  const fixturePath = `${import.meta.dir}/fixtures/${name}`;
  const file = Bun.file(fixturePath);
  if (!(await file.exists())) {
    throw new Error(`Fixture not found: ${fixturePath}`);
  }
  return file.json();
}

/** Assert that a function throws a ZodError and return the caught error. */
function expectZodError(fn: () => unknown): ZodError {
  try {
    fn();
    throw new Error("Expected ZodError but no error was thrown");
  } catch (e) {
    if (e instanceof ZodError) return e;
    throw e;
  }
}

// ── HandoffRequest ────────────────────────────────────────────

describe("HandoffRequestSchema", () => {
  // ── TEST-1: Happy path ──────────────────────────────────

  test("parses valid handoff request fixture", async () => {
    const data = await loadFixture("handoff-request-valid.json");
    const result = HandoffRequestSchema.parse(data);

    expect(result.schema_version).toBe("0.1.0");
    expect(result.task_id).toBe("task-001");
    expect(result.role).toBe("developer");
    expect(result.objective).toContain("Implement user authentication");
    expect(result.artifacts).toEqual([
      "src/auth/login.ts",
      "src/auth/register.ts",
      "tests/auth/login.test.ts",
    ]);
    expect(result.guardrails).toEqual([
      "Rule 1: No secrets in code",
      "Rule 2: Sanitize all inputs",
    ]);
    expect(result.output_path).toBe("/tmp/zao-output/task-001");
  });

  test("parses request without optional guardrails", () => {
    const result = HandoffRequestSchema.parse({
      schema_version: "0.1.0",
      task_id: "task-002",
      role: "reviewer",
      objective: "Review code for security issues",
      artifacts: [],
      output_path: "/tmp/output",
    });

    expect(result.guardrails).toBeUndefined();
  });

  // ── TEST-2: Missing required fields ─────────────────────

  test("throws on missing task_id", () => {
    const err = expectZodError(() =>
      HandoffRequestSchema.parse({
        schema_version: "0.1.0",
        role: "developer",
        objective: "Do something",
        artifacts: [],
        output_path: "/tmp/out",
      })
    );
    expect(err.message).toContain("task_id");
  });

  test("throws on missing objective (invalid fixture)", async () => {
    const data = await loadFixture("handoff-request-invalid.json");
    const err = expectZodError(() => HandoffRequestSchema.parse(data));
    expect(err.message).toContain("objective");
  });

  // ── TEST-3: Wrong types ─────────────────────────────────

  test("throws when artifacts is not an array", () => {
    const err = expectZodError(() =>
      HandoffRequestSchema.parse({
        schema_version: "0.1.0",
        task_id: "task-003",
        role: "developer",
        objective: "Do something",
        artifacts: "not-an-array",
        output_path: "/tmp/out",
      })
    );
    expect(err.message).toContain("artifacts");
  });

  test("throws when output_path is a number", () => {
    const err = expectZodError(() =>
      HandoffRequestSchema.parse({
        schema_version: "0.1.0",
        task_id: "task-004",
        role: "developer",
        objective: "Do something",
        artifacts: [],
        output_path: 123,
      })
    );
    expect(err.message).toContain("output_path");
  });

  // ── TEST-4: Extra unknown fields ────────────────────────

  test("strict: rejects object with extra unknown field", () => {
    const err = expectZodError(() =>
      HandoffRequestSchema.parse({
        schema_version: "0.1.0",
        task_id: "task-005",
        role: "developer",
        objective: "Do something",
        artifacts: [],
        output_path: "/tmp/out",
        should_not_be_here: "extra",
      })
    );
    // Strict mode should mention the unrecognized key
    expect(err.message).toMatch(/unrecognized|unknown|should_not_be_here/i);
  });

  // ── TEST-5: schema_version ──────────────────────────────

  test("accepts schema_version '0.1.0'", () => {
    const result = HandoffRequestSchema.parse({
      schema_version: "0.1.0",
      task_id: "task-006",
      role: "developer",
      objective: "Do something",
      artifacts: [],
      output_path: "/tmp/out",
    });
    expect(result.schema_version).toBe("0.1.0");
  });

  test("rejects schema_version '0.2.0'", () => {
    const err = expectZodError(() =>
      HandoffRequestSchema.parse({
        schema_version: "0.2.0",
        task_id: "task-006",
        role: "developer",
        objective: "Do something",
        artifacts: [],
        output_path: "/tmp/out",
      })
    );
    expect(err.message).toContain("schema_version");
  });

  // ── Additional coverage: missing fields ─────────────────

  test("throws on missing role", () => {
    const err = expectZodError(() =>
      HandoffRequestSchema.parse({
        schema_version: "0.1.0",
        task_id: "task-007",
        objective: "Do something",
        artifacts: [],
        output_path: "/tmp/out",
      })
    );
    expect(err.message).toContain("role");
  });

  test("throws on missing artifacts", () => {
    const err = expectZodError(() =>
      HandoffRequestSchema.parse({
        schema_version: "0.1.0",
        task_id: "task-008",
        role: "developer",
        objective: "Do something",
        output_path: "/tmp/out",
      })
    );
    expect(err.message).toContain("artifacts");
  });

  test("throws on missing output_path", () => {
    const err = expectZodError(() =>
      HandoffRequestSchema.parse({
        schema_version: "0.1.0",
        task_id: "task-009",
        role: "developer",
        objective: "Do something",
        artifacts: [],
      })
    );
    expect(err.message).toContain("output_path");
  });

  test("throws on missing schema_version", () => {
    const err = expectZodError(() =>
      HandoffRequestSchema.parse({
        task_id: "task-010",
        role: "developer",
        objective: "Do something",
        artifacts: [],
        output_path: "/tmp/out",
      })
    );
    expect(err.message).toContain("schema_version");
  });

  // ── Additional coverage: wrong types ────────────────────

  test("throws when task_id is a number", () => {
    const err = expectZodError(() =>
      HandoffRequestSchema.parse({
        schema_version: "0.1.0",
        task_id: 999,
        role: "developer",
        objective: "Do something",
        artifacts: [],
        output_path: "/tmp/out",
      })
    );
    expect(err.message).toContain("task_id");
  });

  test("throws when guardrails is an object instead of array", () => {
    const err = expectZodError(() =>
      HandoffRequestSchema.parse({
        schema_version: "0.1.0",
        task_id: "task-011",
        role: "developer",
        objective: "Do something",
        artifacts: [],
        output_path: "/tmp/out",
        guardrails: { rule: "invalid" },
      })
    );
    expect(err.message).toContain("guardrails");
  });

  // ── Additional coverage: min(1) empty string violations ──

  test("rejects empty string for task_id (min(1))", () => {
    const err = expectZodError(() =>
      HandoffRequestSchema.parse({
        schema_version: "0.1.0",
        task_id: "",
        role: "developer",
        objective: "Do something",
        artifacts: [],
        output_path: "/tmp/out",
      })
    );
    expect(err.message).toContain("task_id");
  });

  test("rejects empty string for role (min(1))", () => {
    const err = expectZodError(() =>
      HandoffRequestSchema.parse({
        schema_version: "0.1.0",
        task_id: "task-012",
        role: "",
        objective: "Do something",
        artifacts: [],
        output_path: "/tmp/out",
      })
    );
    expect(err.message).toContain("role");
  });

  test("rejects empty string for output_path (min(1))", () => {
    const err = expectZodError(() =>
      HandoffRequestSchema.parse({
        schema_version: "0.1.0",
        task_id: "task-013",
        role: "developer",
        objective: "Do something",
        artifacts: [],
        output_path: "",
      })
    );
    expect(err.message).toContain("output_path");
  });

  // ── Additional coverage: edge cases ─────────────────────

  test("accepts unicode and emoji in objective", () => {
    const result = HandoffRequestSchema.parse({
      schema_version: "0.1.0",
      task_id: "task-014",
      role: "developer",
      objective: "Fix the résumé upload 🚀 with café-latte encoding",
      artifacts: [],
      output_path: "/tmp/out",
    });
    expect(result.objective).toContain("🚀");
  });
});

// ── HandoffResponse ───────────────────────────────────────────

describe("HandoffResponseSchema", () => {
  // ── TEST-1: Happy path ──────────────────────────────────

  test("parses valid handoff response fixture", async () => {
    const data = await loadFixture("handoff-response-valid.json");
    const result = HandoffResponseSchema.parse(data);

    expect(result.schema_version).toBe("0.1.0");
    expect(result.status).toBe("success");
    expect(result.summary).toContain("Authentication module implemented");
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0]!.file_path).toBe("src/auth/login.ts");
    expect(result.changes[0]!.content).toContain("export async function login");
  });

  test("parses response with needs_clarification status", () => {
    const result = HandoffResponseSchema.parse({
      schema_version: "0.1.0",
      status: "needs_clarification",
      summary: "Need clarification on scope",
      changes: [],
    });

    expect(result.status).toBe("needs_clarification");
  });

  test("parses response with failed status", () => {
    const result = HandoffResponseSchema.parse({
      schema_version: "0.1.0",
      status: "failed",
      summary: "Build error prevented completion",
      changes: [],
    });

    expect(result.status).toBe("failed");
  });

  // ── TEST-2: Missing required fields ─────────────────────

  test("throws on missing status", () => {
    const err = expectZodError(() =>
      HandoffResponseSchema.parse({
        schema_version: "0.1.0",
        summary: "Done.",
        changes: [],
      })
    );
    expect(err.message).toContain("status");
  });

  test("throws on missing changes", () => {
    const err = expectZodError(() =>
      HandoffResponseSchema.parse({
        schema_version: "0.1.0",
        status: "success",
        summary: "Done.",
      })
    );
    expect(err.message).toContain("changes");
  });

  // ── TEST-3: Wrong types ─────────────────────────────────

  test("throws when changes is not an array", () => {
    const err = expectZodError(() =>
      HandoffResponseSchema.parse({
        schema_version: "0.1.0",
        status: "success",
        summary: "Done.",
        changes: "not-an-array",
      })
    );
    expect(err.message).toContain("changes");
  });

  test("throws when change entry missing file_path", () => {
    const err = expectZodError(() =>
      HandoffResponseSchema.parse({
        schema_version: "0.1.0",
        status: "success",
        summary: "Done.",
        changes: [{ content: "some content" }],
      })
    );
    expect(err.message).toContain("file_path");
  });

  // ── TEST-4: Extra unknown fields ────────────────────────

  test("strict: rejects object with extra unknown field (invalid fixture)", async () => {
    const data = await loadFixture("handoff-response-invalid.json");
    const err = expectZodError(() => HandoffResponseSchema.parse(data));
    expect(err.message).toMatch(/unrecognized|unknown|extra_unknown_field/i);
  });

  test("strict: rejects change entry with extra field", () => {
    const err = expectZodError(() =>
      HandoffResponseSchema.parse({
        schema_version: "0.1.0",
        status: "success",
        summary: "Done.",
        changes: [{ file_path: "a.ts", content: "x", diff: "should not be here" }],
      })
    );
    expect(err.message).toMatch(/unrecognized|unknown|diff/i);
  });

  // ── TEST-5: schema_version ──────────────────────────────

  test("accepts schema_version '0.1.0'", () => {
    const result = HandoffResponseSchema.parse({
      schema_version: "0.1.0",
      status: "success",
      summary: "Done.",
      changes: [],
    });
    expect(result.schema_version).toBe("0.1.0");
  });

  test("rejects schema_version '1.0.0'", () => {
    const err = expectZodError(() =>
      HandoffResponseSchema.parse({
        schema_version: "1.0.0",
        status: "success",
        summary: "Done.",
        changes: [],
      })
    );
    expect(err.message).toContain("schema_version");
  });

  // ── Additional coverage: missing fields ─────────────────

  test("throws on missing summary", () => {
    const err = expectZodError(() =>
      HandoffResponseSchema.parse({
        schema_version: "0.1.0",
        status: "success",
        changes: [],
      })
    );
    expect(err.message).toContain("summary");
  });

  test("throws on missing schema_version", () => {
    const err = expectZodError(() =>
      HandoffResponseSchema.parse({
        status: "success",
        summary: "Done.",
        changes: [],
      })
    );
    expect(err.message).toContain("schema_version");
  });

  // ── Additional coverage: wrong types ────────────────────

  test("throws on invalid status enum value", () => {
    const err = expectZodError(() =>
      HandoffResponseSchema.parse({
        schema_version: "0.1.0",
        status: "pending",
        summary: "Done.",
        changes: [],
      })
    );
    expect(err.message).toContain("status");
  });

  test("throws when change entry has content as number", () => {
    const err = expectZodError(() =>
      HandoffResponseSchema.parse({
        schema_version: "0.1.0",
        status: "success",
        summary: "Done.",
        changes: [{ file_path: "a.ts", content: 123 }],
      })
    );
    expect(err.message).toContain("content");
  });

  // ── Additional coverage: min(1) violations ──────────────

  test("rejects empty file_path in changes[] (min(1))", () => {
    const err = expectZodError(() =>
      HandoffResponseSchema.parse({
        schema_version: "0.1.0",
        status: "success",
        summary: "Done.",
        changes: [{ file_path: "", content: "x" }],
      })
    );
    expect(err.message).toContain("file_path");
  });

  // ── Additional coverage: edge cases ─────────────────────

  test("accepts unicode and emoji in summary", () => {
    const result = HandoffResponseSchema.parse({
      schema_version: "0.1.0",
      status: "success",
      summary: "Implemented résumé parser 🚀 for café users",
      changes: [],
    });
    expect(result.summary).toContain("🚀");
  });
});

// ── ToolExecutionRequest ──────────────────────────────────────

describe("ToolExecutionRequestSchema", () => {
  // ── TEST-1: Happy path ──────────────────────────────────

  test("parses valid tool execution request fixture", async () => {
    const data = await loadFixture("tool-execution-request-valid.json");
    const result = ToolExecutionRequestSchema.parse(data);

    expect(result.schema_version).toBe("0.1.0");
    expect(result.action_type).toBe("shell");
    expect(result.command).toBe("bun test");
    expect(result.user_facing_explanation).toContain("Running the test suite");
  });

  // ── TEST-2: Missing required fields ─────────────────────

  test("throws on missing action_type", () => {
    const err = expectZodError(() =>
      ToolExecutionRequestSchema.parse({
        schema_version: "0.1.0",
        command: "ls -la",
        user_facing_explanation: "List files",
      })
    );
    expect(err.message).toContain("action_type");
  });

  // ── TEST-3: Wrong types ─────────────────────────────────

  test("throws when command is a number (invalid fixture)", async () => {
    const data = await loadFixture("tool-execution-request-invalid.json");
    const err = expectZodError(() => ToolExecutionRequestSchema.parse(data));
    expect(err.message).toContain("command");
  });

  // ── TEST-4: Extra unknown fields ────────────────────────

  test("strict: rejects object with extra field", () => {
    const err = expectZodError(() =>
      ToolExecutionRequestSchema.parse({
        schema_version: "0.1.0",
        action_type: "shell",
        command: "ls",
        user_facing_explanation: "List files",
        extra_field: "should not be here",
      })
    );
    expect(err.message).toMatch(/unrecognized|unknown|extra_field/i);
  });

  // ── TEST-5: schema_version ──────────────────────────────

  test("accepts schema_version '0.1.0'", () => {
    const result = ToolExecutionRequestSchema.parse({
      schema_version: "0.1.0",
      action_type: "shell",
      command: "ls",
      user_facing_explanation: "List files",
    });
    expect(result.schema_version).toBe("0.1.0");
  });

  test("rejects schema_version '0.0.9'", () => {
    const err = expectZodError(() =>
      ToolExecutionRequestSchema.parse({
        schema_version: "0.0.9",
        action_type: "shell",
        command: "ls",
        user_facing_explanation: "List files",
      })
    );
    expect(err.message).toContain("schema_version");
  });

  // ── Additional coverage: missing fields ─────────────────

  test("throws on missing command", () => {
    const err = expectZodError(() =>
      ToolExecutionRequestSchema.parse({
        schema_version: "0.1.0",
        action_type: "shell",
        user_facing_explanation: "List files",
      })
    );
    expect(err.message).toContain("command");
  });

  test("throws on missing user_facing_explanation", () => {
    const err = expectZodError(() =>
      ToolExecutionRequestSchema.parse({
        schema_version: "0.1.0",
        action_type: "shell",
        command: "ls",
      })
    );
    expect(err.message).toContain("user_facing_explanation");
  });

  test("throws on missing schema_version", () => {
    const err = expectZodError(() =>
      ToolExecutionRequestSchema.parse({
        action_type: "shell",
        command: "ls",
        user_facing_explanation: "List files",
      })
    );
    expect(err.message).toContain("schema_version");
  });

  // ── Additional coverage: wrong types ────────────────────

  test("throws when action_type is a number", () => {
    const err = expectZodError(() =>
      ToolExecutionRequestSchema.parse({
        schema_version: "0.1.0",
        action_type: 42,
        command: "ls",
        user_facing_explanation: "List files",
      })
    );
    expect(err.message).toContain("action_type");
  });

  test("throws when user_facing_explanation is a number", () => {
    const err = expectZodError(() =>
      ToolExecutionRequestSchema.parse({
        schema_version: "0.1.0",
        action_type: "shell",
        command: "ls",
        user_facing_explanation: 123,
      })
    );
    expect(err.message).toContain("user_facing_explanation");
  });

  // ── Additional coverage: min(1) empty string violations ──

  test("rejects empty string for action_type (min(1))", () => {
    const err = expectZodError(() =>
      ToolExecutionRequestSchema.parse({
        schema_version: "0.1.0",
        action_type: "",
        command: "ls",
        user_facing_explanation: "List files",
      })
    );
    expect(err.message).toContain("action_type");
  });

  test("rejects empty string for command (min(1))", () => {
    const err = expectZodError(() =>
      ToolExecutionRequestSchema.parse({
        schema_version: "0.1.0",
        action_type: "shell",
        command: "",
        user_facing_explanation: "List files",
      })
    );
    expect(err.message).toContain("command");
  });
});

// ── MemoryState ───────────────────────────────────────────────

describe("MemoryStateSchema", () => {
  // ── TEST-1: Happy path ──────────────────────────────────

  test("parses valid memory state fixture", async () => {
    const data = await loadFixture("memory-state-valid.json");
    const result = MemoryStateSchema.parse(data);

    expect(result.schema_version).toBe("0.1.0");
    expect(result.current_phase).toBe("phase_1_implementation");
    expect(result.session_id).toBe("session-20260802-001");
    expect(result.phases).toHaveLength(3);
    expect(result.phases[0]!.name).toBe("phase_0_planning");
    expect(result.phases[0]!.status).toBe("complete");
    expect(result.phases[1]!.name).toBe("phase_1_implementation");
    expect(result.phases[1]!.status).toBe("active");
  });

  test("parses memory state with empty phases", () => {
    const result = MemoryStateSchema.parse({
      schema_version: "0.1.0",
      current_phase: "phase_0_planning",
      session_id: "session-001",
      phases: [],
    });

    expect(result.phases).toHaveLength(0);
  });

  // ── TEST-2: Missing required fields ─────────────────────

  test("throws on missing session_id (invalid fixture)", async () => {
    const data = await loadFixture("memory-state-invalid.json");
    const err = expectZodError(() => MemoryStateSchema.parse(data));
    expect(err.message).toContain("session_id");
  });

  test("throws on missing current_phase", () => {
    const err = expectZodError(() =>
      MemoryStateSchema.parse({
        schema_version: "0.1.0",
        session_id: "session-001",
        phases: [],
      })
    );
    expect(err.message).toContain("current_phase");
  });

  // ── TEST-3: Wrong types ─────────────────────────────────

  test("throws when phases is not an array", () => {
    const err = expectZodError(() =>
      MemoryStateSchema.parse({
        schema_version: "0.1.0",
        current_phase: "phase_1",
        session_id: "session-001",
        phases: { name: "wrong", status: "complete" },
      })
    );
    expect(err.message).toContain("phases");
  });

  test("throws when phase entry has wrong types", () => {
    const err = expectZodError(() =>
      MemoryStateSchema.parse({
        schema_version: "0.1.0",
        current_phase: "phase_1",
        session_id: "session-001",
        phases: [{ name: 123, status: "complete" }],
      })
    );
    expect(err.message).toContain("name");
  });

  // ── TEST-4: Extra unknown fields ────────────────────────

  test("strict: rejects memory state with extra field", () => {
    const err = expectZodError(() =>
      MemoryStateSchema.parse({
        schema_version: "0.1.0",
        current_phase: "phase_1",
        session_id: "session-001",
        phases: [],
        unrecognized_property: true,
      })
    );
    expect(err.message).toMatch(/unrecognized|unknown|unrecognized_property/i);
  });

  test("strict: rejects phase entry with extra field", () => {
    const err = expectZodError(() =>
      MemoryStateSchema.parse({
        schema_version: "0.1.0",
        current_phase: "phase_1",
        session_id: "session-001",
        phases: [{ name: "phase_0", status: "complete", extra: "no" }],
      })
    );
    expect(err.message).toMatch(/unrecognized|unknown|extra/i);
  });

  // ── TEST-5: schema_version ──────────────────────────────

  test("accepts schema_version '0.1.0'", () => {
    const result = MemoryStateSchema.parse({
      schema_version: "0.1.0",
      current_phase: "phase_1",
      session_id: "session-001",
      phases: [],
    });
    expect(result.schema_version).toBe("0.1.0");
  });

  test("rejects schema_version '0.1.0-beta'", () => {
    const err = expectZodError(() =>
      MemoryStateSchema.parse({
        schema_version: "0.1.0-beta",
        current_phase: "phase_1",
        session_id: "session-001",
        phases: [],
      })
    );
    expect(err.message).toContain("schema_version");
  });

  // ── Additional coverage: missing fields ─────────────────

  test("throws on missing phases", () => {
    const err = expectZodError(() =>
      MemoryStateSchema.parse({
        schema_version: "0.1.0",
        current_phase: "phase_1",
        session_id: "session-001",
      })
    );
    expect(err.message).toContain("phases");
  });

  test("throws on missing schema_version", () => {
    const err = expectZodError(() =>
      MemoryStateSchema.parse({
        current_phase: "phase_1",
        session_id: "session-001",
        phases: [],
      })
    );
    expect(err.message).toContain("schema_version");
  });

  // ── Additional coverage: wrong types ────────────────────

  test("throws when current_phase is a number", () => {
    const err = expectZodError(() =>
      MemoryStateSchema.parse({
        schema_version: "0.1.0",
        current_phase: 42,
        session_id: "session-001",
        phases: [],
      })
    );
    expect(err.message).toContain("current_phase");
  });

  test("throws when session_id is a number", () => {
    const err = expectZodError(() =>
      MemoryStateSchema.parse({
        schema_version: "0.1.0",
        current_phase: "phase_1",
        session_id: 123,
        phases: [],
      })
    );
    expect(err.message).toContain("session_id");
  });

  test("throws when phase entry status is a number", () => {
    const err = expectZodError(() =>
      MemoryStateSchema.parse({
        schema_version: "0.1.0",
        current_phase: "phase_1",
        session_id: "session-001",
        phases: [{ name: "phase_0", status: 999 }],
      })
    );
    expect(err.message).toContain("status");
  });

  // ── Additional coverage: min(1) empty string violations ──

  test("rejects empty string for current_phase (min(1))", () => {
    const err = expectZodError(() =>
      MemoryStateSchema.parse({
        schema_version: "0.1.0",
        current_phase: "",
        session_id: "session-001",
        phases: [],
      })
    );
    expect(err.message).toContain("current_phase");
  });

  test("rejects empty string for session_id (min(1))", () => {
    const err = expectZodError(() =>
      MemoryStateSchema.parse({
        schema_version: "0.1.0",
        current_phase: "phase_1",
        session_id: "",
        phases: [],
      })
    );
    expect(err.message).toContain("session_id");
  });

  test("rejects empty string for phase name (min(1))", () => {
    const err = expectZodError(() =>
      MemoryStateSchema.parse({
        schema_version: "0.1.0",
        current_phase: "phase_1",
        session_id: "session-001",
        phases: [{ name: "", status: "complete" }],
      })
    );
    expect(err.message).toContain("name");
  });

  test("rejects empty string for phase status (min(1))", () => {
    const err = expectZodError(() =>
      MemoryStateSchema.parse({
        schema_version: "0.1.0",
        current_phase: "phase_1",
        session_id: "session-001",
        phases: [{ name: "phase_0", status: "" }],
      })
    );
    expect(err.message).toContain("status");
  });
});

// ── EventLogEntry ─────────────────────────────────────────────

describe("EventLogEntrySchema", () => {
  // Helper: standard v0.2.0 envelope
  const envelope = {
    event_id: "018f1234-5678-7abc-8000-123456789abc",
    session_id: "018f1234-5678-7abc-8000-123456789abd",
    parent_session_id: null as string | null,
  };

  // ── TEST-1: Happy path ──────────────────────────────────

  test("parses valid event log entry fixture", async () => {
    const data = await loadFixture("event-log-entry-valid.json");
    const result = EventLogEntrySchema.parse(data);

    expect(result.schema_version).toBe("0.2.0");
    expect(result.event_id).toBe("018f1234-5678-7abc-8000-123456789abc");
    expect(result.session_id).toBe("018f1234-5678-7abc-8000-123456789abd");
    expect(result.parent_session_id).toBeNull();
    expect(result.timestamp).toBe("2026-08-02T14:30:00.000Z");
    expect(result.agent_role).toBe("developer");
    expect(result.model_id).toBe("deepseek-v4-pro");
    expect(result.prompt_tokens).toBe(1250);
    expect(result.completion_tokens).toBe(340);
    expect(result.cache_hit).toBe(false);
    expect(result.action).toBe("implement_schema_contracts");
  });

  test("parses entry with cache hit true", () => {
    const result = EventLogEntrySchema.parse({
      schema_version: "0.2.0" as const,
      ...envelope,
      timestamp: "2026-08-02T15:00:00.000Z",
      agent_role: "reviewer",
      model_id: "claude-sonnet-5",
      prompt_tokens: 500,
      completion_tokens: 100,
      cache_hit: true,
      action: "review_code",
    });

    expect(result.cache_hit).toBe(true);
  });

  test("parses entry with zero tokens", () => {
    const result = EventLogEntrySchema.parse({
      schema_version: "0.2.0" as const,
      ...envelope,
      timestamp: "2026-08-02T16:00:00.000Z",
      agent_role: "orchestrator",
      model_id: "none",
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_hit: false,
      action: "noop",
    });

    expect(result.prompt_tokens).toBe(0);
    expect(result.completion_tokens).toBe(0);
  });

  // ── TEST-2: Missing required fields ─────────────────────

  test("throws on missing agent_role", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        ...envelope,
        timestamp: "2026-08-02T14:30:00.000Z",
        model_id: "deepseek-v4-pro",
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_hit: false,
        action: "test",
      })
    );
    expect(err.message).toContain("agent_role");
  });

  // ── TEST-3: Wrong types ─────────────────────────────────

  test("throws when prompt_tokens is a string (invalid fixture)", async () => {
    const data = await loadFixture("event-log-entry-invalid.json");
    const err = expectZodError(() => EventLogEntrySchema.parse(data));
    expect(err.message).toContain("prompt_tokens");
  });

  test("throws when cache_hit is a string", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        ...envelope,
        timestamp: "2026-08-02T14:30:00.000Z",
        agent_role: "developer",
        model_id: "deepseek-v4-pro",
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_hit: "not-a-boolean",
        action: "test",
      })
    );
    expect(err.message).toContain("cache_hit");
  });

  // ── TEST-4: Passthrough allows extra fields ──────────────

  test("passthrough: allows entry with extra fields", () => {
    // EventLogEntrySchema uses .passthrough() — extra fields are
    // allowed (delegation, executor, HITL add domain-specific fields).
    const result = EventLogEntrySchema.parse({
      schema_version: "0.2.0",
      ...envelope,
      timestamp: "2026-08-02T14:30:00.000Z",
      agent_role: "developer",
      model_id: "deepseek-v4-pro",
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_hit: false,
      action: "test",
      cost_cents: 5,
    });
    expect(result.cost_cents).toBe(5);
  });

  // ── TEST-5: schema_version ──────────────────────────────

  test("accepts schema_version '0.2.0'", () => {
    const result = EventLogEntrySchema.parse({
      schema_version: "0.2.0" as const,
      ...envelope,
      timestamp: "2026-08-02T14:30:00.000Z",
      agent_role: "developer",
      model_id: "deepseek-v4-pro",
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_hit: false,
      action: "test",
    });
    expect(result.schema_version).toBe("0.2.0");
  });

  test("rejects missing schema_version", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        ...envelope,
        timestamp: "2026-08-02T14:30:00.000Z",
        agent_role: "developer",
        model_id: "deepseek-v4-pro",
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_hit: false,
        action: "test",
      })
    );
    expect(err.message).toContain("schema_version");
  });

  test("rejects schema_version '0.1.0'", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.1.0",
        ...envelope,
        timestamp: "2026-08-02T14:30:00.000Z",
        agent_role: "developer",
        model_id: "deepseek-v4-pro",
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_hit: false,
        action: "test",
      })
    );
    expect(err.message).toContain("schema_version");
  });

  // ── Additional coverage: missing fields ─────────────────

  test("throws on missing event_id", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        session_id: envelope.session_id,
        parent_session_id: envelope.parent_session_id,
        timestamp: "2026-08-02T14:30:00.000Z",
        agent_role: "developer",
        model_id: "deepseek-v4-pro",
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_hit: false,
        action: "test",
      })
    );
    expect(err.message).toContain("event_id");
  });

  test("throws on missing timestamp", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        ...envelope,
        agent_role: "developer",
        model_id: "deepseek-v4-pro",
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_hit: false,
        action: "test",
      })
    );
    expect(err.message).toContain("timestamp");
  });

  test("throws on missing model_id", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        ...envelope,
        timestamp: "2026-08-02T14:30:00.000Z",
        agent_role: "developer",
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_hit: false,
        action: "test",
      })
    );
    expect(err.message).toContain("model_id");
  });

  test("throws on missing prompt_tokens", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        ...envelope,
        timestamp: "2026-08-02T14:30:00.000Z",
        agent_role: "developer",
        model_id: "deepseek-v4-pro",
        completion_tokens: 50,
        cache_hit: false,
        action: "test",
      })
    );
    expect(err.message).toContain("prompt_tokens");
  });

  test("throws on missing completion_tokens", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        ...envelope,
        timestamp: "2026-08-02T14:30:00.000Z",
        agent_role: "developer",
        model_id: "deepseek-v4-pro",
        prompt_tokens: 100,
        cache_hit: false,
        action: "test",
      })
    );
    expect(err.message).toContain("completion_tokens");
  });

  test("throws on missing cache_hit", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        ...envelope,
        timestamp: "2026-08-02T14:30:00.000Z",
        agent_role: "developer",
        model_id: "deepseek-v4-pro",
        prompt_tokens: 100,
        completion_tokens: 50,
        action: "test",
      })
    );
    expect(err.message).toContain("cache_hit");
  });

  test("throws on missing action", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        ...envelope,
        timestamp: "2026-08-02T14:30:00.000Z",
        agent_role: "developer",
        model_id: "deepseek-v4-pro",
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_hit: false,
      })
    );
    expect(err.message).toContain("action");
  });

  // ── Additional coverage: wrong types ────────────────────

  test("throws when timestamp is a number", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        ...envelope,
        timestamp: 1234,
        agent_role: "developer",
        model_id: "deepseek-v4-pro",
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_hit: false,
        action: "test",
      })
    );
    expect(err.message).toContain("timestamp");
  });

  test("throws when agent_role is a number", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        ...envelope,
        timestamp: "2026-08-02T14:30:00.000Z",
        agent_role: 42,
        model_id: "deepseek-v4-pro",
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_hit: false,
        action: "test",
      })
    );
    expect(err.message).toContain("agent_role");
  });

  test("throws when model_id is a number", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        ...envelope,
        timestamp: "2026-08-02T14:30:00.000Z",
        agent_role: "developer",
        model_id: 123,
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_hit: false,
        action: "test",
      })
    );
    expect(err.message).toContain("model_id");
  });

  test("throws when completion_tokens is a string", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        ...envelope,
        timestamp: "2026-08-02T14:30:00.000Z",
        agent_role: "developer",
        model_id: "deepseek-v4-pro",
        prompt_tokens: 100,
        completion_tokens: "fifty",
        cache_hit: false,
        action: "test",
      })
    );
    expect(err.message).toContain("completion_tokens");
  });

  // ── Additional coverage: min(1) empty string violations ──

  test("rejects empty string for timestamp (min(1))", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        ...envelope,
        timestamp: "",
        agent_role: "developer",
        model_id: "deepseek-v4-pro",
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_hit: false,
        action: "test",
      })
    );
    expect(err.message).toContain("timestamp");
  });

  test("rejects empty string for agent_role (min(1))", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        ...envelope,
        timestamp: "2026-08-02T14:30:00.000Z",
        agent_role: "",
        model_id: "deepseek-v4-pro",
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_hit: false,
        action: "test",
      })
    );
    expect(err.message).toContain("agent_role");
  });

  test("rejects empty string for model_id (min(1))", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        ...envelope,
        timestamp: "2026-08-02T14:30:00.000Z",
        agent_role: "developer",
        model_id: "",
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_hit: false,
        action: "test",
      })
    );
    expect(err.message).toContain("model_id");
  });

  test("rejects empty string for action (min(1))", () => {
    const err = expectZodError(() =>
      EventLogEntrySchema.parse({
        schema_version: "0.2.0",
        ...envelope,
        timestamp: "2026-08-02T14:30:00.000Z",
        agent_role: "developer",
        model_id: "deepseek-v4-pro",
        prompt_tokens: 100,
        completion_tokens: 50,
        cache_hit: false,
        action: "",
      })
    );
    expect(err.message).toContain("action");
  });

  // ── Additional coverage: edge cases ─────────────────────

  test("accepts negative token counts (z.number() has no min constraint)", () => {
    const result = EventLogEntrySchema.parse({
      schema_version: "0.2.0" as const,
      ...envelope,
      timestamp: "2026-08-02T14:30:00.000Z",
      agent_role: "developer",
      model_id: "deepseek-v4-pro",
      prompt_tokens: -1,
      completion_tokens: -1,
      cache_hit: false,
      action: "test",
    });
    expect(result.prompt_tokens).toBe(-1);
    expect(result.completion_tokens).toBe(-1);
  });
});
