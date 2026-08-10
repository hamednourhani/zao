/**
 * Tests for the config loader — llm-providers.yaml loading, parsing,
 * env substitution, and validation.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadLlmProvidersConfig,
  type ResolvedProviderCatalog,
} from "../src/config.ts";
import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
} from "../src/errors.ts";

// ── Helpers ────────────────────────────────────────────────────────

let testDir: string;

async function writeConfig(content: string): Promise<string> {
  const dir = join(tmpdir(), `mo-llm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "llm-providers.yaml");
  await writeFile(path, content, "utf-8");
  return path;
}

async function cleanup(path: string): Promise<void> {
  const dir = path.substring(0, path.lastIndexOf("/"));
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

const MINIMAL_CONFIG = `
llm_providers:
  deepseek:
    api_key: "sk-test-deepseek-key"
    models:
      deepseek-chat:
        api_model_id: "deepseek-chat"
  openai:
    api_key: "sk-test-openai-key"
    models:
      gpt-4o:
        api_model_id: "gpt-4o"
`;

// ── Tests ───────────────────────────────────────────────────────────

describe("loadLlmProvidersConfig", () => {
  describe("file not found", () => {
    it("throws ConfigFileNotFoundError for missing file", () => {
      expect(loadLlmProvidersConfig({
        configPath: "/nonexistent/path/llm-providers.yaml",
      })).rejects.toThrow(ConfigFileNotFoundError);
    });
  });

  describe("parse errors", () => {
    it("throws ConfigParseError for invalid YAML", async () => {
      const path = await writeConfig("llm_providers: [unclosed");
      try {
        await expect(
          loadLlmProvidersConfig({ configPath: path }),
        ).rejects.toThrow(ConfigParseError);
      } finally {
        await cleanup(path);
      }
    });

    it("throws ConfigParseError for empty file (null YAML)", async () => {
      const path = await writeConfig("---\n");
      try {
        await expect(
          loadLlmProvidersConfig({ configPath: path }),
        ).rejects.toThrow(ConfigParseError);
      } finally {
        await cleanup(path);
      }
    });
  });

  describe("schema validation", () => {
    it("throws ConfigValidationError when llm_providers is missing", async () => {
      const path = await writeConfig("some_other_key: value\n");
      try {
        await expect(
          loadLlmProvidersConfig({ configPath: path }),
        ).rejects.toThrow(ConfigValidationError);
      } finally {
        await cleanup(path);
      }
    });

    it("throws ConfigValidationError when provider has no models", async () => {
      const path = await writeConfig(`
llm_providers:
  deepseek:
    api_key: "sk-key"
    models: {}
`);
      try {
        await expect(
          loadLlmProvidersConfig({ configPath: path }),
        ).rejects.toThrow(ConfigValidationError);
      } finally {
        await cleanup(path);
      }
    });

    it("throws ConfigValidationError when model entry has no api_model_id", async () => {
      const path = await writeConfig(`
llm_providers:
  deepseek:
    api_key: "sk-key"
    models:
      deepseek-chat:
        something_else: true
`);
      try {
        await expect(
          loadLlmProvidersConfig({ configPath: path }),
        ).rejects.toThrow(ConfigValidationError);
      } finally {
        await cleanup(path);
      }
    });

    it("throws ConfigValidationError when llm_providers is empty", async () => {
      const path = await writeConfig("llm_providers: {}\n");
      try {
        await expect(
          loadLlmProvidersConfig({ configPath: path }),
        ).rejects.toThrow(ConfigValidationError);
      } finally {
        await cleanup(path);
      }
    });
  });

  describe("env substitution", () => {
    it("resolves env vars in api_key", async () => {
      const path = await writeConfig(`
llm_providers:
  deepseek:
    api_key: "\${TEST_DEEPSEEK_KEY}"
    models:
      deepseek-chat:
        api_model_id: "deepseek-chat"
`);
      try {
        const catalog = await loadLlmProvidersConfig({
          configPath: path,
          env: { TEST_DEEPSEEK_KEY: "sk-resolved-key" },
        });
        const deepseekCfg = catalog.providers.get("deepseek");
        expect(deepseekCfg).toBeDefined();
        expect(deepseekCfg!.apiKey).toBe("sk-resolved-key");
      } finally {
        await cleanup(path);
      }
    });

    it("throws ConfigValidationError for unresolved env var", async () => {
      const path = await writeConfig(`
llm_providers:
  deepseek:
    api_key: "\${UNSET_VARIABLE}"
    models:
      deepseek-chat:
        api_model_id: "deepseek-chat"
`);
      try {
        await expect(
          loadLlmProvidersConfig({
            configPath: path,
            env: {},
          }),
        ).rejects.toThrow(ConfigValidationError);
      } finally {
        await cleanup(path);
      }
    });

    it("resolves env vars in base_url", async () => {
      const path = await writeConfig(`
llm_providers:
  openai:
    api_key: "\${OPENAI_KEY}"
    base_url: "\${OPENAI_BASE_URL}"
    models:
      gpt-4o:
        api_model_id: "gpt-4o"
`);
      try {
        const catalog = await loadLlmProvidersConfig({
          configPath: path,
          env: { OPENAI_KEY: "sk-key", OPENAI_BASE_URL: "https://custom.api/v1" },
        });
        const openaiCfg = catalog.providers.get("openai");
        expect(openaiCfg).toBeDefined();
        expect(openaiCfg!.apiKey).toBe("sk-key");
        expect(openaiCfg!.baseUrl).toBe("https://custom.api/v1");
      } finally {
        await cleanup(path);
      }
    });
  });

  describe("successful loading", () => {
    it("loads a valid config and returns resolved catalog", async () => {
      const path = await writeConfig(MINIMAL_CONFIG);
      try {
        const catalog = await loadLlmProvidersConfig({ configPath: path });

        expect(catalog.providers.size).toBe(2);
        expect(catalog.providers.has("deepseek")).toBe(true);
        expect(catalog.providers.has("openai")).toBe(true);

        const deepseekCfg = catalog.providers.get("deepseek")!;
        expect(deepseekCfg.apiKey).toBe("sk-test-deepseek-key");
        expect(deepseekCfg.models["deepseek-chat"]).toBeDefined();
        expect(deepseekCfg.models["deepseek-chat"]!.apiModelId).toBe("deepseek-chat");

        const openaiCfg = catalog.providers.get("openai")!;
        expect(openaiCfg.apiKey).toBe("sk-test-openai-key");
        expect(openaiCfg.models["gpt-4o"]).toBeDefined();
        expect(openaiCfg.models["gpt-4o"]!.apiModelId).toBe("gpt-4o");

        expect(catalog.allClientIds).toContain("deepseek:deepseek-chat");
        expect(catalog.allClientIds).toContain("openai:gpt-4o");
        expect(catalog.allClientIds.length).toBe(2);
      } finally {
        await cleanup(path);
      }
    });

    it("loads config with multiple models per provider", async () => {
      const path = await writeConfig(`
llm_providers:
  openai:
    api_key: "sk-key"
    models:
      gpt-4o:
        api_model_id: "gpt-4o"
      gpt-4o-mini:
        api_model_id: "gpt-4o-mini"
`);
      try {
        const catalog = await loadLlmProvidersConfig({ configPath: path });
        expect(catalog.allClientIds.length).toBe(2);
        expect(catalog.allClientIds).toContain("openai:gpt-4o");
        expect(catalog.allClientIds).toContain("openai:gpt-4o-mini");
      } finally {
        await cleanup(path);
      }
    });
  });

  describe("optional fields", () => {
    it("loads config without base_url", async () => {
      const path = await writeConfig(MINIMAL_CONFIG);
      try {
        const catalog = await loadLlmProvidersConfig({ configPath: path });
        const deepseekCfg = catalog.providers.get("deepseek")!;
        expect(deepseekCfg.baseUrl).toBeUndefined();
      } finally {
        await cleanup(path);
      }
    });
  });
});
