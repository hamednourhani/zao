/**
 * Session Show tests — TD-010-B (T11 subset).
 *
 * Covers:
 * - zao session show <id> output (table + json formats)
 * - Read-only: manifest unchanged after show
 * - Child session id rejected
 * - Missing session → error
 *
 * @module session-show.test
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm, readFile, writeFile, mkdir, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { initSession, writeArtifact } from "../src/core/artifacts.ts";
import { createTestRegistry } from "./fixtures/role-registry.ts";
import type { RoleRegistry } from "../src/schemas/role-definition.ts";
import { generateSessionId } from "../src/core/ids.ts";

// ── Temp Directory Management ──────────────────────────────────────

let testStoreRoot: string;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-show-${crypto.randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

const TEST_REGISTRY: RoleRegistry = createTestRegistry();

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

// ── Helpers ────────────────────────────────────────────────────────

async function createShowableSession(): Promise<{
  sessionId: string;
  sessionDir: string;
}> {
  const initResult = await initSession({
    role: "planner",
    taskSummary: "Demo task for session show",
    projectDir: process.cwd(),
    modelProvider: "deepseek",
    modelId: "deepseek-chat",
  });

  const sessionDir = initResult.sessionDir;
  const sessionId = initResult.sessionId;

  // Write orchestration spec with 2 steps (manually constructed for test)
  const specRoles: Record<string, Record<string, unknown>> = {};
  for (const [name, def] of TEST_REGISTRY.roles) {
    specRoles[name] = {
      prompt_template: def.prompt_template,
      context_budget: def.context_budget,
      model: def.model,
      provenance: def.provenance,
      model_provenance: def.model_provenance,
    };
  }
  const spec = {
    schema_version: "0.2.0",
    generated_at: new Date().toISOString(),
    default_model: TEST_REGISTRY.defaultModel,
    roles: specRoles,
    flow: {
      schema_version: "0.2.0",
      provenance: "test",
      steps: [
        { id: "plan", role: "planner", when: null, context: null },
        { id: "default", role: "developer", when: null, context: null },
      ],
    },
  };
  await writeArtifact(
    join(sessionDir, "orchestration-spec.json"),
    JSON.stringify(spec, null, 2),
  );

  // Create completed child for step "plan"
  const childId = generateSessionId();
  await mkdir(join(sessionDir, "agents", childId), { recursive: true, mode: 0o700 });
  const childManifest = {
    schema_version: "0.2.0",
    session_id: childId,
    parent_session_id: sessionId,
    node_id: "plan",
    role: "planner",
    task_summary: "Plan the work",
    model_id: "deepseek-chat",
    created_at: new Date().toISOString(),
    status: "complete",
  };
  await writeArtifact(
    join(sessionDir, "agents", childId, "session.json"),
    JSON.stringify(childManifest, null, 2),
  );

  // Write agents/index.jsonl
  await writeFile(
    join(sessionDir, "agents", "index.jsonl"),
    JSON.stringify({
      session_id: childId,
      parent_session_id: sessionId,
      node_id: "plan",
      role: "planner",
      started_at: new Date().toISOString(),
      status: "complete",
    }) + "\n",
  );

  return { sessionId, sessionDir };
}

// ═════════════════════════════════════════════════════════════════════
// T11: zao session show output
// ═════════════════════════════════════════════════════════════════════

describe("T11: zao session show", () => {
  test("table format outputs expected fields", async () => {
    const { sessionId } = await createShowableSession();

    // Capture stdout
    let stdout = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    const capture = (s: string) => { stdout += s; return true; };
    process.stdout.write = capture as typeof process.stdout.write;

    try {
      const { handleSessionShow } = await import("../src/cli/session.ts");
      await handleSessionShow({ sessionId, format: "table" });
    } finally {
      process.stdout.write = origWrite;
    }

    expect(stdout).toContain("Session:");
    expect(stdout).toContain("Demo task for session show");
    expect(stdout).toContain("Status:");
    expect(stdout).toContain("Steps:");
    expect(stdout).toContain("plan");
    expect(stdout).toContain("default");
    expect(stdout).toContain("complete"); // plan status
    expect(stdout).toContain("not-run"); // default status
  });

  test("json format outputs valid JSON", async () => {
    const { sessionId } = await createShowableSession();

    let stdout = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    const capture = (s: string) => { stdout += s; return true; };
    process.stdout.write = capture as typeof process.stdout.write;

    try {
      const { handleSessionShow } = await import("../src/cli/session.ts");
      await handleSessionShow({ sessionId, format: "json" });
    } finally {
      process.stdout.write = origWrite;
    }

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.session_id).toBe(sessionId);
    expect(parsed.task).toContain("Demo task");
    expect(parsed.status).toBeDefined();
    expect(parsed.resume_count).toBe(0);
    expect(parsed.steps).toBeInstanceOf(Array);
    expect(parsed.steps.length).toBe(2);
  });

  test("read-only: manifest mtime unchanged after show", async () => {
    const { sessionId, sessionDir } = await createShowableSession();

    const manifestPath = join(sessionDir, "session.json");
    const beforeStat = await fsStat(manifestPath);
    const beforeMtime = beforeStat.mtimeMs;

    // Run session show
    let stdout = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    const capture = (s: string) => { stdout += s; return true; };
    process.stdout.write = capture as typeof process.stdout.write;

    try {
      const { handleSessionShow } = await import("../src/cli/session.ts");
      await handleSessionShow({ sessionId, format: "table" });
    } finally {
      process.stdout.write = origWrite;
    }

    const afterStat = await fsStat(manifestPath);
    expect(afterStat.mtimeMs).toBe(beforeMtime);
    expect(stdout).toContain("Session:");
  });

  test("child session id returns error", async () => {
    const { sessionDir } = await createShowableSession();

    // Find child session id
    const idxRaw = await readFile(
      join(sessionDir, "agents", "index.jsonl"),
      "utf-8",
    );
    let childId = "";
    for (const line of idxRaw.split("\n")) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      childId = parsed.session_id;
      break;
    }

    expect(childId).toBeTruthy();

    const { handleSessionShow } = await import("../src/cli/session.ts");
    const result = await handleSessionShow({ sessionId: childId, format: "table" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("child");
  });

  test("unknown session id returns error", async () => {
    const fakeId = generateSessionId();

    const { handleSessionShow } = await import("../src/cli/session.ts");
    const result = await handleSessionShow({ sessionId: fakeId, format: "table" });

    expect(result.success).toBe(false);
    expect(result.isValidationError).toBe(true);
    expect(result.error).toContain("not found");
  });

  test("json format on session with no child steps shows empty steps array", async () => {
    // Create a session without any child steps (no orchestration-spec.json, no agents/)
    const initResult = await initSession({
      role: "planner",
      taskSummary: "Session with no steps",
      projectDir: process.cwd(),
      modelProvider: "deepseek",
      modelId: "deepseek-chat",
    });
    const sessionId = initResult.sessionId;

    let stdout = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    const capture = (s: string) => { stdout += s; return true; };
    process.stdout.write = capture as typeof process.stdout.write;

    try {
      const { handleSessionShow } = await import("../src/cli/session.ts");
      await handleSessionShow({ sessionId, format: "json" });
    } finally {
      process.stdout.write = origWrite;
    }

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.session_id).toBe(sessionId);
    expect(parsed.steps).toBeInstanceOf(Array);
    expect(parsed.steps.length).toBe(0);
  });

  test("json format on session with no orchestration-spec shows empty steps", async () => {
    // Use a session that has agents/index.jsonl but no orchestration-spec.json
    const { sessionId, sessionDir } = await createShowableSession();

    // Remove the orchestration spec
    const { rm } = await import("node:fs/promises");
    await rm(join(sessionDir, "orchestration-spec.json"), { force: true });

    let stdout = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    const capture = (s: string) => { stdout += s; return true; };
    process.stdout.write = capture as typeof process.stdout.write;

    try {
      const { handleSessionShow } = await import("../src/cli/session.ts");
      await handleSessionShow({ sessionId, format: "json" });
    } finally {
      process.stdout.write = origWrite;
    }

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.session_id).toBe(sessionId);
    expect(parsed.steps).toBeInstanceOf(Array);
    expect(parsed.steps.length).toBe(0);
  });
});
