/**
 * Model context-window registry — a static lookup table of known
 * provider:model pairs with their context-window sizes (TD-010-D).
 *
 * ## Design
 *
 * - Pure data + pure function. No I/O, no API calls, zero runtime cost.
 * - Follows the `BUILT_IN_ADAPTERS` pattern in `llm-clients/registry.ts`.
 * - User override (`context_window` in `.zao/config.yaml`) wins over
 *   registry values. Default fallback (128K) is the final safety net.
 * - Registry values may become stale as providers update model windows.
 *   The config override is the user escape hatch until the registry
 *   is updated (a one-line code change per model).
 *
 * @module model-registry
 */

// ── Type Definitions ──────────────────────────────────────────────

/** Metadata for a known model. */
export interface ModelMetadata {
  /** Maximum context window size in tokens. */
  contextWindow: number;
  /** Maximum output tokens the model can produce. */
  maxOutputTokens?: number;
}

// ── Static Registry ───────────────────────────────────────────────

/**
 * Static lookup of known models and their context-window sizes.
 *
 * Key format: `"provider:model"` (e.g. `"deepseek:deepseek-chat"`).
 * All values are in tokens.
 */
const MODEL_REGISTRY: Record<string, ModelMetadata> = {
  "deepseek:deepseek-chat": { contextWindow: 128_000, maxOutputTokens: 8_192 },
  "deepseek:deepseek-reasoner": { contextWindow: 128_000, maxOutputTokens: 32_000 },
  "openai:gpt-4o": { contextWindow: 128_000, maxOutputTokens: 16_384 },
  "openai:gpt-4o-mini": { contextWindow: 128_000, maxOutputTokens: 16_384 },
  "openai:gpt-4.1": { contextWindow: 1_000_000, maxOutputTokens: 32_768 },
  "google:gemini-2.5-flash": { contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  "google:gemini-2.5-pro": { contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  "google:gemini-1.5-pro": { contextWindow: 2_000_000, maxOutputTokens: 8_192 },
  "anthropic:claude-3-5-sonnet": { contextWindow: 200_000, maxOutputTokens: 8_192 },
  "anthropic:claude-sonnet-4": { contextWindow: 200_000, maxOutputTokens: 16_384 },
  "anthropic:claude-opus-4": { contextWindow: 200_000, maxOutputTokens: 32_000 },
};

/** Default context window for unknown models (128K tokens). */
const DEFAULT_CONTEXT_WINDOW = 128_000;

// ── Core Function ─────────────────────────────────────────────────

// ── Caching Support ────────────────────────────────────────────────

/**
 * Set of provider:model keys known to support prompt caching.
 *
 * Prompt caching allows the LLM provider to cache a stable prefix
 * (typically the system prompt) and avoid re-processing it on each
 * request, reducing both latency and cost.
 *
 * This set is provider-verified: only models with documented, tested
 * prompt caching behaviour are listed. Adding an untested model here
 * will cause `generateObject` to fail at the provider if unsupported.
 */
const CACHING_MODELS: Set<string> = new Set([
  "deepseek:deepseek-chat",
  "openai:gpt-4o",
  "openai:gpt-4o-mini",
  "openai:gpt-4.1",
  "anthropic:claude-sonnet-4",
  "anthropic:claude-opus-4",
  "google:gemini-2.5-pro",
  "google:gemini-2.5-flash",
]);

/**
 * Returns whether a given provider:model pair supports prompt caching.
 *
 * When this returns `true`, the harness may set `cache: true` on
 * generation options so the provider caches the stable prefix (Layer 1
 * of the context — system prompt + role identity) across requests.
 *
 * For unsupported models, the `cache` flag is a no-op.
 *
 * @param provider - The provider identifier (e.g. "deepseek", "openai").
 * @param model    - The model identifier (e.g. "deepseek-chat", "gpt-4o").
 * @returns `true` if the model supports prompt caching.
 */
export function supportsCaching(provider: string, model: string): boolean {
  const llmId = `${provider}:${model}`;
  return CACHING_MODELS.has(llmId);
}

/**
 * Resolves the effective context window for a given provider and model.
 *
 * ## Resolution order (first wins)
 *
 * 1. **User override** — `context_window` value from `.zao/config.yaml`
 * 2. **Registry lookup** — `MODEL_REGISTRY` entry for `provider:model`
 * 3. **Default fallback** — 128K tokens, with a console warning
 *
 * @param provider - The provider identifier (e.g. "deepseek", "openai").
 * @param model    - The model identifier (e.g. "deepseek-chat", "gpt-4o").
 * @param override - Optional user-configured override from config.
 * @returns The resolved context-window size and its provenance.
 */
export function resolveContextWindow(
  provider: string,
  model: string,
  override?: number,
): { contextWindow: number; source: "registry" | "override" | "default" } {
  // 1. User override in config wins
  if (override !== undefined) {
    if (typeof override !== "number" || override <= 0 || !Number.isInteger(override)) {
      throw new Error(
        `Invalid context_window override: ${override}. Must be a positive integer.`,
      );
    }
    return { contextWindow: override, source: "override" };
  }

  // 2. Registry lookup
  const llmId = `${provider}:${model}`;
  const entry = MODEL_REGISTRY[llmId];
  if (entry) {
    return { contextWindow: entry.contextWindow, source: "registry" };
  }

  // 3. Default fallback — warn about unknown model
  console.warn(
    `Unknown llm_id "${llmId}" — using default context window of ` +
    `${DEFAULT_CONTEXT_WINDOW.toLocaleString()} tokens. ` +
    `Consider adding it to MODEL_REGISTRY or setting ` +
    `context_window in .zao/config.yaml.`,
  );
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, source: "default" };
}
