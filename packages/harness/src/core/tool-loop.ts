/**
 * Tool Execution Loop — multi-turn LLM conversation with tool execution.
 *
 * When a step declares tools, the harness runs a multi-turn loop:
 * 1. Send prompt to LLM
 * 2. LLM responds with either `tool_call` or `final`
 * 3. If `tool_call`: execute the tool, send result back to LLM, goto 2
 * 4. If `final`: done, return result
 *
 * ## Key behaviors
 *
 * - **Multi-turn**: Real tasks need multiple tool calls (read → analyze → write → verify).
 * - **Max turns guard**: Prevents infinite loops (default 10).
 * - **Human gate**: If a tool requires approval and `onToolApproval` is provided,
 *   the callback is invoked before execution. Rejection fails the step.
 * - **Tool validation**: Tool calls are validated against the allowed tools list
 *   and path confinement is enforced by the executor.
 * - **Event logging**: Every LLM call and tool execution is logged.
 *
 * ## ADR-005 compliance
 *
 * - Session ID is provided by the caller (controller or CLI).
 * - Every event carries the v0.2.0 envelope.
 *
 * ## ADR-009 compliance
 *
 * - LLM client is resolved by the caller and passed in. No provider config
 *   or credentials cross this boundary.
 *
 * @module tool-loop
 */

import type { z } from "zod";
import { generateStructuredResponse } from "./llm.ts";
import type { GenerateObjectFn } from "./llm.ts";
import type { ModelOptions } from "./llm.ts";
import type { LlmClient } from "@zao/llm-clients";
import { HandoffWithToolsSchema } from "../schemas/tool-call.ts";
import type { HandoffWithTools, ToolCall, } from "../schemas/tool-call.ts";
import type { ToolExecutionRequest } from "../schemas/tool-execution.ts";
import type { EventLogEntry } from "../schemas/event-log.ts";
import { executeTool } from "./executor.ts";
import type { ExecutorConfig } from "./executor.ts";
import type { ToolResult } from "./executor.ts";
import { validateToolAccess } from "./tool-access.ts";
import type { ToolDeclaration } from "../schemas/flow.ts";
import { logger } from "./logger.ts";
import { progress } from "./progress.ts";

// ── Type Definitions ───────────────────────────────────────────────

/** Parameters for the {@link runToolLoop} function. */
export interface ToolLoopParams {
  /** System/initial prompt for the LLM. */
  prompt: string;
  /** Project root for path confinement. */
  projectRoot: string;
  /** Session directory for event logging. */
  sessionDir: string;
  /** Session ID for event logging. */
  sessionId: string;
  /** Available tools with their approval requirements. */
  tools: ToolDeclaration[];
  /** LLM client from the registry. */
  llmClient: LlmClient;
  /** LLM generation options (temperature, maxTokens). */
  options?: ModelOptions;
  /** Maximum turns before forcing stop (default 10). */
  maxTurns?: number;
  /** Callback for tool approval. If not provided, tools requiring approval fail. */
  onToolApproval?: (toolCall: ToolCall) => Promise<ToolApprovalResult>;
  /** Inject mock generateObject for tests. */
  _generateObjectFn?: GenerateObjectFn;
  /** Agent role name for event logging. */
  agentRole?: string;
}

/** Result of a tool approval check. */
export interface ToolApprovalResult {
  /** Whether the tool call was approved. */
  approved: boolean;
  /** Optional reason for the decision (e.g., "Denied by user"). */
  reason?: string;
}

/** The result of a {@link runToolLoop} execution. */
export interface ToolLoopResult {
  /** Whether the loop produced a valid final response. */
  success: boolean;
  /** The final HandoffWithTools response (only on success). */
  result?: HandoffWithTools;
  /** Error message (only on failure). */
  error?: string;
  /** All logged events from LLM calls and tool executions. */
  events: EventLogEntry[];
  /** Total number of LLM turns executed. */
  totalTurns: number;
}

// ── Constants ──────────────────────────────────────────────────────

/** Default maximum number of LLM turns before forced stop. */
const DEFAULT_MAX_TURNS = 10;

// ── Internal Helpers ───────────────────────────────────────────────

/**
 * Maps a tool name (from ToolCall) to the action_type used by
 * {@link executeTool}.
 *
 * - `readFile` → `file_read`
 * - `writeFile` → `file_write`
 * - `executeShell` → `shell`
 *
 * @param toolName - The tool name from the LLM's tool call.
 * @returns The corresponding action_type for the executor.
 */
function mapToolToActionType(toolName: string): string {
  switch (toolName) {
    case "readFile":
      return "file_read";
    case "writeFile":
      return "file_write";
    case "executeShell":
      return "shell";
    default:
      // L1 fix: fail fast for unknown tool names instead of silently
      // passing through, which would propagate an invalid action_type
      // to the executor.
      throw new Error(`Unknown tool name: "${toolName}". Valid tools: readFile, writeFile, executeShell.`);
  }
}

/**
 * Builds the command/path argument for a `ToolExecutionRequest` from
 * a tool call's args.
 *
 * - For `readFile` / `writeFile`: uses `args.path`
 * - For `executeShell`: uses `args.command`
 *
 * @param toolName - The tool being called.
 * @param args - The arguments from the tool call.
 * @returns A result object with either the command string or an error.
 */
function extractCommand(toolName: string, args: ToolCall["args"]): { success: true; command: string } | { success: false; error: string } {
  if (toolName === "executeShell") {
    if (!args.command) {
      return { success: false, error: `Tool "${toolName}" requires a "command" argument` };
    }
    return { success: true, command: args.command };
  }
  // readFile / writeFile
  if (!args.path) {
    return { success: false, error: `Tool "${toolName}" requires a "path" argument` };
  }
  return { success: true, command: args.path };
}

/** Maximum length for stdout/stderr in tool result messages (characters). */
const RESULT_TRUNCATION_LIMIT = 4000;

/**
 * Converts a tool result into a human-readable string for the LLM.
 * This message is appended to the conversation so the LLM can
 * use the tool output in its next response.
 *
 * Output of stdout/stderr is capped at {@link RESULT_TRUNCATION_LIMIT}
 * characters each; overflow is replaced with `...[truncated]` to keep
 * the conversation context manageable.
 *
 * @param toolName - The tool that was executed.
 * @param result - The result from the executor.
 * @returns A formatted message string.
 */
function formatToolResult(toolName: string, result: { success: boolean; error?: string; fileContent?: string; filePath?: string; stdout?: string; stderr?: string; exitCode?: number }): string {
  if (!result.success) {
    return `Tool "${toolName}" failed: ${result.error ?? "Unknown error"}`;
  }

  function truncate(s: string | undefined): string {
    if (!s) return "";
    if (s.length <= RESULT_TRUNCATION_LIMIT) return s;
    return s.slice(0, RESULT_TRUNCATION_LIMIT) + "...[truncated]";
  }

  switch (toolName) {
    case "readFile":
      return `Tool "${toolName}" result for ${result.filePath ?? "unknown"}:\n${truncate(result.fileContent) || "(empty)"}`;
    case "writeFile":
      return `Tool "${toolName}" succeeded: wrote to ${result.filePath ?? "unknown"}`;
    case "executeShell":
      return [
        `Tool "${toolName}" result (exit code: ${result.exitCode ?? 0}):`,
        result.stdout ? `stdout:\n${truncate(result.stdout)}` : "",
        result.stderr ? `stderr:\n${truncate(result.stderr)}` : "",
      ].filter(Boolean).join("\n");
    default:
      return `Tool "${toolName}" completed successfully.`;
  }
}

/**
 * Finds a tool declaration in the allowed tools list by name.
 *
 * @param toolName - The tool to look up.
 * @param tools - The list of allowed tool declarations.
 * @returns The matching declaration or `undefined` if not found.
 */
function findToolDeclaration(
  toolName: string,
  tools: ToolLoopParams["tools"],
): ToolDeclaration | undefined {
  return tools.find((t) => t.tool === toolName);
}

// ── Core Function ─────────────────────────────────────────────────

/**
 * Runs a multi-turn LLM conversation loop where the LLM can call tools
 * and receive results before producing a final response.
 *
 * ## Flow
 *
 * 1. Initialize conversation with the prompt as the first user message.
 * 2. For each turn (up to `maxTurns`):
 *    a. Call `generateStructuredResponse` with `HandoffWithToolsSchema`
 *    b. If `type === "final"`: return success with the result.
 *    c. If `type === "tool_call"`:
 *       - Validate the tool is in the allowed tools list.
 *       - If the tool requires approval, invoke `onToolApproval`.
 *         Rejection fails the step with "Denied by user".
 *       - Map the tool name to an action_type and build a
 *         `ToolExecutionRequest`.
 *       - Call `executeTool` with auto-approve (HITL gate is handled
 *         by `onToolApproval`).
 *       - Append the tool result to the conversation as a message.
 *       - Continue the loop.
 * 3. If `maxTurns` is reached: return error "Max turns exceeded".
 *
 * @param params - Prompt, tools, LLM client, and execution config.
 * @returns A {@link ToolLoopResult} with success status and final response.
 */
export async function runToolLoop(
  params: ToolLoopParams,
): Promise<ToolLoopResult> {
  const {
    prompt,
    projectRoot,
    sessionDir,
    sessionId,
    tools,
    llmClient,
    options,
    maxTurns = DEFAULT_MAX_TURNS,
    onToolApproval,
    _generateObjectFn,
    agentRole = "orchestrator",
  } = params;

  const allEvents: EventLogEntry[] = [];
  let conversationPrompt = prompt;

  for (let turn = 0; turn < maxTurns; turn++) {
    progress.update({ phase: "delegating" });
    // ── Call LLM ──────────────────────────────────────────────────
    const llmResult = await generateStructuredResponse<HandoffWithTools>(
      conversationPrompt,
      HandoffWithToolsSchema as z.ZodSchema<HandoffWithTools>,
      llmClient,
      options,
      _generateObjectFn,
      agentRole,
    );

    // Collect events from the LLM call
    allEvents.push(...llmResult.events);

    // ── LLM call failed ──
    if (!llmResult.success) {
      return {
        success: false,
        error: `LLM call failed on turn ${turn + 1}: ${llmResult.error}`,
        events: allEvents,
        totalTurns: turn + 1,
      };
    }

    const response = llmResult.result;

    // ── Final response ──
    if (response.type === "final") {
      return {
        success: true,
        result: response,
        events: allEvents,
        totalTurns: turn + 1,
      };
    }

    // ── Tool call ──
    if (response.type === "tool_call") {
      const toolCall = response.tool_call;

      // ── Step 1: Validate tool access (allowlist + path confinement) ──
      const accessResult = validateToolAccess(toolCall, tools, projectRoot);
      if (!accessResult.valid) {
        // Security violation — log and stop immediately (fail-closed)
        // NOTE: This console.error is a best-effort visible log for quick triage;
        // structured logging (decisions.jsonl / violations.jsonl) is handled by the
        // caller (controller) which receives the error string and calls logViolation.
        logger.error(`[security] BANNED ACTION: ${accessResult.message}`);
        return {
          success: false,
          error: `BANNED ACTION: ${accessResult.message}`,
          events: allEvents,
          totalTurns: turn + 1,
        };
      }

      // ── Step 2: Find tool declaration for requires_approval check ──
      // Guaranteed to find it — validateToolAccess already confirmed the
      // tool is in the allowed list.
      const toolDecl = findToolDeclaration(toolCall.tool, tools)!;

      // ── Step 3: Human gate — check if tool requires approval ──────
      if (toolDecl.requires_approval) {
        // Fail-closed (H1 fix): if the tool requires approval but no
        // callback is provided, reject the tool call immediately.
        // Previously this was fail-open: the `&& onToolApproval` check
        // allowed tools requiring approval to execute when no callback
        // was wired up.
        if (!onToolApproval) {
          return {
            success: false,
            error: `Tool "${toolCall.tool}" requires human approval but no approval callback was provided. This step cannot proceed without human oversight.`,
            events: allEvents,
            totalTurns: turn + 1,
          };
        }
        const approval = await onToolApproval(toolCall);
        if (!approval.approved) {
          return {
            success: false,
            error: approval.reason ?? "Denied by user",
            events: allEvents,
            totalTurns: turn + 1,
          };
        }
      }

      // ── Execute the tool ────────────────────────────────────────
      let toolResult: Awaited<ReturnType<typeof executeTool>>;

      try {
        // Validate tool args (extract command/path from args)
        const extracted = extractCommand(toolCall.tool, toolCall.args);
        if (!extracted.success) {
          toolResult = {
            success: false,
            action: mapToolToActionType(toolCall.tool) as ToolResult["action"],
            error: extracted.error,
          };
        } else {
          const command = extracted.command;
          const actionType = mapToolToActionType(toolCall.tool);

          // Build the tool execution request.
          // content is an optional field on ToolExecutionRequest (added v0.1.0+content).
          const request: ToolExecutionRequest = {
            schema_version: "0.1.0",
            action_type: actionType,
            command,
            user_facing_explanation: toolCall.reason,
            ...(toolCall.tool === "writeFile" && toolCall.args.content
              ? { content: toolCall.args.content }
              : {}),
          };

          const executorConfig: ExecutorConfig = {
            projectRoot,
            sessionDir,
            sessionId,
            // Auto-approve HITL checks in executeTool since the
            // human gate is handled by onToolApproval above.
          };

          toolResult = await executeTool(
            request,
            executorConfig,
            undefined, // session
            true,      // autoApprove — HITL gate handled by onToolApproval
          );
        }
      } catch (err: unknown) {
        // Tool execution failed (execution error, not construction)
        toolResult = {
          success: false,
          action: mapToolToActionType(toolCall.tool) as ToolResult["action"],
          error: err instanceof Error ? err.message : String(err),
        };
      }

      // ── Append tool result to conversation ──────────────────────
      const resultMessage = formatToolResult(toolCall.tool, toolResult);
      // ── M1: Context budget guard ─────────────────────────────────
      // The conversation grows unbounded across turns as tool results
      // are appended. This is a v1 best-effort safeguard — in production,
      // a proper token-aware context window management strategy (TD-010-E)
      // should replace this simple character-count check.
      const MAX_CONTEXT_CHARS = 200_000;
      const newPrompt = `${conversationPrompt}\n\n--- Tool Execution Result ---\n${resultMessage}\n\nBased on the tool result above, continue with your task or respond with a final answer.`;
      if (newPrompt.length > MAX_CONTEXT_CHARS) {
        logger.warn(
          `[zao] Context budget warning: conversation exceeds ${MAX_CONTEXT_CHARS} characters ` +
          `(${newPrompt.length}). The LLM may fail due to context window overflow. ` +
          `Consider enabling compaction (TD-010-C) or reducing maxTurns.`
        );
      }
      conversationPrompt = newPrompt;

      // Continue the loop for the next LLM turn
      continue;
    }

    // Should not reach here — discriminated union covers all cases
    return {
      success: false,
      error: `Unknown response type on turn ${turn + 1}`,
      events: allEvents,
      totalTurns: turn + 1,
    };
  }

  // ── Max turns exceeded ───────────────────────────────────────────
  return {
    success: false,
    error: `Max turns exceeded (${maxTurns}). The LLM did not produce a final response within the allowed turns.`,
    events: allEvents,
    totalTurns: maxTurns,
  };
}

