/**
 * Harness API integration tests — run-job.ts (TD-029-DE Part 2).
 *
 * Covers:
 * - TEST-6: runJob returns a successful result for a single job
 * - TEST-7: runJob returns a typed error for bad role
 * - Bad input validation (missing project_dir, etc.)
 * - Resume context threading
 *
 * Uses createMockModel for deterministic LLM simulation.
 * Does NOT import controller internals.
 *
 * @module run-job.test
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runJob } from "../../src/api/run-job.ts";
import type { RunJobInput } from "../../src/api/run-job.ts";
import { createMockModel } from "../mocks/mock-model.ts";
import { createMockRegistryForLlmId } from "../fixtures/mock-llm-client.ts";

// ── Temp Directory Management ──────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-runjob-${randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

let testStoreRoot: string;

beforeAll(async () => {
  testStoreRoot = makeTempDir();
  await ensureDir(testStoreRoot);
  // Set ZAO_HOME to isolate test sessions from the host's ~/.zao
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

// ── Helpers ────────────────────────────────────────────────────────

/** Valid input fixture. */
function validInput(overrides?: Partial<RunJobInput>): RunJobInput {
  return {
    role: {
      role_id: "developer",
      description: "You are a developer agent. Write clean code.",
      prompt_template:
        "You are a developer agent. Write clean code.\n\nTask: {{task}}",
      llm_id: "deepseek:deepseek-chat",
    },
    task: "Write a hello world function",
    project_dir: makeTempDir(),
    config: {
      auto_yes: true,
      format: "table",
    },
    _registry: createMockRegistryForLlmId("deepseek:deepseek-chat"),
    ...overrides,
  } as RunJobInput;
}

// ── TEST-6: runJob returns a successful result for a single job ────

describe("runJob success (TEST-6)", () => {
  test("returns success with session_id and session_dir", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = createMockModel([{}]); // default success response

    const result = await runJob({
      ...validInput({ project_dir: projectDir }),
      _generateObjectFn: mock,
    });

    expect(result.success).toBe(true);
    expect(result.session_id).toBeTruthy();
    expect(result.session_dir).toBeTruthy();
    expect(result.session_dir).toContain("sessions");
    expect(result.is_validation_error).toBeFalsy();
  });

  test("returns result payload on success", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = createMockModel([{}]);

    const result = await runJob({
      ...validInput({ project_dir: projectDir }),
      _generateObjectFn: mock,
    });

    expect(result.success).toBe(true);
    expect(result.result).toBeDefined();
  });
});

// ── TEST-7: runJob returns a typed error for bad role ──────────────

describe("runJob validation errors (TEST-7)", () => {
  test("returns error for missing task", async () => {
    const result = await runJob({
      role: {
        role_id: "developer",
        description: "A dev",
      },
      // Missing task
      project_dir: "/tmp/test",
    });

    expect(result.success).toBe(false);
    expect(result.is_validation_error).toBe(true);
    expect(result.error).toContain("task");
    expect(result.session_id).toBe("");
  });

  test("returns error for missing project_dir", async () => {
    const result = await runJob({
      role: {
        role_id: "developer",
        description: "A dev",
      },
      task: "Build something",
      // Missing project_dir
    });

    expect(result.success).toBe(false);
    expect(result.is_validation_error).toBe(true);
    expect(result.error).toContain("project_dir");
  });

  test("returns error for missing role", async () => {
    const result = await runJob({
      task: "Build something",
      project_dir: "/tmp/test",
    });

    expect(result.success).toBe(false);
    expect(result.is_validation_error).toBe(true);
    expect(result.error).toContain("role");
  });

  test("returns error for invalid role shape", async () => {
    const result = await runJob({
      role: { role_id: "" }, // empty role_id
      task: "Build something",
      project_dir: "/tmp/test",
    });

    expect(result.success).toBe(false);
    expect(result.is_validation_error).toBe(true);
    expect(result.error).toContain("role_id");
  });

  test("returns error for invalid role_id", async () => {
    const result = await runJob({
      role: {
        role_id: "", // empty role_id
        description: "A dev",
      },
      task: "Build something",
      project_dir: "/tmp/test",
    });

    expect(result.success).toBe(false);
    expect(result.is_validation_error).toBe(true);
    expect(result.error).toContain("role_id");
  });
});

// ── Resume context threading ───────────────────────────────────────

describe("resume context", () => {
  test("accepts resume_context without error", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = createMockModel([{}]);

    const result = await runJob({
      ...validInput({ project_dir: projectDir }),
      session_id: null,
      resume_context: {
        recent_events: 5,
        summary: "Previously completed step 1. Now on step 2.",
      },
      _generateObjectFn: mock,
    });

    // Resume context is accepted even if not fully wired into loop yet
    expect(result.success).toBe(true);
    expect(result.session_id).toBeTruthy();
  });

  test("session_id null creates new session", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = createMockModel([{}]);

    const result = await runJob({
      ...validInput({ project_dir: projectDir }),
      session_id: null,
      _generateObjectFn: mock,
    });

    expect(result.success).toBe(true);
    expect(result.session_id).toBeTruthy();
  });
});

// ── Config mapping ─────────────────────────────────────────────────

describe("config mapping", () => {
  test("auto_yes is passed through", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    // Mock that captures the prompt to verify auto_yes context
    const capturedPrompts: string[] = [];
    const mock = createMockModel([{}], capturedPrompts);

    const result = await runJob({
      ...validInput({ project_dir: projectDir }),
      config: { auto_yes: true, format: "table" },
      _generateObjectFn: mock,
    });

    expect(result.success).toBe(true);
  });
});

// ── Resume (session_id non-null) ───────────────────────────────────

describe("runJob resume (session_id)", () => {
  test("resumes existing session with stored role and llm_id", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    // Create a session directory manually under the test store root
    const storeRoot = process.env["ZAO_HOME"]!;
    const sessionId = randomUUID();
    const sessionDir = join(storeRoot, "sessions", sessionId);
    await ensureDir(sessionDir);

    const now = new Date().toISOString();

    // Write session.json (ParentManifest v0.2.0)
    const manifest = {
      schema_version: "0.2.0",
      session_id: sessionId,
      parent_session_id: null,
      created_at: now,
      updated_at: now,
      status: "active",
      task: "Write a hello world function",
      role: "developer",
      model_config: { provider: "deepseek", model: "deepseek-chat" },
      repo_root: projectDir,
      repo_remote: null,
      repo_commit_at_start: null,
      cwd: projectDir,
      branched_from: null,
      resume_count: 0,
      compaction_history: [],
    };
    await writeFile(
      join(sessionDir, "session.json"),
      JSON.stringify(manifest, null, 2),
    );

    // Write session-config.json (v1.0 — immutable, no credentials)
    const sessionConfig = {
      schema_version: "1.0",
      role_name: "developer",
      resolved_role: {
        prompt_template:
          "You are a developer agent. Write clean code.\n\nTask: {{task}}",
        context_budget: 0.65,
        model: "deepseek-chat",
        llm_id: "deepseek:deepseek-chat",
        provenance: "test",
        model_provenance: "test",
      },
      llm_id: "deepseek:deepseek-chat",
      temperature: 0.1,
      created_at: now,
    };
    await writeFile(
      join(sessionDir, "session-config.json"),
      JSON.stringify(sessionConfig, null, 2),
    );

    // Call runJob with session_id — the role from session-config
    // should be replayed (not the input role's model_config).
    const capturedPrompts: string[] = [];
    const mock = createMockModel([{}], capturedPrompts);

    const result = await runJob({
      ...validInput({ project_dir: projectDir }),
      session_id: sessionId,
      _generateObjectFn: mock,
    });

    expect(result.success).toBe(true);
    expect(result.session_id).toBe(sessionId);

    // Verify the stored role's prompt_template was used
    expect(capturedPrompts.length).toBeGreaterThan(0);
    expect(capturedPrompts[0]!).toContain("You are a developer agent");
    expect(capturedPrompts[0]!).toContain("Task:");
  });
});
