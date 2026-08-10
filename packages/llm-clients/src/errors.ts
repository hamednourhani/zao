/**
 * LLM Client error taxonomy — all config and provider errors thrown by the registry.
 *
 * ## Design
 *
 * All errors extend {@link LlmClientConfigError}, which carries a `code` for
 * programmatic discrimination. Subclasses cover specific failure modes:
 *
 * | Subclass | Code | Trigger |
 * |---|---|---|
 * | `ConfigFileNotFoundError` | `CONFIG_FILE_NOT_FOUND` | File missing |
 * | `ConfigParseError` | `CONFIG_PARSE_ERROR` | Invalid YAML |
 * | `ConfigValidationError` | `CONFIG_VALIDATION_ERROR` | Schema violation / unresolved env |
 * | `ProviderNotConfiguredError` | `PROVIDER_NOT_CONFIGURED` | Unknown provider |
 * | `ModelNotConfiguredError` | `MODEL_NOT_CONFIGURED` | Unknown model slug |
 * | `MissingApiKeyError` | `MISSING_API_KEY` | Paid provider has no `api_key` |
 *
 * ## Rules
 *
 * - Config errors are thrown by `createDefaultRegistry()` or `getClient()`.
 * - Runtime errors (rate limit, network, provider down) are handled by the
 *   harness's retry layer — the registry never retries network calls.
 *
 * @module errors
 */

/**
 * Base error for all LLM client configuration failures.
 * Carries a `code` for programmatic discrimination.
 */
export class LlmClientConfigError extends Error {
  /** Discriminator code (e.g. `"CONFIG_FILE_NOT_FOUND"`). */
  public readonly code: string;

  /**
   * @param message - Human-readable error description.
   * @param code - Machine-readable error code.
   */
  constructor(message: string, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

/**
 * The `llm-providers.yaml` config file was not found at the expected path.
 */
export class ConfigFileNotFoundError extends LlmClientConfigError {
  /**
   * @param path - The expected file path.
   */
  constructor(path: string) {
    super(
      `LLM providers config file not found at "${path}". ` +
        "Create ~/.zao/llm-providers.yaml or set ZAO_LLM_PROVIDERS_PATH.",
      "CONFIG_FILE_NOT_FOUND",
    );
  }
}

/**
 * The config file could not be parsed as valid YAML.
 */
export class ConfigParseError extends LlmClientConfigError {
  /**
   * @param path - The config file path.
   * @param cause - The underlying parse error message.
   */
  constructor(path: string, cause: string) {
    super(
      `Failed to parse LLM providers config at "${path}": ${cause}`,
      "CONFIG_PARSE_ERROR",
    );
  }
}

/**
 * The config file passed YAML parsing but failed schema validation
 * or contained an unresolved environment variable.
 */
export class ConfigValidationError extends LlmClientConfigError {
  /**
   * @param issues - Validation issue descriptions.
   */
  constructor(issues: string) {
    super(
      `LLM providers config validation failed: ${issues}`,
      "CONFIG_VALIDATION_ERROR",
    );
  }
}

/**
 * The `llm_id` references a provider that is not configured
 * in `llm-providers.yaml`.
 */
export class ProviderNotConfiguredError extends LlmClientConfigError {
  /**
   * @param providerId - The provider key (e.g. "google") from the `llm_id`.
   * @param configured - The list of configured provider IDs.
   */
  constructor(providerId: string, configured: string[]) {
    super(
      `Provider "${providerId}" is not configured. ` +
        `Configured providers: ${configured.join(", ") || "(none)"}.`,
      "PROVIDER_NOT_CONFIGURED",
    );
  }
}

/**
 * The `llm_id` references a model slug that does not exist under
 * the configured provider.
 */
export class ModelNotConfiguredError extends LlmClientConfigError {
  /**
   * @param providerId - The provider key.
   * @param modelSlug - The requested model slug.
   * @param available - The list of configured model slugs for this provider.
   */
  constructor(
    providerId: string,
    modelSlug: string,
    available: string[],
  ) {
    super(
      `Model "${modelSlug}" is not configured for provider "${providerId}". ` +
        `Available models: ${available.join(", ") || "(none)"}.`,
      "MODEL_NOT_CONFIGURED",
    );
  }
}

/**
 * A paid provider requires an `api_key`, but none was configured
 * (or env substitution failed).
 */
export class MissingApiKeyError extends LlmClientConfigError {
  /**
   * @param providerId - The provider that requires an API key.
   */
  constructor(providerId: string) {
    super(
      `Provider "${providerId}" requires an api_key, but none was found. ` +
        "Set it in llm-providers.yaml or via environment variable substitution.",
      "MISSING_API_KEY",
    );
  }
}
