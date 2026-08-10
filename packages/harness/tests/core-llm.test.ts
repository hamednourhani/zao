/**
 * Core LLM tests for `generateStructuredResponse`.
 *
 * Uses dependency injection (`_generateObjectFn` parameter) to mock
 * the `generateObject` call from the `ai` package. No real API calls
 * are made — all tests are deterministic and fast.
 *
 * @module core-llm.test
 */

import { describe, expect, test, mock } from "bun:test";
import { z } from "zod";
import { NoObjectGeneratedError, RetryError } from "ai";
import { APICallError, TypeValidationError } from "@ai-sdk/provider";
import { generateStructuredResponse } from "../src/core/llm.ts";
import type { EventLogEntry as _EventLogEntry } from "../src/schemas/event-log.ts";
import { mockClientFromLegacy } from "./fixtures/mock-llm-client.ts";

// ── Test Schema ──────────────────────────────────────────────────

/** Minimal Zod schema used across all tests. */
const TestSchema = z.object({
  answer: z.string(),
});

type TestResult = z.infer<typeof TestSchema>;

// ── Mock Helpers ─────────────────────────────────────────────────

/**
 * Creates a mock `generateObject` result that contains a valid object
 * and simulated token usage.
 */
function mockSuccessResult<T>(object: T) {
  return {
    object,
    reasoning: undefined,
    finishReason: "stop" as const,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      inputTokenDetails: {
        noCacheTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokenDetails: {
        textTokens: 50,
        reasoningTokens: 0,
      },
      raw: undefined,
    },
    warnings: undefined,
    request: {
      body: undefined,
      headers: undefined,
    },
    response: {
      id: "test-id",
      timestamp: new Date(),
      modelId: "test-model",
      headers: {},
    },
    providerMetadata: undefined,
    toJsonResponse: () => new Response(),
  };
}

/**
 * Creates a raw ZodError-like object with the given issues.
 * Matches the shape that `TypeValidationError.cause` would contain.
 */
function zodErrorShape(issues: Array<{ path: string[]; message: string }>) {
  return {
    name: "ZodError",
    message: JSON.stringify(issues),
    issues: issues.map(({ path, message }) => ({
      code: "invalid_type",
      expected: "string",
      received: "undefined",
      path,
      message,
    })),
  };
}

// ── Suite ────────────────────────────────────────────────────────

describe("generateStructuredResponse", () => {
  // ── TEST-1: Happy path — success ───────────────────────────

  test("returns success with parsed result on valid response", async () => {
    const expectedResult: TestResult = { answer: "42" };
    const mockGenObj = mock(() => Promise.resolve(mockSuccessResult(expectedResult)));

    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.answer).toBe("42");
      expect(result.events).toHaveLength(1);
      expect(result.events[0]!.action).toBe("llm_call_success");
      expect(result.events[0]!.model_id).toBe("gpt-4o");
    }

    expect(mockGenObj).toHaveBeenCalledTimes(1);
  });

  // ── TEST-2: Schema validation failure → retry with error path → success ──

  test("retries with error path on schema validation failure and succeeds on retry", async () => {
    const expectedResult: TestResult = { answer: "corrected" };

    // First call: throw TypeValidationError wrapping a ZodError
    const zodErr = zodErrorShape([
      { path: ["answer"], message: "Invalid input: expected string, received number" },
    ]);
    const typeValErr = new TypeValidationError({
      value: { answer: 123 },
      cause: zodErr,
    });
    const noObjErr = new NoObjectGeneratedError({
      message: "No object generated",
      cause: typeValErr,
      text: '{"answer": 123}',
      response: {} as any,
      usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } as any,
      finishReason: "stop",
    });

    // Second call: succeeds
    const mockGenObj = mock()
      .mockRejectedValueOnce(noObjErr)
      .mockResolvedValueOnce(mockSuccessResult(expectedResult));

    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.answer).toBe("corrected");
      // 2 events: first failure, then success
      expect(result.events).toHaveLength(2);
      expect(result.events[0]!.action).toBe("llm_call_failed");
      expect(result.events[1]!.action).toBe("llm_call_success");
    }

    // Should have been called twice
    expect(mockGenObj).toHaveBeenCalledTimes(2);

    // Verify the second call includes the error path in the prompt
    const secondCallArgs = (mockGenObj as any).mock.calls[1]?.[0] as
      | { prompt?: string }
      | undefined;
    expect(secondCallArgs?.prompt).toContain("failed schema validation");
    expect(secondCallArgs?.prompt).toContain("answer: Invalid input: expected string, received number");
  });

  // ── TEST-3: 3 consecutive schema validation failures → returns error ──

  test("returns error after 3 consecutive schema validation failures", async () => {
    const zodErr = zodErrorShape([
      { path: ["answer"], message: "Invalid input: expected string, received number" },
    ]);
    const typeValErr = new TypeValidationError({
      value: { answer: 123 },
      cause: zodErr,
    });
    const noObjErr = new NoObjectGeneratedError({
      message: "No object generated",
      cause: typeValErr,
      text: '{"answer": 123}',
      response: {} as any,
      usage: {
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
      } as any,
      finishReason: "stop",
    });

    const mockGenObj = mock()
      .mockRejectedValueOnce(noObjErr)
      .mockRejectedValueOnce(noObjErr)
      .mockRejectedValueOnce(noObjErr);

    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Schema validation failed after 3 retries");
      expect(result.error).toContain("answer:");
    }

    // 3 events, all failures
    expect(result.events).toHaveLength(3);
    for (const event of result.events) {
      expect(event.action).toBe("llm_call_failed");
    }

    // Called exactly 3 times (no 4th call)
    expect(mockGenObj).toHaveBeenCalledTimes(3);
  });

  // ── TEST-4: API 429 → retry with backoff → success on retry ──

  test("retries with backoff on API 429 and succeeds on retry", async () => {
    const expectedResult: TestResult = { answer: "api-recovered" };
    const apiErr = new APICallError({
      message: "Rate limit exceeded",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: {},
      responseBody: "Rate limit",
      isRetryable: true,
    });

    const mockGenObj = mock()
      .mockRejectedValueOnce(apiErr)
      .mockResolvedValueOnce(mockSuccessResult(expectedResult));

    const startTime = Date.now();
    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );
    const elapsed = Date.now() - startTime;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.answer).toBe("api-recovered");
    }

    // 2 events: failure + success
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.action).toBe("llm_call_failed");
    expect(result.events[1]!.action).toBe("llm_call_success");

    expect(mockGenObj).toHaveBeenCalledTimes(2);

    // Backoff: first retry should be after at least 900ms (1s minus tolerance)
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  // ── TEST-5: 3 consecutive API errors → returns error ──

  test("returns error after 3 consecutive API errors", async () => {
    const apiErr = new APICallError({
      message: "Internal server error",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 500,
      responseHeaders: {},
      responseBody: "Server error",
      isRetryable: true,
    });

    const mockGenObj = mock()
      .mockRejectedValueOnce(apiErr)
      .mockRejectedValueOnce(apiErr)
      .mockRejectedValueOnce(apiErr);

    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("API error after 3 retries");
    }

    // 3 events, all failures
    expect(result.events).toHaveLength(3);
    for (const event of result.events) {
      expect(event.action).toBe("llm_call_failed");
    }

    expect(mockGenObj).toHaveBeenCalledTimes(3);
  });

  // ── TEST-6: Event log contains model_id, token counts ──────

  test("event log entries contain model_id, token counts, and correct action", async () => {
    const expectedResult: TestResult = { answer: "logged" };

    // First call fails (schema error with usage), second succeeds (with usage)
    const zodErr = zodErrorShape([
      { path: ["answer"], message: "Required" },
    ]);
    const typeValErr = new TypeValidationError({
      value: {},
      cause: zodErr,
    });
    const noObjErr = new NoObjectGeneratedError({
      message: "No object generated",
      cause: typeValErr,
      text: "{}",
      response: {} as any,
      usage: {
        inputTokens: 30,
        outputTokens: 5,
        totalTokens: 35,
      } as any,
      finishReason: "stop",
    });

    const successUsage = {
      inputTokens: 80,
      outputTokens: 40,
      totalTokens: 120,
    };

    const mockGenObj = mock()
      .mockRejectedValueOnce(noObjErr)
      .mockResolvedValueOnce({
        ...mockSuccessResult(expectedResult),
        usage: {
          ...mockSuccessResult(expectedResult).usage,
          inputTokens: successUsage.inputTokens,
          outputTokens: successUsage.outputTokens,
          totalTokens: successUsage.totalTokens,
        },
      });

    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "deepseek", model: "deepseek-chat" }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(2);

    // First event (failed attempt): should have token counts from the error's usage
    const failEvent = result.events[0]!;
    expect(failEvent.model_id).toBe("deepseek-chat");
    expect(failEvent.action).toBe("llm_call_failed");
    expect(failEvent.schema_version).toBe("0.2.0");
    expect(failEvent.agent_role).toBe("orchestrator");
    expect(failEvent.cache_hit).toBe(false);
    expect(typeof failEvent.timestamp).toBe("string");
    expect(failEvent.timestamp.length).toBeGreaterThan(0);
    // Token counts from the error's usage
    expect(failEvent.prompt_tokens).toBe(30);
    expect(failEvent.completion_tokens).toBe(5);

    // Second event (success): should have token counts from the success result
    const successEvent = result.events[1]!;
    expect(successEvent.model_id).toBe("deepseek-chat");
    expect(successEvent.action).toBe("llm_call_success");
    expect(successEvent.prompt_tokens).toBe(80);
    expect(successEvent.completion_tokens).toBe(40);
  });

  // ── Edge Case: Non-retryable API error returns immediately ──

  test("returns error immediately on non-retryable API error", async () => {
    const apiErr = new APICallError({
      message: "Invalid API key",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 401,
      responseHeaders: {},
      responseBody: "Unauthorized",
      isRetryable: false,
    });

    const mockGenObj = mock().mockRejectedValueOnce(apiErr);

    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid API key");
    }

    // Only 1 call, no retry
    expect(mockGenObj).toHaveBeenCalledTimes(1);
    expect(result.events).toHaveLength(1);
  });

  // ── Edge Case: RetryError wrapping validation → treated as schema error ──

  test("handles RetryError wrapping schema validation as retryable schema error", async () => {
    const zodErr = zodErrorShape([
      { path: ["answer"], message: "Invalid input: expected string, received number" },
    ]);
    const typeValErr = new TypeValidationError({
      value: { answer: 123 },
      cause: zodErr,
    });

    // RetryError where the last error is a validation error
    // RetryError's constructor sets lastError from the last element in errors
    const retryErr = new RetryError({
      message: "Retry exhausted",
      reason: "maxRetriesExceeded",
      errors: [typeValErr],
    });

    const expectedResult: TestResult = { answer: "recovered" };
    const mockGenObj = mock()
      .mockRejectedValueOnce(retryErr)
      .mockResolvedValueOnce(mockSuccessResult(expectedResult));

    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(2);
    expect(mockGenObj).toHaveBeenCalledTimes(2);
  });

  // ── Edge Case: DeepSeek provider is configured correctly ──

  test("accepts deepseek provider config", async () => {
    const expectedResult: TestResult = { answer: "deepseek works" };
    const mockGenObj = mock(() => Promise.resolve(mockSuccessResult(expectedResult)));

    const result = await generateStructuredResponse(
      "test prompt",
      TestSchema,
      mockClientFromLegacy({ provider: "deepseek", model: "deepseek-chat" }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(true);
    expect(result.events[0]!.model_id).toBe("deepseek-chat");
  });

  // ── Edge Case: Google provider is configured correctly ──

  test("accepts google provider config", async () => {
    const expectedResult: TestResult = { answer: "gemini works" };
    const mockGenObj = mock(() => Promise.resolve(mockSuccessResult(expectedResult)));

    const result = await generateStructuredResponse(
      "test prompt",
      TestSchema,
      mockClientFromLegacy({ provider: "google", model: "gemini-2.0-flash" }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(true);
    expect(result.events[0]!.model_id).toBe("gemini-2.0-flash");
  });

  // ── Edge Case: OpenRouter provider uses custom baseURL ──

  test("accepts openrouter provider config with baseURL", async () => {
    const expectedResult: TestResult = { answer: "openrouter works" };
    const mockGenObj = mock(() => Promise.resolve(mockSuccessResult(expectedResult)));

    const result = await generateStructuredResponse(
      "test prompt",
      TestSchema,
      mockClientFromLegacy({
        provider: "openrouter",
        model: "openai/gpt-4o",
      }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(true);
    expect(result.events[0]!.model_id).toBe("openai/gpt-4o");
  });

  // ── Edge Case: Temperature and maxTokens are passed through ──

  test("passes temperature and maxTokens to generateObject", async () => {
    const expectedResult: TestResult = { answer: "temp test" };
    const mockGenObj = mock(() => Promise.resolve(mockSuccessResult(expectedResult)));

    await generateStructuredResponse(
      "test prompt",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      { temperature: 0.3, maxTokens: 2000 },
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    const callArgs = (mockGenObj as any).mock.calls[0]?.[0] as
      | { temperature?: number; maxTokens?: number }
      | undefined;
    expect(callArgs?.temperature).toBe(0.3);
    expect(callArgs?.maxTokens).toBe(2000);
  });

  // ── Gap: Multiple Zod error paths concatenated with "; " ──

  test("includes multiple Zod error paths in retry prompt, joined by semicolons", async () => {
    const zodErr = zodErrorShape([
      { path: ["answer"], message: "Invalid input: expected string" },
      { path: ["confidence"], message: "Required" },
    ]);
    const typeValErr = new TypeValidationError({
      value: { answer: 123 },
      cause: zodErr,
    });
    const noObjErr = new NoObjectGeneratedError({
      message: "No object generated",
      cause: typeValErr,
      text: '{"answer": 123}',
      response: {} as any,
      usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } as any,
      finishReason: "stop",
    });

    const expectedResult: TestResult = { answer: "corrected" };
    const mockGenObj = mock()
      .mockRejectedValueOnce(noObjErr)
      .mockResolvedValueOnce(mockSuccessResult(expectedResult));

    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(true);
    const secondCallArgs = (mockGenObj as any).mock.calls[1]?.[0] as
      | { prompt?: string }
      | undefined;

    // Both error paths should appear, joined by "; "
    expect(secondCallArgs?.prompt).toContain("answer: Invalid input: expected string");
    expect(secondCallArgs?.prompt).toContain("confidence: Required");
    // Should contain the semicolon separator between paths
    expect(secondCallArgs?.prompt).toMatch(/answer.*;.*confidence|confidence.*;.*answer/);
  });

  // ── Gap: Backoff timing for 3 consecutive API failures ──

  test("applies exponential backoff correctly across 3 consecutive API failures", async () => {
    const apiErr = new APICallError({
      message: "Internal server error",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 500,
      responseHeaders: {},
      responseBody: "Server error",
      isRetryable: true,
    });

    const mockGenObj = mock()
      .mockRejectedValueOnce(apiErr)
      .mockRejectedValueOnce(apiErr)
      .mockRejectedValueOnce(apiErr);

    const startTime = Date.now();
    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );
    const elapsed = Date.now() - startTime;

    expect(result.success).toBe(false);

    // Backoff schedule: 1s after 1st failure, 2s after 2nd failure = ~3s total
    // Allow 200ms tolerance below the expected 3000ms sum
    expect(elapsed).toBeGreaterThanOrEqual(2700);
    // Should not exceed 4000ms (1s + 2s + generous buffer)
    expect(elapsed).toBeLessThan(4000);

    expect(mockGenObj).toHaveBeenCalledTimes(3);
  });

  // ── Gap: RetryError wrapping API errors (not schema) ──

  test("retries with backoff when RetryError wraps non-schema API errors", async () => {
    const apiErr = new APICallError({
      message: "Service unavailable",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 503,
      responseHeaders: {},
      responseBody: "Unavailable",
      isRetryable: true,
    });
    const retryErr = new RetryError({
      message: "Retry exhausted",
      reason: "maxRetriesExceeded",
      errors: [apiErr],
    });

    const expectedResult: TestResult = { answer: "recovered" };
    const mockGenObj = mock()
      .mockRejectedValueOnce(retryErr)
      .mockResolvedValueOnce(mockSuccessResult(expectedResult));

    const startTime = Date.now();
    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );
    const elapsed = Date.now() - startTime;

    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(2);

    // Should have waited for the API backoff period (≥900ms)
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(mockGenObj).toHaveBeenCalledTimes(2);
  });

  // ── Gap: Timeout (network) as retryable APICallError ──

  test("retries with backoff on APICallError with retryable timeout", async () => {
    const timeoutErr = new APICallError({
      message: "Connection timed out",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: undefined, // Network timeouts may not have a status code
      responseHeaders: {},
      responseBody: "ETIMEDOUT",
      isRetryable: true,
    });

    const expectedResult: TestResult = { answer: "timeout-recovered" };
    const mockGenObj = mock()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce(mockSuccessResult(expectedResult));

    const startTime = Date.now();
    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );
    const elapsed = Date.now() - startTime;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.answer).toBe("timeout-recovered");
    }
    expect(result.events).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  // ── Gap: Unknown error never throws (returns StructuredResult) ──

  test("returns StructuredResult (never throws) on unexpected error types", async () => {
    const rawError = new Error("Something completely unexpected happened");

    const mockGenObj = mock().mockRejectedValueOnce(rawError);

    // Must not throw — the function must always return a result
    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Something completely unexpected happened");
    }
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.action).toBe("llm_call_failed");
    expect(mockGenObj).toHaveBeenCalledTimes(1);
  });

  // ── Gap: 2 schema failures → 1 success (3 events, correct sequence) ──

  test("returns success with 3 events after 2 schema failures then success", async () => {
    const zodErr1 = zodErrorShape([
      { path: ["answer"], message: "Invalid input: expected string, received number" },
    ]);
    const typeValErr1 = new TypeValidationError({
      value: { answer: 123 },
      cause: zodErr1,
    });
    const noObjErr1 = new NoObjectGeneratedError({
      message: "No object generated",
      cause: typeValErr1,
      text: '{"answer": 123}',
      response: {} as any,
      usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } as any,
      finishReason: "stop",
    });

    const zodErr2 = zodErrorShape([
      { path: ["answer"], message: "Invalid input: expected string, received boolean" },
    ]);
    const typeValErr2 = new TypeValidationError({
      value: { answer: true },
      cause: zodErr2,
    });
    const noObjErr2 = new NoObjectGeneratedError({
      message: "No object generated",
      cause: typeValErr2,
      text: '{"answer": true}',
      response: {} as any,
      usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 } as any,
      finishReason: "stop",
    });

    const expectedResult: TestResult = { answer: "finally correct" };
    const mockGenObj = mock()
      .mockRejectedValueOnce(noObjErr1)
      .mockRejectedValueOnce(noObjErr2)
      .mockResolvedValueOnce(mockSuccessResult(expectedResult));

    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      undefined,
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.answer).toBe("finally correct");
    }

    // 3 events: fail, fail, success
    expect(result.events).toHaveLength(3);
    expect(result.events[0]!.action).toBe("llm_call_failed");
    expect(result.events[1]!.action).toBe("llm_call_failed");
    expect(result.events[2]!.action).toBe("llm_call_success");

    expect(mockGenObj).toHaveBeenCalledTimes(3);

    // Verify the third call's prompt contains the second error path
    const thirdCallArgs = (mockGenObj as any).mock.calls[2]?.[0] as
      | { prompt?: string }
      | undefined;
    expect(thirdCallArgs?.prompt).toContain("failed schema validation");
    expect(thirdCallArgs?.prompt).toContain("received boolean");
  });

  // ── Prompt Caching (Gap #3) ────────────────────────────────────────

  test("forwards cache: true as providerOptions to generateObject", async () => {
    const expectedResult: TestResult = { answer: "cached response" };
    const mockGenObj = mock().mockResolvedValueOnce(mockSuccessResult(expectedResult));

    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "deepseek", model: "deepseek-chat" }),
      { cache: true, temperature: 0.1 },
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(true);
    expect(mockGenObj).toHaveBeenCalledTimes(1);

    // Verify that providerOptions was passed with cache flag
    const callArgs = (mockGenObj as any).mock.calls[0]?.[0] as
      | { providerOptions?: Record<string, unknown> }
      | undefined;
    expect(callArgs?.providerOptions).toBeDefined();
    expect(callArgs?.providerOptions?.deepseek).toEqual({ cache: true });
  });

  test("does NOT pass providerOptions when cache is false", async () => {
    const expectedResult: TestResult = { answer: "no cache" };
    const mockGenObj = mock().mockResolvedValueOnce(mockSuccessResult(expectedResult));

    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      { temperature: 0.1 },
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(true);
    expect(mockGenObj).toHaveBeenCalledTimes(1);

    // Verify no providerOptions when cache is not set
    const callArgs = (mockGenObj as any).mock.calls[0]?.[0] as
      | { providerOptions?: Record<string, unknown> }
      | undefined;
    expect(callArgs?.providerOptions).toBeUndefined();
  });

  test("forwards cache: false without providerOptions", async () => {
    const expectedResult: TestResult = { answer: "explicit no cache" };
    const mockGenObj = mock().mockResolvedValueOnce(mockSuccessResult(expectedResult));

    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      { cache: false },
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(true);
    expect(mockGenObj).toHaveBeenCalledTimes(1);

    const callArgs = (mockGenObj as any).mock.calls[0]?.[0] as
      | { providerOptions?: Record<string, unknown> }
      | undefined;
    expect(callArgs?.providerOptions).toBeUndefined();
  });

  test("sets cache_hit=true when usage.inputTokenDetails.cacheReadTokens > 0", async () => {
    const expectedResult: TestResult = { answer: "cached response" };
    const mockResult = mockSuccessResult(expectedResult);
    // Simulate a cache hit by adding cacheReadTokens to the usage
    const mockGenObj = mock().mockResolvedValueOnce({
      ...mockResult,
      usage: {
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
        inputTokenDetails: {
          cacheReadTokens: 50,
          cacheWriteTokens: 0,
        },
        outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
      },
    });

    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "deepseek", model: "deepseek-chat" }),
      { cache: true },
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.cache_hit).toBe(true);
  });

  test("sets cache_hit=false when usage.inputTokenDetails.cacheReadTokens === 0", async () => {
    const expectedResult: TestResult = { answer: "no cache" };
    const mockResult = mockSuccessResult(expectedResult);
    // No cache hit
    const mockGenObj = mock().mockResolvedValueOnce({
      ...mockResult,
      usage: {
        inputTokens: 150,
        outputTokens: 25,
        totalTokens: 175,
        inputTokenDetails: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        outputTokenDetails: { textTokens: 25, reasoningTokens: 0 },
      },
    });

    const result = await generateStructuredResponse(
      "What is the answer?",
      TestSchema,
      mockClientFromLegacy({ provider: "openai", model: "gpt-4o" }),
      { temperature: 0.1 },
      mockGenObj as unknown as typeof import("ai").generateObject,
    );

    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.cache_hit).toBe(false);
  });
});
