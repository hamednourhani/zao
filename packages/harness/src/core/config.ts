/**
 * Configuration loader for the zao harness.
 *
 * Reads `.zao/config.yaml` if it exists for non-credential harness settings.
 * Provider credentials are now owned by `@zao/llm-clients` (ADR-009).
 *
 * ## Config format (`.zao/config.yaml`)
 *
 * ```yaml
 * temperature: 0.1
 * max_tokens: 4096
 * ```
 *
 * ## Note
 *
 * Provider, model, and api_key fields have been REMOVED (TD-033).
 * Those are now configured via `~/.zao/llm-providers.yaml` and resolved
 * through the `@zao/llm-clients` registry.
 *
 * @module config
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { logger } from "./logger.ts";

// ── Type Definitions ───────────────────────────────────────────────

/** Tokenizer strategy for context budgeting and token estimation. */
export type TokenizerStrategy = "auto" | "heuristic" | "gpt-tokenizer";

/** Configuration for the core run loop (non-credential settings only). */
export interface LoopConfig {
  /** Sampling temperature (0–2). Lower values = more deterministic. */
  temperature?: number;
  /** Maximum completion tokens. */
  maxTokens?: number;
  /**
   * Optional user override for context window size in tokens.
   * When set, this value is used instead of the registry or default.
   * Must be a positive integer.
   */
  contextWindow?: number;
  /**
   * Fraction of context window at which compaction is triggered.
   * Default is 0.65 (65%). Set to 0 to disable compaction.
   */
  compactionThreshold?: number;
  /**
   * Provider for the compactor model (e.g. "deepseek").
   * Falls back to the active model's provider if not configured.
   */
  compactorProvider?: string;
  /**
   * Model for the compactor (e.g. "deepseek-chat").
   * Falls back to the active model if not configured.
   */
  compactorModel?: string;
  /**
   * Tokenizer strategy for context budgeting (TD-010-E).
   * - "auto": prefers gpt-tokenizer for supported providers, heuristic fallback
   * - "heuristic": always use chars/4 approximation
   * - "gpt-tokenizer": always use the gpt-tokenizer package
   * Default: "auto".
   */
  tokenizer?: TokenizerStrategy;
  /**
   * Number of events between automatic checkpoints (TD-010-F).
   * When the event count reaches a multiple of this value, a checkpoint
   * is created automatically. Set to 0 to disable event-based checkpoints.
   * Default: 50.
   */
  checkpoint_interval_events?: number;
  /**
   * Minutes between automatic checkpoints (TD-010-F).
   * When the elapsed time since the last checkpoint exceeds this value,
   * a checkpoint is created automatically. Set to 0 to disable time-based
   * checkpoints.
   * Default: 30.
   */
  checkpoint_interval_minutes?: number;
  /**
   * Maximum number of checkpoints to retain (TD-010-F).
   * When exceeded, the oldest checkpoints are pruned. Set to 0 to disable
   * pruning (keep all checkpoints).
   * Default: 5.
   */
  checkpoint_retention_count?: number;
  /**
   * Compaction strategy to use when the context window is breached (TD-010-G).
   * - "abstractive-llm": LLM produces a prose summary (default, TD-010-C)
   * - "extractive-events": Selects important events verbatim
   * - "hierarchical-summary": Multi-level hierarchical summary
   * Default: "abstractive-llm".
   */
  compaction_strategy?: string;
  /**
   * Fallback behavior when compaction fails (TD-010-G).
   * - "halt": Stop the session with compaction_failed status
   * - "truncate": Remove oldest non-essential events (HITL-gated)
   * - "retry": Retry compaction with backoff
   * Default: "halt".
   */
  compaction_fallback?: string;
}

// ── Config Loading ─────────────────────────────────────────────────

/**
 * Parses a flat YAML config into a `Record<string, string | number>`.
 * Uses the `yaml` library for robust YAML v1.1/v1.2 parsing that
 * handles block scalars, inline comments, quotes, etc. correctly.
 *
 * @param raw - Raw YAML content as a string.
 * @returns A record of key to value.
 */
function parseConfigYaml(raw: string): Record<string, unknown> {
  const parsed = parseYaml(raw);
  if (parsed === null || parsed === undefined || typeof parsed !== "object") {
    return {};
  }
  // Convert nested objects to flat string keys for backward compatibility
  if (Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

/**
 * Loads the harness configuration from `.zao/config.yaml`.
 *
 * Only loads non-credential settings (temperature, maxTokens).
 * Provider credentials are managed by `@zao/llm-clients` (ADR-009, TD-033).
 *
 * ## Behavior
 *
 * - Missing config file → empty config (no error).
 * - Unreadable config file → empty config, warning logged.
 * - Invalid values for `temperature` / `max_tokens` → silently ignored.
 *
 * @param projectDir - Root of the zao project (where `.zao/` lives).
 * @returns A resolved `LoopConfig` instance.
 */
export async function loadConfig(projectDir: string): Promise<LoopConfig> {
  const configPath = resolve(projectDir, ".zao", "config.yaml");

  let fileConfig: Record<string, unknown> = {};

  try {
    const raw = await readFile(configPath, "utf-8");
    fileConfig = parseConfigYaml(raw);
  } catch (error: unknown) {
    const errCode =
      error !== null &&
      typeof error === "object" &&
      "code" in error
        ? (error as { code: string }).code
        : undefined;

    if (errCode === "ENOENT") {
      // No config file — use empty config silently
    } else {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.warn(
        `Could not read ${configPath}: ${message}. Proceeding without harness config.`,
      );
    }
  }

  // Numeric fields: parse, but silently ignore invalid values
  let temperature: number | undefined;
  if (fileConfig["temperature"] !== undefined && fileConfig["temperature"] !== null) {
    const parsed = Number(fileConfig["temperature"]);
    if (!isNaN(parsed)) temperature = parsed;
  }

  let maxTokens: number | undefined;
  if (fileConfig["max_tokens"] !== undefined && fileConfig["max_tokens"] !== null) {
    const parsed = Number(fileConfig["max_tokens"]);
    if (!isNaN(parsed)) maxTokens = parsed;
  }

  let contextWindow: number | undefined;
  if (fileConfig["context_window"] !== undefined && fileConfig["context_window"] !== null) {
    const parsed = Number(fileConfig["context_window"]);
    if (!isNaN(parsed) && Number.isInteger(parsed) && parsed > 0) contextWindow = parsed;
  }

  let compactionThreshold: number | undefined;
  if (fileConfig["compaction_threshold"] !== undefined && fileConfig["compaction_threshold"] !== null) {
    const parsed = Number(fileConfig["compaction_threshold"]);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) compactionThreshold = parsed;
  }

  const compactorProvider =
    typeof fileConfig["compactor_provider"] === "string"
      ? fileConfig["compactor_provider"]
      : undefined;

  const compactorModel =
    typeof fileConfig["compactor_model"] === "string"
      ? fileConfig["compactor_model"]
      : undefined;

  return { temperature, maxTokens, contextWindow, compactionThreshold, compactorProvider, compactorModel };
}

/**
 * Returns the resolved value for a checkpoint config option, falling
 * back to the default when not explicitly configured.
 *
 * @param config - The loaded loop config.
 * @param key - The config key to resolve.
 * @param defaultValue - The default value if not configured.
 * @returns The resolved value.
 */
export function resolveCheckpointConfig(
  config: LoopConfig,
  key: "checkpoint_interval_events" | "checkpoint_interval_minutes" | "checkpoint_retention_count",
  defaultValue: number,
): number {
  const val = config[key];
  if (val !== undefined && val !== null && !isNaN(Number(val))) {
    return Math.max(0, Number(val));
  }
  return defaultValue;
}
