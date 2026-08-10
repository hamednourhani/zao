/**
 * Integration Tests with Mock Model Provider.
 *
 * Exercises the full `runLoop()` pipeline end-to-end using a mock
 * LLM provider — catching wiring bugs, regression issues, and
 * cross-component integration failures that unit tests miss.
 *
 * Each test uses a throwaway project directory, calls `runLoop()`
 * with a mock model factory, and verifies disk artifacts.
 *
 * ## Test coverage (Story 006B)
 *
 * - TEST-1:  Happy path — task → session → artifact → events
 * - TEST-2:  Schema retry — one failure, one success → 2 events
 * - TEST-3:  Schema exhaustion — 3 failures, halt, no artifact
 * - TEST-4:  API retry — 429 → backoff → success
 * - TEST-5:  Egress redaction — secret in task → prompt redacted
 * - TEST-6:  Audit trail completeness — all EventLogEntry fields
 * - TEST-7:  Mock model isolation — error shapes and exhaustion
 * - TEST-8:  Network delay — simulated latency
 * - TEST-9:  API exhaustion — 3 API errors, halt, no artifact
 * - TEST-10: Mixed errors — schema → API → success
 * - TEST-11: Non-retryable error — exhaustion propagates through runLoop
 * - TEST-12: Multiple API retries — 2 API errors → backoff → success
 * - TEST-13: API error with delay — 429 + 200ms delay, then success
 * - TEST-14: Zero delay explicit — 0ms delay does not affect pipeline
 * - TEST-15: No object specified — mock uses default handoff response
 * - TEST-16: Sequential sessions — two calls, independent artifacts
 *
 * @module integration.test
 */

import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runLoop } from "../src/core/loop.ts";
import { DEVELOPER_DEF } from "./fixtures/role-registry.ts";
import { createMockRegistryForLlmId } from "./fixtures/mock-llm-client.ts";
import { createMockModel } from "./mocks/mock-model.ts";

// ── Temp Directory Management ──────────────────────────────────────

/** Directories created during test runs — cleaned up in `afterAll`. */
const tempDirs: string[] = [];
let testStoreRoot: string;

/**
 * Creates a unique throwaway project directory under `/tmp`.
 * All directories are tracked for automatic cleanup.
 */
function makeTempDir(): string {
  const dir = join("/tmp", `zao-integ-${crypto.randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

beforeAll(async () => {
  testStoreRoot = makeTempDir();
  await ensureDir(testStoreRoot);
  process.env["ZAO_HOME"] = testStoreRoot;
});

afterAll(async () => {
  delete process.env["ZAO_HOME"];
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — temp dir may have been cleaned already
    }
  }
});

// ── Config Helper ──────────────────────────────────────────────────

/** Mock registry for integration tests (never reaches a real API). */
const TEST_REGISTRY = createMockRegistryForLlmId("deepseek:deepseek-chat");

/** Pre-built test role registry — avoids disk I/O. */

// ── Helper: Read events from session ───────────────────────────────

/**
 * Reads and parses the `events.jsonl` file from a session directory.
 * Returns an array of parsed event objects.
 */
async function readSessionEvents(sessionDir: string): Promise<Record<string, unknown>[]> {
  const eventsPath = join(sessionDir, "events.jsonl");
  const raw = await readFile(eventsPath, "utf-8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ── Helper: Check file existence ───────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await import("node:fs/promises").then((m) => m.access(path));
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Integration Test Suite
// ═══════════════════════════════════════════════════════════════════

describe("Integration: runLoop with Mock Model", () => {
  // ── TEST-1: Happy Path ──────────────────────────────────────────

  test("happy path: task → session → artifact → events", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = createMockModel([{}]); // 1 valid response (uses defaults)

    const result = await runLoop({
      task: "Implement a simple feature",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mock,
      _roleDef: DEVELOPER_DEF,
    });

    // ── Assert: runLoop reports success ──
    expect(result.success).toBe(true);
    expect(result.sessionDir).toContain(join(testStoreRoot, "sessions"));
    expect(result.artifactPath).toBe(
      join(result.sessionDir, "result.json"),
    );

    // ── Assert: session directory and artifact exist on disk ──
    const eventsPath = join(result.sessionDir, "events.jsonl");
    const artifactPath = result.artifactPath!;
    expect(await fileExists(eventsPath)).toBe(true);
    expect(await fileExists(artifactPath)).toBe(true);

    // ── Assert: exactly 1 event logged ──
    const events = await readSessionEvents(result.sessionDir);
    expect(events.length).toBe(1);
    expect(events[0]!.action).toBe("llm_call_success");
  });

  // ── TEST-2: Schema Retry → Success ──────────────────────────────

  test("schema retry: first call malformed, second succeeds", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = createMockModel([
      { schemaError: "changes.0.file_path: expected string, received number" },
      { object: { schema_version: "0.1.0", status: "success", summary: "Fixed after retry.", changes: [] } },
    ]);

    const result = await runLoop({
      task: "Retry task",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mock,
      _roleDef: DEVELOPER_DEF,
    });

    expect(result.success).toBe(true);
    expect(result.artifactPath).toBe(
      join(result.sessionDir, "result.json"),
    );

    // ── Assert: 2 events (1 failure + 1 success) ──
    // Note: The story draft mentions "3 events", but only actual LLM
    // calls produce events — the retry decision itself is not an event.
    const events = await readSessionEvents(result.sessionDir);
    expect(events.length).toBe(2);
    expect(events[0]!.action).toBe("llm_call_failed");
    expect(events[1]!.action).toBe("llm_call_success");

    // ── Assert: artifact contains the retry-success response ──
    const artifactRaw = await readFile(result.artifactPath!, "utf-8");
    const artifact = JSON.parse(artifactRaw);
    expect(artifact.result.summary).toBe("Fixed after retry.");
  });

  // ── TEST-3: 3 Consecutive Schema Failures → Halt ────────────────

  test("3 consecutive schema failures → halt, no artifact, 3 failed events", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const schemaErr = "changes: expected array, received null";
    const mock = createMockModel([
      { schemaError: schemaErr },
      { schemaError: schemaErr },
      { schemaError: schemaErr },
    ]);

    const result = await runLoop({
      task: "Impossible task",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mock,
      _roleDef: DEVELOPER_DEF,
    });

    // ── Assert: failure reported ──
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Schema validation failed after 3 retries");

    // ── Assert: no artifact path returned ──
    expect(result.artifactPath).toBeUndefined();

    // ── Assert: no artifact file on disk ──
    const artifactPath = join(result.sessionDir, "result.json");
    expect(await fileExists(artifactPath)).toBe(false);

    // ── Assert: 3 failure events in events.jsonl ──
    const events = await readSessionEvents(result.sessionDir);
    expect(events.length).toBe(3);
    for (const event of events) {
      expect(event.action).toBe("llm_call_failed");
      expect(event.model_id).toBe("deepseek-chat");
    }
  });

  // ── TEST-4: API 429 Retry → Success ─────────────────────────────

  test("API 429 error: backoff then success", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = createMockModel([
      { apiError: 429 },
      { object: { schema_version: "0.1.0", status: "success", summary: "Recovered from rate limit.", changes: [] } },
    ]);

    const startTime = Date.now();

    const result = await runLoop({
      task: "API retry task",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mock,
      _roleDef: DEVELOPER_DEF,
    });

    const elapsed = Date.now() - startTime;

    // ── Assert: success after retry ──
    expect(result.success).toBe(true);

    // ── Assert: backoff delay was applied (≥ 900ms, first backoff = 1000ms) ──
    expect(elapsed).toBeGreaterThanOrEqual(900);

    // ── Assert: 2 events (1 failure + 1 success) ──
    const events = await readSessionEvents(result.sessionDir);
    expect(events.length).toBe(2);
    expect(events[0]!.action).toBe("llm_call_failed");
    expect(events[1]!.action).toBe("llm_call_success");
  });

  // ── TEST-5: Egress Redaction ────────────────────────────────────

  test("egress redaction: secret in task → mock receives redacted prompt", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const capturedPrompts: string[] = [];
    const mock = createMockModel([{}], capturedPrompts);

    const result = await runLoop({
      task: "Use API key sk-ant-api03-abc123def456 for authentication",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mock,
      _roleDef: DEVELOPER_DEF,
    });

    expect(result.success).toBe(true);

    // ── Assert: at least one prompt was captured ──
    expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);

    // ── Assert: the captured prompt contains [REDACTED] ──
    const capturedPrompt = capturedPrompts.join("\n");
    expect(capturedPrompt).toContain("[REDACTED]");

    // ── Assert: the raw secret is NOT in the captured prompt ──
    expect(capturedPrompt).not.toContain("sk-ant-api03-abc123def456");
  });

  // ── TEST-6: Audit Trail Completeness ────────────────────────────

  test("audit trail: events.jsonl contains all required fields", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = createMockModel([
      { object: { schema_version: "0.1.0", status: "success", summary: "Audit test.", changes: [] } },
    ]);

    const result = await runLoop({
      task: "Verify audit trail",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mock,
      _roleDef: DEVELOPER_DEF,
    });

    expect(result.success).toBe(true);

    // ── Assert: exactly 1 event ──
    const events = await readSessionEvents(result.sessionDir);
    expect(events.length).toBe(1);

    const event = events[0]!;

    // All required EventLogEntry fields must be present and well-typed
    expect(event.schema_version).toBe("0.2.0");
    expect(typeof event.event_id).toBe("string");
    expect(typeof event.session_id).toBe("string");
    expect(event.parent_session_id === null).toBe(true);
    expect(typeof event.timestamp).toBe("string");
    expect((event.timestamp as string).length).toBeGreaterThan(0);
    expect(event.agent_role).toBe("developer");
    expect(event.model_id).toBe("deepseek-chat");
    expect(typeof event.prompt_tokens).toBe("number");
    expect(event.prompt_tokens as number).toBeGreaterThan(0);
    expect(typeof event.completion_tokens).toBe("number");
    expect(event.completion_tokens as number).toBeGreaterThan(0);
    expect(typeof event.cache_hit).toBe("boolean");
    expect(event.action).toBe("llm_call_success");
  });

  // ── TEST-7: Mock Model Isolation — Error Shapes ─────────────────

  test("mock model produces correct AiSdk error shapes", async () => {
    const { NoObjectGeneratedError } = await import("ai");
    const { APICallError, TypeValidationError } = await import("@ai-sdk/provider");

    // ── Sub-test A: Schema error chain ──
    const schemaMock = createMockModel([
      { schemaError: "changes.0.file_path: expected string, received number" },
    ]);

    let schemaCaught: unknown = null;
    try {
      await (schemaMock as Function)({
        prompt: "test",
        model: {},
        schema: {},
      });
    } catch (err) {
      schemaCaught = err;
    }

    expect(schemaCaught).not.toBeNull();
    expect(NoObjectGeneratedError.isInstance(schemaCaught)).toBe(true);
    const nogenErr = schemaCaught as InstanceType<typeof NoObjectGeneratedError>;
    expect(nogenErr.message).toBe("No object generated");
    expect(TypeValidationError.isInstance(nogenErr.cause)).toBe(true);

    // ── Sub-test B: APICallError shape (429) ──
    const apiMock = createMockModel([{ apiError: 429 }]);

    let apiCaught: unknown = null;
    try {
      await (apiMock as Function)({
        prompt: "test",
        model: {},
        schema: {},
      });
    } catch (err) {
      apiCaught = err;
    }

    expect(apiCaught).not.toBeNull();
    expect(APICallError.isInstance(apiCaught)).toBe(true);
    const apiErr = apiCaught as InstanceType<typeof APICallError>;
    expect(apiErr.statusCode).toBe(429);
    expect(apiErr.isRetryable).toBe(true);

    // ── Sub-test C: Network timeout (statusCode=undefined) ──
    const timeoutMock = createMockModel([{ apiError: 0 }]);

    let timeoutCaught: unknown = null;
    try {
      await (timeoutMock as Function)({
        prompt: "test",
        model: {},
        schema: {},
      });
    } catch (err) {
      timeoutCaught = err;
    }

    expect(timeoutCaught).not.toBeNull();
    expect(APICallError.isInstance(timeoutCaught)).toBe(true);
    const timeoutErr = timeoutCaught as InstanceType<typeof APICallError>;
    expect(timeoutErr.statusCode).toBeUndefined();
    expect(timeoutErr.isRetryable).toBe(true);

    // ── Sub-test D: Valid response shape (usage format) ──
    const validMock = createMockModel([{ object: { key: "value" } }]);

    const validResult = await (validMock as Function)({
      prompt: "test",
      model: {},
      schema: {},
    });

    expect(validResult.object).toEqual({ key: "value" });
    expect(typeof validResult.text).toBe("string");
    expect(validResult.usage.inputTokens).toBe(150);
    expect(validResult.usage.outputTokens).toBe(25);
    expect(validResult.usage.totalTokens).toBe(175);
    expect(validResult.finishReason).toBe("stop");

    // ── Sub-test E: Exhaustion error ──
    const exhaustMock = createMockModel([{ object: { done: true } }]);
    await (exhaustMock as Function)({ prompt: "first", model: {}, schema: {} });

    let exhaustCaught: unknown = null;
    try {
      await (exhaustMock as Function)({ prompt: "second", model: {}, schema: {} });
    } catch (err) {
      exhaustCaught = err;
    }

    expect(exhaustCaught).not.toBeNull();
    expect(exhaustCaught instanceof Error).toBe(true);
    expect((exhaustCaught as Error).message).toContain("exhausted");
    expect((exhaustCaught as Error).message).toContain("no more responses");
  });

  // ── TEST-8: Network Delay Simulation ────────────────────────────

  test("network delay: 500ms latency simulated without breaking pipeline", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = createMockModel([
      { delay: 500, object: { schema_version: "0.1.0", status: "success", summary: "Delayed response.", changes: [] } },
    ]);

    const startTime = Date.now();

    const result = await runLoop({
      task: "Delay test",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mock,
      _roleDef: DEVELOPER_DEF,
    });

    const elapsed = Date.now() - startTime;

    // ── Assert: pipeline still succeeds ──
    expect(result.success).toBe(true);

    // ── Assert: the delay was actually applied (≥ 500ms) ──
    expect(elapsed).toBeGreaterThanOrEqual(500);

    // ── Assert: 1 event logged ──
    const events = await readSessionEvents(result.sessionDir);
    expect(events.length).toBe(1);
    expect(events[0]!.action).toBe("llm_call_success");
  });

  // ── TEST-9: API Error Exhaustion ─────────────────────────────────

  test("3 consecutive API errors → halt, no artifact, 3 failed events", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = createMockModel([
      { apiError: 429 },
      { apiError: 503 },
      { apiError: 429 },
    ]);

    const result = await runLoop({
      task: "API exhaustion task",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mock,
      _roleDef: DEVELOPER_DEF,
    });

    // ── Assert: failure reported ──
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("API error after 3 retries");

    // ── Assert: no artifact ──
    expect(result.artifactPath).toBeUndefined();

    // ── Assert: 3 failure events ──
    const events = await readSessionEvents(result.sessionDir);
    expect(events.length).toBe(3);
    for (const event of events) {
      expect(event.action).toBe("llm_call_failed");
    }
  });

  // ── TEST-10: Mixed Error Scenario ──────────────────────────────

  test("mixed errors: schema failure, then API error, then success", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = createMockModel([
      { schemaError: "changes.0.file_path: expected string, received number" },
      { apiError: 429 },
      { object: { schema_version: "0.1.0", status: "success", summary: "Survived mixed errors.", changes: [] } },
    ]);

    const result = await runLoop({
      task: "Mixed error task",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mock,
      _roleDef: DEVELOPER_DEF,
    });

    // ── Assert: success after mixed error recovery ──
    expect(result.success).toBe(true);

    // ── Assert: 3 events (2 failures + 1 success) ──
    const events = await readSessionEvents(result.sessionDir);
    expect(events.length).toBe(3);
    expect(events[0]!.action).toBe("llm_call_failed");
    expect(events[1]!.action).toBe("llm_call_failed");
    expect(events[2]!.action).toBe("llm_call_success");

    // ── Assert: artifact written ──
    const artifactRaw = await readFile(result.artifactPath!, "utf-8");
    const artifact = JSON.parse(artifactRaw);
    expect(artifact.result.summary).toBe("Survived mixed errors.");
  });

  // ── TEST-11: Unknown/Non-Retryable Error Propagation ───────────

  test("non-retryable error through runLoop: fails immediately with 1 event", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    // Mock exhaustion is a non-retryable error (plain Error, not APICallError/TypeValidationError)
    const mock = createMockModel([]); // 0 responses → exhaustion on first call

    const result = await runLoop({
      task: "Non-retryable error task",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mock,
      _roleDef: DEVELOPER_DEF,
    });

    // ── Assert: failure reported ──
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("exhausted");

    // ── Assert: no artifact ──
    expect(result.artifactPath).toBeUndefined();

    // ── Assert: exactly 1 event (no retries for unknown errors) ──
    const events = await readSessionEvents(result.sessionDir);
    expect(events.length).toBe(1);
    expect(events[0]!.action).toBe("llm_call_failed");
  });

  // ── TEST-12: Multiple API Retries → Success ────────────────────

  test("2 API errors then success: backoff applied, 3 events", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = createMockModel([
      { apiError: 503 },
      { apiError: 429 },
      { object: { schema_version: "0.1.0", status: "success", summary: "Recovered after 2 API errors.", changes: [] } },
    ]);

    const startTime = Date.now();

    const result = await runLoop({
      task: "Double API retry task",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mock,
      _roleDef: DEVELOPER_DEF,
    });

    const elapsed = Date.now() - startTime;

    // ── Assert: success ──
    expect(result.success).toBe(true);

    // ── Assert: backoff delay was applied (≥ 1000ms + 2000ms = 3000ms) ──
    expect(elapsed).toBeGreaterThanOrEqual(3000);

    // ── Assert: 3 events (2 failures + 1 success) ──
    const events = await readSessionEvents(result.sessionDir);
    expect(events.length).toBe(3);
    expect(events[0]!.action).toBe("llm_call_failed");
    expect(events[1]!.action).toBe("llm_call_failed");
    expect(events[2]!.action).toBe("llm_call_success");
  });

  // ═══════════════════════════════════════════════════════════════════
  // Edge Case Tests (Story 006B — coverage gap fill)
  // ═══════════════════════════════════════════════════════════════════

  // ── TEST-13: API Error with Delay → Success ─────────────────────

  test("API error with delay: 429 + 200ms delay, then success", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = createMockModel([
      { apiError: 429, delay: 200 },
      { object: { schema_version: "0.1.0", status: "success", summary: "Delayed retry success.", changes: [] } },
    ]);

    const startTime = Date.now();

    const result = await runLoop({
      task: "Delayed API retry task",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mock,
      _roleDef: DEVELOPER_DEF,
    });

    const elapsed = Date.now() - startTime;

    // ── Assert: success after retry ──
    expect(result.success).toBe(true);

    // ── Assert: total time includes delay (200ms) + backoff (≥1000ms) ──
    expect(elapsed).toBeGreaterThanOrEqual(1200);

    // ── Assert: 2 events ──
    const events = await readSessionEvents(result.sessionDir);
    expect(events.length).toBe(2);
    expect(events[0]!.action).toBe("llm_call_failed");
    expect(events[1]!.action).toBe("llm_call_success");
  });

  // ── TEST-14: Zero Delay Explicit ────────────────────────────────

  test("zero delay: explicit 0ms delay does not affect pipeline", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = createMockModel([
      { delay: 0, object: { schema_version: "0.1.0", status: "success", summary: "Zero delay.", changes: [] } },
    ]);

    const result = await runLoop({
      task: "Zero delay task",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mock,
      _roleDef: DEVELOPER_DEF,
    });

    // ── Assert: success ──
    expect(result.success).toBe(true);

    // ── Assert: 1 event logged ──
    const events = await readSessionEvents(result.sessionDir);
    expect(events.length).toBe(1);
    expect(events[0]!.action).toBe("llm_call_success");
  });

  // ── TEST-15: No Object Specified (Uses Default) ─────────────────

  test("no object specified: mock uses default handoff response", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    // No `object` field — factory uses DEFAULT_OBJECT
    const mock = createMockModel([{}]);

    const result = await runLoop({
      task: "Default object task",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mock,
      _roleDef: DEVELOPER_DEF,
    });

    // ── Assert: success ──
    expect(result.success).toBe(true);

    // ── Assert: artifact written with default object ──
    const artifactRaw = await readFile(result.artifactPath!, "utf-8");
    const artifact = JSON.parse(artifactRaw);
    expect(artifact.schema_version).toBe("0.2.0");
    expect(artifact.provenance).toBeDefined();
    expect(artifact.result.status).toBe("success");
    expect(artifact.result.summary).toBe("Task completed successfully.");

    // ── Assert: 1 event ──
    const events = await readSessionEvents(result.sessionDir);
    expect(events.length).toBe(1);
    expect(events[0]!.action).toBe("llm_call_success");
  });

  // ── TEST-16: Sequential Sessions Isolation ──────────────────────

  test("sequential sessions: two independent runLoop calls have separate artifacts", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock1 = createMockModel([
      { object: { schema_version: "0.1.0", status: "success", summary: "First call.", changes: [] } },
    ]);
    const mock2 = createMockModel([
      { object: { schema_version: "0.1.0", status: "success", summary: "Second call.", changes: [] } },
    ]);

    // ── Call 1 ──
    const result1 = await runLoop({
      task: "First task",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mock1,
    });

    expect(result1.success).toBe(true);

    // ── Call 2 (same projectDir, different session) ──
    const result2 = await runLoop({
      task: "Second task",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mock2,
    });

    expect(result2.success).toBe(true);

    // ── Assert: different session directories ──
    expect(result1.sessionDir).not.toBe(result2.sessionDir);

    // ── Assert: both artifacts exist and are independent ──
    const artifact1 = JSON.parse(await readFile(result1.artifactPath!, "utf-8"));
    const artifact2 = JSON.parse(await readFile(result2.artifactPath!, "utf-8"));
    expect(artifact1.result.summary).toBe("First call.");
    expect(artifact2.result.summary).toBe("Second call.");

    // ── Assert: each session has its own events ──
    const events1 = await readSessionEvents(result1.sessionDir);
    const events2 = await readSessionEvents(result2.sessionDir);
    expect(events1.length).toBe(1);
    expect(events2.length).toBe(1);
    expect(events1[0]!.action).toBe("llm_call_success");
    expect(events2[0]!.action).toBe("llm_call_success");
  });

});
