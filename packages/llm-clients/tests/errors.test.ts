/**
 * Tests for the llm-clients error taxonomy.
 *
 * Verifies that every error subclass extends LlmClientConfigError, carries the
 * correct `code`, and produces meaningful messages.
 */

import { describe, it, expect } from "bun:test";
import {
  LlmClientConfigError,
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  ProviderNotConfiguredError,
  ModelNotConfiguredError,
  MissingApiKeyError,
} from "../src/errors.ts";

describe("LlmClientConfigError (base class)", () => {
  it("is an instance of Error", () => {
    const err = new LlmClientConfigError("test", "TEST_CODE");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name, message, and code", () => {
    const err = new LlmClientConfigError("something broke", "BROKEN");
    expect(err.name).toBe("LlmClientConfigError");
    expect(err.message).toBe("something broke");
    expect(err.code).toBe("BROKEN");
  });
});

describe("ConfigFileNotFoundError", () => {
  it("has correct code and message", () => {
    const err = new ConfigFileNotFoundError("/tmp/config.yaml");
    expect(err).toBeInstanceOf(LlmClientConfigError);
    expect(err.code).toBe("CONFIG_FILE_NOT_FOUND");
    expect(err.message).toContain("/tmp/config.yaml");
  });
});

describe("ConfigParseError", () => {
  it("has correct code and message", () => {
    const err = new ConfigParseError("/tmp/config.yaml", "unexpected token");
    expect(err).toBeInstanceOf(LlmClientConfigError);
    expect(err.code).toBe("CONFIG_PARSE_ERROR");
    expect(err.message).toContain("/tmp/config.yaml");
    expect(err.message).toContain("unexpected token");
  });
});

describe("ConfigValidationError", () => {
  it("has correct code and message", () => {
    const err = new ConfigValidationError("field x is required");
    expect(err).toBeInstanceOf(LlmClientConfigError);
    expect(err.code).toBe("CONFIG_VALIDATION_ERROR");
    expect(err.message).toContain("field x is required");
  });
});

describe("ProviderNotConfiguredError", () => {
  it("has correct code and message", () => {
    const err = new ProviderNotConfiguredError("google", ["deepseek", "openai"]);
    expect(err).toBeInstanceOf(LlmClientConfigError);
    expect(err.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(err.message).toContain("google");
    expect(err.message).toContain("deepseek, openai");
  });

  it("handles empty configured list", () => {
    const err = new ProviderNotConfiguredError("google", []);
    expect(err.message).toContain("(none)");
  });
});

describe("ModelNotConfiguredError", () => {
  it("has correct code and message", () => {
    const err = new ModelNotConfiguredError("deepseek", "gpt-4", ["deepseek-chat"]);
    expect(err).toBeInstanceOf(LlmClientConfigError);
    expect(err.code).toBe("MODEL_NOT_CONFIGURED");
    expect(err.message).toContain("gpt-4");
    expect(err.message).toContain("deepseek");
    expect(err.message).toContain("deepseek-chat");
  });
});

describe("MissingApiKeyError", () => {
  it("has correct code and message", () => {
    const err = new MissingApiKeyError("deepseek");
    expect(err).toBeInstanceOf(LlmClientConfigError);
    expect(err.code).toBe("MISSING_API_KEY");
    expect(err.message).toContain("deepseek");
    expect(err.message).toContain("api_key");
  });
});
