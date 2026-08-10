/**
 * `zao session list` and `zao session show <id>` CLI commands.
 *
 * ## ADR-005 compliance
 *
 * - Reads `~/.zao/index.jsonl` ONLY (never folder-scans)
 * - Status resolved via last-line-wins semantics
 * - Supports filtering by status, repo, date, limit
 * - Output formats: table (default) and JSON
 *
 * @module cli/session
 */

import { resolveStoreRoot, listSessions } from "../core/session-store.ts";
import { findSessionDir, loadManifest, readGlobalIndex } from "../core/session-store.ts";
import type { ParentManifest } from "../schemas/session-manifest.ts";
import type { SessionListEntry, GlobalIndexResolvedEntry } from "../schemas/session-index.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────

export interface SessionListFlags {
  status?: string;
  repo?: string;
  since?: string;
  limit?: number;
  format?: "table" | "json";
}

// ── Formatting ──────────────────────────────────────────────────────

/**
 * Formats a list of sessions as a human-readable table.
 */
function formatTable(sessions: SessionListEntry[]): string {
  if (sessions.length === 0) {
    return "No sessions found.";
  }

  const header = [
    "SESSION ID",
    "STATUS",
    "CREATED",
    "COMPLETED",
    "TASK",
    "MODELS",
  ];

  const rows = sessions.map((s) => {
    const shortId = s.session_id.slice(0, 12);
    const created = s.created_at.slice(0, 19).replace("T", " ");
    const completed = s.completed_at
      ? s.completed_at.slice(0, 19).replace("T", " ")
      : "-";
    const task = (s.task_summary ?? "").slice(0, 60);
    const models = s.models.join(", ").slice(0, 30);
    return [shortId, s.status, created, completed, task, models];
  });

  // Calculate column widths
  const widths = header.map((_, colIdx) =>
    Math.max(
      header[colIdx]!.length,
      ...rows.map((r) => r[colIdx]!.length),
    ),
  );

  const divider = widths.map((w) => "-".repeat(w)).join("-+-") + "-";
  const headerStr = header
    .map((h, i) => h.padEnd(widths[i]!))
    .join(" | ");
  const rowStrs = rows.map(
    (r) => r.map((c, i) => c!.padEnd(widths[i]!)).join(" | "),
  );

  return [
    headerStr,
    divider,
    ...rowStrs,
    "",
    `${sessions.length} session(s)`,
  ].join("\n");
}

/**
 * Formats a list of sessions as JSON.
 */
function formatJson(sessions: SessionListEntry[]): string {
  return JSON.stringify(sessions, null, 2);
}

// ── Command Handler ─────────────────────────────────────────────────

/**
 * Handles the `zao session list` command.
 *
 * Reads the global index, applies filters, and outputs formatted results.
 *
 * @param flags - CLI flags for filtering and formatting.
 * @returns Exit code: 0 on success, 1 on error.
 */
export async function handleSessionList(
  flags: SessionListFlags,
): Promise<void> {
  try {
    const storeRoot = await resolveStoreRoot();
    const sessions = await listSessions(storeRoot, {
      status: flags.status,
      repo: flags.repo,
      since: flags.since,
      limit: flags.limit,
    });

    const format = flags.format ?? "table";

    if (format === "json") {
      process.stdout.write(formatJson(sessions) + "\n");
    } else {
      process.stdout.write(formatTable(sessions) + "\n");
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error listing sessions: ${message}\n`);
    process.exit(1);
  }
}

/**
 * Parses the `session list` subcommand arguments into flags.
 *
 * @param args - Raw arguments after "session list".
 * @returns Parsed flags object.
 */
export function parseSessionListArgs(args: string[]): SessionListFlags {
  const flags: SessionListFlags = {};
  let i = 0;

  while (i < args.length) {
    const arg = args[i]!;
    switch (arg) {
      case "--status": {
        i++;
        if (i < args.length) flags.status = args[i];
        i++;
        break;
      }
      case "--repo": {
        i++;
        if (i < args.length) flags.repo = args[i];
        i++;
        break;
      }
      case "--since": {
        i++;
        if (i < args.length) flags.since = args[i];
        i++;
        break;
      }
      case "--limit": {
        i++;
        if (i < args.length) {
          const n = parseInt(args[i]!, 10);
          if (!isNaN(n) && n > 0) flags.limit = n;
        }
        i++;
        break;
      }
      case "--format": {
        i++;
        if (i < args.length) {
          const fmt = args[i];
          if (fmt === "json" || fmt === "table") {
            flags.format = fmt;
          }
        }
        i++;
        break;
      }
      default: {
        i++;
        break;
      }
    }
  }

  return flags;
}

// ── Session Show (read-only inspector) ──────────────────────────────

/** Options for `zao session show`. */
export interface SessionShowOptions {
  /** The session identifier to inspect. */
  sessionId: string;
  /** Output format: table (default) or json. */
  format?: "table" | "json";
}

/** Per-step info extracted from child manifests. */
interface StepInfo {
  /** Step/node id from the flow. */
  id: string;
  /** Agent role that executed this step. */
  role: string;
  /** Completion status: complete, failed, interrupted, skipped, or not-run. */
  status: string;
}

/**
 * Result of a `zao session show` invocation.
 */
export interface SessionShowResult {
  /** Whether the session was successfully inspected and output. */
  success: boolean;
  /** Error message, populated only when success is false. */
  error?: string;
  /** True when the error is a validation issue (exit code 3). */
  isValidationError?: boolean;
}

/**
 * Handles the `zao session show <id>` command.
 *
 * Read-only inspector: resolves the session, reads its manifest and
 * agents/index.jsonl, and prints a formatted summary. NEVER writes
 * anything.
 *
 * On error, returns a `{ success: false, error, isValidationError }` object
 * rather than silently showing stale/uncommitted data (governance §E3).
 *
 * @param options - Session id and optional format.
 * @returns A result object indicating success or the error encountered.
 */
export async function handleSessionShow(
  options: SessionShowOptions,
): Promise<SessionShowResult> {
  const storeRoot = await resolveStoreRoot();

  // Resolve session directory
  const sessionDir = await findSessionDir(storeRoot, options.sessionId);
  if (!sessionDir) {
    return {
      success: false,
      error:
        `Error: Session "${options.sessionId}" not found.\n` +
        'Use "zao session list" to see available sessions.\n',
      isValidationError: true,
    };
  }

  // Read manifest (fail-closed) — try parent first, then child
  let manifest: ParentManifest | undefined;
  let isChild = false;
  try {
    manifest = await loadManifest(sessionDir);
  } catch {
    // May be a child session — try child schema
    const { readArtifact } = await import("../core/artifacts.ts");
    const { ChildManifestSchema } = await import("../schemas/session-manifest.ts");
    const childResult = await readArtifact(
      join(sessionDir, "session.json"),
      ChildManifestSchema,
    );
    if (childResult.success) {
      isChild = true;
    } else {
      return {
        success: false,
        error: `Cannot read session manifest at "${sessionDir}"`,
      };
    }
  }

  // If child, stop here (manifest is undefined for children)
  if (isChild) {
    return {
      success: false,
      error:
        `Error: Session "${options.sessionId}" is a child session.\n` +
        "Only root sessions can be inspected. Check the parent session.\n",
    };
  }

  // manifest is guaranteed defined if not a child
  const rootManifest = manifest!;
  let specSteps: Array<{ id: string; role: string }> = [];
  try {
    const specRaw = await readFile(
      join(sessionDir, "orchestration-spec.json"),
      "utf-8",
    );
    const spec = JSON.parse(specRaw);
    const flow = spec["flow"] as
      | { steps?: Array<{ id: string; role: string }> }
      | undefined;
    if (flow?.steps) {
      specSteps = flow.steps;
    }
  } catch {
    // No spec — fine, step table will be empty
  }

  // Read agents/index.jsonl to determine per-step statuses
  const stepStatuses = new Map<string, string>();
  try {
    const indexPath = join(sessionDir, "agents", "index.jsonl");
    const raw = await readFile(indexPath, "utf-8");
    // Last-line-wins per session_id; map node_id → latest status
    const byNodeId = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed["node_id"] && typeof parsed["node_id"] === "string") {
          byNodeId.set(
            parsed["node_id"],
            typeof parsed["status"] === "string" ? parsed["status"] : "active",
          );
        }
      } catch {
        continue;
      }
    }
    for (const [nodeId, status] of byNodeId) {
      stepStatuses.set(nodeId, status);
    }
  } catch {
    // No agents index — all steps show as "not-run"
  }

  // Map statuses to human-readable labels
  const statusLabel = (s: string): string => {
    switch (s) {
      case "complete": return "complete";
      case "failed": return "failed";
      case "interrupted": return "interrupted";
      case "skipped": return "skipped";
      case "active": return "not-run";
      default: return "not-run";
    }
  };

  // Read last event timestamp
  let lastEventTimestamp = "";
  try {
    const eventsRaw = await readFile(
      join(sessionDir, "events.jsonl"),
      "utf-8",
    );
    const lines = eventsRaw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length > 0) {
      const lastEvent = JSON.parse(lines[lines.length - 1]!);
      if (typeof lastEvent["timestamp"] === "string") {
        lastEventTimestamp = lastEvent["timestamp"];
      }
    }
  } catch {
    // No events — fine
  }

  // Build steps info
  const stepInfos: StepInfo[] = specSteps.map((s) => ({
    id: s.id,
    role: s.role,
    status: statusLabel(stepStatuses.get(s.id) ?? "not-run"),
  }));

  // Format output
  const format = options.format ?? "table";

  if (format === "json") {
    const output = {
      session_id: rootManifest.session_id,
      task: rootManifest.task,
      status: rootManifest.status,
      created_at: rootManifest.created_at,
      updated_at: rootManifest.updated_at,
      model: rootManifest.model_config,
      repo_root: rootManifest.repo_root,
      repo_remote: rootManifest.repo_remote,
      cwd: rootManifest.cwd,
      resume_count: rootManifest.resume_count,
      last_event_timestamp: lastEventTimestamp || null,
      steps: stepInfos,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } else {
    // Table format
    const lines: string[] = [];
    lines.push(`Session: ${rootManifest.session_id.slice(0, 12)}...`);
    lines.push(`Task: ${rootManifest.task}`);
    lines.push(`Status: ${rootManifest.status}`);
    lines.push(`Created: ${rootManifest.created_at}`);
    lines.push(`Updated: ${rootManifest.updated_at}`);
    if (rootManifest.repo_root) {
      lines.push(`Repo: ${rootManifest.repo_root}`);
    }
    lines.push(`Resume count: ${rootManifest.resume_count}`);
    if (lastEventTimestamp) {
      lines.push(`Last event: ${lastEventTimestamp}`);
    }
    lines.push("");

    if (stepInfos.length > 0) {
      lines.push("Steps:");
      const maxIdLen = Math.max(
        4,
        ...stepInfos.map((s) => s.id.length),
      );
      const maxRoleLen = Math.max(
        4,
        ...stepInfos.map((s) => s.role.length),
      );
      const header = `  ${"STEP".padEnd(maxIdLen)}  ${"ROLE".padEnd(maxRoleLen)}  STATUS`;
      const divider = `  ${"-".repeat(maxIdLen)}  ${"-".repeat(maxRoleLen)}  ------`;
      lines.push(header);
      lines.push(divider);
      for (const step of stepInfos) {
        lines.push(
          `  ${step.id.padEnd(maxIdLen)}  ${step.role.padEnd(maxRoleLen)}  ${step.status}`,
        );
      }
    } else {
      lines.push("Steps: (no flow spec found)");
    }

    process.stdout.write(lines.join("\n") + "\n");
  }

  return { success: true };
}

// ── Session Branching ────────────────────────────────────────────────

/** Options for `mo branch`. */
export interface BranchOptions {
  /** The source session id to branch from. */
  sourceId: string;
  /** Optional checkpoint id to branch from. */
  fromCheckpoint?: string;
}

/**
 * Handles the `mo branch <session_id> [--from-checkpoint <id>]` command.
 *
 * Creates a new peer parent session linked to the source via `branched_from`.
 * The source session is never modified.
 *
 * @param options - Branch options (source session and optional checkpoint).
 */
export async function handleBranch(options: BranchOptions): Promise<void> {
  try {
    const { branchSession } = await import("../core/branch.ts");
    const branchId = await branchSession(options.sourceId, {
      fromCheckpoint: options.fromCheckpoint,
    });
    process.stdout.write(`Branch created: ${branchId}\n`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error branching session: ${message}\n`);
    process.exit(1);
  }
}

// ── Session Tree ─────────────────────────────────────────────────────

/**
 * Handles the `mo session tree <session_id>` command.
 *
 * Displays two trees:
 * 1. **Agent tree**: delegation hierarchy from `agents/index.jsonl`
 * 2. **Branch tree**: branching lineage from global index `branched_from`
 *
 * @param sessionId - The root session identifier.
 */
export async function handleSessionTree(sessionId: string): Promise<void> {
  try {
    const storeRoot = await resolveStoreRoot();

    // Resolve the session
    const sessionDir = await findSessionDir(storeRoot, sessionId);
    if (!sessionDir) {
      process.stderr.write(
        `Error: Session "${sessionId}" not found.\n`,
      );
      process.exit(1);
    }

    // Agent tree: from agents/index.jsonl
    const agentTree = await buildAgentTree(sessionDir);

    // Branch tree: from global index
    const branchTree = await buildBranchTree(storeRoot, sessionId);

    const output: string[] = [];

    output.push(`Session: ${sessionId.slice(0, 12)}...`);
    output.push("");

    // Agent tree
    output.push("Agent tree (delegation hierarchy):");
    if (agentTree.length > 0) {
      for (const line of agentTree) {
        output.push(`  ${line}`);
      }
    } else {
      output.push("  (no subagents spawned)");
    }
    output.push("");

    // Branch tree
    output.push("Branch tree (lineage):");
    if (branchTree.length > 0) {
      for (const line of branchTree) {
        output.push(`  ${line}`);
      }
    } else {
      output.push("  (no branches)");
    }

    process.stdout.write(output.join("\n") + "\n");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error showing session tree: ${message}\n`);
    process.exit(1);
  }
}

/**
 * Builds a human-readable agent delegation tree from the session's
 * `agents/index.jsonl`.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @returns Array of formatted tree lines.
 */
async function buildAgentTree(sessionDir: string): Promise<string[]> {
  const lines: string[] = [];

  try {
    const indexPath = join(sessionDir, "agents", "index.jsonl");
    const raw = await readFile(indexPath, "utf-8");

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        const shortId = (entry["session_id"] ?? "").slice(0, 12);
        const role = entry["role"] ?? "unknown";
        const status = entry["status"] ?? "active";
        lines.push(`├─ ${role} (${shortId}...) [${status}]`);
      } catch {
        continue;
      }
    }
  } catch {
    // No agents index — return empty
  }

  return lines;
}

/**
 * Builds a human-readable branch lineage tree from the global index.
 *
 * Walks `branched_from` links across all index entries to trace the
 * lineage of a session.
 *
 * @param storeRoot - The resolved store root.
 * @param sessionId - The root session to start from.
 * @returns Array of formatted tree lines.
 */
async function buildBranchTree(
  storeRoot: string,
  sessionId: string,
): Promise<string[]> {
  const lines: string[] = [];
  const allEntries = await readGlobalIndex(storeRoot);

  // Build a map of session_id → entry for quick lookup
  const byId = new Map<string, GlobalIndexResolvedEntry>();
  for (const entry of allEntries) {
    byId.set(entry.session_id, entry);
  }

  // Walk the branch tree
  const visited = new Set<string>();

  function walk(currentId: string, depth: number): void {
    if (visited.has(currentId)) return;
    visited.add(currentId);

    const entry = byId.get(currentId);
    const shortId = currentId.slice(0, 12);
    const prefix = "  ".repeat(depth) + (depth > 0 ? "└─ " : "");

    if (entry?.branched_from !== null && entry?.branched_from !== undefined) {
      const bf = entry.branched_from as { session_id: string };
      const sourceShortId = bf.session_id.slice(0, 12);
      lines.push(`${prefix}${shortId}... (branched from ${sourceShortId}...) [${entry?.status ?? "?"}]`);

      // Recursively walk the source
      if (bf.session_id && !visited.has(bf.session_id)) {
        walk(bf.session_id, depth + 1);
      }
    } else {
      lines.push(`${prefix}${shortId}... [${entry?.status ?? "?"}]`);
    }

    // Also check for sessions branched FROM this one
    for (const [id, e] of byId) {
      if (visited.has(id)) continue;
      if (
        e.branched_from !== null &&
        e.branched_from !== undefined &&
        typeof e.branched_from === "object" &&
        (e.branched_from as { session_id: string }).session_id === currentId
      ) {
        walk(id, depth + 1);
      }
    }
  }

  walk(sessionId, 0);
  return lines;
}
