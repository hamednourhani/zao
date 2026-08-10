/**
 * Session branching tests — T1 through T5 from TD-010-F ticket.
 *
 * @module branch.test
 */

import { describe, expect, test, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { initSession } from "../src/core/artifacts.ts";
import { findSessionDir, loadManifest, readGlobalIndex } from "../src/core/session-store.ts";
import { branchSession } from "../src/core/branch.ts";

// ── Temp Directory Management ─────────────────────────────────

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-branch-${crypto.randomUUID()}`);
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

// ── T1: Branch creates peer parent ────────────────────────────

describe("T1: Branch creates peer parent", () => {
  test("creates new session with branched_from in manifest and index", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      // Create a source session
      const { sessionId: sourceId, sessionDir: _sourceDir } = await initSession({
        role: "developer",
        taskSummary: "Source session",
      });

      // Branch from it
      const branchId = await branchSession(sourceId);

      // Branch ID should be different from source
      expect(branchId).not.toBe(sourceId);
      expect(typeof branchId).toBe("string");
      expect(branchId.length).toBeGreaterThan(0);

      // Branch folder should exist as a peer in sessions/
      const branchDir = join(storeRoot, "sessions", branchId);
      const branchStat = await Bun.file(branchDir).stat();
      expect(branchStat.isDirectory()).toBe(true);

      // Branch manifest should have branched_from populated
      const branchManifest = await loadManifest(branchDir);
      expect(branchManifest.session_id).toBe(branchId);
      expect(branchManifest.branched_from).not.toBeNull();
      if (branchManifest.branched_from) {
        expect(branchManifest.branched_from.session_id).toBe(sourceId);
        expect(branchManifest.branched_from.checkpoint_id).toBeNull();
      }

      // Global index should have branched_from in the creation line
      const globalEntries = await readGlobalIndex(storeRoot);
      const branchEntry = globalEntries.find(e => e.session_id === branchId);
      expect(branchEntry).toBeDefined();
      expect(branchEntry!.branched_from).not.toBeNull();
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });
});

// ── T2: Source immutability ───────────────────────────────────

describe("T2: Source immutability", () => {
  test("source session is never modified by branching", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      const { sessionId: sourceId, sessionDir: sourceDir } = await initSession({
        role: "developer",
        taskSummary: "Source session for immutability",
      });

      // Snapshot source manifest before branch
      const sourceManifestBefore = await loadManifest(sourceDir);
      expect(sourceManifestBefore.branched_from).toBeNull();
      expect(sourceManifestBefore.resume_count).toBe(0);

      // Branch
      await branchSession(sourceId);

      // Source manifest should be unchanged
      const sourceManifestAfter = await loadManifest(sourceDir);
      expect(sourceManifestAfter.branched_from).toBeNull();
      expect(sourceManifestAfter.resume_count).toBe(0);
      expect(sourceManifestAfter.status).toBe("active");
      expect(sourceManifestAfter.created_at).toBe(sourceManifestBefore.created_at);

      // Source session should still be findable as a root
      const foundSourceDir = await findSessionDir(storeRoot, sourceId);
      expect(foundSourceDir).not.toBeNull();
      expect(foundSourceDir).toBe(sourceDir);
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });
});

// ── T3: Branch from checkpoint ────────────────────────────────

describe("T3: Branch from checkpoint", () => {
  test("throws when checkpoint id is provided but not found", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      const { sessionId: sourceId } = await initSession({
        role: "developer",
        taskSummary: "Source for checkpoint branch",
      });

      // Try branching from a non-existent checkpoint
      await expect(
        branchSession(sourceId, { fromCheckpoint: "nonexistent" }),
      ).rejects.toThrow(/checkpoint.*not found|empty/);
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });

  test("branches from a valid checkpoint when available", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      const { sessionId: sourceId, sessionDir: sourceDir } = await initSession({
        role: "developer",
        taskSummary: "Source with checkpoint",
      });

      // Create a checkpoint manually
      const { createCheckpoint } = await import("../src/core/session-store.ts");
      const checkpointDir = await createCheckpoint(sourceDir);
      const checkpointId = checkpointDir.split("/").pop()!;

      // Branch from that checkpoint
      const branchId = await branchSession(sourceId, { fromCheckpoint: checkpointId });

      // Branch manifest should reference the checkpoint
      const branchDir = join(storeRoot, "sessions", branchId);
      const branchManifest = await loadManifest(branchDir);
      expect(branchManifest.branched_from).not.toBeNull();
      if (branchManifest.branched_from) {
        expect(branchManifest.branched_from.checkpoint_id).toBe(checkpointId);
      }
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });
});

// ── T4: Index branch query ────────────────────────────────────

describe("T4: Index branch query", () => {
  test("global index shows branch lineage", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      const { sessionId: sourceId } = await initSession({
        role: "developer",
        taskSummary: "Original session",
      });

      const branchId = await branchSession(sourceId);

      // Read global index — both sessions should be present
      const entries = await readGlobalIndex(storeRoot);
      expect(entries.length).toBe(2);

      const sourceEntry = entries.find(e => e.session_id === sourceId);
      const branchEntry = entries.find(e => e.session_id === branchId);

      expect(sourceEntry).toBeDefined();
      expect(branchEntry).toBeDefined();
      expect(branchEntry!.branched_from).not.toBeNull();
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });
});

// ── Error cases ──────────────────────────────────────────────

describe("Branch error cases", () => {
  test("throws when source session not found", async () => {
    const storeRoot = makeTempDir();
    await ensureDir(storeRoot);

    const orig = process.env["ZAO_HOME"];
    process.env["ZAO_HOME"] = storeRoot;
    try {
      await expect(
        branchSession("nonexistent-session-id"),
      ).rejects.toThrow(/not found/);
    } finally {
      if (orig !== undefined) process.env["ZAO_HOME"] = orig;
      else delete process.env["ZAO_HOME"];
    }
  });
});
