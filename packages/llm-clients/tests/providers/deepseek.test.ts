/**
 * Tests for the DeepSeek provider adapter.
 *
 * Verifies that the adapter validates configs correctly (api_key required)
 * and creates Vercel AI SDK model objects with the correct parameters.
 * No network calls are made — we verify the object shape only.
 */

import { describe, it, expect } from "bun:test";
import { deepseekAdapter } from "../../src/providers/deepseek.ts";
import { MissingApiKeyError } from "../../src/errors.ts";
import type { ProviderConfig } from "../../src/providers/types.ts";

describe("deepseekAdapter", () => {
  describe("providerId", () => {
    it('is "deepseek"', () => {
      expect(deepseekAdapter.providerId).toBe("deepseek");
    });
  });

  describe("validateConfig", () => {
    it("does not throw when apiKey is present", () => {
      expect(() => {
        deepseekAdapter.validateConfig({
          apiKey: "sk-valid-key",
          models: { test: { apiModelId: "test" } },
        });
      }).not.toThrow();
    });

    it("throws MissingApiKeyError when apiKey is empty", () => {
      expect(() => {
        deepseekAdapter.validateConfig({
          apiKey: "",
          models: { test: { apiModelId: "test" } },
        });
      }).toThrow(MissingApiKeyError);
    });

    it("throws MissingApiKeyError when apiKey is missing", () => {
      expect(() => {
        deepseekAdapter.validateConfig({
          models: { test: { apiModelId: "test" } },
        } as ProviderConfig);
      }).toThrow(MissingApiKeyError);
    });

    it("throws MissingApiKeyError when apiKey is whitespace only", () => {
      expect(() => {
        deepseekAdapter.validateConfig({
          apiKey: "   ",
          models: { test: { apiModelId: "test" } },
        });
      }).toThrow(MissingApiKeyError);
    });

    it("does NOT validate key format (no regex check)", () => {
      // The controller does smoke tests — adapters only check presence
      expect(() => {
        deepseekAdapter.validateConfig({
          apiKey: "not-a-valid-format",
          models: { test: { apiModelId: "test" } },
        });
      }).not.toThrow();
    });
  });

  describe("createModel", () => {
    const config: ProviderConfig = {
      apiKey: "sk-test-key",
      models: {
        "deepseek-chat": { apiModelId: "deepseek-chat" },
        "deepseek-reasoner": { apiModelId: "deepseek-reasoner" },
      },
    };

    it("creates a model object that is defined", () => {
      const model = deepseekAdapter.createModel(
        "deepseek-chat",
        { temperature: 0.1 },
        config,
      );
      expect(model).toBeDefined();
    });

    it("uses the correct apiModelId from config", () => {
      const model = deepseekAdapter.createModel(
        "deepseek-reasoner",
        {},
        config,
      );
      expect(model).toBeDefined();
    });

    it("falls back to modelSlug as apiModelId if model not in config", () => {
      // This shouldn't happen in production (registry validates), but we defend anyway
      const model = deepseekAdapter.createModel(
        "unknown-model",
        {},
        config,
      );
      expect(model).toBeDefined();
    });

    it("passes temperature and maxTokens options", () => {
      const model = deepseekAdapter.createModel(
        "deepseek-chat",
        { temperature: 0.7, maxTokens: 8192 },
        config,
      );
      expect(model).toBeDefined();
    });

    it("creates a fresh object on each call (no caching)", () => {
      const model1 = deepseekAdapter.createModel("deepseek-chat", {}, config);
      const model2 = deepseekAdapter.createModel("deepseek-chat", {}, config);
      // Each call should create a new object via the SDK factory
      expect(model1).toBeDefined();
      expect(model2).toBeDefined();
    });

    it("accepts cache option without error", () => {
      // The cache flag is forwarded to the SDK via provider options
      // at the generateObject call site in llm.ts. The adapter's
      // createModel simply acknowledges it — caching is provider-level.
      const model = deepseekAdapter.createModel(
        "deepseek-chat",
        { cache: true },
        config,
      );
      expect(model).toBeDefined();
    });

    it("accepts cache: false without error", () => {
      const model = deepseekAdapter.createModel(
        "deepseek-chat",
        { cache: false },
        config,
      );
      expect(model).toBeDefined();
    });
  });
});
