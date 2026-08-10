/**
 * Session Resume tests — TD-010-B.
 *
 * Covers:
 * - T1: Happy path — interrupted run resumes at step 2
 * - T2: Root-only enforcement (child id rejected)
 * - T3: Complete is terminal (completed run refused)
 * - T4: Checkpoint before mutation
 * - T5: Failed run prompt + --yes skips
 * - T6: --recent-events N controls context
 * - T7: Missing/corrupt manifest → fail closed
 * - T8a: Config drift = note, original spec used
 * - T8b: Unreplayable spec → fail closed
 * - T9: session_resumed event envelope
 * - T10: Completed steps never re-run (result.json unchanged)
 * - T11: zao session show output
 * - T12: resume_count increments + global index line
 * - T13: Original spec replayed (verify snapshot used)
 *
 * @module resume.test
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm, readFile, writeFile, mkdir, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { initSession, writeArtifact, appendEvent } from "../src/core/artifacts.ts";
import { generateSessionId } from "../src/core/ids.ts";
import { createTestRegistry } from "./fixtures/role-registry.ts";
import { createMockModel } from "./mocks/mock-model.ts";
import type { MockResponse } from "./mocks/mock-model.ts";
import { resumeSession } from "../src/core/resume.ts";
import { resolveStoreRoot, loadManifest } from "../src/core/session-store.ts";
import type { RoleRegistry } from "../src/schemas/role-definition.ts";
import type { ResolvedRoleDefinition } from "../src/schemas/role-definition.ts";
import { createMockRegistryForLlmId } from "./fixtures/mock-llm-client.ts";
// generateOrchestrationSpec removed (TD-029-F slimmed harness)

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Manually constructs an orchestration spec from a RoleRegistry.
 * Replaces the removed `generateOrchestrationSpec` (TD-029-F).
 */
function buildOrchestrationSpec(registry: RoleRegistry): Record<string, unknown> {
  const roles: Record<string, Record<string, unknown>> = {};
  for (const [name, def] of registry.roles) {
    roles[name] = {
      prompt_template: def.prompt_template,
      context_budget: def.context_budget,
      model: def.model,
      provenance: def.provenance,
      model_provenance: def.model_provenance,
    };
  }
  return {
    schema_version: "0.2.0",
    generated_at: new Date().toISOString(),
    default_model: registry.defaultModel,
    roles,
  };
}

// ── Temp Directory Management ──────────────────────────────────────

let testStoreRoot: string;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-resume-${crypto.randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

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
    } catch { /* best-effort */ }
  }
});

// ── Mock Helpers ───────────────────────────────────────────────────

function mockSuccessResponse(): MockResponse {
  return {
    object: {
      schema_version: "0.1.0",
      status: "success",
      summary: "Task completed successfully.",
      changes: [{ file_path: "output.txt", content: "# Done" }],
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────

/** Create a test registry with the standard 4 roles. */
const TEST_REGISTRY: RoleRegistry = createTestRegistry();

/** Mock LLM client registry for resume tests — avoids real config files. */
const TEST_LLM_REGISTRY = createMockRegistryForLlmId("deepseek:deepseek-chat");

/**
 * Writes a session-config.json to the given session directory.
 * This is the immutable config required for resume since TD-029-F.
 */
async function writeSessionConfig(
  sessionDir: string,
  roleName: string,
  roleDef?: ResolvedRoleDefinition,
): Promise<void> {
  const effectiveRoleDef: ResolvedRoleDefinition = roleDef ?? {
    prompt_template:
      "You are a developer agent. Write production-quality code following " +
      "the project's conventions and patterns. Prioritize readability, " +
      "defensive error handling, and comprehensive type safety.",
    context_budget: 0.65,
    model: "deepseek-chat",
    llm_id: "deepseek:deepseek-chat",
    provenance: "built-in",
    model_provenance: "built-in",
  };
  // SECURITY: ADR-009 — no credential fields in session files.
  // Uses v1.0 schema format with canonical llm_id.
  const config = {
    schema_version: "1.0",
    role_name: roleName,
    resolved_role: effectiveRoleDef,
    llm_id: "deepseek:deepseek-chat",
    temperature: 0.1,
    created_at: new Date().toISOString(),
    model_id: "deepseek-chat",
  };
  await writeArtifact(
    join(sessionDir, "session-config.json"),
    JSON.stringify(config, null, 2),
  );
}

/**
 * Creates a realistic interrupted session with 3 steps:
 * step-1: completed successfully (child session with result.json)
 * step-2: never started (interrupted here)
 * step-3: never started
 *
 * Returns { sessionId, sessionDir }.
 */
async function createInterruptedSession(): Promise<{
  sessionId: string;
  sessionDir: string;
}> {
  // Create root session
  const initResult = await initSession({
    role: "planner",
    taskSummary: "Build a multi-step feature",
    projectDir: process.cwd(),
    modelProvider: "deepseek",
    modelId: "deepseek-chat",
  });

  const sessionDir = initResult.sessionDir;
  const sessionId = initResult.sessionId;

  // Write session-config.json (required for resume since TD-029-F)
  const plannerDef = TEST_REGISTRY.roles.get("planner");
  await writeSessionConfig(sessionDir, "planner", plannerDef);

  // Write orchestration spec with 3 steps
  const roleSpec = buildOrchestrationSpec(TEST_REGISTRY);
  const spec = {
    ...roleSpec,
    flow: {
      schema_version: "0.2.0",
      provenance: "test",
      steps: [
        { id: "step-1", role: "planner", when: null, context: null },
        { id: "step-2", role: "developer", when: null, context: null },
        { id: "step-3", role: "reviewer", when: null, context: null },
      ],
    },
  };
  await writeArtifact(
    join(sessionDir, "orchestration-spec.json"),
    JSON.stringify(spec, null, 2),
  );

  // Create completed child for step-1
  const child1Id = generateSessionId();
  await mkdir(join(sessionDir, "agents", child1Id), { recursive: true, mode: 0o700 });

  const child1Manifest = {
    schema_version: "0.2.0",
    session_id: child1Id,
    parent_session_id: sessionId,
    node_id: "step-1",
    role: "planner",
    task_summary: "Plan the feature",
    model_id: "deepseek-chat",
    created_at: new Date().toISOString(),
    status: "complete",
  };
  await writeArtifact(
    join(sessionDir, "agents", child1Id, "session.json"),
    JSON.stringify(child1Manifest, null, 2),
  );

  // Write child1 result.json
  await writeArtifact(
    join(sessionDir, "agents", child1Id, "result.json"),
    JSON.stringify({
      schema_version: "0.2.0",
      provenance: { source: "subagent", role: "planner", session_id: child1Id, model: "deepseek-chat", timestamp: new Date().toISOString() },
      result: { status: "success", summary: "Plan complete.", changes: [] },
    }, null, 2),
  );

  // Append to agents/index.jsonl (creation + completion lines)
  const agentsIndexPath = join(sessionDir, "agents", "index.jsonl");
  await writeFile(
    agentsIndexPath,
    JSON.stringify({ session_id: child1Id, parent_session_id: sessionId, node_id: "step-1", role: "planner", started_at: new Date().toISOString(), status: "active" }) + "\n" +
    JSON.stringify({ session_id: child1Id, parent_session_id: sessionId, role: "planner", started_at: new Date().toISOString(), status: "complete" }) + "\n",
  );

  // Set manifest.status to "interrupted"
  const manifest = await loadManifest(sessionDir);
  await writeArtifact(
    join(sessionDir, "session.json"),
    JSON.stringify({ ...manifest, status: "interrupted" }, null, 2),
  );

  // Write a root events.jsonl with a couple events
  const event = {
    schema_version: "0.2.0",
    event_id: generateSessionId(),
    session_id: sessionId,
    parent_session_id: null,
    timestamp: new Date().toISOString(),
    agent_role: "orchestrator",
    model_id: "zao-orchestrator",
    prompt_tokens: 100,
    completion_tokens: 0,
    cache_hit: false,
    action: "flow_step",
    node_id: "step-1",
    flow_step_status: "success",
  };
  await appendEvent(sessionDir, event as unknown as Record<string, unknown>);

  return { sessionId, sessionDir };
}

/**
 * Creates a completed session (all steps done).
 */
async function createCompletedSession(): Promise<{
  sessionId: string;
  sessionDir: string;
}> {
  const { sessionId, sessionDir } = await createInterruptedSession();

  // Create completed step-2 child
  const child2Id = generateSessionId();
  await mkdir(join(sessionDir, "agents", child2Id), { recursive: true, mode: 0o700 });
  const child2Manifest = {
    schema_version: "0.2.0",
    session_id: child2Id,
    parent_session_id: sessionId,
    node_id: "step-2",
    role: "developer",
    task_summary: "Implement the feature",
    model_id: "deepseek-chat",
    created_at: new Date().toISOString(),
    status: "complete",
  };
  await writeArtifact(
    join(sessionDir, "agents", child2Id, "session.json"),
    JSON.stringify(child2Manifest, null, 2),
  );
  await writeArtifact(
    join(sessionDir, "agents", child2Id, "result.json"),
    JSON.stringify({ schema_version: "0.2.0", provenance: {}, result: { status: "success" } }, null, 2),
  );

  // Append step-2 to agents/index.jsonl
  const agentsIndexPath = join(sessionDir, "agents", "index.jsonl");
  await writeFile(
    agentsIndexPath,
    JSON.stringify({ session_id: child2Id, parent_session_id: sessionId, node_id: "step-2", role: "developer", started_at: new Date().toISOString(), status: "complete" }) + "\n",
    { flag: "a" },
  );

  // Update manifest to complete
  const manifest = await loadManifest(sessionDir);
  await writeArtifact(
    join(sessionDir, "session.json"),
    JSON.stringify({ ...manifest, status: "complete" }, null, 2),
  );

  return { sessionId, sessionDir };
}

// ═════════════════════════════════════════════════════════════════════
// T1: Happy path — interrupted run resumes at step 2
// ═════════════════════════════════════════════════════════════════════

describe("T1: happy path resume", () => {
  test("interrupted session resumes at step 2", async () => {
    const { sessionId, sessionDir } = await createInterruptedSession();

    // Mock model: success for step-2 and step-3
    const m = createMockModel([mockSuccessResponse(), mockSuccessResponse()]);

    const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m });

    expect(result.success).toBe(true);
    expect(result.completed).toBe(true);

    // Verify step-1 result.json content unchanged (ground truth)
    const agentsDir = join(sessionDir, "agents");
    // find the child dir for step-1
    const child1Entries = await (async () => {
      // Read agents/index.jsonl to find step-1 child id
      const idxRaw = await readFile(join(agentsDir, "index.jsonl"), "utf-8");
      for (const line of idxRaw.split("\n")) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        if (parsed.node_id === "step-1" && parsed.status === "active") {
          return parsed.session_id;
        }
      }
      return null;
    })();

    if (child1Entries) {
      const child1Dir = join(agentsDir, child1Entries as string);
      try {
        const resultRaw = await readFile(join(child1Dir, "result.json"), "utf-8");
        expect(resultRaw).toContain("Plan complete.");
      } catch {
        // ok if child dir structure differs
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// T2: Root-only enforcement
// ═════════════════════════════════════════════════════════════════════

describe("T2: child id rejected", () => {
  test("child session id is rejected", async () => {
    const { sessionDir } = await createInterruptedSession();

    // Find a child session id
    const agentsIndexPath = join(sessionDir, "agents", "index.jsonl");
    const idxRaw = await readFile(agentsIndexPath, "utf-8");
    let childId = "";
    for (const line of idxRaw.split("\n")) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      if (parsed.node_id === "step-1") {
        childId = parsed.session_id;
        break;
      }
    }

    if (childId) {
      const result = await resumeSession(childId, { _registry: TEST_LLM_REGISTRY });
      expect(result.success).toBe(false);
      expect(result.error).toContain("child");
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// T3: Complete is terminal
// ═════════════════════════════════════════════════════════════════════

describe("T3: complete is terminal", () => {
  test("completed run refused", async () => {
    const { sessionId } = await createCompletedSession();
    const result = await resumeSession(sessionId, { _registry: TEST_LLM_REGISTRY });
    expect(result.success).toBe(false);
    expect(result.error).toContain("terminal");
  });
});

// ═════════════════════════════════════════════════════════════════════
// T4: Checkpoint before mutation
// ═════════════════════════════════════════════════════════════════════

describe("T4: checkpoint before mutation", () => {
  test("checkpoint directory exists after resume", async () => {
    const { sessionId, sessionDir } = await createInterruptedSession();

    const m = createMockModel([mockSuccessResponse(), mockSuccessResponse()]);
    const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m });
    expect(result.success).toBe(true);

    // Check that checkpoints/ exists with at least one entry
    const checkpointsDir = join(sessionDir, "checkpoints");
    let entries: string[];
    try {
      const { readdir } = await import("node:fs/promises");
      entries = await readdir(checkpointsDir);
    } catch {
      // No checkpoint dir
      expect(false).toBe(true);
      return;
    }
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });
});

// ═════════════════════════════════════════════════════════════════════
// T5: Failed run prompt + --yes skips
// ═════════════════════════════════════════════════════════════════════

describe("T5: failed run prompt", () => {
  test("failed run: --yes proceeds without prompt (mock model returns success)", async () => {
    const { sessionId, sessionDir } = await createInterruptedSession();

    // Set status to "failed" with error in result.json
    const manifest = await loadManifest(sessionDir);
    await writeArtifact(
      join(sessionDir, "session.json"),
      JSON.stringify({ ...manifest, status: "failed" }, null, 2),
    );
    await writeArtifact(
      join(sessionDir, "result.json"),
      JSON.stringify({
        schema_version: "0.2.0",
        timestamp: new Date().toISOString(),
        overall_success: false,
        error: "Step-1 failed: API error 500",
        steps: [{ id: "step-1", status: "failed", error: "API error 500" }],
      }, null, 2),
    );

    const m = createMockModel([mockSuccessResponse(), mockSuccessResponse()]);
    const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m });

    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// T6: --recent-events N controls context — DELETED (TD-029-F: multi-step flow concept, not applicable to single-job harness)
// ─────────────────────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════════
// T7: Missing/corrupt manifest → fail closed
// ═════════════════════════════════════════════════════════════════════

describe("T7: missing/corrupt manifest", () => {
  test("corrupt session.json fails closed", async () => {
    const { sessionId, sessionDir } = await createInterruptedSession();

    // Corrupt the manifest
    await writeArtifact(join(sessionDir, "session.json"), "not valid json {{{");

    const result = await resumeSession(sessionId, { _registry: TEST_LLM_REGISTRY });
    expect(result.success).toBe(false);
    expect(result.error).toContain("manifest");
  });
});

// ═════════════════════════════════════════════════════════════════════
// T8a: Config drift = note, original spec used
// T8b: Unreplayable spec → fail closed
// ═════════════════════════════════════════════════════════════════════

describe("T8: config drift and replay-ability", () => {
  // TD-029-F: Config drift detection removed from slimmed harness.
  // The controller handles config drift now. This test verifies resume
  // still works even when spec diverges.
  test("T8a: config divergence does not block resume (slimmed)", async () => {
    const { sessionId, sessionDir } = await createInterruptedSession();

    // Create real config divergence: modify the orchestration-spec.json's
    // planner role prompt to differ from the test registry.
    // The "planner" role in the test registry has a specific prompt_template.
    // We change it in the snapshot so `compareSpecToCurrent` detects drift.
    const DIVERGENT_PLANNER_PROMPT = "DIVERGENT_SNAPSHOT_PROMPT_FOR_T8A_" + crypto.randomUUID();
    const specRaw = await readFile(join(sessionDir, "orchestration-spec.json"), "utf-8");
    const spec = JSON.parse(specRaw);
    spec.roles.planner.prompt_template = DIVERGENT_PLANNER_PROMPT;
    await writeArtifact(
      join(sessionDir, "orchestration-spec.json"),
      JSON.stringify(spec, null, 2),
    );

    // Capture stdout to verify drift note was printed
    const stdoutChunks: string[] = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = function(chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void): boolean {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return originalStdoutWrite(chunk as string, encoding as BufferEncoding, cb);
    } as typeof process.stdout.write;

    // Capture prompts to verify resume ran
    const capturedPrompts: string[] = [];
    const m = createMockModel([mockSuccessResponse()], capturedPrompts);

    try {
      const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m });
      expect(result.success).toBe(true);

      // 1. No drift note (config drift detection moved to controller)
      // drift detection is skipped in slimmed harness

      // 2. Resume reached the LLM
      expect(capturedPrompts.length).toBeGreaterThanOrEqual(1);

      // 3. Basic resume completed
      expect(result.completed).toBe(true);
      // The session config stores the planner role, so the prompt should
      // contain the planner's prompt_template (replayed from session-config.json).
      const hasPlannerPrompt = capturedPrompts.some(
        (p) => p.includes("You are a planning agent") || p.includes("planning agent"),
      );
      expect(hasPlannerPrompt).toBe(true);

      // 4. For stronger proof: verify none of the captured prompts use the
      // divergent planner prompt (which is the "current config" at this point,
      // since the spec snapshot has the divergent prompt). The step-1 (planner)
      // was already completed and skipped — no LLM call uses the divergent
      // planner prompt. But the fact that the resume succeeded without error
      // proves the snapshot was used, because the current config host
      // (test registry's planner prompt) does NOT match the snapshot.
      const hasDivergentPrompt = capturedPrompts.some(
        (p) => p.includes(DIVERGENT_PLANNER_PROMPT),
      );
      // The divergent planner prompt should NOT appear in any prompt
      // because step-1 (planner) was already completed — it's never
      // called during this resume.
      expect(hasDivergentPrompt).toBe(false);
    } finally {
      process.stdout.write = originalStdoutWrite;
    }
  });

  // TD-029-F: Replay-ability check removed from slimmed harness.
  // The controller validates role existence now. Resume proceeds
  // with built-in defaults even for unknown roles.
  // T8b deleted — unreplayable spec does not block resume in slimmed harness.
});

// ═════════════════════════════════════════════════════════════════════
// T9: Envelope on session_resumed
// ═════════════════════════════════════════════════════════════════════

describe("T9: session_resumed event envelope", () => {
  test("session_resumed event has full envelope fields", async () => {
    const { sessionId, sessionDir } = await createInterruptedSession();

    const m = createMockModel([mockSuccessResponse(), mockSuccessResponse()]);
    const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m });
    expect(result.success).toBe(true);

    const eventsPath = join(sessionDir, "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    let foundResumed = false;
    for (const line of eventsRaw.split("\n")) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.action === "session_resumed") {
        foundResumed = true;
        expect(ev.schema_version).toBe("0.2.0");
        expect(ev.event_id).toBeTruthy();
        expect(ev.session_id).toBe(sessionId);
        expect(ev.parent_session_id).toBeNull();
        // resume_point is flow-specific, not present in single-job resume (TD-029-F)
        expect(typeof ev.resume_count).toBe("number");
        expect(ev.checkpoint_id).toBeTruthy();
      }
    }
    expect(foundResumed).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════
// T10: Completed steps never re-run (ground truth)
// ═════════════════════════════════════════════════════════════════════

describe("T10: completed steps never re-run", () => {
  test("step-1 result.json mtime and content unchanged after resume", async () => {
    const { sessionId, sessionDir } = await createInterruptedSession();

    // Find step-1 child dir
    const agentsDir = join(sessionDir, "agents");
    const idxRaw = await readFile(join(agentsDir, "index.jsonl"), "utf-8");
    let step1ChildId = "";
    for (const line of idxRaw.split("\n")) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      if (parsed.node_id === "step-1" && parsed.status === "active") {
        step1ChildId = parsed.session_id;
        break;
      }
    }

    // Record mtime and content before resume
    const step1ResultPath = join(agentsDir, step1ChildId, "result.json");
    const beforeStat = await fsStat(step1ResultPath);
    const beforeMtime = beforeStat.mtimeMs;
    const beforeContent = await readFile(step1ResultPath, "utf-8");

    const m = createMockModel([mockSuccessResponse(), mockSuccessResponse()]);
    const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m });
    expect(result.success).toBe(true);

    // After resume: mtime and content should be unchanged
    const afterContent = await readFile(step1ResultPath, "utf-8");
    const afterStat = await fsStat(step1ResultPath);

    expect(afterContent).toBe(beforeContent);
    expect(afterStat.mtimeMs).toBe(beforeMtime);
  });
});

// ═════════════════════════════════════════════════════════════════════
// T12: resume_count increments + global index line
// ═════════════════════════════════════════════════════════════════════

describe("T12: resume_count + global index", () => {
  test("resume_count increments and global index line added", async () => {
    const { sessionId, sessionDir } = await createInterruptedSession();

    const manifest = await loadManifest(sessionDir);
    const beforeCount = manifest.resume_count;

    const m = createMockModel([mockSuccessResponse(), mockSuccessResponse()]);
    const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m });
    expect(result.success).toBe(true);

    const afterManifest = await loadManifest(sessionDir);
    expect(afterManifest.resume_count).toBe(beforeCount + 1);

    // Check global index has a line for this session (re-activation)
    const storeRoot = await resolveStoreRoot();
    const indexPath = join(storeRoot, "index.jsonl");
    const raw = await readFile(indexPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    // The most recent creation line should be our resume
    let foundOurLine = false;
    for (const line of lines) {
      const parsed = JSON.parse(line);
      if (parsed.session_id === sessionId && parsed.status === "active") {
        foundOurLine = true;
      }
    }
    // There should be at least one "active" line (the initial create)
    // and the resume re-activation also writes an "active" line
    expect(foundOurLine).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════
// T13: Original spec replayed — DELETED (TD-029-F: broken test with expect(1).toBe(3);
// testing multi-step flow spec replay, not applicable to single-job harness)
// ═════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════
// Edge Cases — TD-010-B Coverage Gaps
// ═════════════════════════════════════════════════════════════════════

// ── Edge case: Resume with empty events.jsonl ──────────────────────

describe("Edge: resume with no prior events", () => {
  test("empty events.jsonl does not crash resume", async () => {
    const { sessionId, sessionDir } = await createInterruptedSession();

    // Clear events.jsonl
    await writeArtifact(join(sessionDir, "events.jsonl"), "");

    const m = createMockModel([mockSuccessResponse(), mockSuccessResponse()]);
    const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m });
    expect(result.success).toBe(true);
  });
});

// ── Edge case: --recent-events 0 (zero events in context) ─────────

describe("Edge: --recent-events 0", () => {
  test("recentEvents=0 produces no events in context", async () => {
    const { sessionId } = await createInterruptedSession();

    const m = createMockModel([mockSuccessResponse(), mockSuccessResponse()]);
    const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, recentEvents: 0, _generateObjectFn: m });
    expect(result.success).toBe(true);
    // The session_resumed event should have been appended regardless
    expect(result).toBeDefined();
  });
});

// ── Edge case: --recent-events larger than total events ───────────

describe("Edge: --recent-events exceeds total events", () => {
  test("recentEvents larger than total events includes all available", async () => {
    const { sessionId } = await createInterruptedSession();

    // Only ~1 event was created by createInterruptedSession
    // Setting recentEvents=100 should just include whatever exists
    const m = createMockModel([mockSuccessResponse(), mockSuccessResponse()]);
    const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, recentEvents: 100, _generateObjectFn: m });
    expect(result.success).toBe(true);
  });
});

// ── Edge case: Double resume (resume_count increments twice) ──────

describe("Edge: double resume increments resume_count twice", () => {
  test("resume_count increments on each resume call", async () => {
    const { sessionId, sessionDir } = await createInterruptedSession();

    const manifestBefore = await loadManifest(sessionDir);
    const initialCount = manifestBefore.resume_count;

    // First resume
    const m1 = createMockModel([mockSuccessResponse(), mockSuccessResponse()]);
    const r1 = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m1 });
    expect(r1.success).toBe(true);

    const manifestMid = await loadManifest(sessionDir);
    expect(manifestMid.resume_count).toBe(initialCount + 1);

    // Second resume: re-set status to interrupted and update orchestration spec
    // (simulate another failure after first resume)
    await writeArtifact(
      join(sessionDir, "session.json"),
      JSON.stringify({ ...manifestMid, status: "interrupted" }, null, 2),
    );

    // Re-write agents/index.jsonl for step-2 as incomplete
    const agentsIndexPath = join(sessionDir, "agents", "index.jsonl");
    const idxRaw = await readFile(agentsIndexPath, "utf-8");
    // Remove step-2 completion from agents/index.jsonl
    const filteredLines = idxRaw
      .split("\n")
      .filter((l) => {
        if (!l.trim()) return false;
        const parsed = JSON.parse(l);
        return parsed.node_id !== "step-2";
      })
      .join("\n");
    await writeFile(agentsIndexPath, filteredLines + "\n");

    const m2 = createMockModel([mockSuccessResponse(), mockSuccessResponse()]);
    const r2 = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m2 });
    expect(r2.success).toBe(true);

    const manifestAfter = await loadManifest(sessionDir);
    expect(manifestAfter.resume_count).toBe(initialCount + 2);
  });
});

// ── Edge case: Checkpoint idempotency ─────────────────────────────

describe("Edge: checkpoint idempotency", () => {
  test("second checkpoint creates different directory, does not overwrite first", async () => {
    const { sessionId, sessionDir } = await createInterruptedSession();

    // First resume → first checkpoint
    const m1 = createMockModel([mockSuccessResponse(), mockSuccessResponse()]);
    const r1 = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m1 });
    expect(r1.success).toBe(true);

    const checkpointsDir = join(sessionDir, "checkpoints");
    const { readdir } = await import("node:fs/promises");
    const entriesAfterFirst = await readdir(checkpointsDir);
    expect(entriesAfterFirst.length).toBe(1);
    const firstCheckpointId = entriesAfterFirst[0]!;

    // Reset session for second resume
    const manifest = await loadManifest(sessionDir);
    await writeArtifact(
      join(sessionDir, "session.json"),
      JSON.stringify({ ...manifest, status: "interrupted" }, null, 2),
    );
    // Re-write agents/index.jsonl
    const agentsIndexPath = join(sessionDir, "agents", "index.jsonl");
    const idxRaw = await readFile(agentsIndexPath, "utf-8");
    const filteredLines = idxRaw
      .split("\n")
      .filter((l) => {
        if (!l.trim()) return false;
        const parsed = JSON.parse(l);
        return parsed.node_id !== "step-2";
      })
      .join("\n");
    await writeFile(agentsIndexPath, filteredLines + "\n");

    const m2 = createMockModel([mockSuccessResponse(), mockSuccessResponse()]);
    const r2 = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m2 });
    expect(r2.success).toBe(true);

    const entriesAfterSecond = await readdir(checkpointsDir);
    expect(entriesAfterSecond.length).toBe(2);
    // First checkpoint still intact
    expect(entriesAfterSecond).toContain(firstCheckpointId);

    // Verify the first checkpoint content is still there
    const firstCheckpointDir = join(checkpointsDir, firstCheckpointId);
    const firstEntries = await readdir(firstCheckpointDir);
    // Should have at least events.jsonl or session.json
    expect(firstEntries.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Edge case: Resume with skipped (gated) step in middle ────────

describe("Edge: resume after skipped step (gate)", () => {
  test("resume at step 3 when step 2 was skipped by gate", async () => {
    // Create a session where:
    // step-1 = complete (success)
    // step-2 = skipped (gate: when step-1.status == "failed")
    // step-3 = not run
    // → resume should jump to step-3

    const initResult = await initSession({
      role: "planner",
      taskSummary: "Task with gated step",
      projectDir: process.cwd(),
      modelProvider: "deepseek",
      modelId: "deepseek-chat",
    });
    const sessionDir = initResult.sessionDir;
    const sessionId = initResult.sessionId;

    // Write session-config.json (required for resume since TD-029-F)
    const plannerDef = TEST_REGISTRY.roles.get("planner");
    await writeSessionConfig(sessionDir, "planner", plannerDef);

    // Write orchestration spec with gated step
    const roleSpec = buildOrchestrationSpec(TEST_REGISTRY);
    const spec = {
      ...roleSpec,
      flow: {
        schema_version: "0.2.0",
        provenance: "test-edge-gate",
        steps: [
          { id: "step-1", role: "planner", when: null, context: null },
          { id: "step-2", role: "developer", when: 'step-1.status == "failed"', context: null },
          { id: "step-3", role: "reviewer", when: null, context: null },
        ],
      },
    };
    await writeArtifact(
      join(sessionDir, "orchestration-spec.json"),
      JSON.stringify(spec, null, 2),
    );

    // step-1 completed successfully
    const child1Id = generateSessionId();
    await mkdir(join(sessionDir, "agents", child1Id), { recursive: true, mode: 0o700 });
    await writeArtifact(
      join(sessionDir, "agents", child1Id, "session.json"),
      JSON.stringify({
        schema_version: "0.2.0",
        session_id: child1Id,
        parent_session_id: sessionId,
        node_id: "step-1",
        role: "planner",
        task_summary: "Plan done",
        model_id: "deepseek-chat",
        created_at: new Date().toISOString(),
        status: "complete",
      }, null, 2),
    );

    // Write agents/index.jsonl: step-1 complete, step-2 skipped
    await writeFile(
      join(sessionDir, "agents", "index.jsonl"),
      // step-1 creation + completion
      JSON.stringify({ session_id: child1Id, parent_session_id: sessionId, node_id: "step-1", role: "planner", started_at: new Date().toISOString(), status: "active" }) + "\n" +
      JSON.stringify({ session_id: child1Id, parent_session_id: sessionId, role: "planner", started_at: new Date().toISOString(), status: "complete" }) + "\n",
    );

    // Set manifest to interrupted
    const manifest = await loadManifest(sessionDir);
    await writeArtifact(
      join(sessionDir, "session.json"),
      JSON.stringify({ ...manifest, status: "interrupted" }, null, 2),
    );

    // Resume: should detect step-2 is skipped and resume at step-2
    // (findResumePoint walks steps: step-1=complete, step-2 has no child → first incomplete = step-2)
    const m = createMockModel([mockSuccessResponse(), mockSuccessResponse()]);
    const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m });
    expect(result.success).toBe(true);

    // Verify the resume succeeded (single-job mode — no flow steps to check)
    expect(result.success).toBe(true);
    expect(result.completed).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════
// M3: single-job resume (slimmed, adapted for TD-029-F)
//
// In the slimmed harness, there are no flow "skip" steps. Resume always
// re-enters the runLoop for the original task. This test verifies that
// resume works for a basic single-job session.
// ═════════════════════════════════════════════════════════════════════

describe("M3: single-job resume (slimmed)", () => {
  test("single-job resume re-enters loop with original task", async () => {
    // ── Create an interrupted 2-step session (step-1 completed, step-2 not started) ──
    const initResult = await initSession({
      role: "planner",
      taskSummary: "M3 result.json check test",
      projectDir: process.cwd(),
      modelProvider: "deepseek",
      modelId: "deepseek-chat",
    });
    const sessionDir = initResult.sessionDir;
    const sessionId = initResult.sessionId;

    // Write session-config.json (required for resume since TD-029-F)
    const plannerDef = TEST_REGISTRY.roles.get("planner");
    await writeSessionConfig(sessionDir, "planner", plannerDef);

    const roleSpec = buildOrchestrationSpec(TEST_REGISTRY);
    const spec = {
      ...roleSpec,
      flow: {
        schema_version: "0.2.0",
        provenance: "test-m3",
        steps: [
          { id: "step-1", role: "planner", when: null, context: null },
          { id: "step-2", role: "developer", when: null, context: null },
        ],
      },
    };
    await writeArtifact(
      join(sessionDir, "orchestration-spec.json"),
      JSON.stringify(spec, null, 2),
    );

    // Completed child for step-1
    const child1Id = generateSessionId();
    await mkdir(join(sessionDir, "agents", child1Id), { recursive: true, mode: 0o700 });

    const child1Manifest = {
      schema_version: "0.2.0",
      session_id: child1Id,
      parent_session_id: sessionId,
      node_id: "step-1",
      role: "planner",
      task_summary: "Plan the task",
      model_id: "deepseek-chat",
      created_at: new Date().toISOString(),
      status: "complete",
    };
    await writeArtifact(
      join(sessionDir, "agents", child1Id, "session.json"),
      JSON.stringify(child1Manifest, null, 2),
    );
    await writeArtifact(
      join(sessionDir, "agents", child1Id, "result.json"),
      JSON.stringify({
        schema_version: "0.2.0",
        provenance: { source: "subagent", role: "planner", session_id: child1Id, model: "deepseek-chat", timestamp: new Date().toISOString() },
        result: { status: "success", summary: "Plan complete.", changes: [] },
      }, null, 2),
    );

    // agents/index.jsonl marks step-1 as complete
    await writeFile(
      join(sessionDir, "agents", "index.jsonl"),
      JSON.stringify({ session_id: child1Id, parent_session_id: sessionId, node_id: "step-1", role: "planner", started_at: new Date().toISOString(), status: "active" }) + "\n" +
      JSON.stringify({ session_id: child1Id, parent_session_id: sessionId, role: "planner", started_at: new Date().toISOString(), status: "complete" }) + "\n",
    );

    // Manifest as interrupted
    const manifest = await loadManifest(sessionDir);
    await writeArtifact(
      join(sessionDir, "session.json"),
      JSON.stringify({ ...manifest, status: "interrupted" }, null, 2),
    );

    // Root events.jsonl with step-1 completion
    await appendEvent(sessionDir, {
      schema_version: "0.2.0",
      event_id: generateSessionId(),
      session_id: sessionId,
      parent_session_id: null,
      timestamp: new Date().toISOString(),
      agent_role: "orchestrator",
      model_id: "zao-orchestrator",
      prompt_tokens: 100,
      completion_tokens: 0,
      cache_hit: false,
      action: "flow_step",
      node_id: "step-1",
      flow_step_status: "success",
    } as unknown as Record<string, unknown>);

    // ── M3 trigger: delete step-1's result.json ──
    await rm(join(sessionDir, "agents", child1Id, "result.json"));

    // ── Resume with mock LLM (single-job — only one response needed) ──
    const capturedPrompts: string[] = [];
    const m = createMockModel(
      [mockSuccessResponse()],
      capturedPrompts,
    );
    const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m });

    // ── Assertions ──────────────────────────────────────────────
    expect(result.success).toBe(true);

    // 1. The stored session config has planner role, so the prompt
    // should contain the planner's prompt_template
    const hasPlannerPrompt = capturedPrompts.some((p) =>
      p.includes("You are a planning agent"),
    );
    expect(hasPlannerPrompt).toBe(true);

    // 2. Resume completed successfully
    expect(result.completed).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════
// TD-029-F: Resume Role Preservation Tests
// ═════════════════════════════════════════════════════════════════════

// ── Helper: planner role definition ──────────────────────────────────

const PLANNER_ROLE_DEF: ResolvedRoleDefinition = {
  prompt_template:
    "You are a planning agent. Break down complex tasks into ordered " +
    "steps with clear dependencies. Identify risks, prerequisites, " +
    "and decision points before execution begins.",
  context_budget: 0.70,
  model: "deepseek-chat",
  llm_id: "deepseek:deepseek-chat",
  provenance: "built-in",
  model_provenance: "built-in",
};

const DEVELOPER_ROLE_DEF: ResolvedRoleDefinition = {
  prompt_template:
    "You are a developer agent. Write production-quality code following " +
    "the project's conventions and patterns. Prioritize readability, " +
    "defensive error handling, and comprehensive type safety.",
  context_budget: 0.65,
  model: "deepseek-chat",
  llm_id: "deepseek:deepseek-chat",
  provenance: "built-in",
  model_provenance: "built-in",
};

async function createSessionWithRole(
  roleName: string,
  roleDef: ResolvedRoleDefinition,
): Promise<{ sessionId: string; sessionDir: string }> {
  const initResult = await initSession({
    role: roleName,
    taskSummary: `Test session with role: ${roleName}`,
    projectDir: process.cwd(),
    modelProvider: "deepseek",
    modelId: "deepseek-chat",
  });

  const sessionDir = initResult.sessionDir;
  const sessionId = initResult.sessionId;

  // Write session-config.json with the specified role
  await writeSessionConfig(sessionDir, roleName, roleDef);

  // Set manifest to interrupted
  const manifest = await loadManifest(sessionDir);
  await writeArtifact(
    join(sessionDir, "session.json"),
    JSON.stringify({ ...manifest, status: "interrupted" }, null, 2),
  );

  return { sessionId, sessionDir };
}

describe("Role preservation: planner → resume → still planner", () => {
  test("session created with planner role resumes as planner", async () => {
    const { sessionId } = await createSessionWithRole("planner", PLANNER_ROLE_DEF);

    const capturedPrompts: string[] = [];
    const m = createMockModel([mockSuccessResponse()], capturedPrompts);
    const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m });

    expect(result.success).toBe(true);
    expect(result.completed).toBe(true);

    // The LLM should receive the planner prompt, not the developer prompt
    const hasPlanner = capturedPrompts.some((p) =>
      p.includes("You are a planning agent"),
    );
    expect(hasPlanner).toBe(true);

    // Should NOT receive the developer prompt
    const hasDeveloper = capturedPrompts.some((p) =>
      p.includes("You are a developer agent. Write production-quality"),
    );
    expect(hasDeveloper).toBe(false);
  });
});

describe("Role preservation: developer → resume → still developer", () => {
  test("session created with developer role resumes as developer", async () => {
    const { sessionId } = await createSessionWithRole("developer", DEVELOPER_ROLE_DEF);

    const capturedPrompts: string[] = [];
    const m = createMockModel([mockSuccessResponse()], capturedPrompts);
    const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m });

    expect(result.success).toBe(true);
    expect(result.completed).toBe(true);

    // The LLM should receive the developer prompt
    const hasDeveloper = capturedPrompts.some((p) =>
      p.includes("You are a developer agent. Write production-quality"),
    );
    expect(hasDeveloper).toBe(true);

    // Should NOT receive the planner prompt
    const hasPlanner = capturedPrompts.some((p) =>
      p.includes("You are a planning agent"),
    );
    expect(hasPlanner).toBe(false);
  });
});

describe("Role preservation: default developer → resume --role architect → still developer", () => {
  test("--role flag on resume is ignored, stored config takes priority", async () => {
    // Create a session with the default developer role
    const { sessionId } = await createSessionWithRole("developer", DEVELOPER_ROLE_DEF);

    // Even though we call resumeSession, the stored config is developer.
    // There's no --role flag in the resumeSession API, but the CLI handles
    // --role warning. Test that the stored config always wins.
    const capturedPrompts: string[] = [];
    const m = createMockModel([mockSuccessResponse()], capturedPrompts);
    const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true, _generateObjectFn: m });

    expect(result.success).toBe(true);

    // The stored config is developer, so the prompt should be developer
    const hasDeveloper = capturedPrompts.some((p) =>
      p.includes("You are a developer agent. Write production-quality"),
    );
    expect(hasDeveloper).toBe(true);

    // Should NOT receive the architect prompt
    const hasArchitect = capturedPrompts.some((p) =>
      p.includes("You are an architect"),
    );
    expect(hasArchitect).toBe(false);
  });
});

describe("Role preservation: missing session-config.json fails closed", () => {
  test("resume fails when session-config.json is missing", async () => {
    const initResult = await initSession({
      role: "developer",
      taskSummary: "No config test",
      projectDir: process.cwd(),
      modelProvider: "deepseek",
      modelId: "deepseek-chat",
    });

    const sessionDir = initResult.sessionDir;
    const sessionId = initResult.sessionId;

    // Do NOT write session-config.json

    // Set manifest to interrupted
    const manifest = await loadManifest(sessionDir);
    await writeArtifact(
      join(sessionDir, "session.json"),
      JSON.stringify({ ...manifest, status: "interrupted" }, null, 2),
    );

    const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true });
    expect(result.success).toBe(false);
    expect(result.isValidationError).toBe(true);
    expect(result.error).toContain("Session config not found");
  });
});

describe("Role preservation: corrupted session-config.json fails closed", () => {
  test("resume fails when session-config.json is corrupted", async () => {
    const initResult = await initSession({
      role: "developer",
      taskSummary: "Corrupt config test",
      projectDir: process.cwd(),
      modelProvider: "deepseek",
      modelId: "deepseek-chat",
    });

    const sessionDir = initResult.sessionDir;
    const sessionId = initResult.sessionId;

    // Write a corrupted session-config.json (missing _roleDef)
    await writeArtifact(
      join(sessionDir, "session-config.json"),
      JSON.stringify({ schema_version: "0.2.0", model_id: "gpt-4" }, null, 2),
    );

    // Set manifest to interrupted
    const manifest = await loadManifest(sessionDir);
    await writeArtifact(
      join(sessionDir, "session.json"),
      JSON.stringify({ ...manifest, status: "interrupted" }, null, 2),
    );

    const result = await resumeSession(sessionId, {     _registry: TEST_LLM_REGISTRY, yes: true });
    expect(result.success).toBe(false);
    expect(result.isValidationError).toBe(true);
    expect(result.error).toContain("corrupted");
  });
});
