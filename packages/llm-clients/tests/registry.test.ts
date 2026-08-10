/**
 * Tests for the LlmClientRegistry — getClient, listClients, registerProvider,
 * test injection, and error handling.
 */

import { describe, it, expect } from "bun:test";
import type { LanguageModel } from "ai";
import {
  createTestRegistry,
  createDefaultRegistry,
  type LlmClientRegistry,
  type LlmClient,
} from "../src/registry.ts";
import type {
  ProviderAdapter,
  ProviderConfig,
  ModelOptions,
} from "../src/providers/types.ts";
import {
  ProviderNotConfiguredError,
  ModelNotConfiguredError,
  MissingApiKeyError,
} from "../src/errors.ts";

// ── Test Adapter ──────────────────────────────────────────────────

/**
 * Creates a lightweight fake provider adapter for testing.
 * Returns a mock LanguageModel that does not make network calls.
 */
function createTestAdapter(
  providerId: string = "test",
): ProviderAdapter & { createModelCalls: Array<{ slug: string; options: ModelOptions; config: ProviderConfig }> } {
  const createModelCalls: Array<{ slug: string; options: ModelOptions; config: ProviderConfig }> = [];

  return {
    providerId,
    createModelCalls,

    validateConfig(config: ProviderConfig): void {
      if (config.apiKey === "") {
        throw new MissingApiKeyError(providerId);
      }
    },

    createModel(
      modelSlug: string,
      options: ModelOptions,
      config: ProviderConfig,
    ): LanguageModel {
      createModelCalls.push({ slug: modelSlug, options, config });
      return {
        modelId: modelSlug,
        provider: providerId,
      } as unknown as LanguageModel;
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function testProviderConfig(models: Record<string, string>): ProviderConfig {
  const modelEntries: Record<string, { apiModelId: string }> = {};
  for (const [slug, apiModelId] of Object.entries(models)) {
    modelEntries[slug] = { apiModelId };
  }
  return {
    apiKey: "sk-test-key",
    models: modelEntries,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("createTestRegistry", () => {
  it("returns a registry with no clients", () => {
    const registry = createTestRegistry();
    expect(registry.listClients()).toEqual([]);
  });

  it("rejects getClient for any llm_id with no providers", async () => {
    const registry = createTestRegistry();
    await expect(
      registry.getClient("test:mock"),
    ).rejects.toThrow(ProviderNotConfiguredError);
  });
});

describe("registerProvider", () => {
  it("registers a provider and allows getClient", async () => {
    const registry = createTestRegistry();
    const adapter = createTestAdapter("test");
    registry.registerProvider(adapter, testProviderConfig({ mock: "mock-model" }));

    const client = await registry.getClient("test:mock");
    expect(client.llmId).toBe("test:mock");
    expect(client.providerId).toBe("test");
    expect(client.modelSlug).toBe("mock");
    expect(client.apiModelId).toBe("mock-model");
  });

  it("validates config via adapter.validateConfig", () => {
    const registry = createTestRegistry();
    const adapter = createTestAdapter("test");

    expect(() => {
      registry.registerProvider(adapter, {
        apiKey: "",
        models: { mock: { apiModelId: "mock" } },
      });
    }).toThrow(MissingApiKeyError);
  });

  it("rejects getClient for unknown model slug", async () => {
    const registry = createTestRegistry();
    const adapter = createTestAdapter("test");
    registry.registerProvider(adapter, testProviderConfig({ mock: "mock-model" }));

    await expect(
      registry.getClient("test:unknown"),
    ).rejects.toThrow(ModelNotConfiguredError);
  });

  it("rejects getClient for unknown provider", async () => {
    const registry = createTestRegistry();
    const adapter = createTestAdapter("test");
    registry.registerProvider(adapter, testProviderConfig({ mock: "mock-model" }));

    await expect(
      registry.getClient("other:mock"),
    ).rejects.toThrow(ProviderNotConfiguredError);
  });

  it("rejects malformed llm_id without colon", async () => {
    const registry = createTestRegistry();
    const adapter = createTestAdapter("test");
    registry.registerProvider(adapter, testProviderConfig({ mock: "mock-model" }));

    await expect(
      registry.getClient("no-colon-here"),
    ).rejects.toThrow(ProviderNotConfiguredError);
  });
});

describe("LlmClient.createModel", () => {
  it("creates a LanguageModel with correct options", async () => {
    const registry = createTestRegistry();
    const adapter = createTestAdapter("test");
    registry.registerProvider(adapter, testProviderConfig({ mock: "mock-model" }));

    const client = await registry.getClient("test:mock");
    const model = client.createModel({ temperature: 0.1, maxTokens: 4096 });

    expect(model).toBeDefined();
    expect(adapter.createModelCalls.length).toBe(1);
    expect(adapter.createModelCalls[0]!.slug).toBe("mock");
    expect(adapter.createModelCalls[0]!.options.temperature).toBe(0.1);
    expect(adapter.createModelCalls[0]!.options.maxTokens).toBe(4096);
  });

  it("creates a model with default options when omitted", async () => {
    const registry = createTestRegistry();
    const adapter = createTestAdapter("test");
    registry.registerProvider(adapter, testProviderConfig({ mock: "mock-model" }));

    const client = await registry.getClient("test:mock");
    const model = client.createModel();

    expect(model).toBeDefined();
    expect(adapter.createModelCalls.length).toBe(1);
    expect(adapter.createModelCalls[0]!.options.temperature).toBeUndefined();
    expect(adapter.createModelCalls[0]!.options.maxTokens).toBeUndefined();
  });
});

describe("listClients", () => {
  it("returns all configured clients after registration", () => {
    const registry = createTestRegistry();
    const adapter = createTestAdapter("test");
    registry.registerProvider(adapter, testProviderConfig({
      mock: "mock-model",
      other: "other-model",
    }));

    const clients = registry.listClients();
    expect(clients.length).toBe(2);
    expect(clients.find((c) => c.llmId === "test:mock")).toBeDefined();
    expect(clients.find((c) => c.llmId === "test:other")).toBeDefined();
  });

  it("returns correct ClientInfo shape", () => {
    const registry = createTestRegistry();
    const adapter = createTestAdapter("test");
    registry.registerProvider(adapter, testProviderConfig({ mock: "mock-model" }));

    const [client] = registry.listClients();
    expect(client!.llmId).toBe("test:mock");
    expect(client!.providerId).toBe("test");
    expect(client!.modelSlug).toBe("mock");
    expect(client!.apiModelId).toBe("mock-model");
  });
});

describe("multiple providers", () => {
  it("supports registering multiple providers", async () => {
    const registry = createTestRegistry();
    const adapterA = createTestAdapter("provider-a");
    const adapterB = createTestAdapter("provider-b");

    registry.registerProvider(adapterA, testProviderConfig({ modelA: "api-model-a" }));
    registry.registerProvider(adapterB, testProviderConfig({ modelB: "api-model-b" }));

    const clientA = await registry.getClient("provider-a:modelA");
    const clientB = await registry.getClient("provider-b:modelB");

    expect(clientA.providerId).toBe("provider-a");
    expect(clientB.providerId).toBe("provider-b");
    expect(registry.listClients().length).toBe(2);
  });

  it("re-registering a provider updates its config", async () => {
    const registry = createTestRegistry();
    const adapter = createTestAdapter("test");

    registry.registerProvider(adapter, testProviderConfig({ old: "old-model" }));
    expect(registry.listClients().length).toBe(1);

    registry.registerProvider(adapter, testProviderConfig({ new: "new-model" }));
    expect(registry.listClients().length).toBe(1);

    const client = await registry.getClient("test:new");
    expect(client.apiModelId).toBe("new-model");

    await expect(
      registry.getClient("test:old"),
    ).rejects.toThrow(ModelNotConfiguredError);
  });
});

describe("createDefaultRegistry (integration)", () => {
  it("requires a valid config file (integration smoke test)", async () => {
    // createDefaultRegistry requires the config file to exist.
    // This test verifies it throws appropriately when file is missing.
    await expect(
      createDefaultRegistry({ configPath: "/nonexistent/path/config.yaml" }),
    ).rejects.toThrow();
  });
});
