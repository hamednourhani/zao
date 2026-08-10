/**
 * Test mock helpers for the LLM Client Registry.
 *
 * Provides factory functions for creating mock {@link LlmClient} and
 * {@link LlmClientRegistry} objects for deterministic tests without
 * real API keys or network calls.
 *
 * @module mock-llm-client
 */

import type { LanguageModel } from "ai";
import type {
  LlmClient,
  LlmClientRegistry,
  ProviderAdapter,
  ProviderConfig,
  ModelOptions,
} from "@zao/llm-clients";
import { createTestRegistry as createEmptyRegistry } from "@zao/llm-clients";

// ── Mock LlmClient ─────────────────────────────────────────────────

/**
 * Creates a mock {@link LlmClient} that returns a fake `LanguageModel`.
 * No network calls are made.
 *
 * @param overrides - Optional overrides for client properties.
 * @returns A valid LlmClient suitable for tests.
 */
export function createMockLlmClient(overrides?: {
  llmId?: string;
  providerId?: string;
  modelSlug?: string;
  apiModelId?: string;
}): LlmClient {
  const llmId = overrides?.llmId ?? "openai:gpt-4o";
  const providerId = overrides?.providerId ?? "openai";
  const modelSlug = overrides?.modelSlug ?? "gpt-4o";
  const apiModelId = overrides?.apiModelId ?? "gpt-4o";

  return {
    llmId,
    providerId,
    modelSlug,
    apiModelId,

    createModel(_options?: ModelOptions): LanguageModel {
      return {
        modelId: apiModelId,
        provider: providerId,
      } as unknown as LanguageModel;
    },
  };
}

/**
 * Legacy-compatible mock client factory for tests that previously used
 * `{ provider: string, model: string, apiKey: string }` objects.
 * Returns a mock LlmClient with the same provider/model values.
 */
export function mockClientFromLegacy(config: {
  provider: string;
  model: string;
  apiKey?: string;
}): LlmClient {
  return createMockLlmClient({
    llmId: `${config.provider}:${config.model}`,
    providerId: config.provider,
    modelSlug: config.model,
    apiModelId: config.model,
  });
}

// ── Mock Registry ──────────────────────────────────────────────────

/**
 * Creates a mock {@link LlmClientRegistry} pre-configured with a single
 * test provider. The `getClient` method always returns the same mock client.
 *
 * @param mockClient - Optional pre-built mock client. Defaults to "openai:gpt-4o".
 * @returns A LlmClientRegistry suitable for tests.
 */
export function createMockRegistry(
  mockClient?: LlmClient,
): LlmClientRegistry {
  const client = mockClient ?? createMockLlmClient();
  return createMockRegistryForLlmId(client.llmId, client);
}

/**
 * Creates a mock registry pre-configured for a specific llm_id.
 * Parses the llm_id (`provider:model-slug`) and registers a mock
 * provider adapter for it.
 *
 * @param llmId - Canonical LLM identifier (e.g. "deepseek:deepseek-chat").
 * @param mockClient - Optional pre-built mock client.
 * @returns A LlmClientRegistry that supports `getClient(llmId)`.
 */
export function createMockRegistryForLlmId(
  llmId: string,
  mockClient?: LlmClient,
): LlmClientRegistry {
  const colonIdx = llmId.indexOf(":");
  if (colonIdx < 0) {
    throw new Error(`Invalid llmId format: "${llmId}" — expected "provider:model-slug"`);
  }

  const providerId = llmId.slice(0, colonIdx);
  const modelSlug = llmId.slice(colonIdx + 1);

  const client = mockClient ?? createMockLlmClient({
    llmId,
    providerId,
    modelSlug,
    apiModelId: modelSlug,
  });

  const registry = createEmptyRegistry();

  // Create a test adapter that returns the mock client
  const testAdapter: ProviderAdapter = {
    providerId: client.providerId,
    validateConfig(_config: ProviderConfig): void {
      // No-op for tests
    },
    createModel(
      _modelSlug: string,
      _options: ModelOptions,
      _config: ProviderConfig,
    ): LanguageModel {
      return client.createModel();
    },
  };

  registry.registerProvider(testAdapter, {
    apiKey: "sk-test",
    models: { [client.modelSlug]: { apiModelId: client.apiModelId } },
  });

  return registry;
}
