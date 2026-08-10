/**
 * DeepSeek provider adapter — wraps `@ai-sdk/deepseek`.
 *
 * Validates that `api_key` is present (DeepSeek requires auth) and
 * creates Vercel AI SDK model objects using the official DeepSeek provider.
 *
 * @module providers/deepseek
 */

import { createDeepSeek } from "@ai-sdk/deepseek";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, ProviderConfig, ModelOptions } from "./types.ts";
import { MissingApiKeyError } from "../errors.ts";

/**
 * Adapter for the DeepSeek API provider.
 *
 * - Requires `api_key` (paid provider).
 * - Maps model slugs to `api_model_id` via config.
 */
export const deepseekAdapter: ProviderAdapter = {
  providerId: "deepseek",

  /**
   * Validates that the DeepSeek config has a non-empty `api_key`.
   * Does NOT validate key format — that's the controller's smoke test job.
   *
   * @param config - The parsed provider config.
   * @throws {MissingApiKeyError} If `apiKey` is missing or empty.
   */
  validateConfig(config: ProviderConfig): void {
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      throw new MissingApiKeyError("deepseek");
    }
  },

  /**
   * Creates a DeepSeek Vercel AI SDK model object.
   *
   * @param modelSlug - The user-defined model alias (e.g. "deepseek-chat").
   * @param options - Temperature, maxTokens options.
   * @param config - The provider config with apiKey.
   * @returns A Vercel AI SDK `LanguageModel`.
   */
  createModel(
    modelSlug: string,
    options: ModelOptions,
    config: ProviderConfig,
  ): LanguageModel {
    const apiModelId = config.models[modelSlug]?.apiModelId ?? modelSlug;

    // options.cache is consumed at the harness level (llm.ts generateObject
    // call). The adapter just acknowledges the option exists.
    void options;

    const client = createDeepSeek({
      apiKey: config.apiKey ?? "",
      baseURL: config.baseUrl,
    });

    return client.chat(apiModelId) as unknown as LanguageModel;
  },
};
