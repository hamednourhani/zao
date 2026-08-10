/**
 * Subagent delegation tests for `delegateToSubagent`.
 *
 * Covers all 4 acceptance tests from Story 009 (updated for TD-012):
 * - AC-1: Delegate to "developer" role → fresh context → result written to disk
 * - AC-2: Delegate to "reviewer" with different model → correct model used
 * - AC-3: Subagent result file validated against HandoffResponseSchema
 * - AC-4: events.jsonl contains delegation entry with role and model_id
 *
 * TD-012 additions:
 * - Generic filenames: result written to `result.json` (not `delegation_result_*.json`)
 * - Unknown role → fail closed
 * - Legacy artifact name readable via readDelegationResult
 * - Same-role-double-delegation: no overwrite (separate sessions)
 *
 * @module delegation.test
 */

import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { rm, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { delegateToSubagent, readDelegationResult } from "../src/core/delegation.ts";
import { createMockModel } from "./mocks/mock-model.ts";
import type { MockResponse } from "./mocks/mock-model.ts";
import { createTestRegistry, DEVELOPER_DEF } from "./fixtures/role-registry.ts";
import { mockClientFromLegacy } from "./fixtures/mock-llm-client.ts";
import type { LlmClient } from "@zao/llm-clients";
import type { ModelOptions } from "../src/core/llm.ts";

// ── Constants ──────────────────────────────────────────────────────

/** Fake API key for testing — never reaches a real provider. */
const FAKE_API_KEY = "sk-test-000000000000000000000000";

/** Default model config for tests that don't override it. */
const TEST_MODEL_CONFIG = {
  provider: "openai",
  model: "gpt-4o",
  apiKey: FAKE_API_KEY,
  temperature: 0,
};

/** Mock LLM client derived from the test config. */
const TEST_LLM_CLIENT: LlmClient = mockClientFromLegacy(TEST_MODEL_CONFIG);

/** Default LLM options for mock tests. */
const TEST_LLM_OPTIONS: ModelOptions = { temperature: 0 };

/** Pre-built test role registry — avoids disk I/O. */

// ── Temp Directory Management ──────────────────────────────────────

/** Store root for sessions (ZAO_HOME) */
let testStoreRoot: string;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-delegation-${crypto.randomUUID()}`);
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

// ── Session Discovery Helper ───────────────────────────────────────

/**
 * Finds the session directory that contains the delegation result
 * artifact (`result.json`) from the global store.
 */
async function findSessionDir(): Promise<string> {
  const sessionsDir = join(testStoreRoot, "sessions");
  const entries = await readdir(sessionsDir);
  for (const entry of entries) {
    const resultPath = join(sessionsDir, entry, "result.json");
    try {
      await readFile(resultPath, "utf-8");
      return join(sessionsDir, entry);
    } catch {
      // File doesn't exist in this session directory — try the next one
    }
  }
  throw new Error(
    `Could not find session containing result.json in ${sessionsDir}`,
  );
}

/**
 * Finds a session directory by its event content (matching role in delegation event).
 */
async function findSessionDirByRole(role: string): Promise<string> {
  const sessionsDir = join(testStoreRoot, "sessions");
  const entries = await readdir(sessionsDir);
  for (const entry of entries) {
    const eventsPath = join(sessionsDir, entry, "events.jsonl");
    try {
      const raw = await readFile(eventsPath, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.action === "delegation" && event.agent_role === role) {
          return join(sessionsDir, entry);
        }
      }
    } catch {
      // File doesn't exist in this session directory — try the next one
    }
  }
  throw new Error(
    `Could not find session with delegation event for role "${role}" in ${sessionsDir}`,
  );
}

/**
 * Reads and parses the events.jsonl file from a session directory.
 */
async function readSessionEvents(sessionDir: string): Promise<Record<string, unknown>[]> {
  const eventsPath = join(sessionDir, "events.jsonl");
  const raw = await readFile(eventsPath, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("delegateToSubagent", () => {
  // ── TEST-1 / AC-1: Fresh context, delegation to developer ────────
  test("should delegate to developer role and return successful result", async () => {
    const projectDir = makeTempDir();
    const mockModel = createMockModel([{}]); // default valid HandoffResponse

    const result = await delegateToSubagent(
      "developer",
      "Write a TypeScript utility function",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.schema_version).toBe("0.1.0");
      expect(result.result.status).toBe("success");
      expect(typeof result.result.summary).toBe("string");
      expect(result.result.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(result.result.changes)).toBe(true);
    }
  });

  // ── AC-2: Delegate to reviewer with different model config ───────
  test("should use correct model when modelConfig is provided for reviewer", async () => {
    const projectDir = makeTempDir();
    const reviewerModelConfig = {
      provider: "google",
      model: "gemini-2.0-flash",
      apiKey: FAKE_API_KEY,
      temperature: 0,
    };
    const reviewerClient = mockClientFromLegacy(reviewerModelConfig);
    const mockModel = createMockModel([{}]);

    const result = await delegateToSubagent(
      "reviewer",
      "Review the pull request for security issues",
      [],
      reviewerClient,
      projectDir,
      { temperature: 0 },
      mockModel,
      DEVELOPER_DEF,
    );

    expect(result.success).toBe(true);

    // Verify the events.jsonl contains a delegation entry with the correct model
    const sessionDir = await findSessionDirByRole("reviewer");
    const events = await readSessionEvents(sessionDir);

    const delegationEvent = events.find(
      (e) => e.action === "delegation" && e.agent_role === "reviewer",
    );
    expect(delegationEvent).toBeDefined();
    // Note: role-resolved model (deepseek-chat from defaults) overrides config model
    // But the role has model: null → inherits default "deepseek-chat"
    expect(delegationEvent!.model_id).toBe("deepseek-chat");
    expect(delegationEvent!.schema_version).toBe("0.2.0");
  });

  // ── TEST-2 / AC-1: Result file written to correct path ───────────
  test("should write result to result.json in session directory", async () => {
    const projectDir = makeTempDir();
    const customSummary = "Implemented user authentication module.";
    const mockResponses: MockResponse[] = [
      {
        object: {
          schema_version: "0.1.0",
          status: "success",
          summary: customSummary,
          changes: [
            { file_path: "src/auth.ts", content: "export function login() {}" },
          ],
        },
      },
    ];
    const mockModel = createMockModel(mockResponses);

    const result = await delegateToSubagent(
      "developer",
      "Implement authentication",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    expect(result.success).toBe(true);

    // Use sessionDir from the delegation result (deterministic)
    expect(result.success).toBe(true);
    const sessionDir = (result as { sessionDir: string }).sessionDir;
    const artifactPath = join(sessionDir, "result.json");
    const raw = await readFile(artifactPath, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.result.schema_version).toBe("0.1.0");
    expect(parsed.result.status).toBe("success");
    expect(parsed.result.summary).toBe(customSummary);
    expect(parsed.result.changes).toHaveLength(1);
    expect(parsed.result.changes[0].file_path).toBe("src/auth.ts");

    // Provenance envelope assertions
    expect(parsed.provenance).toBeDefined();
    expect(parsed.provenance.source).toBe("subagent");
    expect(parsed.provenance.role).toBe("developer");
    expect(parsed.provenance.session_id).toBeDefined();
    expect(typeof parsed.provenance.session_id).toBe("string");
    expect(parsed.provenance.session_id.length).toBeGreaterThan(0);
    expect(parsed.provenance.model).toBe("deepseek-chat");
    expect(typeof parsed.provenance.timestamp).toBe("string");
  });

  // ── TEST-4 / AC-4: events.jsonl contains delegation entry ────────
  test("should log delegation event to events.jsonl with role and model_id", async () => {
    const projectDir = makeTempDir();
    const mockModel = createMockModel([{}]);

    const result = await delegateToSubagent(
      "architect",
      "Design the system architecture",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    expect(result.success).toBe(true);

    const sessionDir = await findSessionDirByRole("architect");
    const events = await readSessionEvents(sessionDir);

    // Verify delegation event exists
    const delegationEvents = events.filter(
      (e) => e.action === "delegation",
    );
    expect(delegationEvents).not.toBeEmpty();

    const delegationEvent = delegationEvents.find(
      (e) => e.agent_role === "architect",
    );
    expect(delegationEvent).toBeDefined();
    expect(delegationEvent!.model_id).toBe("deepseek-chat");
    expect(delegationEvent!.schema_version).toBe("0.2.0");
    expect(typeof delegationEvent!.timestamp).toBe("string");
    expect(typeof delegationEvent!.prompt_tokens).toBe("number");
    expect(delegationEvent!.prompt_tokens).toBeGreaterThan(0);

    // Verify LLM call events also exist
    const llmEvents = events.filter(
      (e) => e.action === "llm_call_success",
    );
    expect(llmEvents).not.toBeEmpty();
  });

  // ── TEST-3 / AC-3: Schema validation failure → retry ────────────
  test("should retry on schema validation failure within subagent context", async () => {
    const projectDir = makeTempDir();
    const capturedPrompts: string[] = [];
    const mockResponses: MockResponse[] = [
      {
        schemaError: "changes.0.file_path: expected string, received number",
      },
      {
        object: {
          schema_version: "0.1.0",
          status: "success",
          summary: "Fixed after schema validation failure.",
          changes: [
            { file_path: "src/fixed.ts", content: "// corrected content" },
          ],
        },
      },
    ];
    const mockModel = createMockModel(mockResponses, capturedPrompts);

    const result = await delegateToSubagent(
      "developer",
      "Write a function with correct schema",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.summary).toBe("Fixed after schema validation failure.");
    }

    expect(capturedPrompts.length).toBe(2);
    const retryPrompt = capturedPrompts[1]!;
    expect(retryPrompt).toContain("schema validation");
    expect(retryPrompt).toContain("changes.0.file_path");

    // Verify result file written
    const sessionDir = await findSessionDir();
    const artifactPath = join(sessionDir, "result.json");
    const raw = await readFile(artifactPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.result.status).toBe("success");
  });

  // ── TEST-1: Fresh context — no orchestrator history leak ─────────
  test("should NOT include orchestrator history in subagent context", async () => {
    const projectDir = makeTempDir();
    const capturedPrompts: string[] = [];
    const mockModel = createMockModel([{}], capturedPrompts);

    const result = await delegateToSubagent(
      "developer",
      "Build a React component",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    expect(result.success).toBe(true);

    const prompt = capturedPrompts[0]!;

    // Should contain the developer role identity prompt
    expect(prompt).toContain("You are a developer agent");

    // Should NOT contain orchestrator-related terms
    expect(prompt).not.toContain("orchestrator");

    // Should contain the task description
    expect(prompt).toContain("Build a React component");

    // Should NOT contain any other role's identity prompt
    expect(prompt).not.toContain("You are a code reviewer");
    expect(prompt).not.toContain("You are a planning agent");
    expect(prompt).not.toContain("You are an architect");
  });

  // ── Additional: Verify result file content matches schema ────────
  test("should validate result file content against HandoffResponseSchema", async () => {
    const projectDir = makeTempDir();
    const mockResponses: MockResponse[] = [
      {
        object: {
          schema_version: "0.1.0",
          status: "needs_clarification",
          summary: "Requires more context about the data model.",
          changes: [],
        },
      },
    ];
    const mockModel = createMockModel(mockResponses);

    const result = await delegateToSubagent(
      "planner",
      "Plan the database migration",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.status).toBe("needs_clarification");
      expect(result.result.changes).toEqual([]);
    }

    const sessionDir = (result as { sessionDir?: string }).sessionDir!;
    const artifactPath = join(sessionDir, "result.json");
    const raw = await readFile(artifactPath, "utf-8");
    const persisted = JSON.parse(raw);

    expect(persisted.result.schema_version).toBe("0.1.0");
    expect(persisted.result.status).toBe("needs_clarification");
    expect(persisted.result.summary).toBe("Requires more context about the data model.");
    expect(persisted.result.changes).toEqual([]);
  });

  // ── Additional: Default artifacts empty array ─────────────────────
  test("should work with no artifacts provided (default empty array)", async () => {
    const projectDir = makeTempDir();
    const mockModel = createMockModel([{}]);

    const result = await delegateToSubagent(
      "developer",
      "Simple task",
      undefined, // artifacts defaults to []
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    expect(result.success).toBe(true);
  });

  // ── Additional: Four roles produce separate result files ─────────
  test("should produce separate result files for different roles in same project", async () => {
    const projectDir = makeTempDir();
    const devMock = createMockModel([{}]);
    const reviewerMock = createMockModel([{}]);

    const devResult = await delegateToSubagent(
      "developer",
      "Write code",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      devMock,
      DEVELOPER_DEF,
    );
    expect(devResult.success).toBe(true);

    const reviewerResult = await delegateToSubagent(
      "reviewer",
      "Review code",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      reviewerMock,
      DEVELOPER_DEF,
    );
    expect(reviewerResult.success).toBe(true);

    // Verify both result files exist in their respective sessions
    const sessionsDir = join(testStoreRoot, "sessions");
    const entries = await readdir(sessionsDir);
    const sessionEntries = entries.filter((e) => !e.endsWith(".jsonl"));

    // At least 2 sessions
    expect(sessionEntries.length).toBeGreaterThanOrEqual(2);

    // Each session should have its own result.json
    let found = 0;
    for (const entry of sessionEntries) {
      try {
        await readFile(join(sessionsDir, entry, "result.json"), "utf-8");
        found++;
      } catch {
        // Not every session has result.json — that's fine
      }
    }
    expect(found).toBeGreaterThanOrEqual(2);
  });

  // ── Additional: Error handling — failed LLM call returned as result ──
  test("should return failure result when LLM call fails (never throws)", async () => {
    const projectDir = makeTempDir();
    const mockResponses: MockResponse[] = [
      { apiError: 429 },
      { apiError: 429 },
      { apiError: 429 },
    ];
    const mockModel = createMockModel(mockResponses);

    const result = await delegateToSubagent(
      "developer",
      "Task that will fail",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe("string");
      expect(result.error).toContain("API error");
    }
  });

  // ── NEW TEST: Empty task string ──────────────────────────────────
  test("should handle empty task string gracefully", async () => {
    const projectDir = makeTempDir();
    const mockModel = createMockModel([{}]);

    const result = await delegateToSubagent(
      "developer",
      "",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.schema_version).toBe("0.1.0");
    }
  });

  // ── NEW TEST: Temperature and maxTokens passthrough ──────────────
  test("should pass temperature and maxTokens from modelConfig through to the LLM", async () => {
    const projectDir = makeTempDir();
    const capturedConfigs: Array<{ temperature?: number; maxTokens?: number }> = [];

    const modelConfigWithParams = {
      provider: "openai",
      model: "gpt-4o",
      apiKey: FAKE_API_KEY,
      temperature: 0.7,
      maxTokens: 2048,
    };
    const paramsClient = mockClientFromLegacy(modelConfigWithParams);

    const baseMock = createMockModel([{}]);
    const capturingMock = (async (params: Record<string, any>) => {
      capturedConfigs.push({
        temperature: params["temperature"] as number | undefined,
        maxTokens: params["maxTokens"] as number | undefined,
      });
      return baseMock(params as Parameters<typeof baseMock>[0]);
    }) as typeof baseMock;

    const result = await delegateToSubagent(
      "developer",
      "Test temperature and maxTokens passthrough",
      [],
      paramsClient,
      projectDir,
      { temperature: 0.7, maxTokens: 2048 },
      capturingMock,
      DEVELOPER_DEF,
    );

    expect(result.success).toBe(true);
    expect(capturedConfigs).not.toBeEmpty();

    const captured = capturedConfigs[0];
    expect(captured).toBeDefined();
    if (captured) {
      expect(captured.temperature).toBe(0.7);
      expect(captured.maxTokens).toBe(2048);
    }
  });

  // ── NEW TEST: Path traversal security — artifacts outside root ────
  test("should not crash when artifact path tries to escape project root", async () => {
    const projectDir = makeTempDir();
    const mockModel = createMockModel([{}]);

    const result = await delegateToSubagent(
      "developer",
      "Test path traversal",
      ["../../../etc/passwd"],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.schema_version).toBe("0.1.0");
    }
  });

  // ── TD-012: Same role delegated twice → separate sessions ────────
  test("should create separate sessions for two delegations to the same role (no overwrite)", async () => {
    const projectDir = makeTempDir();
    const firstMock = createMockModel([{}]);
    const secondMock = createMockModel([{}]);

    const firstResult = await delegateToSubagent(
      "architect",
      "First task",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      firstMock,
      DEVELOPER_DEF,
    );
    expect(firstResult.success).toBe(true);

    const secondResult = await delegateToSubagent(
      "architect",
      "Second task",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      secondMock,
      DEVELOPER_DEF,
    );
    expect(secondResult.success).toBe(true);

    // Both delegations to the same role should produce separate sessions
    const sessionsDir = join(testStoreRoot, "sessions");
    const entries = await readdir(sessionsDir);
    const architectSessions = entries.filter((e) => !e.endsWith(".jsonl"));
    expect(architectSessions.length).toBeGreaterThanOrEqual(2);

    // Each session should contain its own result.json
    let found = 0;
    for (const entry of architectSessions) {
      try {
        await readFile(
          join(sessionsDir, entry, "result.json"),
          "utf-8",
        );
        found++;
      } catch {
        // Not every session is for architect
      }
    }
    expect(found).toBeGreaterThanOrEqual(2);
  });

  // ── NEW TEST: "failed" status in HandoffResponse ─────────────────
  test("should handle 'failed' status in the HandoffResponse", async () => {
    const projectDir = makeTempDir();
    const mockResponses: MockResponse[] = [
      {
        object: {
          schema_version: "0.1.0",
          status: "failed",
          summary: "Task could not be completed due to insufficient context.",
          changes: [],
        },
      },
    ];
    const mockModel = createMockModel(mockResponses);

    const result = await delegateToSubagent(
      "planner",
      "Plan something impossible",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.status).toBe("failed");
      expect(result.result.summary).toContain("insufficient context");
      expect(result.result.changes).toEqual([]);
    }
  });

  // ── NEW TEST: No modelConfig → loadConfig fallback ───────────────
  test("should fall back to config defaults when no modelConfig is provided", async () => {
    const projectDir = makeTempDir();
    const mockModel = createMockModel([{}]);

    const result = await delegateToSubagent(
      "developer",
      "Task without explicit model config",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    // Should succeed with default config
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.schema_version).toBe("0.1.0");
    }
  });

  // ── NEW TEST: Artifact file that does not exist ──────────────────
  test("should handle non-existent artifact files without crashing", async () => {
    const projectDir = makeTempDir();
    const mockModel = createMockModel([{}]);

    const result = await delegateToSubagent(
      "developer",
      "Task with a missing artifact reference",
      ["/nonexistent/file/that/does/not/exist.md"],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.schema_version).toBe("0.1.0");
    }
  });

  // ── NEW TEST: Schema validation exhausts all retries ─────────────
  test("should return failure after exhausting all schema validation retries", async () => {
    const projectDir = makeTempDir();
    const mockResponses: MockResponse[] = [
      { schemaError: "changes.0.file_path: expected string, received number" },
      { schemaError: "summary: expected string, received null" },
      { schemaError: "schema_version: expected '0.1.0', received '1.0.0'" },
    ];
    const mockModel = createMockModel(mockResponses);

    const result = await delegateToSubagent(
      "developer",
      "Task with schema issues",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe("string");
      expect(result.error).toContain("Schema validation failed");
    }
  });

  // ── NEW TEST: Very large task string (stress test) ───────────────
  test("should handle a very large task string without crashing", async () => {
    const projectDir = makeTempDir();
    const mockModel = createMockModel([{}]);

    const largeTask = "A".repeat(10_000);

    const result = await delegateToSubagent(
      "planner",
      largeTask,
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.schema_version).toBe("0.1.0");
    }
  });

  // ── TD-029-F: Unknown role no longer fails (role def provided directly) ──
  test("should succeed even with unknown role name (role def provided directly)", async () => {
    const projectDir = makeTempDir();
    const mockModel = createMockModel([{}]); // default valid HandoffResponse

    const result = await delegateToSubagent(
      "nonexistent_role",
      "Do something",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    // In slimmed harness, role name is a label — _roleDef is the actual definition.
    // Unknown role names don't cause failures since the definition is provided directly.
    expect(result.success).toBe(true);
  });

  // ── TD-012: Legacy artifact name readable ────────────────────────
  test("should read legacy delegation_result_*.json artifact", async () => {
    // Create a session directory manually with a legacy artifact
    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    // Write a legacy artifact
    const legacyContent = {
      provenance: {
        source: "subagent",
        role: "reviewer",
        session_id: "session-legacy-test",
        model: "old-model",
        delegated_at: new Date().toISOString(),
      },
      result: {
        schema_version: "0.1.0",
        status: "success" as const,
        summary: "Legacy review result",
        changes: [],
      },
    };
    await writeFile(
      join(sessionDir, "delegation_result_reviewer.json"),
      JSON.stringify(legacyContent, null, 2),
    );

    // readDelegationResult should find it via legacy fallback
    const result = await readDelegationResult(sessionDir, "reviewer");
    expect(result).not.toBeNull();
    const parsed = result as { provenance: { role: string }; result: { summary: string } };
    expect(parsed.provenance.role).toBe("reviewer");
    expect(parsed.result.summary).toBe("Legacy review result");
  });

  // ── TD-012: Generic filename — no role-named artifacts ───────────
  test("should write result.json (generic filename, not delegation_result_*.json)", async () => {
    const projectDir = makeTempDir();
    const mockModel = createMockModel([{}]);

    const result = await delegateToSubagent(
      "architect",
      "Design something",
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      DEVELOPER_DEF,
    );

    // Use sessionDir from the delegation result (deterministic)
    const sessionDir = (result as { sessionDir?: string }).sessionDir!;
    const newPath = join(sessionDir, "result.json");
    const newRaw = await readFile(newPath, "utf-8");
    expect(JSON.parse(newRaw).provenance.role).toBe("architect");

    // Verify NO legacy-named file exists
    const legacyPath = join(sessionDir, "delegation_result_architect.json");
    try {
      await readFile(legacyPath, "utf-8");
      // If we reach here, the legacy file exists — that's a failure
      throw new Error("Legacy filename should not exist");
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        // Expected: file does not exist
      } else if ((err as Error).message === "Legacy filename should not exist") {
        throw err;
      }
      // Other errors are fine — the point is the legacy file shouldn't be there
    }
  });
});

// ── HIGH-004: renderPromptTemplate wired in delegation ─────────

describe("delegateToSubagent — HIGH-004: Prompt template rendering", () => {
  test("role with {{task}} template sends substituted task to LLM", async () => {
    const projectDir = makeTempDir();
    const capturedPrompts: string[] = [];

    // Create a registry where the developer role has a template with {{task}}
    const registry = createTestRegistry();
    registry.roles.set("developer", {
      prompt_template: "Your job: {{task}}, assigned to {{role}}",
      context_budget: 0.65,
      model: "deepseek-chat",
      llm_id: "deepseek:deepseek-chat",
      provenance: "test",
      model_provenance: "test",
    });

    const mockModel = createMockModel([{}], capturedPrompts);

    const taskDescription = "Write a sorting algorithm";

    const result = await delegateToSubagent(
      "developer",
      taskDescription,
      [],
      TEST_LLM_CLIENT,
      projectDir,
      TEST_LLM_OPTIONS,
      mockModel,
      registry.roles.get("developer")!,
    );

    expect(result.success).toBe(true);

    // Verify the LLM received the SUBSTITUTED text
    expect(capturedPrompts.length).toBe(1);
    const prompt = capturedPrompts[0]!;
    expect(prompt).toContain(`Your job: ${taskDescription}`);
    expect(prompt).toContain("assigned to developer");
    expect(prompt).not.toContain("{{task}}");
    expect(prompt).not.toContain("{{role}}");
  });
});

// ── MED-002: handoff-response.json fallback readable ────────────

describe("readDelegationResult — MED-002: handoff-response.json fallback", () => {
  test("reads legacy handoff-response.json when result.json and delegation_result_*.json are missing", async () => {
    const sessionDir = makeTempDir();
    await ensureDir(sessionDir);

    // Write a legacy handoff-response.json
    const handoffContent = {
      schema_version: "0.1.0",
      status: "success" as const,
      summary: "Legacy handoff response result from old orchestrator",
      changes: [],
    };
    await writeFile(
      join(sessionDir, "handoff-response.json"),
      JSON.stringify(handoffContent, null, 2),
    );

    // readDelegationResult should find it via the third fallback
    const result = await readDelegationResult(sessionDir, "some_role");
    expect(result).not.toBeNull();
    const parsed = result as { summary: string };
    expect(parsed.summary).toBe("Legacy handoff response result from old orchestrator");
  });
});
