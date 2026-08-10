/**
 * Session manifest schema tests (v0.2.0).
 *
 * Validates ParentManifestSchema and ChildManifestSchema
 * against valid/invalid fixtures.
 *
 * @module session-manifest.test
 */

import { describe, expect, test } from "bun:test";
import {
  ParentManifestSchema,
  ChildManifestSchema,
} from "../src/schemas/session-manifest.ts";

// ── Parent Manifest ────────────────────────────────────────────

describe("ParentManifestSchema", () => {
  const validParent = {
    schema_version: "0.2.0" as const,
    session_id: "018f1234-5678-7abc-8000-123456789abc",
    parent_session_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    status: "active" as const,
    task: "Implement feature X",
    role: "developer",
    model_config: {
      provider: "deepseek",
      model: "deepseek-chat",
    },
    repo_root: "/home/user/project",
    repo_remote: "https://github.com/user/project.git",
    repo_commit_at_start: "abc123def456",
    cwd: "/home/user/project",
    branched_from: null,
    resume_count: 0,
    compaction_history: [],
  };

  test("accepts valid parent manifest", () => {
    const result = ParentManifestSchema.parse(validParent);
    expect(result.schema_version).toBe("0.2.0");
    expect(result.session_id).toBe(validParent.session_id);
    expect(result.status).toBe("active");
  });

  test("rejects parent manifest with missing required field", () => {
    const { session_id, ...missingField } = validParent;
    expect(() => ParentManifestSchema.parse(missingField)).toThrow();
  });

  test("parent_session_id must be null", () => {
    expect(() =>
      ParentManifestSchema.parse({
        ...validParent,
        parent_session_id: "some-id",
      }),
    ).toThrow();
  });

  test("branched_from must be null", () => {
    expect(() =>
      ParentManifestSchema.parse({
        ...validParent,
        branched_from: "session-id",
      }),
    ).toThrow();
  });

  test("accepts null repo fields", () => {
    const result = ParentManifestSchema.parse({
      ...validParent,
      repo_root: null,
      repo_remote: null,
      repo_commit_at_start: null,
    });
    expect(result.repo_root).toBeNull();
  });

  test("rejects extra unknown fields (strict)", () => {
    expect(() =>
      ParentManifestSchema.parse({
        ...validParent,
        extra_field: "should not be here",
      }),
    ).toThrow();
  });
});

// ── Child Manifest ─────────────────────────────────────────────

describe("ChildManifestSchema", () => {
  const validChild = {
    schema_version: "0.2.0" as const,
    session_id: "018f1234-5678-7abc-8000-123456789def",
    parent_session_id: "018f1234-5678-7abc-8000-123456789abc",
    node_id: "review-node",
    role: "reviewer",
    task_summary: "Review PR #42",
    model_id: "deepseek-chat",
    created_at: "2026-01-01T00:05:00.000Z",
    status: "active" as const,
  };

  test("accepts valid child manifest", () => {
    const result = ChildManifestSchema.parse(validChild);
    expect(result.session_id).toBe(validChild.session_id);
    expect(result.parent_session_id).toBe(validChild.parent_session_id);
  });

  test("rejects child manifest without parent_session_id", () => {
    const { parent_session_id, ...missing } = validChild;
    expect(() => ChildManifestSchema.parse(missing)).toThrow();
  });

  test("accepts child manifest without optional node_id", () => {
    const { node_id, ...withoutNodeId } = validChild;
    const result = ChildManifestSchema.parse(withoutNodeId);
    expect(result.node_id).toBeUndefined();
  });

  test("rejects child manifest with null status", () => {
    expect(() =>
      ChildManifestSchema.parse({
        ...validChild,
        status: "invalid-status",
      }),
    ).toThrow();
  });
});
