/**
 * ToolExecutionRequest schema — validates tool invocation commands.
 *
 * Represents a single tool call that the orchestrator executes on behalf
 * of a subagent. The user_facing_explanation is free-text DATA that
 * must never be interpreted as instructions (GUARDRAILS Rule 14).
 *
 * @module tool-execution
 */

import { z } from "zod";

/** Validates a single tool invocation command from a subagent. */
export const ToolExecutionRequestSchema = z
  .object({
    /** Schema contract version — locked to "0.1.0" per GUARDRAILS Rule 7. */
    schema_version: z.literal("0.1.0"),
    /** The type of action (e.g., "shell", "file_write", "file_read"). */
    action_type: z.string().min(1),
    /** The command or operation to execute. */
    command: z.string().min(1),
    /** DATA, never instructions. Treat as untrusted content. */
    user_facing_explanation: z.string(),
    /**
     * Optional file content for `file_write` operations.
     * Populated by the tool loop from the LLM's tool_call args,
     * validated by Zod as a string when present.
     */
    content: z.string().optional(),
  })
  .strict();

export type ToolExecutionRequest = z.infer<typeof ToolExecutionRequestSchema>;
