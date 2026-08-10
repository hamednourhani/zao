/**
 * Core LLM call with schema validation and retry logic.
 *
 * Implements `generateStructuredResponse()` — the atomic unit of mo's harness.
 * Makes a structured API call to an LLM, enforces the response schema via Zod,
 * and retries with descriptive error feedback on failure.
 *
 * Key behaviors:
 * - Schema validation failures: retry up to 3 times with Zod error paths in the prompt
 * - API errors (429, 5xx, network): retry with exponential backoff up to 3 times
 * - After exhausting all retries, returns a structured error (never throws)
 * - Every attempt logs an EventLogEntry-compatible object
 *
 * ## ADR-009 compliance
 *
 * This module no longer imports provider factories directly. All provider
 * clients are created by `@zao/llm-clients` and passed in as {@link LlmClient}
 * objects. No API keys, provider configs, or credential fields cross this
 * boundary.
 *
 * @module llm
 */

import type { z } from "zod";
import { generateObject, NoObjectGeneratedError, RetryError } from "ai";
import { APICallError, TypeValidationError } from "@ai-sdk/provider";
import type { EventLogEntry } from "../schemas/event-log.ts";
import { redactSecrets } from "./artifacts.ts";
import type { LlmClient, ModelOptions } from "@zao/llm-clients";

// ── Type Definitions ────────────────────────────────────────────

/** Successful structured generation result. */
export interface StructuredResultSuccess<T> {
  success: true;
  result: T;
  events: EventLogEntry[];
}

/** Failed structured generation result (exhausted retries). */
export interface StructuredResultFailure {
  success: false;
  error: string;
  events: EventLogEntry[];
}

/** The result of a `generateStructuredResponse` call — success or failure. */
export type StructuredResult<T> =
  | StructuredResultSuccess<T>
  | StructuredResultFailure;

// ── Re-export for callers ──────────────────────────────────────────

export type { ModelOptions } from "@zao/llm-clients";

// ── Internal Types ───────────────────────────────────────────────

/**
 * The shape of usage metadata returned by the AI SDK.
 * Maps SDK's `inputTokens`/`outputTokens` to our `prompt_tokens`/`completion_tokens`.
 * Also includes cache details for prompt caching verification (TICKET-005).
 */
interface SDKUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Detailed token breakdown including cache hits. */
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

/**
 * Function signature compatible with `generateObject` from the `ai` package.
 * Used for dependency injection in tests and by {@link runLoop} for
 * forwarding mock implementations from the orchestrator layer.
 */
export type GenerateObjectFn = typeof generateObject;

// ── Constants ────────────────────────────────────────────────────

const MAX_SCHEMA_RETRIES = 3;
const MAX_API_RETRIES = 3;
const API_BACKOFF_SCHEDULE_MS = [1000, 2000, 4000];

// ── Event Logging ────────────────────────────────────────────────

/**
 * Creates an EventLogEntry-compatible log object for a single LLM attempt.
 *
 * @param modelId - The model identifier used for this call.
 * @param action  - The action label (e.g. "llm_call_success", "llm_call_failed").
 * @param usage   - Token usage data from the AI SDK, if available.
 * @param agentRole - The agent role name for the event.
 * @returns An `EventLogEntry` object suitable for appending to `events.jsonl`.
 */
function createEventLogEntry(
  modelId: string,
  action: string,
  usage?: SDKUsage,
  agentRole?: string,
): EventLogEntry {
  // Detect cache hit from the AI SDK's detailed token breakdown.
  // When inputTokenDetails.cacheReadTokens > 0, the provider served
  // some input tokens from its cache rather than recomputing them.
  const cacheHit = (usage?.inputTokenDetails?.cacheReadTokens ?? 0) > 0;

  return {
    schema_version: "0.2.0" as const,
    event_id: "",        // Populated by caller (loop/delegation)
    session_id: "",      // Populated by caller (loop/delegation)
    parent_session_id: null, // Populated by caller (loop/delegation)
    timestamp: new Date().toISOString(),
    agent_role: agentRole ?? "orchestrator",
    model_id: modelId,
    prompt_tokens: usage?.inputTokens ?? 0,
    completion_tokens: usage?.outputTokens ?? 0,
    cache_hit: cacheHit,
    action,
  };
}

// ── Error Classification ─────────────────────────────────────────

/**
 * Determines whether an error represents a retryable API-level error
 * (network issue, rate limit, server error) vs a schema validation error.
 */
function isRetryableApiError(error: unknown): boolean {
  // Direct API errors with the retryable flag set
  if (APICallError.isInstance(error)) {
    return error.isRetryable;
  }
  // RetryError wraps multiple errors — treat as API-level when SDK
  // retries are exhausted for non-validation reasons
  if (RetryError.isInstance(error)) {
    // If the last error in the chain is a validation error, treat as
    // schema failure (not API retry). Otherwise, treat as API error.
    return !isSchemaValidationError(error.lastError);
  }
  return false;
}

/**
 * Determines whether an error (or its cause chain) is a schema
 * validation failure (TypeValidationError or ZodError).
 */
function isSchemaValidationError(error: unknown): boolean {
  let current: unknown = error;

  while (current) {
    // Check for explicit SDK validation errors
    if (TypeValidationError.isInstance(current)) return true;

    // RetryError wraps the last error that caused retry exhaustion
    if (RetryError.isInstance(current)) {
      current = (current as RetryError).lastError;
      continue;
    }

    // NoObjectGeneratedError wraps schema or parse failures
    if (NoObjectGeneratedError.isInstance(current)) {
      current = (current as NoObjectGeneratedError).cause;
      continue;
    }

    // ZodError has an `issues` array of ZodIssue objects
    if (
      current !== null &&
      typeof current === "object" &&
      "issues" in current
    ) {
      return true;
    }

    break;
  }

  return false;
}

// ── Error Path Extraction ────────────────────────────────────────

/**
 * Extracts a human-readable error path from a schema validation error.
 *
 * Walks the error chain (RetryError → NoObjectGeneratedError →
 * TypeValidationError → ZodError) to find Zod issues with field paths
 * like `changes[2].file: expected string, received undefined`.
 *
 * @returns A semicolon-separated string of error paths and messages.
 */
function extractErrorPath(error: unknown): string {
  let current: unknown = error;

  // Unwrap error chain to find the root ZodError
  while (current) {
    if (RetryError.isInstance(current)) {
      current = current.lastError;
      continue;
    }
    if (
      NoObjectGeneratedError.isInstance(current) ||
      TypeValidationError.isInstance(current)
    ) {
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    break;
  }

  // Extract issues from ZodError-like objects
  if (
    current !== null &&
    typeof current === "object" &&
    "issues" in current
  ) {
    const issues = (current as { issues: unknown[] }).issues;
    if (Array.isArray(issues)) {
      return issues
        .map((issue) => {
          const path =
            Array.isArray((issue as { path?: unknown[] }).path) &&
            (issue as { path?: unknown[] }).path!.length > 0
              ? (issue as { path: unknown[] }).path.join(".")
              : "<root>";
          const message =
            typeof (issue as { message?: unknown }).message === "string"
              ? (issue as { message: string }).message
              : "Unknown error";
          return `${path}: ${message}`;
        })
        .join("; ");
    }
  }

  // Fallback: use Error.message or string coercion
  if (current instanceof Error) return current.message;
  return String(current ?? error);
}

// ── Retry Prompt Builder ─────────────────────────────────────────

/**
 * Appends schema validation error details to the original prompt so the
 * model can correct its output on the next attempt.
 *
 * @param originalPrompt - The original user prompt sent to the LLM.
 * @param errorPath      - Human-readable error path/message from Zod validation.
 * @returns The original prompt with schema validation error details appended.
 */
function buildRetryPrompt(
  originalPrompt: string,
  errorPath: string,
): string {
  return `${originalPrompt}\n\nYour previous response failed schema validation with the following errors:\n${errorPath}\nPlease fix your response to match the required schema exactly.`;
}

// ── Sleep Utility ─────────────────────────────────────────────────

/**
 * Returns a promise that resolves after `ms` milliseconds.
 *
 * @param ms - Duration to sleep in milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Core Function ─────────────────────────────────────────────────

/**
 * Generates a structured, typed response from an LLM with automatic
 * retry on schema validation failures and API errors.
 *
 * ## Behavior
 *
 * 1. Creates a model from the provided {@link LlmClient}
 * 2. Calls the LLM via the Vercel AI SDK's `generateObject`
 * 3. On success: parses, logs, and returns `{ success: true, result, events }`
 * 4. On schema validation failure: extracts the Zod error path, appends it
 *    to a retry prompt, and retries (up to 3 times total)
 * 5. On API errors (429, 5xx, network timeout): retries with exponential
 *    backoff (1s, 2s, 4s) up to 3 times
 * 6. After exhausting all retries, returns `{ success: false, error, events }`
 *    — **never throws**
 * 7. Every attempt (success or failure) appends to the `events` array
 *
 * ## ADR-009
 *
 * The client is created by `@zao/llm-clients` from the registry. No API keys,
 * provider configs, or credential fields are handled by this function.
 *
 * @param prompt - The natural-language prompt to send to the LLM.
 * @param schema - The Zod schema to validate the response against.
 * @param client - The resolved LLM client from the registry.
 * @param options - Temperature and maxTokens options.
 * @param _generateObjectFn - **Internal/test-only.** Allows injecting a mock
 *   `generateObject` implementation. Do not use in production.
 * @param _agentRole - The agent role name for event logging.
 *
 * @returns A `StructuredResult` — either success with the typed result or
 *          failure with an error message and event log.
 */
export async function generateStructuredResponse<T>(
  prompt: string,
  schema: z.ZodSchema<T>,
  client: LlmClient,
  options?: ModelOptions,
  _generateObjectFn?: GenerateObjectFn,
  _agentRole?: string,
): Promise<StructuredResult<T>> {
  const genObj = _generateObjectFn ?? generateObject;
  const events: EventLogEntry[] = [];
  const agentRole = _agentRole ?? "orchestrator";
  const modelId = client.apiModelId;

  let model: ReturnType<LlmClient["createModel"]>;
  try {
    model = client.createModel(options);
  } catch (error: unknown) {
    events.push(createEventLogEntry(modelId, "llm_call_failed", undefined, agentRole));
    return {
      success: false,
      error: `Failed to initialize model: ${error instanceof Error ? error.message : String(error)}`,
      events,
    };
  }

  // Defense-in-depth: redact secrets at the network choke point
  // before any prompt reaches an external provider. Combined with
  // redact-on-load in loadArtifacts() (context.ts), this ensures no
  // secret survives to an external API even if a new code path skips
  // the context builder. Deterministic: same input → same redacted
  // output → preserves prompt-cache prefix stability.
  const safePrompt = redactSecrets(prompt);
  let currentPrompt = safePrompt;
  let schemaRetries = 0;
  let apiRetries = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const result = await genObj({
        model,
        schema,
        prompt: currentPrompt,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        // Prompt caching: when `cache` is true, pass provider-specific
        // options that tell the provider to cache the stable prefix.
        // Layer 1 (system prompt + role identity) is designed to be
        // byte-identical across requests, making it cacheable.
        ...(options?.cache ? {
          providerOptions: {
            [client.providerId]: { cache: true },
          },
        } : {}),
      });

      // ── Success ──
      events.push(
        createEventLogEntry(modelId, "llm_call_success", {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          inputTokenDetails: result.usage.inputTokenDetails,
        }, agentRole),
      );

      return {
        success: true,
        result: result.object as T,
        events,
      };
    } catch (error: unknown) {
      // ── Classify the error ──

      if (isRetryableApiError(error)) {
        // API-level error (network, rate limit, server error)
        apiRetries++;
        events.push(
          createEventLogEntry(
            modelId,
            "llm_call_failed",
            extractUsageFromError(error),
            agentRole,
          ),
        );

        if (apiRetries >= MAX_API_RETRIES) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            success: false,
            error: `API error after ${apiRetries} retries: ${message}`,
            events,
          };
        }

        const delayMs =
          API_BACKOFF_SCHEDULE_MS[apiRetries - 1] ?? 4000;
        await sleep(delayMs);
        continue;
      }

      if (isSchemaValidationError(error)) {
        // Schema validation failure — retry with error feedback
        schemaRetries++;
        const errorPath = extractErrorPath(error);

        events.push(
          createEventLogEntry(
            modelId,
            "llm_call_failed",
            extractUsageFromError(error),
            agentRole,
          ),
        );

        if (schemaRetries >= MAX_SCHEMA_RETRIES) {
          return {
            success: false,
            error: `Schema validation failed after ${schemaRetries} retries: ${errorPath}`,
            events,
          };
        }

        // Build retry prompt from the redacted prompt so secrets
        // don't leak through retry paths either.
        currentPrompt = buildRetryPrompt(safePrompt, errorPath);
        continue;
      }

      // Unknown / unexpected error — fail immediately (no retry)
      events.push(
        createEventLogEntry(modelId, "llm_call_failed", undefined, agentRole),
      );

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        events,
      };
    }
  }
}

// ── Usage Extraction Helper ───────────────────────────────────────

/**
 * Attempts to extract token usage information from an error object.
 *
 * `NoObjectGeneratedError` carries usage data even when generation
 * fails, which is useful for cost tracking.
 */
function extractUsageFromError(error: unknown): SDKUsage | undefined {
  if (NoObjectGeneratedError.isInstance(error)) {
    return {
      inputTokens: error.usage?.inputTokens,
      outputTokens: error.usage?.outputTokens,
    };
  }
  return undefined;
}
