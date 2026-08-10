/**
 * LlmClientRegistry — the central registry that owns credentials and creates
 * provider-specific Vercel AI SDK model objects on demand.
 *
 * ## Design (ADR-009)
 *
 * - Reads `llm-providers.yaml` at load time; validates fail-closed.
 * - `getClient(llmId)` resolves a canonical `provider:model-slug` string
 *   to a ready `LlmClient`.
 * - `listClients()` exposes all configured models for controller planning.
 * - `registerProvider(adapter)` is the public extension point for tests
 *   and future providers.
 * - No client caching in Phase 1 — `createModel()` returns a fresh instance
 *   each time.
 *
 * ## Test injection
 *
 * Use `createTestRegistry()` + `registerProvider()` to create a registry
 * with fake adapters that don't touch the network.
 *
 * @module registry
 */

import type { LanguageModel } from "ai";
import type {
  ProviderAdapter,
  ModelOptions,
  ProviderConfig,
} from "./providers/types.ts";
import {
  ProviderNotConfiguredError,
  ModelNotConfiguredError,
} from "./errors.ts";
import { loadLlmProvidersConfig } from "./config.ts";
import type { ResolvedProviderCatalog } from "./config.ts";
import { deepseekAdapter } from "./providers/deepseek.ts";
import { openaiAdapter } from "./providers/openai.ts";

// ── Public Types ──────────────────────────────────────────────────

/**
 * A ready-to-use LLM client that can create Vercel AI SDK model objects.
 *
 * Returned by {@link LlmClientRegistry.getClient}.
 */
export interface LlmClient {
  /** The canonical `llm_id` (e.g. "deepseek:deepseek-chat"). */
  readonly llmId: string;
  /** The provider key (e.g. "deepseek"). */
  readonly providerId: string;
  /** The user-defined model slug (e.g. "deepseek-chat"). */
  readonly modelSlug: string;
  /** The actual API model ID sent to the provider (e.g. "deepseek-chat"). */
  readonly apiModelId: string;

  /**
   * Creates a fresh Vercel AI SDK `LanguageModel` instance.
   *
   * @param options - Temperature, maxTokens, etc.
   * @returns A ready-to-use LanguageModel.
   */
  createModel(options?: ModelOptions): LanguageModel;
}

/**
 * Information about a single configured provider/model combination,
 * returned by {@link LlmClientRegistry.listClients} for controller planning.
 */
export interface ClientInfo {
  /** The canonical `llm_id`. */
  llmId: string;
  /** The provider key. */
  providerId: string;
  /** The user-defined model slug. */
  modelSlug: string;
  /** The actual API model ID. */
  apiModelId: string;
}

/**
 * The central LLM client registry interface.
 */
export interface LlmClientRegistry {
  /**
   * Resolves a canonical `llm_id` to a ready client.
   *
   * @param llmId - The `provider:model-slug` identifier.
   * @returns A ready `LlmClient` (config is already validated at load time).
   * @throws {ProviderNotConfiguredError} If the provider is unknown.
   * @throws {ModelNotConfiguredError} If the model slug is unknown.
   */
  getClient(llmId: string): Promise<LlmClient>;

  /**
   * Exposes every configured provider/model combination so the
   * controller can plan flows without hitting mid-run failures.
   *
   * @returns Array of client info objects.
   */
  listClients(): ClientInfo[];

  /**
   * Registers a provider adapter at runtime. The adapter's
   * {@link ProviderAdapter.validateConfig} is called immediately.
   * This is the public extension point for tests and future providers.
   *
   * @param adapter - The provider adapter to register.
   * @param config - Optional provider configuration. Required for
   *   test registries; for production registries, config is loaded
   *   from the config file.
   */
  registerProvider(adapter: ProviderAdapter, config?: ProviderConfig): void;
}

// ── Built-in adapters ─────────────────────────────────────────────

/** Phase 1 built-in provider adapters (deepseek, openai). */
const BUILT_IN_ADAPTERS: ProviderAdapter[] = [
  deepseekAdapter,
  openaiAdapter,
];

// ── Registry Implementation ───────────────────────────────────────

/**
 * Creates the default production registry, loading config from
 * `llm-providers.yaml` and registering all built-in adapters.
 *
 * ## Behavior
 *
 * - Fails fast if the config file is missing, malformed, or invalid.
 * - Validates each built-in adapter's config via `validateConfig()`.
 * - Returns a fully initialized registry ready for `getClient()` calls.
 *
 * @param options - Optional overrides.
 * @param options.configPath - Explicit path to the config file.
 * @param options.env - Environment object (default `process.env`).
 * @returns A ready `LlmClientRegistry`.
 * @throws {LlmClientConfigError} If config loading or validation fails.
 */
export async function createDefaultRegistry(options?: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<LlmClientRegistry> {
  const catalog = await loadLlmProvidersConfig(options);

  const registry = new LlmClientRegistryImpl(catalog);

  // Register all built-in adapters with their config from the catalog
  for (const adapter of BUILT_IN_ADAPTERS) {
    const providerConfig = catalog.providers.get(adapter.providerId);
    if (providerConfig) {
      registry.registerProvider(adapter, providerConfig);
    }
  }

  return registry;
}

/**
 * Creates an empty test registry with no config loaded.
 *
 * Use `registerProvider()` to add test adapters and `registerProvider()`
 * with a config to set up providers without real API keys.
 *
 * @returns An empty `LlmClientRegistry` ready for test injection.
 */
export function createTestRegistry(): LlmClientRegistry {
  return new LlmClientRegistryImpl({
    providers: new Map(),
    allClientIds: [],
  });
}

// ── Internal Implementation ───────────────────────────────────────

/**
 * Internal implementation of {@link LlmClientRegistry}.
 */
class LlmClientRegistryImpl implements LlmClientRegistry {
  /** Map of provider ID → adapter. */
  private readonly adapters = new Map<string, ProviderAdapter>();
  /** Map of provider ID → validated config. */
  private readonly configs = new Map<string, ProviderConfig>();
  /** Flat list of all { llmId, providerId, modelSlug, apiModelId }. */
  private readonly clientList: ClientInfo[] = [];

  /**
   * @param catalog - The resolved provider catalog from config loading.
   */
  constructor(catalog: ResolvedProviderCatalog) {
    // Build the client info list from the catalog eagerly
    for (const [providerId, config] of catalog.providers) {
      for (const [modelSlug, modelEntry] of Object.entries(config.models)) {
        this.clientList.push({
          llmId: `${providerId}:${modelSlug}`,
          providerId,
          modelSlug,
          apiModelId: modelEntry.apiModelId,
        });
      }
    }
  }

  /** @inheritdoc */
  async getClient(llmId: string): Promise<LlmClient> {
    const colonIdx = llmId.indexOf(":");
    if (colonIdx < 0) {
      throw new ProviderNotConfiguredError(llmId, Array.from(this.adapters.keys()));
    }

    const providerId = llmId.slice(0, colonIdx);
    const modelSlug = llmId.slice(colonIdx + 1);

    const config = this.configs.get(providerId);
    if (!config) {
      throw new ProviderNotConfiguredError(
        providerId,
        Array.from(this.adapters.keys()),
      );
    }

    const modelEntry = config.models[modelSlug];
    if (!modelEntry) {
      throw new ModelNotConfiguredError(
        providerId,
        modelSlug,
        Object.keys(config.models ?? {}),
      );
    }

    const adapter = this.adapters.get(providerId)!;

    return {
      llmId,
      providerId,
      modelSlug,
      apiModelId: modelEntry.apiModelId,

      createModel(options?: ModelOptions): LanguageModel {
        return adapter.createModel(modelSlug, options ?? {}, config);
      },
    };
  }

  /** @inheritdoc */
  listClients(): ClientInfo[] {
    return [...this.clientList];
  }

  /** @inheritdoc */
  registerProvider(adapter: ProviderAdapter, config?: ProviderConfig): void {
    if (config) {
      // Validate before storing (fail-closed)
      adapter.validateConfig(config);
      this.configs.set(adapter.providerId, config);

      // Remove all existing entries for this provider (re-registration replaces old config)
      for (let i = this.clientList.length - 1; i >= 0; i--) {
        if (this.clientList[i]!.providerId === adapter.providerId) {
          this.clientList.splice(i, 1);
        }
      }

      // Build client list entries for this provider
      for (const [modelSlug, modelEntry] of Object.entries(config.models)) {
        this.clientList.push({
          llmId: `${adapter.providerId}:${modelSlug}`,
          providerId: adapter.providerId,
          modelSlug,
          apiModelId: modelEntry.apiModelId,
        });
      }
    }

    this.adapters.set(adapter.providerId, adapter);
  }
}
