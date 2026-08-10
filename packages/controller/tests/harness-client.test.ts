/**
 * DefaultHarnessClient tests — TD-029-DE review findings.
 *
 * Covers:
 * - Test 1: DefaultHarnessClient calls runJob with correct role/provider/model mapping
 * - Test 2: DefaultHarnessClient throws if provider is missing
 * - Test 3: DefaultHarnessClient maps snake_case output to camelCase correctly
 *
 * Uses dependency injection to avoid real LLM calls.
 *
 * @module harness-client.test
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DefaultHarnessClient } from "../src/harness-client.ts";
import type { RunJobOutput } from "../../harness/src/api/run-job.ts";
import type { ResumeContext } from "../src/execution-runner.ts";
import type { ResolvedRoleDefinition } from "../src/schemas/role-definition.ts";

// ── Temp Directory Management ──────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-harness-client-${randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

let testStoreRoot: string;

beforeAll(async () => {
  testStoreRoot = makeTempDir();
  await mkdir(testStoreRoot, { recursive: true });
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

function createResolvedRole(
  overrides?: Partial<ResolvedRoleDefinition>,
): ResolvedRoleDefinition {
  return {
    prompt_template: "You are a developer. Task: {{task}}",
    context_budget: 0.65,
    model: "deepseek-chat",
    provenance: "test",
    model_provenance: "test",
    llm_id: "deepseek:deepseek-chat",
    ...overrides,
  };
}

// ── Test 1: correct role/provider/model mapping ───────────────────

describe("role/provider/model mapping", () => {
  test("maps roleId, prompt_template, and llm_id to runJob input", async () => {
    const capturedInputs: unknown[] = [];

    const fakeRunJob = async (input: unknown): Promise<RunJobOutput> => {
      capturedInputs.push(input);
      return {
        success: true,
        session_id: "sess-123",
        session_dir: "/tmp/sess-123",
        result: { summary: "done" },
        events: [{ type: "test" }],
      };
    };

    const client = new DefaultHarnessClient(fakeRunJob);

    const result = await client.runJob({
      roleId: "developer",
      resolvedRole: createResolvedRole({
        prompt_template: "You are a coder. Task: {{task}}",
        llm_id: "openai:gpt-4o",
      }),
      task: "Build the feature",
      projectDir: "/tmp/project",
      config: { autoYes: true, format: "json" },
    });

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("sess-123");

    expect(capturedInputs.length).toBe(1);
    const input = capturedInputs[0] as {
      role: {
        role_id: string;
        description: string;
        prompt_template: string;
        llm_id?: string;
      };
      task: string;
      project_dir: string;
      config: { auto_yes: boolean; format: string };
    };

    expect(input.role.role_id).toBe("developer");
    expect(input.role.description).toBe("You are a coder. Task: {{task}}");
    expect(input.role.prompt_template).toBe("You are a coder. Task: {{task}}");
    expect(input.role.llm_id).toBe("openai:gpt-4o");
    expect(input.task).toBe("Build the feature");
    expect(input.project_dir).toBe("/tmp/project");
    expect(input.config.auto_yes).toBe(true);
    expect(input.config.format).toBe("json");
  });

  test("threads resume context into the runJob input", async () => {
    const capturedInputs: unknown[] = [];

    const fakeRunJob = async (input: unknown): Promise<RunJobOutput> => {
      capturedInputs.push(input);
      return {
        success: true,
        session_id: "sess-456",
        session_dir: "/tmp/sess-456",
        events: [],
      };
    };

    const client = new DefaultHarnessClient(fakeRunJob);
    const resumeContext: ResumeContext = {
      summary: "Previously completed step 1.",
      recentEvents: ["[10:00] step_completed"],
    };

    await client.runJob({
      roleId: "developer",
      resolvedRole: createResolvedRole(),
      task: "Continue",
      projectDir: "/tmp/project",
      config: { autoYes: true, format: "table" },
      resumeContext,
    });

    const input = capturedInputs[0] as {
      resume_context: { summary?: string; recent_events?: number };
    };
    expect(input.resume_context.summary).toBe("Previously completed step 1.");
    expect(input.resume_context.recent_events).toBe(1);
  });
});

// ── Test 2: missing provider returns typed failure ───────────────

describe("missing provider validation", () => {
  test("returns failure when resolvedRole has no llm_id", async () => {
    const client = new DefaultHarnessClient(async () => ({
      success: true,
      session_id: "",
      session_dir: "",
      events: [],
    }));

    const result = await client.runJob({
      roleId: "developer",
      resolvedRole: createResolvedRole({ llm_id: undefined }),
      task: "Build",
      projectDir: "/tmp/project",
      config: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("missing llm_id");
  });

  test("returns failure when llm_id is empty", async () => {
    const client = new DefaultHarnessClient(async () => ({
      success: true,
      session_id: "",
      session_dir: "",
      events: [],
    }));

    const result = await client.runJob({
      roleId: "developer",
      resolvedRole: createResolvedRole({
        llm_id: "",
      }),
      task: "Build",
      projectDir: "/tmp/project",
      config: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("missing llm_id");
  });

  test("returns failure when llm_id model is missing", async () => {
    const client = new DefaultHarnessClient(async () => ({
      success: true,
      session_id: "",
      session_dir: "",
      events: [],
    }));

    const result = await client.runJob({
      roleId: "developer",
      resolvedRole: createResolvedRole({
        llm_id: "deepseek:",
      }),
      task: "Build",
      projectDir: "/tmp/project",
      config: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid llm_id");
  });
});

// ── Test 3: snake_case output mapping ─────────────────────────────

describe("output mapping", () => {
  test("maps snake_case runJob output to camelCase", async () => {
    const fakeRunJob = async (): Promise<RunJobOutput> => ({
      success: false,
      session_id: "sess-789",
      session_dir: "/tmp/sess-789",
      result: undefined,
      events: [{ event: "failure" }],
      error: "API rate limit",
      is_validation_error: false,
    });

    const client = new DefaultHarnessClient(fakeRunJob);

    const result = await client.runJob({
      roleId: "developer",
      resolvedRole: createResolvedRole(),
      task: "Build",
      projectDir: "/tmp/project",
      config: {},
    });

    expect(result.success).toBe(false);
    expect(result.sessionId).toBe("sess-789");
    expect(result.sessionDir).toBe("/tmp/sess-789");
    expect(result.error).toBe("API rate limit");
    expect(result.events).toHaveLength(1);
  });
});
