/**
 * Context compaction — lossy summarization of conversation history
 * when the estimated token count breaches the compaction threshold
 * (TD-010-C).
 *
 * ## Flow
 *
 * 1. `buildContext()` detects the breach and throws `ContextCompactionNeeded`
 * 2. `runLoop()` catches it and calls `runCompactionFlow()`
 * 3. Pre-compaction HITL: asks user to approve lossy summarization
 * 4. Compactor LLM: summarizes the conversation into `summary.md`
 * 5. Post-compaction HITL: asks user to approve resuming with summary
 * 6. If approved, `runLoop()` retries `buildContext()` with the summary
 *
 * ## Guards
 *
 * - Recursion guard: if compaction is already in progress (a `summary.md`
 *   already exists), `buildContext` must not throw again. The caller
 *   should detect this via a flag.
 * - Data safety: `events.jsonl` is backed up before compaction.
 * - `--yes` does NOT auto-approve compaction (both HITLs ignore autoYes).
 *
 * @module compaction
 */

import type { ContextModelConfig } from "./context.ts";
import { appendEvent, writeArtifact } from "./artifacts.ts";
import { join } from "node:path";
import { copyFileSync } from "node:fs";
import { generateSessionId } from "./ids.ts";

// ── Re-export for backward compatibility ──────────────────────────
export { ContextCompactionNeeded } from "./compaction-errors.ts";

// ── Simple Compactor Response Schema ──────────────────────────────

/**
 * The compactor LLM returns a plain string summary.
 * This is passed directly to `writeArtifact` for `summary.md`.
 */
export interface CompactorResponse {
  summary: string;
}

// ── Detection ─────────────────────────────────────────────────────

/**
 * Checks whether the estimated token count breaches the compaction
 * threshold for the given model config.
 *
 * @param estimatedTokens - The current estimated token count.
 * @param modelConfig     - The model configuration (window + threshold).
 * @returns `true` if compaction is needed.
 */
export function detectCompactionNeed(
  estimatedTokens: number,
  modelConfig: ContextModelConfig,
): boolean {
  const threshold = modelConfig.compactionThreshold ?? 0.65;
  return estimatedTokens > modelConfig.contextWindow * threshold;
}

// ── HITL Details ──────────────────────────────────────────────────

/** Details passed to the HITL prompter at each compaction step. */
export interface CompactionHITLDetails {
  /** Estimated tokens before compaction. */
  estimatedTokens: number;
  /** Model context window size. */
  contextWindow: number;
  /** Compaction threshold fraction. */
  threshold: number;
  /** Estimated tokens after compaction (post-HITL only). */
  tokensAfter?: number;
  /** First portion of the reconstructed prompt (post-HITL only). */
  promptPreview?: string;
  /** Path to the written summary.md (post-HITL only). */
  summaryPath?: string;
}

// ── Compaction Flow Parameters ────────────────────────────────────

/** Injected function signature for the compactor LLM call. */
export type CompactorGenerateFn = (
  prompt: string,
) => Promise<{ success: boolean; result?: CompactorResponse; error?: string }>;

/** Injected function signature for the HITL approval prompts. */
export type CompactionHITLPrompter = (
  step: "pre" | "post",
  details: CompactionHITLDetails,
) => Promise<boolean>;

/** Parameters for {@link runCompactionFlow}. */
export interface CompactionParams {
  /** Session directory for artifact I/O. */
  sessionDir: string;
  /** UUIDv7 session identifier. */
  sessionId: string;
  /** Raw events.jsonl content (for backup reference, not modified here). */
  eventsJsonl: string;
  /** The current full context string (for the compactor to summarize). */
  currentContext: string;
  /** The original task description. */
  task: string;
  /** The agent role name for event logging. */
  roleName: string;
  /** Model configuration (window + threshold). */
  modelConfig: ContextModelConfig;
  /** Injectable compactor LLM call (for testing). */
  generateCompactor: CompactorGenerateFn;
  /** Injectable HITL prompter (for testing). */
  promptForCompactionHITL: CompactionHITLPrompter;
  /**
   * Estimated token count at the time the compaction threshold was
   * breached. Passed through from the `ContextCompactionNeeded` error
   * so HITL prompts can show the actual token count.
   */
  estimatedTokens?: number;
  /**
   * Whether the compaction was already attempted once (recursion guard).
   * When true, `runCompactionFlow` returns an error immediately to
   * prevent infinite compaction loops.
   */
  alreadyCompacted?: boolean;
}

// ── Core Flow ─────────────────────────────────────────────────────

/**
 * Runs the full compaction flow: pre-HITL → compactor LLM → post-HITL.
 *
 * ## Recursive compaction guard
 *
 * If `params.alreadyCompacted` is true (meaning a compaction was already
 * performed but the threshold was breached again), the function returns
 * an error immediately. This prevents infinite compaction loops.
 *
 * @param params - Compaction parameters (session, context, injectables).
 * @returns Whether execution should resume, plus the summary if generated.
 */
export async function runCompactionFlow(
  params: CompactionParams,
): Promise<{
  resumed: boolean;
  summary?: string;
  error?: string;
}> {
  // ── Recursive compaction guard ──────────────────────────────────
  if (params.alreadyCompacted) {
    await appendEvent(params.sessionDir, {
      schema_version: "0.2.0",
      event_id: generateSessionId(),
      session_id: params.sessionId,
      parent_session_id: null,
      timestamp: new Date().toISOString(),
      agent_role: params.roleName,
      model_id: params.modelConfig.model,
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_hit: false,
      action: "context_compaction_failed",
      error: "Recursive compaction guard: threshold breached again after compaction",
    });
    return {
      resumed: false,
      error: "compaction_failed: recursive guard — threshold breached again after compaction",
    };
  }

  // ── Step 1: Pre-compaction HITL ─────────────────────────────────
  const preApproved = await params.promptForCompactionHITL("pre", {
    estimatedTokens:
      params.estimatedTokens ?? params.modelConfig.contextWindow,
    contextWindow: params.modelConfig.contextWindow,
    threshold: params.modelConfig.compactionThreshold ?? 0.65,
  });

  if (!preApproved) {
    await appendEvent(params.sessionDir, {
      schema_version: "0.2.0",
      event_id: generateSessionId(),
      session_id: params.sessionId,
      parent_session_id: null,
      timestamp: new Date().toISOString(),
      agent_role: params.roleName,
      model_id: params.modelConfig.model,
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_hit: false,
      action: "context_compaction_hitl_denied",
    });
    return { resumed: false, error: "compaction_denied" };
  }

  await appendEvent(params.sessionDir, {
    schema_version: "0.2.0",
    event_id: generateSessionId(),
    session_id: params.sessionId,
    parent_session_id: null,
    timestamp: new Date().toISOString(),
    agent_role: params.roleName,
    model_id: params.modelConfig.model,
    prompt_tokens: 0,
    completion_tokens: 0,
    cache_hit: false,
    action: "context_compaction_hitl_approved",
  });

  // ── Step 2: Backup events.jsonl ─────────────────────────────────
  const eventsPath = join(params.sessionDir, "events.jsonl");
  const backupPath = join(
    params.sessionDir,
    `events.jsonl.pre-compaction.${Date.now()}`,
  );
  try {
    copyFileSync(eventsPath, backupPath);
  } catch {
    // Backup is best-effort — don't block compaction on it
  }

  // ── Step 3: Run compactor LLM ───────────────────────────────────
  await appendEvent(params.sessionDir, {
    schema_version: "0.2.0",
    event_id: generateSessionId(),
    session_id: params.sessionId,
    parent_session_id: null,
    timestamp: new Date().toISOString(),
    agent_role: params.roleName,
    model_id: params.modelConfig.model,
    prompt_tokens: 0,
    completion_tokens: 0,
    cache_hit: false,
    action: "context_compaction_started",
  });

  const compactionPrompt = buildCompactionPrompt(
    params.currentContext,
    params.roleName,
    params.task,
  );

  let summary: string;
  try {
    const compactorResult = await params.generateCompactor(compactionPrompt);
    if (!compactorResult.success || !compactorResult.result) {
      await appendEvent(params.sessionDir, {
        schema_version: "0.2.0",
        event_id: generateSessionId(),
        session_id: params.sessionId,
        parent_session_id: null,
        timestamp: new Date().toISOString(),
        agent_role: params.roleName,
        model_id: params.modelConfig.model,
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_hit: false,
        action: "context_compaction_failed",
        error: compactorResult.error ?? "Compactor returned no result",
      });
      return {
        resumed: false,
        error: `compaction_failed: ${compactorResult.error ?? "Compactor returned no result"}`,
      };
    }
    summary = compactorResult.result.summary;

    // Write summary.md
    const summaryPath = join(params.sessionDir, "summary.md");
    await writeArtifact(summaryPath, summary);

    await appendEvent(params.sessionDir, {
      schema_version: "0.2.0",
      event_id: generateSessionId(),
      session_id: params.sessionId,
      parent_session_id: null,
      timestamp: new Date().toISOString(),
      agent_role: params.roleName,
      model_id: params.modelConfig.model,
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_hit: false,
      action: "context_compaction_completed",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await appendEvent(params.sessionDir, {
      schema_version: "0.2.0",
      event_id: generateSessionId(),
      session_id: params.sessionId,
      parent_session_id: null,
      timestamp: new Date().toISOString(),
      agent_role: params.roleName,
      model_id: params.modelConfig.model,
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_hit: false,
      action: "context_compaction_failed",
      error: message,
    });
    return { resumed: false, error: `compaction_failed: ${message}` };
  }

  // ── Step 4: Post-compaction HITL ────────────────────────────────
  const summaryPath = join(params.sessionDir, "summary.md");
  const postApproved = await params.promptForCompactionHITL("post", {
    estimatedTokens:
      params.estimatedTokens ?? params.modelConfig.contextWindow,
    contextWindow: params.modelConfig.contextWindow,
    threshold: params.modelConfig.compactionThreshold ?? 0.65,
    tokensAfter: Math.ceil(summary.length / 4), // TODO: use encode(summary).length when gpt-tokenizer available for better accuracy
    promptPreview: summary.slice(0, 2000),
    summaryPath,
  });

  if (!postApproved) {
    await appendEvent(params.sessionDir, {
      schema_version: "0.2.0",
      event_id: generateSessionId(),
      session_id: params.sessionId,
      parent_session_id: null,
      timestamp: new Date().toISOString(),
      agent_role: params.roleName,
      model_id: params.modelConfig.model,
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_hit: false,
      action: "resume_context_denied",
    });
    return { resumed: false, summary, error: "resume_denied" };
  }

  await appendEvent(params.sessionDir, {
    schema_version: "0.2.0",
    event_id: generateSessionId(),
    session_id: params.sessionId,
    parent_session_id: null,
    timestamp: new Date().toISOString(),
    agent_role: params.roleName,
    model_id: params.modelConfig.model,
    prompt_tokens: 0,
    completion_tokens: 0,
    cache_hit: false,
    action: "resume_context_approved",
  });

  return { resumed: true, summary };
}

/**
 * Builds the compactor LLM prompt from the conversation history.
 *
 * Exported for testing.
 *
 * @param events - The conversation events.
 * @param role   - The agent role name.
 * @param task   - The original task description.
 * @returns The compactor prompt string.
 */
export function buildCompactionPrompt(
  events: string,
  role: string,
  task: string,
): string {
  return [
    "You are a context compactor. Summarize the following conversation history.",
    "",
    `ORIGINAL TASK: ${task}`,
    `ROLE: ${role}`,
    "",
    "INSTRUCTIONS:",
    "- Preserve: the user's original objective, key decisions, files modified, errors and resolutions, HITL approvals, and the current plan/next steps.",
    "- Discard: retry loops, dead-end attempts, verbose tool output now reflected in files, intermediate reasoning.",
    "- Output a concise markdown summary (no more than 2-3 paragraphs).",
    "",
    "CONVERSATION HISTORY:",
    events,
  ].join("\n");
}
