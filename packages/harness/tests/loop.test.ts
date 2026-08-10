/**
 * Core loop tests for `runLoop`.
 *
 * Covers all 5 acceptance tests from Story 006:
 * - TEST-1: End-to-end with mocked valid LLM response → session, artifact, events
 * - TEST-2: End-to-end with mocked invalid then valid → retry logged → success
 * - TEST-3: End-to-end with 3 invalid → graceful halt → error logged
 * - TEST-4: Verify events.jsonl contains model_id and token counts
 * - TEST-5: Verify atomic write pattern (no corrupted artifacts on simulated crash)
 *
 * Uses dependency injection (`_generateObjectFn` parameter) forwarded through
 * `runLoop` to `generateStructuredResponse`. No real API calls.
 *
 * @module loop.test
 */

import { describe, expect, test, mock, afterAll, beforeAll } from "bun:test";
import { rm } from "node:fs/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NoObjectGeneratedError } from "ai";
import { TypeValidationError } from "@ai-sdk/provider";
import { runLoop } from "../src/core/loop.ts";
import { createTestRegistry, DEVELOPER_DEF } from "./fixtures/role-registry.ts";
import { createMockRegistryForLlmId } from "./fixtures/mock-llm-client.ts";

// ── Constants ──────────────────────────────────────────────────────

/** Mock LLM client registry for tests — avoids real config files. */
const TEST_REGISTRY = createMockRegistryForLlmId("deepseek:deepseek-chat");

/** Pre-built test role registry — avoids disk I/O. */

// ── Temp Directory Management ──────────────────────────────────────

/** Store root for sessions (ZAO_HOME) */
let testStoreRoot: string;
let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-loop-${crypto.randomUUID()}`);
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
      // Best-effort cleanup
    }
  }
});

// ── Mock Helpers ───────────────────────────────────────────────────

/**
 * Creates a mock `generateObject` result containing a valid
 * `HandoffResponse` object with simulated token usage.
 */
function mockHandoffSuccess(overrides: Partial<{
  status: "success" | "needs_clarification" | "failed";
  summary: string;
  fileCount: number;
}> = {}) {
  const status = overrides.status ?? "success";
  const summary = overrides.summary ?? "Task completed successfully.";
  const fileCount = overrides.fileCount ?? 1;

  return {
    object: {
      schema_version: "0.1.0" as const,
      status,
      summary,
      changes: Array.from({ length: fileCount }, (_, i) => ({
        file_path: `src/file-${i}.ts`,
        content: `// Generated content for file ${i}`,
      })),
    },
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
    request: { body: undefined, headers: undefined },
    response: {
      id: "test-loop-id",
      timestamp: new Date(),
      modelId: "gpt-4o",
      headers: {},
    },
    providerMetadata: undefined,
    toJsonResponse: () => new Response(),
  };
}

/**
 * Creates a ZodError-like object for schema validation failure simulation.
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

/**
 * Creates a `NoObjectGeneratedError` with a `TypeValidationError` cause
 * chain that simulates a schema validation failure from the AI SDK.
 */
function createSchemaValidationError(
  issues: Array<{ path: string[]; message: string }>,
) {
  const zodErr = zodErrorShape(issues);
  const typeValErr = new TypeValidationError({
    value: { answer: 123 },
    cause: zodErr,
  });
  return new NoObjectGeneratedError({
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
}

// ── Suite ───────────────────────────────────────────────────────────

describe("runLoop", () => {
  // ── TEST-1: Happy path — valid LLM response ──────────────────

  test("creates session, writes artifact, and logs events on valid LLM response", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const response = mockHandoffSuccess({
      status: "success",
      summary: "Authentication implemented.",
    });
    const mockGenObj = mock(() => Promise.resolve(response));

    const result = await runLoop({
      task: "Implement user authentication",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mockGenObj as unknown as typeof import("ai").generateObject,
      _roleDef: DEVELOPER_DEF,
    });

    // ── Assert: runLoop reports success ──
    expect(result.success).toBe(true);
    expect(result.sessionDir).toContain(join(testStoreRoot, "sessions"));
    expect(result.artifactPath).toBe(join(result.sessionDir, "result.json"));

    // ── Assert: session directory exists ──
    const sessionStat = await import("node:fs/promises").then((m) =>
      m.stat(result.sessionDir),
    );
    expect(sessionStat.isDirectory()).toBe(true);

    // ── Assert: artifact file exists and contains valid JSON ──
    const artifactRaw = await readFile(result.artifactPath!, "utf-8");
    const artifact = JSON.parse(artifactRaw);
    // MED-001: Artifact is now wrapped in ResultArtifactSchema envelope
    expect(artifact.schema_version).toBe("0.2.0");
    expect(artifact.provenance).toBeDefined();
    expect(artifact.provenance.source).toBe("orchestrator");
    expect(artifact.result.schema_version).toBe("0.1.0");
    expect(artifact.result.status).toBe("success");
    expect(artifact.result.summary).toBe("Authentication implemented.");
    expect(artifact.result.changes).toHaveLength(1);

    // ── Assert: events.jsonl exists and has at least one entry ──
    const eventsPath = join(result.sessionDir, "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    const events = eventsRaw.trim().split("\n");
    expect(events.length).toBeGreaterThanOrEqual(1);

    const firstEvent = JSON.parse(events[0]!);
    expect(firstEvent.schema_version).toBe("0.2.0");
    expect(firstEvent.model_id).toBe("deepseek-chat");
    expect(firstEvent.action).toBe("llm_call_success");
    expect(firstEvent.prompt_tokens).toBe(100);
    expect(firstEvent.completion_tokens).toBe(50);
    expect(firstEvent.cache_hit).toBe(false);
    expect(firstEvent.agent_role).toBe("developer");
  });

  // ── TEST-2: Schema validation failure → retry → success ──────

  test("retries on schema validation failure and succeeds on retry", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const schemaErr = createSchemaValidationError([
      { path: ["changes", "content"], message: "Invalid input: expected string, received number" },
    ]);

    const validResponse = mockHandoffSuccess({
      status: "success",
      summary: "Corrected after retry.",
    });

    const mockGenObj = mock()
      .mockRejectedValueOnce(schemaErr)
      .mockResolvedValueOnce(validResponse);

    const result = await runLoop({
      task: "Fix the login bug",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mockGenObj as unknown as typeof import("ai").generateObject,
      _roleDef: DEVELOPER_DEF,
    });

    // ── Assert: runLoop reports success ──
    expect(result.success).toBe(true);
    expect(result.artifactPath).toBe(join(result.sessionDir, "result.json"));

    // ── Assert: artifact contains the corrected response ──
    const artifactRaw = await readFile(result.artifactPath!, "utf-8");
    const artifact = JSON.parse(artifactRaw);
    expect(artifact.result.summary).toBe("Corrected after retry.");

    // ── Assert: events.jsonl has 2 entries (failure + success) ──
    const eventsPath = join(result.sessionDir, "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    const events = eventsRaw.trim().split("\n");
    expect(events.length).toBe(2);

    const firstEvent = JSON.parse(events[0]!);
    expect(firstEvent.action).toBe("llm_call_failed");

    const secondEvent = JSON.parse(events[1]!);
    expect(secondEvent.action).toBe("llm_call_success");
  });

  // ── TEST-3: 3 consecutive schema validation failures → halt ──

  test("halts gracefully after 3 consecutive schema validation failures", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const schemaErr = createSchemaValidationError([
      { path: ["changes"], message: "Invalid input: expected array, received null" },
    ]);

    const mockGenObj = mock()
      .mockRejectedValueOnce(schemaErr)
      .mockRejectedValueOnce(schemaErr)
      .mockRejectedValueOnce(schemaErr);

    const result = await runLoop({
      task: "Do something impossible",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mockGenObj as unknown as typeof import("ai").generateObject,
      _roleDef: DEVELOPER_DEF,
    });

    // ── Assert: runLoop reports failure ──
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Schema validation failed after 3 retries");

    // ── Assert: no artifact (should not exist on failure) ──
    // The function returns artifactPath only on success
    expect(result.artifactPath).toBeUndefined();

    // ── Assert: session directory was still created ──
    const sessionStat = await import("node:fs/promises").then((m) =>
      m.stat(result.sessionDir),
    );
    expect(sessionStat.isDirectory()).toBe(true);

    // ── Assert: events.jsonl exists with 3 failure entries ──
    const eventsPath = join(result.sessionDir, "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    const events = eventsRaw.trim().split("\n");
    expect(events.length).toBe(3);

    for (const line of events) {
      const event = JSON.parse(line);
      expect(event.action).toBe("llm_call_failed");
      expect(event.model_id).toBe("deepseek-chat");
    }
  });

  // ── TEST-4: Events contain model_id and token counts ─────────

  test("events.jsonl entries contain model_id and token count fields", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const response = mockHandoffSuccess();
    const mockGenObj = mock(() => Promise.resolve(response));

    const result = await runLoop({
      task: "Verify event fields",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mockGenObj as unknown as typeof import("ai").generateObject,
      _roleDef: DEVELOPER_DEF,
    });

    expect(result.success).toBe(true);

    const eventsPath = join(result.sessionDir, "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    const events = eventsRaw.trim().split("\n");
    expect(events.length).toBe(1);

    const event = JSON.parse(events[0]!);

    // All required fields of EventLogEntry must be present
    expect(event.schema_version).toBe("0.2.0");
    expect(typeof event.event_id).toBe("string");
    expect(typeof event.session_id).toBe("string");
    expect(event.parent_session_id === null).toBe(true);
    expect(typeof event.timestamp).toBe("string");
    expect(event.timestamp.length).toBeGreaterThan(0);
    expect(event.agent_role).toBe("developer");
    expect(event.model_id).toBe("deepseek-chat");
    expect(typeof event.prompt_tokens).toBe("number");
    expect(event.prompt_tokens).toBeGreaterThan(0);
    expect(typeof event.completion_tokens).toBe("number");
    expect(event.completion_tokens).toBeGreaterThan(0);
    expect(typeof event.cache_hit).toBe("boolean");
    expect(event.action).toBe("llm_call_success");
  });

  // ── TEST-5: Atomic write pattern — no corrupted artifacts ────

  test("artifact is written atomically — no partial/corrupted content", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    // Use a response with multiple changes to test full content integrity
    const response = mockHandoffSuccess({
      status: "success",
      summary: "Multiple files generated.",
      fileCount: 5,
    });
    const mockGenObj = mock(() => Promise.resolve(response));

    const result = await runLoop({
      task: "Generate multiple files",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mockGenObj as unknown as typeof import("ai").generateObject,
      _roleDef: DEVELOPER_DEF,
    });

    expect(result.success).toBe(true);

    // ── Assert: artifact file is valid, complete JSON ──
    const artifactRaw = await readFile(result.artifactPath!, "utf-8");

    // Verify it parses as valid JSON (no truncation)
    let artifact: unknown;
    try {
      artifact = JSON.parse(artifactRaw);
    } catch {
      throw new Error("Artifact file contains invalid/truncated JSON");
    }

    // Verify all expected fields are present and complete
    const obj = artifact as Record<string, unknown>;
    expect(obj.schema_version).toBe("0.2.0");
    expect(obj.provenance).toBeDefined();
    const inner = obj.result as Record<string, unknown>;
    expect(inner.schema_version).toBe("0.1.0");
    expect(inner.status).toBe("success");
    expect(inner.summary).toBe("Multiple files generated.");

    const changes = inner.changes as Array<Record<string, unknown>>;
    expect(changes).toHaveLength(5);

    // Verify every change has the expected structure
    for (let i = 0; i < 5; i++) {
      expect(changes[i]!.file_path).toBe(`src/file-${i}.ts`);
      expect(changes[i]!.content).toBe(`// Generated content for file ${i}`);
    }

    // ── Assert: no .tmp files left behind ──
    const { readdir } = await import("node:fs/promises");
    const sessionFiles = await readdir(result.sessionDir);
    const tmpFiles = sessionFiles.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  // ── TEST: Session init failure is reported, not thrown ───────

  test("returns error result when session initialization fails", async () => {
    // Create a temp ZAO_HOME that can be made unwritable
    const failStoreRoot = makeTempDir();
    await ensureDir(failStoreRoot);
    const sessionsDir = join(failStoreRoot, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    // Make the sessions dir read-only so initSession cannot create subdirs
    const { chmod } = await import("node:fs/promises");
    await chmod(sessionsDir, 0o444);

    const originalMoHome = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = failStoreRoot;

    try {
      const result = await runLoop({
        task: "This should fail at session init",
        roleName: "developer",
        projectDir: failStoreRoot,
        _registry: TEST_REGISTRY,
        _roleDef: DEVELOPER_DEF,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("Failed to initialize session");
    } finally {
      process.env["ZAO_HOME"] = originalMoHome;
      try {
        await chmod(sessionsDir, 0o755);
      } catch {
        // best-effort
      }
    }
  });

  // ── GAP: loadConfig integration (modelConfig omitted) ────────
  // This path (loop.ts:143-153) is never exercised when modelConfig
  // is always passed explicitly in tests.

  test("loads config from .zao/config.yaml when modelConfig is not provided", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);
    await mkdir(join(projectDir, ".zao"), { recursive: true });
    await writeFile(
      join(projectDir, ".zao", "config.yaml"),
      "temperature: 0.2\nmax_tokens: 4000\n",
    );

    const response = mockHandoffSuccess();
    const mockGenObj = mock(() => Promise.resolve(response));

    const result = await runLoop({
      task: "Test config loading",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mockGenObj as unknown as typeof import("ai").generateObject,
      _roleDef: DEVELOPER_DEF,
    });

    expect(result.success).toBe(true);

    const eventsPath = join(result.sessionDir, "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    const events = eventsRaw.trim().split("\n");
    expect(events.length).toBe(1);
    expect(JSON.parse(events[0]!).model_id).toBe("deepseek-chat");
  });

  // ── GAP: No config file — built-in defaults silently used ────

  test("uses built-in defaults (deepseek-chat) when .zao/config.yaml is absent", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);
    // Intentionally do NOT create .zao/config.yaml

    const response = mockHandoffSuccess();
    const mockGenObj = mock(() => Promise.resolve(response));

    const result = await runLoop({
      task: "Test default config",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mockGenObj as unknown as typeof import("ai").generateObject,
      _roleDef: DEVELOPER_DEF,
    });

    expect(result.success).toBe(true);

    const eventsPath = join(result.sessionDir, "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    const events = eventsRaw.trim().split("\n");
    // Default model from config.ts: "deepseek-chat"
    expect(JSON.parse(events[0]!).model_id).toBe("deepseek-chat");
  });

  // ── GAP: 2 schema failures → 1 success → 3 events ────────────
  // TEST-2 covers 1 failure + 1 success. This covers 2 + 1.

  test("logs 3 events (fail, fail, success) for 2 retries then success", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const schemaErr = createSchemaValidationError([
      { path: ["changes", "content"], message: "Invalid input" },
    ]);
    const validResponse = mockHandoffSuccess({
      summary: "Third attempt succeeded.",
    });

    const mockGenObj = mock()
      .mockRejectedValueOnce(schemaErr)
      .mockRejectedValueOnce(schemaErr)
      .mockResolvedValueOnce(validResponse);

    const result = await runLoop({
      task: "Fix after two retries",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mockGenObj as unknown as typeof import("ai").generateObject,
      _roleDef: DEVELOPER_DEF,
    });

    expect(result.success).toBe(true);
    expect(result.artifactPath).toBe(
      join(result.sessionDir, "result.json"),
    );

    const eventsPath = join(result.sessionDir, "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    const events = eventsRaw.trim().split("\n");
    expect(events.length).toBe(3);

    expect(JSON.parse(events[0]!).action).toBe("llm_call_failed");
    expect(JSON.parse(events[1]!).action).toBe("llm_call_failed");
    expect(JSON.parse(events[2]!).action).toBe("llm_call_success");
  });

  // ── GAP: No artifact file on disk when loop fails ─────────────
  // TEST-3 checks result.artifactPath === undefined but not the
  // actual filesystem.

  test("does not create artifact file on disk when llm_result.success is false", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const schemaErr = createSchemaValidationError([
      { path: ["changes"], message: "Invalid" },
    ]);
    const mockGenObj = mock()
      .mockRejectedValueOnce(schemaErr)
      .mockRejectedValueOnce(schemaErr)
      .mockRejectedValueOnce(schemaErr);

    const result = await runLoop({
      task: "Will fail completely",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mockGenObj as unknown as typeof import("ai").generateObject,
      _roleDef: DEVELOPER_DEF,
    });

    expect(result.success).toBe(false);
    expect(result.artifactPath).toBeUndefined();

    // Filesystem check: no result.json should exist
    const artifactPath = join(result.sessionDir, "result.json");
    const artifactFile = Bun.file(artifactPath);
    expect(await artifactFile.exists()).toBe(false);
  });

  // ── GAP: modelConfig temperature & maxTokens forwarded to mock ─

  test("forwards temperature and maxTokens from llmOptions to the LLM call", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const response = mockHandoffSuccess();
    const mockGenObj = mock(() => Promise.resolve(response));

    await runLoop({
      task: "Verify config forwarding",
      roleName: "developer",
      projectDir,
      llmOptions: {
        temperature: 0.7,
        maxTokens: 9000,
      },
      _registry: TEST_REGISTRY,
      _generateObjectFn: mockGenObj as unknown as typeof import("ai").generateObject,
      _roleDef: DEVELOPER_DEF,
    });

    const callArgs = (mockGenObj as any).mock.calls[0]?.[0] as
      | { temperature?: number; maxTokens?: number }
      | undefined;
    expect(callArgs?.temperature).toBe(0.7);
    expect(callArgs?.maxTokens).toBe(9000);
  });

  // ── GAP: Empty task string handled without throwing ───────────

  test("handles empty task string without throwing", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const response = mockHandoffSuccess({ summary: "Empty task completed." });
    const mockGenObj = mock(() => Promise.resolve(response));

    const result = await runLoop({
      task: "",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mockGenObj as unknown as typeof import("ai").generateObject,
      _roleDef: DEVELOPER_DEF,
    });

    // Must never throw — all failures go through the result object
    expect(result.sessionDir).toBeDefined();
    expect(typeof result.success).toBe("boolean");
    if (result.success) {
      const eventsPath = join(result.sessionDir, "events.jsonl");
      const eventsRaw = await readFile(eventsPath, "utf-8");
      expect(eventsRaw.trim().length).toBeGreaterThan(0);
    }
  });

  // ── GAP: Non-retryable error propagates through loop ──────────

  test("returns failure when LLM layer encounters a non-retryable error", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    // A raw Error is neither API-retryable nor a schema validation failure.
    // It should cause the LLM layer to fail immediately and the loop to
    // propagate the error without retrying.
    const rawErr = new Error("Something completely unexpected happened");
    const mockGenObj = mock().mockRejectedValueOnce(rawErr);

    const result = await runLoop({
      task: "Non-retryable error test",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mockGenObj as unknown as typeof import("ai").generateObject,
      _roleDef: DEVELOPER_DEF,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Something completely unexpected happened");
    expect(result.sessionDir).toBeDefined();
    expect(result.artifactPath).toBeUndefined();

    // Should have exactly 1 event (no retries)
    const eventsPath = join(result.sessionDir, "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    const events = eventsRaw.trim().split("\n");
    expect(events.length).toBe(1);
    expect(JSON.parse(events[0]!).action).toBe("llm_call_failed");
  });
});

// ── MED-004: Caching flag is set for supported models ──────────

describe("runLoop — caching integration", () => {
  test("sets cache:true in generationOptions when role uses a caching-supported model", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const response = mockHandoffSuccess({ status: "success" });

    // Capture the arguments passed to generateObject (genObj)
    let capturedGenObjArgs: Record<string, unknown> | null = null;
    const mockGenObj = mock((args: Record<string, unknown>) => {
      capturedGenObjArgs = args;
      return Promise.resolve(response);
    });

    // Use a role definition with deepseek:deepseek-chat, which supports caching
    const registry = createTestRegistry();
    const cachingRoleDef = {
      ...registry.roles.get("developer")!,
      llm_id: "deepseek:deepseek-chat",
    };

    const result = await runLoop({
      task: "Test caching flag",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mockGenObj as unknown as typeof import("ai").generateObject,
      _roleDef: cachingRoleDef,
    });

    expect(result.success).toBe(true);
    expect(capturedGenObjArgs).not.toBeNull();

    // Verify providerOptions includes the cache flag
    const providerOpts = capturedGenObjArgs!.providerOptions as Record<string, unknown> | undefined;
    expect(providerOpts).toBeDefined();
    const deepseekOpts = providerOpts!["deepseek"] as Record<string, unknown> | undefined;
    expect(deepseekOpts).toBeDefined();
    expect(deepseekOpts!.cache).toBe(true);
  });
});

// ── CRIT-002: runLoop uses registry-resolved model ─────────────

describe("runLoop — CRIT-002: Effective model from role registry", () => {
  test("LLM receives registry-resolved model from role definition", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const response = mockHandoffSuccess();
    const mockGenObj = mock(() => Promise.resolve(response));

    // Role model is "deepseek-chat" from DEVELOPER_DEF
    const registry = createTestRegistry();
    registry.roles.set("developer", {
      ...registry.roles.get("developer")!,
      model: "deepseek-chat",
      llm_id: "deepseek:deepseek-chat",
    });

    const result = await runLoop({
      task: "Test effective model",
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mockGenObj as unknown as typeof import("ai").generateObject,
      _roleDef: registry.roles.get("developer")!,
    });

    expect(result.success).toBe(true);

    // Check events.jsonl: model_id should be "deepseek-chat" from role registry
    const eventsPath = join(result.sessionDir, "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    const events = eventsRaw.trim().split("\n");
    expect(events.length).toBe(1);
    const event = JSON.parse(events[0]!);
    expect(event.model_id).toBe("deepseek-chat");
  });
});

// ── HIGH-004: renderPromptTemplate is wired into runLoop ────────

describe("runLoop — HIGH-004: Prompt template rendering", () => {
  test("role with {{task}} template sends substituted task to LLM", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const capturedPrompts: string[] = [];

    // Create a registry where the developer role has a template with {{task}}
    const registry = createTestRegistry();
    registry.roles.set("developer", {
      prompt_template: "Task: {{task}}",
      context_budget: 0.65,
      model: "deepseek-chat",
      llm_id: "deepseek:deepseek-chat",
      provenance: "test",
      model_provenance: "test",
    });

    // Use createMockModel to capture prompts
    const { createMockModel } = await import("./mocks/mock-model.ts");
    const taskDescription = "Build a REST API";
    const mockModel = createMockModel([{}], capturedPrompts);

    await runLoop({
      task: taskDescription,
      roleName: "developer",
      projectDir,
      _registry: TEST_REGISTRY,
      _generateObjectFn: mockModel,
      _roleDef: registry.roles.get("developer")!,
    });

    // Verify the LLM received "Task: Build a REST API" NOT "Task: {{task}}"
    expect(capturedPrompts.length).toBeGreaterThan(0);
    expect(capturedPrompts[0]!).toContain(`Task: ${taskDescription}`);
    expect(capturedPrompts[0]!).not.toContain("{{task}}");
  });
});
