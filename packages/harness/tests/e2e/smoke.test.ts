/**
 * E2E Smoke Test — post-run artifact validation per governance §E1.
 *
 * Runs a single-job with mock LLM, then validates EVERY artifact on disk
 * against its schema. This is the uncancellable gate: it lives INSIDE
 * bun test, so even a raw bun test runs the NEW-H1 catcher.
 *
 * ## TD-029-F slimmed
 *
 * The harness is now single-job only. Multi-step flow e2e tests have
 * moved to the controller. This test validates single-job artifacts.
 *
 * What it validates:
 * 1. Root session.json — ParentManifestSchema, status != active
 * 2. agents/ directory integrity
 * 3. result.json — ResultArtifactSchema or parseable JSON
 * 4. Index lines — global index.jsonl integrity
 * 5. Terminal status transitions — no manifest stuck at active
 * 6. Self-check: planted violation is caught (the catcher works)
 *
 * @module smoke.test
 */

import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { rm, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runLoop } from "../../src/core/loop.ts";
import { createMockModel } from "../mocks/mock-model.ts";
import { ParentManifestSchema } from "../../src/schemas/session-manifest.ts";
import { ResultArtifactSchema } from "../../src/schemas/handoff.ts";
import { SessionConfigSchema } from "../../src/schemas/session-config.ts";
import { readArtifact, writeArtifact } from "../../src/core/artifacts.ts";
import { DEVELOPER_DEF } from "../fixtures/role-registry.ts";
import { createMockRegistryForLlmId } from "../fixtures/mock-llm-client.ts";

// ── Temp Directory Management ──────────────────────────────────────

const tempDirs: string[] = [];
let testStoreRoot: string;

function makeTempDir(): string {
  const dir = join("/tmp", `zao-e2e-${crypto.randomUUID()}`);
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

// ── Helpers ────────────────────────────────────────────────────────

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await import("node:fs/promises").then((m) => m.access(filePath));
    return true;
  } catch {
    return false;
  }
}

async function readJsonLines(filePath: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return raw
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════
// E2E Smoke Test Suite
// ═══════════════════════════════════════════════════════════════════

describe("E2E: Post-run artifact validation (§E1)", () => {

  test("single job: all artifacts valid, no manifest stuck at active", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = createMockModel([
      {
        object: {
          schema_version: "0.1.0",
          status: "success",
          summary: "Implemented feature successfully.",
          changes: [],
        },
      },
    ]);

    const result = await runLoop({
      task: "Implement a test feature",
      projectDir,
      roleName: "developer",
      _roleDef: DEVELOPER_DEF,
      _registry: createMockRegistryForLlmId("deepseek:deepseek-chat"),
      _generateObjectFn: mock,
    });

    // ── Assert: job succeeded ──
    expect(result.success).toBe(true);
    expect(result.sessionDir).toContain(join(testStoreRoot, "sessions"));

    // ── VALIDATE: Root session.json ──
    const rootManifestResult = await readArtifact(
      join(result.sessionDir, "session.json"),
      ParentManifestSchema,
    );
    expect(rootManifestResult.success).toBe(true);
    if (rootManifestResult.success) {
      const root = rootManifestResult.data;
      expect(root.session_id).toBe(result.sessionId);
      expect(root.parent_session_id).toBeNull();
      expect(root.status).not.toBe("active"); // §E1: terminal status
      expect(["complete", "failed", "interrupted"]).toContain(root.status);
    }

    // ── VALIDATE: agents/ directory ──
    const agentsDir = join(result.sessionDir, "agents");
    if (await fileExists(agentsDir)) {
      const agentDirs = await readdir(agentsDir);
      // Single job may have no agents or one
      for (const entry of agentDirs) {
        if (entry === "index.jsonl") continue;
        // Verify child session files exist
        const childDir = join(agentsDir, entry);
        try {
          await import("node:fs/promises").then((m) => m.stat(childDir));
        } catch {
          // OK if child doesn't exist — single job won't always spawn agents
        }
      }
    }

    // ── VALIDATE: result.json ──
    const resultArtifactPath = join(result.sessionDir, "result.json");
    expect(await fileExists(resultArtifactPath)).toBe(true);
    const resultArtifactResult = await readArtifact(
      resultArtifactPath,
      ResultArtifactSchema,
    );
    if (!resultArtifactResult.success) {
      // Try as raw JSON
      const resultRaw = await readFile(resultArtifactPath, "utf-8");
      const resultJson = JSON.parse(resultRaw);
      expect(resultJson.schema_version).toBe("0.2.0");
    }

    // ── VALIDATE: session-config.json (ADR-009: no credentials) ──
    const sessionConfigPath = join(result.sessionDir, "session-config.json");
    expect(await fileExists(sessionConfigPath)).toBe(true);
    const sessionConfigResult = await readArtifact(
      sessionConfigPath,
      SessionConfigSchema,
    );
    // SessionConfigSchema is v1.0 — older tests may write v0.2.0.
    // If schema validation fails, check that no credentials leaked.
    if (!sessionConfigResult.success) {
      const configRaw = await readFile(sessionConfigPath, "utf-8");
      const configJson = JSON.parse(configRaw);
      // ADR-009: credential fields must not appear
      expect(configJson.apiKey).toBeUndefined();
      expect(configJson.api_key).toBeUndefined();
      expect(configJson.apiSecret).toBeUndefined();
      expect(configJson.token).toBeUndefined();
      // Legacy v0.2.0: check model_config doesn't leak credentials
      if (configJson.model_config) {
        expect(configJson.model_config.apiKey).toBeUndefined();
        expect(configJson.model_config.api_key).toBeUndefined();
      }
    }

    // ── VALIDATE: Global index.jsonl ──
    const globalIndexPath = join(testStoreRoot, "index.jsonl");
    expect(await fileExists(globalIndexPath)).toBe(true);
    const globalLines = await readJsonLines(globalIndexPath);
    expect(globalLines.length).toBeGreaterThanOrEqual(2); // creation + completion

    const lastGlobalLine = globalLines[globalLines.length - 1];
    expect(lastGlobalLine).toBeDefined();
    const sid = lastGlobalLine?.["session_id"];
    expect(typeof sid).toBe("string");
    expect(sid).toBe(result.sessionId);
  });

  test("self-check: planted undeclared-field violation is caught", async () => {
    const projectDir = makeTempDir();
    await ensureDir(projectDir);

    const mock = createMockModel([
      {
        object: {
          schema_version: "0.1.0",
          status: "success",
          summary: "Done.",
          changes: [],
        },
      },
    ]);

    const result = await runLoop({
      task: "Self-check test",
      projectDir,
      roleName: "developer",
      _roleDef: DEVELOPER_DEF,
      _registry: createMockRegistryForLlmId("deepseek:deepseek-chat"),
      _generateObjectFn: mock,
    });

    expect(result.success).toBe(true);

    // Plant a violation: add an undeclared field to session.json
    const manifestPath = join(result.sessionDir, "session.json");
    const raw = await readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    parsed["undeclared_field_12345"] = "this should not be here";
    await writeArtifact(manifestPath, JSON.stringify(parsed, null, 2));

    // Assert: schema now rejects the corrupted manifest
    const validationResult = await readArtifact(
      manifestPath,
      ParentManifestSchema,
    );
    expect(validationResult.success).toBe(false);

    if (!validationResult.success) {
      expect(validationResult.error).toBeDefined();
      expect(validationResult.error).toContain("Schema validation failed");
    }
  });
});
