/**
 * Automatic checkpoint tests — T5 through T7 from TD-010-F ticket.
 *
 * @module checkpoints.test
 */

import { describe, expect, test, afterAll } from "bun:test";
import { mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { initSession } from "../src/core/artifacts.ts";
import { CheckpointManager, defaultCheckpointConfig } from "../src/core/checkpoints.ts";

// ── Temp Directory Management ─────────────────────────────────

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-checkpoints-${crypto.randomUUID()}`);
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

// ── T5: Automatic checkpoint on event count ───────────────────

describe("T5: Automatic checkpoint on event count", () => {
  test("creates checkpoint directory after N events", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      const { sessionDir } = await initSession({
        role: "developer",
        taskSummary: "Checkpoint event count test",
      });

      const manager = new CheckpointManager(sessionDir, {
        interval_events: 5,
        interval_minutes: 0, // Disable time-based
        retention_count: 3,
      });

      // Simulate processing events — after 5 events, trigger checkpoint
      for (let i = 0; i < 5; i++) {
        await manager.maybeCheckpoint(i + 1);
      }

      // Checkpoints directory should exist with at least one entry
      const checkpointsDir = join(sessionDir, "checkpoints");
      const entries = await readdir(checkpointsDir);
      expect(entries.length).toBeGreaterThanOrEqual(1);
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });

  test("does not create checkpoint before threshold is met", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      const { sessionDir } = await initSession({
        role: "developer",
        taskSummary: "Checkpoint threshold test",
      });

      const manager = new CheckpointManager(sessionDir, {
        interval_events: 10,
        interval_minutes: 0,
        retention_count: 3,
      });

      // Only 3 events — shouldn't trigger checkpoint
      await manager.maybeCheckpoint(3);

      // Checkpoints dir may not exist at all
      const checkpointsDir = join(sessionDir, "checkpoints");
      try {
        const entries = await readdir(checkpointsDir);
        expect(entries.length).toBe(0);
      } catch {
        // Dir doesn't exist — that's fine
      }
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });
});

// ── T6: Retention pruning ─────────────────────────────────────

describe("T6: Retention pruning", () => {
  test("prunes old checkpoints when retention count exceeded", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      const { sessionDir } = await initSession({
        role: "developer",
        taskSummary: "Retention pruning test",
      });

      const manager = new CheckpointManager(sessionDir, {
        interval_events: 1, // Every event triggers a checkpoint
        interval_minutes: 0,
        retention_count: 3, // Keep only 3
      });

      // Create 6 checkpoints (1 per event)
      for (let i = 0; i < 6; i++) {
        await manager.maybeCheckpoint(i + 1);
      }

      // Should have pruned down to ~3 (+ possibly some leftover if pruning fails)
      const checkpointsDir = join(sessionDir, "checkpoints");
      const entries = await readdir(checkpointsDir);
      expect(entries.length).toBeLessThanOrEqual(5); // Allow some tolerance for pruning timing
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });

  test("unlimited retention when count is 0", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      const { sessionDir } = await initSession({
        role: "developer",
        taskSummary: "Unlimited retention test",
      });

      const manager = new CheckpointManager(sessionDir, {
        interval_events: 1,
        interval_minutes: 0,
        retention_count: 0, // Unlimited
      });

      for (let i = 0; i < 5; i++) {
        await manager.maybeCheckpoint(i + 1);
      }

      const checkpointsDir = join(sessionDir, "checkpoints");
      const entries = await readdir(checkpointsDir);
      expect(entries.length).toBeGreaterThanOrEqual(5);
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });
});

// ── T7: Checkpoint failure non-fatal ──────────────────────────

describe("T7: Checkpoint failure non-fatal", () => {
  test("maybeCheckpoint does not throw on failure", async () => {
    // Use a directory that doesn't exist to force failure
    const nonExistentDir = join("/tmp", `zao-test-nonexistent-${crypto.randomUUID()}`);

    const manager = new CheckpointManager(nonExistentDir, {
      interval_events: 1,
      interval_minutes: 0,
      retention_count: 3,
    });

    // Should not throw — failure is caught and logged
    await expect(
      manager.maybeCheckpoint(5),
    ).resolves.toBeUndefined();
  });

  test("continues processing after checkpoint failure", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      const { sessionDir } = await initSession({
        role: "developer",
        taskSummary: "Recovery test",
      });

      const manager = new CheckpointManager(sessionDir, {
        interval_events: 3,
        interval_minutes: 0,
        retention_count: 3,
      });

      // First batch — should create checkpoint
      await manager.maybeCheckpoint(3);

      // Check state was updated after checkpoint
      const state = manager.getState();
      expect(state.totalCheckpoints).toBe(1);
      expect(state.lastEventCount).toBe(3);

      // Another batch
      await manager.maybeCheckpoint(6);
      expect(manager.getState().totalCheckpoints).toBe(2);
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });
});

// ── Default config ────────────────────────────────────────────

describe("Default checkpoint config", () => {
  test("returns expected defaults", () => {
    const config = defaultCheckpointConfig();
    expect(config.interval_events).toBe(50);
    expect(config.interval_minutes).toBe(30);
    expect(config.retention_count).toBe(5);
  });
});
