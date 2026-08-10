/**
 * Session branching — creates a new peer parent linked via `branched_from`.
 *
 * Under ADR-005, a branch is a new parent: a peer folder with its own
 * lifecycle, linked to its source via `branched_from` in manifest + index.
 * The source run is never mutated.
 *
 * @module branch
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateSessionId } from "./ids.ts";
import {
  resolveStoreRoot,
  ensureParentDir,
  writeSessionManifest,
  appendGlobalIndexLine,
  findSessionDir,
  loadManifest,
  readCheckpoint,
} from "./session-store.ts";
import { ParentManifestSchema } from "../schemas/session-manifest.ts";
import type { ParentManifest, BranchedFrom } from "../schemas/session-manifest.ts";
import { appendEvent, writeArtifact } from "./artifacts.ts";
import { logger } from "./logger.ts";

/**
 * Options for {@link branchSession}.
 */
export interface BranchSessionOptions {
  /** Optional checkpoint ID to restore from instead of the source head. */
  fromCheckpoint?: string;
}

/**
 * Creates a new peer parent session branched from `sourceId`.
 *
 * The source session is never modified. The new branch:
 * - Gets a fresh UUIDv7 session id
 * - Copies summary.md, last events, and manifest fields from the source head
 *   (or from the specified checkpoint)
 * - Writes `session.json` with `branched_from` populated
 * - Appends a global index line with `branched_from`
 * - Appends a `session_branched` event
 *
 * @param sourceId - The UUIDv7 session identifier of the source run.
 * @param opts - Optional branching options (checkpoint selection).
 * @returns The UUIDv7 identifier of the newly created branch session.
 * @throws {Error} If the source session cannot be found or loaded.
 */
export async function branchSession(
  sourceId: string,
  opts?: BranchSessionOptions,
): Promise<string> {
  const storeRoot = await resolveStoreRoot();

  // 1. Resolve source in the global store
  const sourceDir = await findSessionDir(storeRoot, sourceId);
  if (!sourceDir) {
    throw new Error(
      `Cannot branch: source session "${sourceId}" not found in the global store.`,
    );
  }

  // 2. Load the source manifest (fail-closed)
  const sourceManifest = await loadManifest(sourceDir);

  // 3. Create NEW parent folder (fresh UUIDv7)
  const branchId = generateSessionId();
  const branchDir = await ensureParentDir(branchId, storeRoot);

  // 4. Materialize starting state
  const branchedFrom: BranchedFrom = {
    session_id: sourceId,
    checkpoint_id: opts?.fromCheckpoint ?? null,
  };

  let summaryContent: string | null = null;
  let eventsContent: string | null = null;

  if (opts?.fromCheckpoint) {
    // Restore from checkpoint
    const checkpointData = await readCheckpoint(sourceDir, opts.fromCheckpoint);
    summaryContent = checkpointData["summary.md"] ?? null;
    eventsContent = checkpointData["events.jsonl"] ?? null;

    // A checkpoint is valid if it has at least session.json
    if (!checkpointData["session.json"] && !eventsContent && !summaryContent) {
      throw new Error(
        `Cannot branch: checkpoint "${opts.fromCheckpoint}" is empty or not found in session "${sourceId}".`,
      );
    }
  } else {
    // Copy from source head
    try {
      summaryContent = await readFile(join(sourceDir, "summary.md"), "utf-8");
    } catch {
      // No summary — that's fine
    }

    try {
      eventsContent = await readFile(join(sourceDir, "events.jsonl"), "utf-8");
    } catch {
      // No events — that's fine
    }
  }

  // Copy summary if available
  if (summaryContent) {
    await writeArtifact(join(branchDir, "summary.md"), summaryContent);
  }

  // Copy events if available (truncate to last 500 events to limit size)
  if (eventsContent) {
    const lines = eventsContent.split("\n").filter((l) => l.trim().length > 0);
    const lastEvents = lines.slice(-500).join("\n") + (lines.length > 500 ? "\n" : "");
    await writeArtifact(join(branchDir, "events.jsonl"), lastEvents || "\n");
  }

  // 5. Write new session.json with branched_from
  const now = new Date().toISOString();
  const branchManifest: ParentManifest = {
    schema_version: "0.2.0",
    session_id: branchId,
    parent_session_id: null,
    created_at: now,
    updated_at: now,
    status: "active",
    task: sourceManifest.task,
    role: sourceManifest.role,
    model_config: sourceManifest.model_config,
    repo_root: sourceManifest.repo_root,
    repo_remote: sourceManifest.repo_remote,
    repo_commit_at_start: sourceManifest.repo_commit_at_start,
    cwd: sourceManifest.cwd,
    branched_from: branchedFrom,
    resume_count: 0,
    compaction_history: [],
  };

  await writeSessionManifest(branchDir, branchManifest, ParentManifestSchema);

  // 6. Append global index line with branched_from
  await appendGlobalIndexLine(storeRoot, {
    session_id: branchId,
    created_at: now,
    repo_root: sourceManifest.repo_root ?? null,
    repo_remote: sourceManifest.repo_remote ?? null,
    task_summary: sourceManifest.task.slice(0, 200),
    status: "active",
    branched_from: branchedFrom,
  });

  // 7. Append session_branched event
  await appendEvent(branchDir, {
    schema_version: "0.2.0",
    event_id: generateSessionId(),
    session_id: branchId,
    parent_session_id: null,
    timestamp: now,
    agent_role: sourceManifest.role,
    model_id: sourceManifest.model_config.model,
    prompt_tokens: 0,
    completion_tokens: 0,
    cache_hit: false,
    action: "session_branched",
    metadata: {
      branched_from: branchedFrom,
    },
  });

  logger.info(
    `Session branched: ${branchId.slice(0, 12)}... from ${sourceId.slice(0, 12)}...`,
  );

  return branchId;
}
