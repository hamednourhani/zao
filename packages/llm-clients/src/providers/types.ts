/**
 * Provider adapter interface — the contract every provider implementation
 * must fulfill to be registered with the {@link LlmClientRegistry}.
 *
 * Each adapter is responsible for:
 * - Validating its own config (e.g., deepseek requires `api_key`).
 * - Creating a Vercel AI SDK `LanguageModel` from a model slug + options + config.
 *
 * ## Test injection
 *
 * Tests can implement this interface with a fake `LanguageModel` that does
 * not call the network. Use {@link createTestRegistry} + {@link registerProvider}.
 *
 * @module providers/types
 */

import type { LanguageModel } from "ai";

/**
 * Options passed when creating a model instance.
 */
export interface ModelOptions {
  /** Sampling temperature (0–2). Lower = more deterministic. */
  temperature?: number;
  /** Maximum completion tokens. */
  maxTokens?: number;
  /** When true, requests prompt caching from the provider. No-op for unsupported models. */
  cache?: boolean;
}

/**
 * Configuration for a single provider, as parsed from `llm-providers.yaml`.
 */
export interface ProviderConfig {
  /** API key for authentication (optional for free providers). */
  apiKey?: string;
  /** Optional base URL override for OpenAI-compatible endpoints. */
  baseUrl?: string;
  /** Map of model slug → { apiModelId }. */
  models: Record<string, { apiModelId: string }>;
}

/**
 * A provider adapter knows how to validate its config and create models.
 *
 * ## Implementation rules
 *
 * - `validateConfig` checks that paid providers have `api_key` (but does NOT
 *   validate key format or make network calls — the controller does smoke tests).
 * - `createModel` maps the model slug to the provider's API model ID and
 *   returns a Vercel AI SDK `LanguageModel`.
 */
export interface ProviderAdapter {
  /** The provider key used in `llm_id` (e.g., "deepseek", "openai"). */
  readonly providerId: string;

  /** Validate this provider's configuration. Throws on failure. */
  validateConfig(config: ProviderConfig): void;

  /**
   * Create a Vercel AI SDK `LanguageModel` for the given model slug.
   *
   * @param modelSlug - The user-defined model alias (e.g. "deepseek-chat").
   * @param options - Temperature, maxTokens, etc.
   * @param config - The provider's full config block.
   * @returns A ready-to-use Vercel AI SDK LanguageModel.
   */
  createModel(
    modelSlug: string,
    options: ModelOptions,
    config: ProviderConfig,
  ): LanguageModel;
}
