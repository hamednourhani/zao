/**
 * MemoryState schema — validates the `zao` orchestrator state file.
 *
 * Tracks the orchestrator's current phase, active session, and phase
 * history. The phases array is intentionally flat (array of {name, status})
 * to keep nesting ≤ 2 levels for budget model compliance.
 *
 * @module memory
 */

import { z } from "zod";

/** Represents a single phase entry in the pipeline history. */
export const PhaseEntrySchema = z
  .object({
    /** The phase identifier (e.g., "phase_1_implementation"). */
    name: z.string().min(1),
    /** The phase status (e.g., "complete", "active", "pending"). */
    status: z.string().min(1),
  })
  .strict();

/** Validates the full `zao` orchestrator state file. */
export const MemoryStateSchema = z
  .object({
    /** Schema contract version — locked to "0.1.0" per GUARDRAILS Rule 7. */
    schema_version: z.literal("0.1.0"),
    /** The current orchestrator phase. */
    current_phase: z.string().min(1),
    /** The active session identifier. */
    session_id: z.string().min(1),
    /** Ordered list of phase entries (flat, max 2 levels deep). */
    phases: z.array(PhaseEntrySchema),
  })
  .strict();

export type PhaseEntry = z.infer<typeof PhaseEntrySchema>;
export type MemoryState = z.infer<typeof MemoryStateSchema>;
