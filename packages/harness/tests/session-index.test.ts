/**
 * Session index schema tests.
 *
 * Validates GlobalIndexCreateEntrySchema, GlobalIndexCompleteEntrySchema,
 * and AgentsIndexEntrySchema.
 *
 * @module session-index.test
 */

import { describe, expect, test } from "bun:test";
import {
  GlobalIndexCreateEntrySchema,
  GlobalIndexCompleteEntrySchema,
  AgentsIndexEntrySchema,
} from "../src/schemas/session-index.ts";

// ── Global Index: Create Entry ────────────────────────────────

describe("GlobalIndexCreateEntrySchema", () => {
  const validCreate = {
    session_id: "018f1234-5678-7abc-8000-123456789abc",
    created_at: "2026-01-01T00:00:00.000Z",
    repo_root: "/home/user/project",
    repo_remote: "https://github.com/user/project.git",
    task_summary: "Implement feature X",
    status: "active" as const,
    branched_from: null,
  };

  test("accepts valid create entry", () => {
    const result = GlobalIndexCreateEntrySchema.parse(validCreate);
    expect(result.status).toBe("active");
  });

  test("rejects non-'active' status", () => {
    expect(() =>
      GlobalIndexCreateEntrySchema.parse({
        ...validCreate,
        status: "complete",
      }),
    ).toThrow();
  });

  test("accepts null repo fields", () => {
    const result = GlobalIndexCreateEntrySchema.parse({
      ...validCreate,
      repo_root: null,
      repo_remote: null,
    });
    expect(result.repo_root).toBeNull();
  });

  test("rejects extra unknown fields (strict)", () => {
    expect(() =>
      GlobalIndexCreateEntrySchema.parse({
        ...validCreate,
        extra: true,
      }),
    ).toThrow();
  });
});

// ── Global Index: Complete Entry ──────────────────────────────

describe("GlobalIndexCompleteEntrySchema", () => {
  const validComplete = {
    session_id: "018f1234-5678-7abc-8000-123456789abc",
    completed_at: "2026-01-01T01:00:00.000Z",
    status: "complete" as const,
    agents_spawned: 3,
    models: ["deepseek-chat"],
    tokens: {
      prompt: 10000,
      completion: 5000,
    },
  };

  test("accepts valid complete entry", () => {
    const result = GlobalIndexCompleteEntrySchema.parse(validComplete);
    expect(result.status).toBe("complete");
  });

  test("accepts 'failed' and 'interrupted' statuses", () => {
    expect(
      GlobalIndexCompleteEntrySchema.parse({
        ...validComplete,
        status: "failed",
      }).status,
    ).toBe("failed");

    expect(
      GlobalIndexCompleteEntrySchema.parse({
        ...validComplete,
        status: "interrupted",
      }).status,
    ).toBe("interrupted");
  });

  test("rejects invalid status", () => {
    expect(() =>
      GlobalIndexCompleteEntrySchema.parse({
        ...validComplete,
        status: "active",
      }),
    ).toThrow();
  });

  test("rejects negative agents_spawned", () => {
    expect(() =>
      GlobalIndexCompleteEntrySchema.parse({
        ...validComplete,
        agents_spawned: -1,
      }),
    ).toThrow();
  });
});

// ── Agents Index Entry ────────────────────────────────────────

describe("AgentsIndexEntrySchema", () => {
  const validAgent = {
    session_id: "018f1234-5678-7abc-8000-123456789def",
    parent_session_id: "018f1234-5678-7abc-8000-123456789abc",
    node_id: "review-node",
    role: "reviewer",
    started_at: "2026-01-01T00:05:00.000Z",
    status: "active",
  };

  test("accepts valid agents index entry", () => {
    const result = AgentsIndexEntrySchema.parse(validAgent);
    expect(result.role).toBe("reviewer");
  });

  test("accepts entry without optional node_id", () => {
    const { node_id, ...withoutNode } = validAgent;
    const result = AgentsIndexEntrySchema.parse(withoutNode);
    expect(result.node_id).toBeUndefined();
  });

  test("rejects missing parent_session_id", () => {
    const { parent_session_id, ...missing } = validAgent;
    expect(() => AgentsIndexEntrySchema.parse(missing)).toThrow();
  });
});
