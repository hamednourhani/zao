/**
 * EventLogEntry schema — validates each line in `events.jsonl`.
 *
 * Records agent interactions with token usage tracking. Used for
 * cost accounting, audit trails, and performance analysis.
 *
 * ## v0.2.0 Changes
 *
 * - Added `event_id` (UUIDv7) — unique identifier for this event
 * - Added `session_id` — the session that produced this event
 * - Added `parent_session_id` (nullable) — the parent session (null for root)
 * - Added `node_id` (optional) — flow graph node identifier
 *
 * @module event-log
 */

import { z } from "zod";

/** Validates a single line in the `events.jsonl` audit log. */
export const EventLogEntrySchema = z
  .object({
    /** Schema contract version — upgraded to "0.2.0" for envelope fields. */
    schema_version: z.literal("0.2.0"),
    /** UUIDv7 unique identifier for this event. */
    event_id: z.string().min(1),
    /** UUIDv7 of the session that produced this event. */
    session_id: z.string().min(1),
    /** UUIDv7 of the parent session (null for root sessions). */
    parent_session_id: z.string().nullable(),
    /** ISO 8601 timestamp of the event. */
    timestamp: z.string().min(1),
    /** The agent role that produced this event (e.g., "developer", "architect"). */
    agent_role: z.string().min(1),
    /** The model identifier (e.g., "deepseek-v4-pro"). */
    model_id: z.string().min(1),
    /** Flow graph node identifier (optional, for flow executor). */
    node_id: z.string().optional(),
    /** Number of prompt tokens consumed. */
    prompt_tokens: z.number(),
    /** Number of completion tokens generated. */
    completion_tokens: z.number(),
    /** Whether the response was served from cache. */
    cache_hit: z.boolean(),
    /** The action or operation performed. */
    action: z.string().min(1),
    /** HITL trust tier (0–2). Populated on human-in-the-loop events. */
    hitl_tier: z.number().min(0).max(2).optional(),
    /** The command that was presented for HITL approval (sanitized). */
    hitl_command: z.string().optional(),
    /** Classification reasons for the HITL verdict. */
    hitl_reasons: z.array(z.string()).optional(),
    /** Short summary of a delegated task (first 500 chars). */
    task_summary: z.string().optional(),
    /** Context warning message from the context builder. */
    warning: z.string().optional(),
    /** Reason for an unconditionally blocked (hard-deny) command. */
    hard_deny_reason: z.string().optional(),
    /** Whether the tool execution succeeded. */
    tool_result_success: z.boolean().optional(),
    /** The sanitized command executed by a tool. */
    tool_command: z.string().optional(),
    /** Error message from tool execution (null on success). */
    tool_error: z.string().nullable().optional(),
    /** Exit code from tool execution (null on success). */
    tool_exit_code: z.number().nullable().optional(),
  })
  .passthrough();

export type EventLogEntry = z.infer<typeof EventLogEntrySchema>;
