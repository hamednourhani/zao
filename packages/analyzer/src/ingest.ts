/**
 * Session data ingestion — reads zao session data from the store.
 *
 * Reads `index.jsonl` from the store root, parses each line as JSON,
 * and extracts {@link SessionSummary} objects. Fail-tolerant: skips
 * malformed lines and missing directories without crashing.
 *
 * @module ingest
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────

/** The filename for the session index file. */
const INDEX_FILE = "index.jsonl";

/** Summary of a single zao session extracted from the store. */
export interface SessionSummary {
  /** Unique session identifier. */
  sessionId: string;
  /** Session outcome status. */
  status: "success" | "failed" | "awaiting_hitl" | "unknown";
  /** The task executed in this session. */
  task: string;
  /** Model identifier used. */
  model: string;
  /** Session duration in milliseconds. */
  duration: number;
  /** Number of errors recorded. */
  errorCount: number;
  /** Number of tool calls made. */
  toolCallCount: number;
}

/** A single event log entry (raw JSON). */
export interface EventLogEntry {
  action?: string;
  timestamp?: string;
  agent_role?: string;
  model_id?: string;
  [key: string]: unknown;
}

// ── Ingestion ──────────────────────────────────────────────────────

/**
 * Reads session summaries from the store's `index.jsonl` file.
 *
 * Each line in the file is a JSON object. Lines that fail to parse are
 * skipped with a warning (never crashes). If the file or its directory
 * does not exist, returns an empty array.
 *
 * @param storeRoot - Path to the zao store root (e.g., `~/.zao/`).
 * @returns Array of {@link SessionSummary} objects.
 */
export function ingestSessions(storeRoot: string): SessionSummary[] {
  const indexFile = path.join(storeRoot, INDEX_FILE);
  const summaries: SessionSummary[] = [];

  let raw: string;
  try {
    raw = fs.readFileSync(indexFile, "utf-8");
  } catch {
    // File doesn't exist or can't be read — fail-tolerant
    return summaries;
  }

  const lines = raw.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Malformed JSON — skip line
      continue;
    }

    summaries.push({
      sessionId: String(parsed["session_id"] ?? ""),
      status: normalizeStatus(String(parsed["status"] ?? "")),
      task: String(parsed["task"] ?? ""),
      model: String(parsed["model"] ?? ""),
      duration: Number(parsed["duration"]) || 0,
      errorCount: Number(parsed["error_count"]) || 0,
      toolCallCount: Number(parsed["tool_call_count"]) || 0,
    });
  }

  return summaries;
}

/**
 * Reads event log entries from a session directory's `events.jsonl` file.
 *
 * Reserved for future use (event-level analysis).
 *
 * @param sessionDir - Path to a specific session directory.
 * @returns Array of raw event log entries.
 */
export function readSessionEvents(sessionDir: string): EventLogEntry[] {
  const eventsFile = path.join(sessionDir, "events.jsonl");
  const events: EventLogEntry[] = [];

  let raw: string;
  try {
    raw = fs.readFileSync(eventsFile, "utf-8");
  } catch {
    return events;
  }

  const lines = raw.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    try {
      const parsed = JSON.parse(trimmed) as EventLogEntry;
      events.push(parsed);
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  return events;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Normalizes a raw status string into one of the valid status values.
 *
 * @param raw - The raw status string from the index.
 * @returns A normalized status value.
 */
function normalizeStatus(
  raw: string,
): "success" | "failed" | "awaiting_hitl" | "unknown" {
  const lower = raw.toLowerCase().trim();
  if (lower === "success") return "success";
  if (lower === "failed" || lower === "failure") return "failed";
  if (lower === "awaiting_hitl" || lower === "hitl") return "awaiting_hitl";
  return "unknown";
}
