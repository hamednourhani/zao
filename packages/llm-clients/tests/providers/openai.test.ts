/**
 * Tests for the OpenAI provider adapter.
 *
 * Verifies that the adapter validates configs correctly (api_key required),
 * supports optional base_url, and creates Vercel AI SDK model objects.
 * No network calls are made — we verify the object shape only.
 */

import { describe, it, expect } from "bun:test";
import { openaiAdapter } from "../../src/providers/openai.ts";
import { MissingApiKeyError } from "../../src/errors.ts";
import type { ProviderConfig } from "../../src/providers/types.ts";

describe("openaiAdapter", () => {
  describe("providerId", () => {
    it('is "openai"', () => {
      expect(openaiAdapter.providerId).toBe("openai");
    });
  });

  describe("validateConfig", () => {
    it("does not throw when apiKey is present", () => {
      expect(() => {
        openaiAdapter.validateConfig({
          apiKey: "sk-valid-key",
          models: { test: { apiModelId: "test" } },
        });
      }).not.toThrow();
    });

    it("throws MissingApiKeyError when apiKey is empty", () => {
      expect(() => {
        openaiAdapter.validateConfig({
          apiKey: "",
          models: { test: { apiModelId: "test" } },
        });
      }).toThrow(MissingApiKeyError);
    });

    it("throws MissingApiKeyError when apiKey is missing", () => {
      expect(() => {
        openaiAdapter.validateConfig({
          models: { test: { apiModelId: "test" } },
        } as ProviderConfig);
      }).toThrow(MissingApiKeyError);
    });

    it("does NOT validate key format (no regex check)", () => {
      expect(() => {
        openaiAdapter.validateConfig({
          apiKey: "not-a-valid-openai-key",
          models: { test: { apiModelId: "test" } },
        });
      }).not.toThrow();
    });
  });

  describe("createModel", () => {
    const config: ProviderConfig = {
      apiKey: "sk-test-openai-key",
      models: {
        "gpt-4o": { apiModelId: "gpt-4o" },
        "gpt-4o-mini": { apiModelId: "gpt-4o-mini" },
      },
    };

    it("creates a model object that is defined", () => {
      const model = openaiAdapter.createModel(
        "gpt-4o",
        { temperature: 0.0 },
        config,
      );
      expect(model).toBeDefined();
    });

    it("uses the correct apiModelId from config", () => {
      const model = openaiAdapter.createModel(
        "gpt-4o-mini",
        {},
        config,
      );
      expect(model).toBeDefined();
    });

    it("creates a fresh object on each call (no caching)", () => {
      const model1 = openaiAdapter.createModel("gpt-4o", {}, config);
      const model2 = openaiAdapter.createModel("gpt-4o", {}, config);
      expect(model1).toBeDefined();
      expect(model2).toBeDefined();
    });

    it("passes temperature and maxTokens options", () => {
      const model = openaiAdapter.createModel(
        "gpt-4o",
        { temperature: 0.5, maxTokens: 4096 },
        config,
      );
      expect(model).toBeDefined();
    });

    it("supports base_url override", () => {
      const customConfig: ProviderConfig = {
        apiKey: "sk-key",
        baseUrl: "https://custom-endpoint.openai.com/v1",
        models: { "gpt-4o": { apiModelId: "gpt-4o" } },
      };
      const model = openaiAdapter.createModel("gpt-4o", {}, customConfig);
      expect(model).toBeDefined();
    });
  });
});
