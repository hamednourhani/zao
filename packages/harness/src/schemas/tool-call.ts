/**
 * Tool call schemas — LLM-to-harness tool invocation contracts.
 *
 * When a step has tools, the LLM response is a discriminated union:
 * either a `tool_call` (LLM wants to execute a tool) or `final`
 * (LLM has completed the task). Never both — this prevents ambiguity.
 *
 * ## Why reason is required
 * When the human gate asks "approve writeFile to src/auth.ts?",
 * it displays the LLM's reason: "I need to fix the null check in validate()".
 * The human understands WHY, not just WHAT.
 *
 * @module tool-call
 */

import { z } from "zod";

// ── Tool Names ──────────────────────────────────────────────────────

/** All tool names the LLM can request. */
export const TOOL_NAMES = ["readFile", "writeFile", "executeShell"] as const;

// ── Tool Call ───────────────────────────────────────────────────────

/** A single tool invocation requested by the LLM. */
export const ToolCallSchema = z.object({
  /** Tool to invoke. */
  tool: z.enum(TOOL_NAMES),
  /** Arguments for the tool. Shape depends on the tool. */
  args: z.object({
    /** For readFile/writeFile: path relative to project root. */
    path: z.string().optional(),
    /** For writeFile: content to write. */
    content: z.string().optional(),
    /** For executeShell: command to run. */
    command: z.string().optional(),
  }),
  /** WHY the LLM wants to call this tool (for human gate context). */
  reason: z.string().min(1, "reason is required for human gate context"),
}).strict();

export type ToolCall = z.infer<typeof ToolCallSchema>;

// ── Discriminated Union: tool_call vs final ─────────────────────────

/**
 * Extended handoff schema supporting tool calls.
 *
 * The LLM either wants to call a tool OR is done. Never both.
 * Uses discriminated union on `type` field for TypeScript narrowing.
 *
 * ## Schema version relationship (M3 fix)
 *
 * This schema defines `schema_version: "0.2.0"` — a superset of the
 * original `HandoffResponseSchema` (v0.1.0 in `handoff.ts`). The two
 * must be kept in sync manually: any field added to the original
 * `final` response shape MUST be duplicated here in the `final`
 * variant. The tool_call variant is unique to v0.2.0.
 */
export const HandoffWithToolsSchema = z.discriminatedUnion("type", [
  // LLM wants to call a tool (not final response)
  z.object({
    schema_version: z.literal("0.2.0"),
    type: z.literal("tool_call"),
    tool_call: ToolCallSchema,
  }).strict(),
  // LLM is done (final response)
  z.object({
    schema_version: z.literal("0.2.0"),
    type: z.literal("final"),
    status: z.enum(["success", "needs_clarification", "failed"]),
    summary: z.string(),
    changes: z
      .array(
        z.object({
          file_path: z.string().min(1),
          content: z.string(),
        })
      )
      .optional(),
  }).strict(),
]);

export type HandoffWithTools = z.infer<typeof HandoffWithToolsSchema>;
