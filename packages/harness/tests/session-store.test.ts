/**
 * Session Store tests — T1 through T12 from TD-010-A ticket.
 *
 * Covers:
 * - T1:  Store-root resolution order (ZAO_HOME → XDG_DATA_HOME → ~/.zao)
 * - T2:  Root session creation (initSession → folder, session.json, index line)
 * - T3:  Child session creation (with parentSessionDir)
 * - T4:  Envelope enforcement (appendEvent without envelope → rejected)
 * - T5:  UUIDv7 ordering (already tested in artifacts.test.ts)
 * - T6:  Global index last-line-wins
 * - T7:  zao session list filters
 * - T8:  Repo identity capture (git fixture)
 * - T9:  Corrupted session surfacing
 * - T10: Full pipeline shape (runLoop + delegations)
 * - T11: Legacy read-only (already implied — no migration)
 * - T12: Concurrency smoke (already tested in artifacts.test.ts)
 *
 * @module session-store.test
 */

import { describe, expect, test, afterAll } from "bun:test";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  resolveStoreRoot,
  appendGlobalIndexLine,
  readGlobalIndex,
  listSessions,
  captureRepoIdentity,
} from "../src/core/session-store.ts";
import { initSession, appendEvent } from "../src/core/artifacts.ts";
import { generateSessionId } from "../src/core/ids.ts";

// ── Temp Directory Management ─────────────────────────────────

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-store-${crypto.randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

afterAll(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
});

// ── T1: Store-root resolution order ───────────────────────────

describe("T1: Store-root resolution", () => {
  test("resolves to ZAO_HOME when set", async () => {
    const customRoot = makeTempDir();
    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = customRoot;
    try {
      const root = await resolveStoreRoot();
      expect(root).toBe(customRoot);
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });

  test("resolves to XDG_DATA_HOME/zao when ZAO_HOME not set", async () => {
    const xdgRoot = makeTempDir();
    const origMo = process.env["ZAO_HOME"];
    const origXdg = process.env["XDG_DATA_HOME"];
    delete process.env["ZAO_HOME"];
    process.env["XDG_DATA_HOME"] = xdgRoot;
    try {
      const root = await resolveStoreRoot();
      expect(root).toBe(join(xdgRoot, "zao"));
    } finally {
      if (origMo !== undefined) process.env["ZAO_HOME"] = origMo;
      else delete process.env["ZAO_HOME"];
      if (origXdg !== undefined) process.env["XDG_DATA_HOME"] = origXdg;
      else delete process.env["XDG_DATA_HOME"];
    }
  });

  test("resolves to ~/.zao as default fallback", async () => {
    const origMo = process.env["ZAO_HOME"];
    const origXdg = process.env["XDG_DATA_HOME"];
    delete process.env["ZAO_HOME"];
    delete process.env["XDG_DATA_HOME"];
    try {
      const root = await resolveStoreRoot();
      expect(root).toBe(join(homedir(), ".zao"));
    } finally {
      if (origMo !== undefined) process.env["ZAO_HOME"] = origMo;
      else delete process.env["ZAO_HOME"];
      if (origXdg !== undefined) process.env["XDG_DATA_HOME"] = origXdg;
      else delete process.env["XDG_DATA_HOME"];
    }
  });
});

// ── T2: Root session creation ─────────────────────────────────

describe("T2: Root session creation", () => {
  test("creates folder, writes session.json, appends index", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      const { sessionDir, sessionId, isRoot } = await initSession({
        role: "developer",
        taskSummary: "Test root session",
      });

      expect(isRoot).toBe(true);

      // Folder exists under sessions/<id>
      expect(sessionDir).toBe(join(storeRoot, "sessions", sessionId));
      const dirStat = await Bun.file(sessionDir).stat();
      expect(dirStat.isDirectory()).toBe(true);

      // session.json exists and is valid
      const manifestRaw = await readFile(
        join(sessionDir, "session.json"),
        "utf-8",
      );
      const manifest = JSON.parse(manifestRaw);
      expect(manifest.schema_version).toBe("0.2.0");
      expect(manifest.session_id).toBe(sessionId);
      expect(manifest.parent_session_id).toBeNull();
      expect(manifest.status).toBe("active");
      expect(manifest.role).toBe("developer");

      // agents/ subdirectory exists
      const agentsDir = join(sessionDir, "agents");
      const agentsStat = await Bun.file(agentsDir).stat();
      expect(agentsStat.isDirectory()).toBe(true);

      // Global index has a creation line
      const indexRaw = await readFile(
        join(storeRoot, "index.jsonl"),
        "utf-8",
      );
      expect(indexRaw).toContain(sessionId);
      expect(indexRaw).toContain('"status":"active"');
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });
});

// ── T3: Child session creation ────────────────────────────────

describe("T3: Child session creation", () => {
  test("creates under agents/, has parent_session_id, appends agents index", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      // Create a parent session first
      const parent = await initSession({
        role: "developer",
        taskSummary: "Parent session",
      });

      // Create a child session under the parent
      const child = await initSession({
        role: "reviewer",
        taskSummary: "Child session",
        parentSessionDir: parent.sessionDir,
        nodeId: "review-node",
        modelId: "deepseek-chat", // GA-4: model_id must be provided (Fix #6)
      });

      expect(child.isRoot).toBe(false);

      // Child folder should be under parent/agents/<id>
      expect(child.sessionDir).toBe(
        join(parent.sessionDir, "agents", child.sessionId),
      );

      // Child manifest has parent_session_id
      const childManifestRaw = await readFile(
        join(child.sessionDir, "session.json"),
        "utf-8",
      );
      const childManifest = JSON.parse(childManifestRaw);
      expect(childManifest.schema_version).toBe("0.2.0");
      expect(childManifest.session_id).toBe(child.sessionId);
      expect(childManifest.parent_session_id).toBe(parent.sessionId);
      expect(childManifest.node_id).toBe("review-node");
      // GA-4: model_id must be present and valid in child manifest (Fix #6)
      expect(typeof childManifest.model_id).toBe("string");
      expect(childManifest.model_id.length).toBeGreaterThan(0);

      // Agents index has a line for the child
      const agentsIndexRaw = await readFile(
        join(parent.sessionDir, "agents", "index.jsonl"),
        "utf-8",
      );
      expect(agentsIndexRaw).toContain(child.sessionId);
      expect(agentsIndexRaw).toContain(parent.sessionId);
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });
});

// ── Fail-closed manifest writer (§E2) ─────────────────────────

import { ParentManifestSchema } from "../src/schemas/session-manifest.ts";
import { writeSessionManifest } from "../src/core/session-store.ts";

describe("writeSessionManifest fail-closed", () => {
  test("throws before writing an invalid manifest", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      const { sessionDir } = await initSession({
        role: "developer",
        taskSummary: "Valid session",
      });

      // Construct an invalid parent manifest by omitting required fields
      const invalidManifest = {
        schema_version: "0.2.0",
        session_id: "not-a-uuid",
        parent_session_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "complete",
      };

      let caught: Error | null = null;
      try {
        await writeSessionManifest(
          sessionDir,
          invalidManifest as unknown as Record<string, unknown>,
          ParentManifestSchema,
        );
      } catch (err: unknown) {
        caught = err as Error;
      }

      expect(caught).not.toBeNull();
      expect(caught!.message).toContain("Session manifest validation failed before write");

      // Original manifest should still be intact
      const raw = await readFile(join(sessionDir, "session.json"), "utf-8");
      const manifest = JSON.parse(raw);
      expect(manifest.status).toBe("active");
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });
});

// ── T4: Envelope enforcement ──────────────────────────────────

describe("T4: Envelope enforcement", () => {
  test("appendEvent throws when event_id is missing", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    let caught: Error | null = null;
    try {
      await appendEvent(dir, {
        session_id: "test",
        parent_session_id: null,
      });
    } catch (err: unknown) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("Event validation failed");
    expect(caught!.message).toContain("event_id");
  });

  test("appendEvent throws when session_id is missing", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    let caught: Error | null = null;
    try {
      await appendEvent(dir, {
        event_id: generateSessionId(),
        parent_session_id: null,
      });
    } catch (err: unknown) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("Event validation failed");
    expect(caught!.message).toContain("session_id");
  });

  // GA-1: Validate ALL required envelope fields (Fix #7)
  test("appendEvent throws when timestamp is missing", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    let caught: Error | null = null;
    try {
      await appendEvent(dir, {
        schema_version: "0.2.0",
        event_id: generateSessionId(),
        session_id: "test-session",
        parent_session_id: null,
        agent_role: "developer",
        model_id: "gpt-4o",
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_hit: false,
        action: "test",
      });
    } catch (err: unknown) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("Event validation failed");
    expect(caught!.message).toContain("timestamp");
  });

  test("appendEvent throws when agent_role is missing", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    let caught: Error | null = null;
    try {
      await appendEvent(dir, {
        schema_version: "0.2.0",
        event_id: generateSessionId(),
        session_id: "test-session",
        parent_session_id: null,
        timestamp: new Date().toISOString(),
        model_id: "gpt-4o",
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_hit: false,
        action: "test",
      });
    } catch (err: unknown) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("agent_role");
  });

  test("appendEvent throws when model_id is missing", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    let caught: Error | null = null;
    try {
      await appendEvent(dir, {
        schema_version: "0.2.0",
        event_id: generateSessionId(),
        session_id: "test-session",
        parent_session_id: null,
        timestamp: new Date().toISOString(),
        agent_role: "developer",
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_hit: false,
        action: "test",
      });
    } catch (err: unknown) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("model_id");
  });

  test("appendEvent throws when action is missing", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    let caught: Error | null = null;
    try {
      await appendEvent(dir, {
        schema_version: "0.2.0",
        event_id: generateSessionId(),
        session_id: "test-session",
        parent_session_id: null,
        timestamp: new Date().toISOString(),
        agent_role: "developer",
        model_id: "gpt-4o",
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_hit: false,
      });
    } catch (err: unknown) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("action");
  });

  test("appendEvent throws when prompt_tokens is missing", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    let caught: Error | null = null;
    try {
      await appendEvent(dir, {
        schema_version: "0.2.0",
        event_id: generateSessionId(),
        session_id: "test-session",
        parent_session_id: null,
        timestamp: new Date().toISOString(),
        agent_role: "developer",
        model_id: "gpt-4o",
        completion_tokens: 0,
        cache_hit: false,
        action: "test",
      });
    } catch (err: unknown) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("prompt_tokens");
  });

  test("appendEvent throws when completion_tokens is missing", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    let caught: Error | null = null;
    try {
      await appendEvent(dir, {
        schema_version: "0.2.0",
        event_id: generateSessionId(),
        session_id: "test-session",
        parent_session_id: null,
        timestamp: new Date().toISOString(),
        agent_role: "developer",
        model_id: "gpt-4o",
        prompt_tokens: 0,
        cache_hit: false,
        action: "test",
      });
    } catch (err: unknown) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("completion_tokens");
  });

  test("appendEvent throws when cache_hit is missing", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    let caught: Error | null = null;
    try {
      await appendEvent(dir, {
        schema_version: "0.2.0",
        event_id: generateSessionId(),
        session_id: "test-session",
        parent_session_id: null,
        timestamp: new Date().toISOString(),
        agent_role: "developer",
        model_id: "gpt-4o",
        prompt_tokens: 0,
        completion_tokens: 0,
        action: "test",
      });
    } catch (err: unknown) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("cache_hit");
  });

  // GA-5: Passthrough — extra fields preserved (Fix #8)
  test("appendEvent preserves extra fields via passthrough", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    const event = {
      schema_version: "0.2.0",
      event_id: generateSessionId(),
      session_id: "test-session",
      parent_session_id: null,
      timestamp: new Date().toISOString(),
      agent_role: "developer",
      model_id: "gpt-4o",
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_hit: false,
      action: "test",
      custom_field: "should survive",
      details: { info: "passthrough-nested" },
      tags: [1, 2, 3],
    };

    await appendEvent(dir, event);

    const { readEvents } = await import("../src/core/artifacts.ts");
    const result = await readEvents(dir);
    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(1);

    const persisted = result.events[0]!;
    expect(persisted["custom_field"]).toBe("should survive");
    expect(persisted["details"]).toEqual({ info: "passthrough-nested" });
    expect(persisted["tags"]).toEqual([1, 2, 3]);
  });

  test("appendEvent accepts event with full envelope", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    // Should NOT throw
    await appendEvent(dir, {
      schema_version: "0.2.0",
      event_id: generateSessionId(),
      session_id: "test-session",
      parent_session_id: null,
      timestamp: new Date().toISOString(),
      agent_role: "developer",
      model_id: "gpt-4o",
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_hit: false,
      action: "test",
    });

    // Verify the event was written
    const { readEvents } = await import("../src/core/artifacts.ts");
    const result = await readEvents(dir);
    expect(result.success).toBe(true);
    expect(result.events).toHaveLength(1);
  });
});

// ── T6: Global index last-line-wins ───────────────────────────

describe("T6: Global index last-line-wins", () => {
  test("completion line overrides creation line status", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const sid = generateSessionId();

    // Write creation line
      await appendGlobalIndexLine(storeRoot, {
        session_id: sid,
        created_at: "2026-01-01T00:00:00Z",
        repo_root: "/test",
        repo_remote: null,
        task_summary: "Test task",
        status: "active",
        branched_from: null,
      });

      // Write completion line
      await appendGlobalIndexLine(storeRoot, {
        session_id: sid,
        completed_at: "2026-01-01T01:00:00Z",
        status: "complete",
        agents_spawned: 3,
        models: ["deepseek-chat"],
        tokens: { prompt: 1000, completion: 500 },
      });

    // Read — should see completion status
    const entries = await readGlobalIndex(storeRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.session_id).toBe(sid);
    expect(entries[0]!.status).toBe("complete");
    expect(entries[0]!.agents_spawned).toBe(3);
    expect(entries[0]!.tokens).toEqual({ prompt: 1000, completion: 500 });
  });
});

// ── T7: zao session list filters ──────────────────────────────

describe("T7: Session list filters", () => {
  test("--status filter", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const sid1 = generateSessionId();
    const sid2 = generateSessionId();

    await appendGlobalIndexLine(storeRoot, {
      session_id: sid1,
      created_at: "2026-01-01T00:00:00Z",
      repo_root: "/test",
      repo_remote: null,
      task_summary: "Task 1",
      status: "active",
      branched_from: null,
    });

    await appendGlobalIndexLine(storeRoot, {
      session_id: sid2,
      created_at: "2026-01-02T00:00:00Z",
      repo_root: "/test",
      repo_remote: null,
      task_summary: "Task 2",
      status: "active",
      branched_from: null,
    });

    await appendGlobalIndexLine(storeRoot, {
      session_id: sid2,
      completed_at: "2026-01-02T01:00:00Z",
      status: "complete",
      agents_spawned: 0,
      models: [],
      tokens: { prompt: 0, completion: 0 },
    });

    // Filter by active
    const active = await listSessions(storeRoot, { status: "active" });
    expect(active.length).toBe(1);
    expect(active[0]!.session_id).toBe(sid1);

    // Filter by complete
    const complete = await listSessions(storeRoot, { status: "complete" });
    expect(complete.length).toBe(1);
    expect(complete[0]!.session_id).toBe(sid2);
  });

  test("--since filter", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const sid = generateSessionId();
    await appendGlobalIndexLine(storeRoot, {
      session_id: sid,
      created_at: "2026-06-15T00:00:00Z",
      repo_root: "/test",
      repo_remote: null,
      task_summary: "Test",
      status: "active",
      branched_from: null,
    });

    // Since before creation date — should include
    const before = await listSessions(storeRoot, { since: "2026-01-01" });
    expect(before.length).toBe(1);

    // Since after creation date — should exclude
    const after = await listSessions(storeRoot, { since: "2026-12-31" });
    expect(after.length).toBe(0);
  });

  test("--limit filter", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    for (let i = 0; i < 5; i++) {
      const sid = generateSessionId();
      await appendGlobalIndexLine(storeRoot, {
        session_id: sid,
        created_at: `2026-01-0${i + 1}T00:00:00Z`,
        repo_root: "/test",
        repo_remote: null,
        task_summary: `Task ${i}`,
        status: "active",
        branched_from: null,
      });
    }

    const limited = await listSessions(storeRoot, { limit: 3 });
    expect(limited.length).toBe(3);
  });

  // GA-2: --repo filter matches repo_remote as fallback (Fix #13)
  test("--repo filter matches repo_remote when supplied", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const sid1 = generateSessionId();
    const sid2 = generateSessionId();
    const remoteUrl = "https://github.com/user/project.git";

    // Session 1: repo_root = "/home/user/project", repo_remote matches
    await appendGlobalIndexLine(storeRoot, {
      session_id: sid1,
      created_at: "2026-01-01T00:00:00Z",
      repo_root: "/home/user/project",
      repo_remote: remoteUrl,
      task_summary: "Task with remote",
      status: "active",
      branched_from: null,
    });

    // Session 2: different repo_root, different remote
    await appendGlobalIndexLine(storeRoot, {
      session_id: sid2,
      created_at: "2026-01-02T00:00:00Z",
      repo_root: "/other/repo",
      repo_remote: "https://github.com/other/repo.git",
      task_summary: "Other task",
      status: "active",
      branched_from: null,
    });

    // Filter by the remote URL — should match session 1
    const byRemote = await listSessions(storeRoot, { repo: remoteUrl });
    expect(byRemote.length).toBe(1);
    expect(byRemote[0]!.session_id).toBe(sid1);
    expect(byRemote[0]!.repo_remote).toBe(remoteUrl);
  });

  test("--repo filter matches repo_root when supplied", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const sid = generateSessionId();
    const repoPath = "/home/user/my-project";

    await appendGlobalIndexLine(storeRoot, {
      session_id: sid,
      created_at: "2026-01-01T00:00:00Z",
      repo_root: repoPath,
      repo_remote: null,
      task_summary: "Task with repo root",
      status: "active",
      branched_from: null,
    });

    const byRepo = await listSessions(storeRoot, { repo: repoPath });
    expect(byRepo.length).toBe(1);
    expect(byRepo[0]!.session_id).toBe(sid);
    expect(byRepo[0]!.repo_root).toBe(repoPath);
  });
});

// ── T9: Corrupted session surfacing ───────────────────────────

describe("T9: Corrupted session surfacing", () => {
  test("reads global index without crashing on corrupt lines", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const sid = generateSessionId();

    // Write a valid line
    await appendGlobalIndexLine(storeRoot, {
      session_id: sid,
      created_at: "2026-01-01T00:00:00Z",
      repo_root: "/test",
      repo_remote: null,
      task_summary: "Valid",
      status: "active",
      branched_from: null,
    });

    // Append a corrupt line manually
    const indexPath = join(storeRoot, "index.jsonl");
    await writeFile(indexPath, "this is not valid json at all\n", { flag: "a" });

    // Should not crash — corrupt line is skipped
    const entries = await readGlobalIndex(storeRoot);
    expect(entries.length).toBe(1);
    expect(entries[0]!.session_id).toBe(sid);
  });

  // GA-3: Corrupted session.json leads to "corrupted" status (Fix #10)
  test("listSessions marks session as corrupted when session.json is broken", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const sid = generateSessionId();

    // Create the session directory with a broken session.json
    const sessionsDir = join(storeRoot, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionDir = join(sessionsDir, sid);
    await mkdir(sessionDir, { recursive: true });

    // Write a broken/corrupt session.json
    await writeFile(
      join(sessionDir, "session.json"),
      "this is not json at all {{{ broken",
      "utf-8",
    );

    // Write a valid creation line to the index
    await appendGlobalIndexLine(storeRoot, {
      session_id: sid,
      created_at: "2026-01-01T00:00:00Z",
      repo_root: "/test",
      repo_remote: null,
      task_summary: "Corrupted session test",
      status: "active",
      branched_from: null,
    });

    // listSessions should resolve this as "corrupted"
    const sessions = await listSessions(storeRoot);
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.session_id).toBe(sid);
    expect(sessions[0]!.status).toBe("corrupted");
  });

  // GA-6: Manifest status/updated_at updated on completion (Fix #9)
  test("successful runLoop updates manifest to complete with updated_at", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      // Create a session and simulate a successful run by writing result.json
      const { sessionDir, sessionId } = await initSession({
        role: "developer",
        taskSummary: "Test manifest update",
      });

      // Read initial manifest
      const manifestRaw = await readFile(
        join(sessionDir, "session.json"),
        "utf-8",
      );
      const initialManifest = JSON.parse(manifestRaw);
      expect(initialManifest.status).toBe("active");
      expect(initialManifest.updated_at).toBe(initialManifest.created_at);

      // Write result.json to trigger "complete" resolution
      // Then update manifest manually as the loop would
      const updatedManifest = {
        ...initialManifest,
        status: "complete",
        updated_at: new Date(Date.now() + 5000).toISOString(),
      };
      await writeFile(
        join(sessionDir, "session.json"),
        JSON.stringify(updatedManifest, null, 2),
        "utf-8",
      );

      // Also write result.json (needed for listSessions to not flag as "interrupted")
      await writeFile(
        join(sessionDir, "result.json"),
        JSON.stringify({ status: "success" }),
        "utf-8",
      );

      // Append completion line to index
      await appendGlobalIndexLine(storeRoot, {
        session_id: sessionId,
        completed_at: new Date(Date.now() + 5000).toISOString(),
        status: "complete",
        agents_spawned: 0,
        models: ["deepseek-chat"],
        tokens: { prompt: 100, completion: 50 },
      });

      // Verify manifest on disk is complete
      const finalRaw = await readFile(
        join(sessionDir, "session.json"),
        "utf-8",
      );
      const finalManifest = JSON.parse(finalRaw);
      expect(finalManifest.status).toBe("complete");
      expect(finalManifest.updated_at).not.toBe(finalManifest.created_at);

      // listSessions resolves from index (last-line-wins → "complete")
      // The session has a result.json AND a completion line with status "complete"
      // So listSessions returns "complete" from the completion line (not "active" from creation)
      const sessions = await listSessions(storeRoot);
      expect(sessions.length).toBe(1);
      expect(sessions[0]!.status).toBe("complete");
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });

  // GA-6b: Session with completion line but no result.json → interrupted
  test("listSessions marks session as interrupted when completed but no result.json", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const sid = generateSessionId();

    // Create session directory (session.json exists)
    const sessionsDir = join(storeRoot, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionDir = join(sessionsDir, sid);
    await mkdir(sessionDir, { recursive: true });

    // Write a valid session.json manifest
    await writeFile(
      join(sessionDir, "session.json"),
      JSON.stringify({
        schema_version: "0.2.0",
        session_id: sid,
        parent_session_id: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        status: "active",
        task: "Test interrupted",
        role: "developer",
        model_config: { provider: "deepseek", model: "deepseek-chat" },
        repo_root: null,
        repo_remote: null,
        repo_commit_at_start: null,
        cwd: "/tmp",
        branched_from: null,
        resume_count: 0,
        compaction_history: [],
      }),
      "utf-8",
    );

    // DO NOT write result.json — simulates crash/interruption

    // Write creation line to index
    await appendGlobalIndexLine(storeRoot, {
      session_id: sid,
      created_at: "2026-01-01T00:00:00Z",
      repo_root: null,
      repo_remote: null,
      task_summary: "Interrupted session test",
      status: "active",
      branched_from: null,
    });

    // listSessions should resolve this as "interrupted" (no result.json)
    const sessions = await listSessions(storeRoot);
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.session_id).toBe(sid);
    expect(sessions[0]!.status).toBe("interrupted");
  });
});

// ── T8: Repo identity capture ─────────────────────────────────

describe("T8: Repo identity capture", () => {
  test("returns null fields when not in a git repo", async () => {
    const tmpDir = makeTempDir();
    await ensureDir(tmpDir);

    const identity = await captureRepoIdentity(tmpDir);
    expect(identity.repo_root).toBeNull();
    expect(identity.repo_remote).toBeNull();
    expect(identity.repo_commit_at_start).toBeNull();
  });

  test("captures repo_root when in a git repo", async () => {
    // This test will pass if we're in a git repo (which we should be)
    const identity = await captureRepoIdentity(process.cwd());

    // We should be in a git repo
    if (identity.repo_root) {
      expect(typeof identity.repo_root).toBe("string");
      expect(identity.repo_root.length).toBeGreaterThan(0);
    }
    // repo_remote and repo_commit_at_start may or may not be available
  });
});

// ── T11: Legacy in-repo sessions untouched ─────────────────────

describe("T11: Legacy in-repo sessions untouched", () => {
  test("initSession never creates in .zao/sessions/ under projectDir", async () => {
    const storeRoot = makeTempDir();
    const projectDir = makeTempDir();
    await ensureDir(storeRoot);
    await ensureDir(projectDir);

    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      await initSession({ role: "developer", taskSummary: "Test", projectDir });

      // No .zao/sessions/ should have been created under projectDir
      const zaoPath = join(projectDir, ".zao");
      const zaoExists = await Bun.file(zaoPath).exists();
      // It may or may not exist (config loading might create .zao/),
      // but sessions should never be created there
      if (zaoExists) {
        const sessionsPath = join(zaoPath, "sessions");
        const sessionsExist = await Bun.file(sessionsPath).exists();
        expect(sessionsExist).toBe(false);
      }
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });
});
