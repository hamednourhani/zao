/**
 * Public API for `@zao/llm-clients` — the single component that owns
 * provider credentials and creates Vercel AI SDK model objects.
 *
 * ## Quick start
 *
 * ```typescript
 * import { createDefaultRegistry } from "@zao/llm-clients";
 *
 * const registry = await createDefaultRegistry();
 * const client = await registry.getClient("deepseek:deepseek-chat");
 * const model = client.createModel({ temperature: 0.1 });
 * ```
 *
 * ## Test injection
 *
 * ```typescript
 * import { createTestRegistry } from "@zao/llm-clients";
 *
 * const registry = createTestRegistry();
 * registry.registerProvider(myTestAdapter, { models: { mock: { apiModelId: "mock" } } });
 * const client = await registry.getClient("test:mock");
 * ```
 *
 * @module llm-clients
 */

// ── Registry ──────────────────────────────────────────────────────
export {
  createDefaultRegistry,
  createTestRegistry,
} from "./registry.ts";
export type {
  LlmClientRegistry,
  LlmClient,
  ClientInfo,
} from "./registry.ts";

// ── Provider Adapters ─────────────────────────────────────────────
export type {
  ProviderAdapter,
  ProviderConfig,
  ModelOptions,
} from "./providers/types.ts";

// ── Errors ────────────────────────────────────────────────────────
export {
  LlmClientConfigError,
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  ProviderNotConfiguredError,
  ModelNotConfiguredError,
  MissingApiKeyError,
} from "./errors.ts";
