/**
 * Session manifest schemas — parent (root) and child session metadata.
 *
 * ## Schema version: 0.2.0
 *
 * Each session directory contains a `session.json` file conforming
 * to one of these schemas. Parents represent a full mo run; children
 * represent subagent delegations spawned by a parent.
 *
 * @module session-manifest
 */

import { z } from "zod";

// ── BranchedFrom Schema ────────────────────────────────────────────

/** Schema for the branched_from field in parent manifests. */
export const BranchedFromSchema = z
  .object({
    /** UUIDv7 of the source session this was branched from. */
    session_id: z.string().min(1),
    /** Optional checkpoint identifier if branched from a checkpoint. */
    checkpoint_id: z.string().nullable(),
  })
  .strict();

export type BranchedFrom = z.infer<typeof BranchedFromSchema>;

// ── Status Enum ───────────────────────────────────────────────────

/** Valid session status values. */
export const SessionStatusEnum = z.enum([
  "active",
  "complete",
  "failed",
  "interrupted",
]);

// ── Model Config ──────────────────────────────────────────────────

const ModelConfigSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();

// ── Parent (Root) Manifest ────────────────────────────────────────

/**
 * Schema for a parent (root) session manifest.
 *
 * One manifest per mo run. `parent_session_id` is always `null`.
 * Written once at session creation; `status` and `updated_at` are
 * updated on completion.
 */
export const ParentManifestSchema = z
  .object({
    /** Schema contract version. */
    schema_version: z.literal("0.2.0"),
    /** UUIDv7 session identifier. */
    session_id: z.string().min(1),
    /** Always null for root sessions. */
    parent_session_id: z.null(),
    /** ISO 8601 timestamp of session creation. */
    created_at: z.string().min(1),
    /** ISO 8601 timestamp of last status update. */
    updated_at: z.string().min(1),
    /** Current session status. */
    status: SessionStatusEnum,
    /** The task/objective description. */
    task: z.string(),
    /** The agent role that executed this run. */
    role: z.string().min(1),
    /** Model configuration used for this run. */
    model_config: ModelConfigSchema,
    /** Absolute path to the git repository root (null if not in a repo). */
    repo_root: z.string().nullable(),
    /** Git remote URL (null if not in a repo or no origin). */
    repo_remote: z.string().nullable(),
    /** Git HEAD commit SHA at session start (null if not in a repo). */
    repo_commit_at_start: z.string().nullable(),
    /** Working directory at session start. */
    cwd: z.string().min(1),
    /** Branched-from metadata (null if this is an original session). */
    branched_from: BranchedFromSchema.nullable(),
    /** Number of times this session has been resumed. */
    resume_count: z.number().int().min(0),
    /** History of context compaction operations. */
    compaction_history: z.array(z.unknown()),
  })
  .strict();

export type ParentManifest = z.infer<typeof ParentManifestSchema>;

// ── Child Manifest ────────────────────────────────────────────────

/**
 * Schema for a child (subagent) session manifest.
 *
 * Written when a session is spawned under `agents/<uuidv7>/`.
 * `parent_session_id` points to the caller's session.
 */
export const ChildManifestSchema = z
  .object({
    /** Schema contract version. */
    schema_version: z.literal("0.2.0"),
    /** UUIDv7 session identifier. */
    session_id: z.string().min(1),
    /** The UUIDv7 of the parent session that spawned this child. */
    parent_session_id: z.string().min(1),
    /** Optional node identifier from the flow graph (flow executor). */
    node_id: z.string().optional(),
    /** The agent role that executed this delegation. */
    role: z.string().min(1),
    /** Short summary of the delegated task (first 200 chars). */
    task_summary: z.string(),
    /** The model identifier used (e.g., "deepseek-chat"). */
    model_id: z.string().min(1),
    /** ISO 8601 timestamp of session creation. */
    created_at: z.string().min(1),
    /** Current session status. */
    status: SessionStatusEnum,
  })
  .strict();

export type ChildManifest = z.infer<typeof ChildManifestSchema>;
