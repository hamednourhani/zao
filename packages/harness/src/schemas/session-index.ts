/**
 * Session index entry schemas — global index and per-parent agents index.
 *
 * ## Global index (`~/.zao/index.jsonl`)
 *
 * Append-only; each session has at least one creation line and
 * (on completion) one completion line. Last-line-wins for status.
 *
 * ## Agents index (`sessions/<uuidv7>/agents/index.jsonl`)
 *
 * One line per spawned child session.
 *
 * @module session-index
 */

import { z } from "zod";
import { BranchedFromSchema } from "./session-manifest.ts";
import type { BranchedFrom } from "./session-manifest.ts";

// ── Global Index: Creation Entry ──────────────────────────────────

/**
 * Written when a root session is created.
 * Status is always "active" — the completion line updates it later.
 */
export const GlobalIndexCreateEntrySchema = z
  .object({
    /** UUIDv7 session identifier. */
    session_id: z.string().min(1),
    /** ISO 8601 timestamp of session creation. */
    created_at: z.string().min(1),
    /** Absolute path to the git repository root (null if not in a repo). */
    repo_root: z.string().nullable(),
    /** Git remote URL. */
    repo_remote: z.string().nullable(),
    /** First 200 characters of the task description. */
    task_summary: z.string(),
    /** Always "active" on creation. */
    status: z.literal("active"),
    /** Branched-from metadata (null if original session). */
    branched_from: BranchedFromSchema.nullable(),
  })
  .strict();

export type GlobalIndexCreateEntry = z.infer<typeof GlobalIndexCreateEntrySchema>;

// ── Global Index: Completion Entry ────────────────────────────────

/**
 * Written when a root session finishes (success, failure, or
 * interruption). Overrides the creation entry's status via
 * last-line-wins semantics.
 */
export const GlobalIndexCompleteEntrySchema = z
  .object({
    /** UUIDv7 session identifier — must match the creation entry. */
    session_id: z.string().min(1),
    /** ISO 8601 timestamp of session completion. */
    completed_at: z.string().min(1),
    /** Final status: complete, failed, or interrupted. */
    status: z.enum(["complete", "failed", "interrupted"]),
    /** Number of child sessions spawned during this run. */
    agents_spawned: z.number().int().min(0),
    /** Models used in this run (provider + model names). Filled on completion. */
    models: z.array(z.string()),
    /** Token usage summary for the entire run. */
    tokens: z
      .object({
        prompt: z.number().int().min(0),
        completion: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();

export type GlobalIndexCompleteEntry = z.infer<
  typeof GlobalIndexCompleteEntrySchema
>;

// ── Global Index: Resolved Entry (for readers) ────────────────────

/**
 * The resolved view of a session from the global index,
 * combining creation and completion lines via last-line-wins.
 */
export interface GlobalIndexResolvedEntry {
  session_id: string;
  created_at: string;
  status: string;
  repo_root?: string;
  repo_remote?: string;
  task_summary?: string;
  models: string[];
  branched_from: BranchedFrom | null;
  completed_at?: string;
  agents_spawned?: number;
  tokens?: { prompt: number; completion: number };
}

// ── Agents Index Entry ────────────────────────────────────────────

/**
 * Written when a child session is spawned under a parent's
 * `agents/<uuidv7>/` directory.
 */
export const AgentsIndexEntrySchema = z
  .object({
    /** UUIDv7 session identifier of the child. */
    session_id: z.string().min(1),
    /** UUIDv7 of the parent session that spawned this child. */
    parent_session_id: z.string().min(1),
    /** Optional node identifier from the flow graph. */
    node_id: z.string().optional(),
    /** The agent role (e.g., "developer", "reviewer"). */
    role: z.string().min(1),
    /** ISO 8601 timestamp of child session start. */
    started_at: z.string().min(1),
    /** Status at creation time — typically "active". */
    status: z.string(),
  })
  .strict();

export type AgentsIndexEntry = z.infer<typeof AgentsIndexEntrySchema>;

// ── Session List Types ────────────────────────────────────────────

/** A single row in `zao session list` output. */
export interface SessionListEntry {
  session_id: string;
  created_at: string;
  completed_at?: string;
  status: string;
  repo_root?: string;
  repo_remote?: string;
  task_summary?: string;
  models: string[];
  agents_spawned?: number;
  tokens?: { prompt: number; completion: number };
}

/** Filters accepted by `zao session list`. */
export interface SessionListFilters {
  status?: string;
  repo?: string;
  since?: string;
  limit?: number;
}
