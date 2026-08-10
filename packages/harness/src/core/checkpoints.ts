/**
 * Automatic checkpoint management for session resilience (TD-010-F).
 *
 * Checkpoints are created automatically every N events or M minutes
 * (whichever comes first). Old checkpoints are pruned to maintain a
 * configurable retention window. Checkpoint failures are non-fatal.
 *
 * @module checkpoints
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createCheckpoint } from "./session-store.ts";
import { logger } from "./logger.ts";

/**
 * Configuration for automatic checkpointing.
 */
export interface CheckpointConfig {
  /** Number of events between checkpoints. 0 = disabled. Default: 50. */
  interval_events: number;
  /** Minutes between checkpoints. 0 = disabled. Default: 30. */
  interval_minutes: number;
  /** Maximum number of checkpoints to retain. 0 = unlimited. Default: 5. */
  retention_count: number;
}

/**
 * Internal state tracked by the checkpoint manager.
 */
interface CheckpointState {
  /** Event count at the time of the last checkpoint. */
  lastEventCount: number;
  /** Timestamp (ms) of the last checkpoint. */
  lastCheckpointTime: number;
  /** Total checkpoints created in this session so far. */
  totalCheckpoints: number;
}

/**
 * Creates the default checkpoint configuration.
 */
export function defaultCheckpointConfig(): CheckpointConfig {
  return {
    interval_events: 50,
    interval_minutes: 30,
    retention_count: 5,
  };
}

/**
 * Checkpoint manager — responsible for deciding when to create a
 * checkpoint and running the create/prune cycle.
 */
export class CheckpointManager {
  private config: CheckpointConfig;
  private state: CheckpointState;
  private sessionDir: string;

  constructor(
    sessionDir: string,
    config?: Partial<CheckpointConfig>,
  ) {
    this.sessionDir = sessionDir;
    this.config = { ...defaultCheckpointConfig(), ...config };
    this.state = {
      lastEventCount: 0,
      lastCheckpointTime: Date.now(),
      totalCheckpoints: 0,
    };
  }

  /**
   * Examines the current event count and elapsed time. If either
   * threshold is met, creates a checkpoint and prunes old ones.
   *
   * Failures are caught and logged — they never interrupt the session.
   *
   * @param eventCount - The current number of events processed.
   * @returns A promise that resolves when the checkpoint cycle completes.
   */
  async maybeCheckpoint(eventCount: number): Promise<void> {
    const shouldCheckpoint = this.shouldCreateCheckpoint(eventCount);

    if (!shouldCheckpoint) return;

    await this.doCheckpoint(eventCount);
    await this.pruneOldCheckpoints();
  }

  /**
   * Determines whether a new checkpoint should be created based on
   * event count and time intervals.
   */
  private shouldCreateCheckpoint(eventCount: number): boolean {
    const eventsSinceLast = eventCount - this.state.lastEventCount;
    const now = Date.now();
    const minutesSinceLast = (now - this.state.lastCheckpointTime) / 60000;

    // Event-based trigger
    if (this.config.interval_events > 0 && eventsSinceLast >= this.config.interval_events) {
      return true;
    }

    // Time-based trigger
    if (this.config.interval_minutes > 0 && minutesSinceLast >= this.config.interval_minutes) {
      return true;
    }

    return false;
  }

  /**
   * Performs the actual checkpoint creation, updating internal state
   * on success. Failures are logged but never thrown.
   */
  private async doCheckpoint(eventCount: number): Promise<void> {
    try {
      await createCheckpoint(this.sessionDir);
      this.state.lastEventCount = eventCount;
      this.state.lastCheckpointTime = Date.now();
      this.state.totalCheckpoints++;
      logger.debug(
        `Checkpoint created (total: ${this.state.totalCheckpoints}, events: ${eventCount})`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Checkpoint creation failed (non-fatal): ${message}`);
    }
  }

  /**
   * Prunes old checkpoints if the retention count is exceeded.
   * Always keeps the most recent K checkpoints.
   * Pruning failures are logged but never thrown — we keep extras
   * rather than risking deletion of recent checkpoints.
   */
  private async pruneOldCheckpoints(): Promise<void> {
    if (this.config.retention_count <= 0) return; // Unlimited retention

    const checkpointsDir = join(this.sessionDir, "checkpoints");
    let entries: string[] = [];

    try {
      entries = await readdir(checkpointsDir);
    } catch {
      // No checkpoints dir yet — nothing to prune
      return;
    }

    if (entries.length <= this.config.retention_count) return;

    // Sort entries by modification time (oldest first) so we can
    // identify which to prune.
    const withStats: Array<{ name: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      try {
        const entryStat = await stat(join(checkpointsDir, entry));
        if (entryStat.isDirectory()) {
          withStats.push({ name: entry, mtimeMs: entryStat.mtimeMs });
        }
      } catch {
        // Skip entries we can't stat
      }
    }

    // Sort oldest first
    withStats.sort((a, b) => a.mtimeMs - b.mtimeMs);

    // Prune the oldest entries that exceed retention
    const toPrune = withStats.slice(0, withStats.length - this.config.retention_count);

    for (const { name } of toPrune) {
      try {
        await rm(join(checkpointsDir, name), { recursive: true, force: true });
        logger.debug(`Pruned old checkpoint: ${name.slice(0, 12)}...`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to prune checkpoint ${name.slice(0, 12)}...: ${message}`);
        // Keep extras rather than risk deleting recent
      }
    }
  }

  /**
   * Returns the current checkpoint state for diagnostics.
   */
  getState(): Readonly<CheckpointState> {
    return { ...this.state };
  }

  /**
   * Resets the time-based interval counter (useful after a manual
   * checkpoint or session resume).
   */
  resetTimeCounter(): void {
    this.state.lastCheckpointTime = Date.now();
  }
}
