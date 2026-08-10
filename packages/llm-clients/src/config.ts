/**
 * Config loader — reads, parses, and validates `llm-providers.yaml`.
 *
 * ## Resolution order
 *
 * 1. `ZAO_LLM_PROVIDERS_PATH` environment variable
 * 2. `configPath` option passed to `loadLlmProvidersConfig()`
 * 3. Default: `~/.zao/llm-providers.yaml`
 *
 * ## Behavior
 *
 * - Fail-closed: any error (missing file, parse error, schema violation,
 *   unresolved env var) throws a typed {@link LlmClientConfigError}.
 * - Env substitution: `${VAR_NAME}` in `api_key` and other credential fields
 *   is replaced with `process.env[VAR_NAME]`. Unresolved vars are an error.
 * - The resolved config exposes a flat, validated structure for the registry.
 *
 * @module config
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  LlmProvidersFileSchema,
  type LlmProvidersFile,
  type ProviderConfig as ProviderConfigParsed,
} from "./schemas.ts";
import type { ProviderConfig as AdapterProviderConfig } from "./providers/types.ts";
import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
} from "./errors.ts";

// ── Types ──────────────────────────────────────────────────────────

/**
 * The fully resolved and validated provider catalog.
 * Each provider's config is flattened into the adapter-friendly shape.
 */
export interface ResolvedProviderCatalog {
  /** Map of provider ID → resolved config. */
  providers: Map<string, AdapterProviderConfig>;
  /** Array of all `llm_id` strings in the catalog, for controller planning. */
  allClientIds: string[];
}

// ── Constants ──────────────────────────────────────────────────────

/** Default path for the LLM providers config file. */
const DEFAULT_CONFIG_PATH = join(homedir(), ".zao", "llm-providers.yaml");

/** Regex for env var substitution patterns like `${VAR_NAME}`. */
const ENV_SUBSTITUTION_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// ── Env Substitution ───────────────────────────────────────────────

/**
 * Replaces `${VAR_NAME}` patterns in a string with environment variable values.
 *
 * @param value - The string value to perform substitution on.
 * @param env - The environment object to resolve variables from.
 * @returns The string with all env vars substituted.
 * @throws {ConfigValidationError} If any variable remains unresolved.
 */
function substituteEnvVars(
  value: string,
  env: NodeJS.ProcessEnv,
): string {
  return value.replace(ENV_SUBSTITUTION_RE, (_match, varName: string) => {
    const resolved = env[varName];
    if (resolved === undefined) {
      throw new ConfigValidationError(
        `Environment variable "${varName}" is not set (required by config).`,
      );
    }
    return resolved;
  });
}

/**
 * Recursively walks a config object tree and performs env var substitution
 * on all string values.
 *
 * @param obj - The parsed config (plain object).
 * @param env - The environment object.
 * @throws {ConfigValidationError} If any variable remains unresolved.
 */
function substituteConfigEnvVars(
  obj: unknown,
  env: NodeJS.ProcessEnv,
): void {
  if (typeof obj === "string") {
    // Strings are replaced in-place via the caller — this function only
    // validates string values that contain unresolvable env vars.
    return;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      substituteConfigEnvVars(item, env);
    }
    return;
  }

  if (obj !== null && typeof obj === "object") {
    const record = obj as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string") {
        record[key] = substituteEnvVars(value, env);
      } else if (typeof value === "object" && value !== null) {
        substituteConfigEnvVars(value, env);
      }
    }
  }
}

// ── Config Loading ─────────────────────────────────────────────────

/**
 * Resolves the config file path from options, env var, or default.
 *
 * @param configPath - Optional explicit path override.
 * @returns The resolved absolute path.
 */
function resolveConfigPath(configPath?: string): string {
  if (configPath) return configPath;
  const envPath = process.env["ZAO_LLM_PROVIDERS_PATH"];
  if (envPath) return envPath;
  return DEFAULT_CONFIG_PATH;
}

/**
 * Loads, parses, and validates the `llm-providers.yaml` config file.
 *
 * ## Validation pipeline
 *
 * 1. Read the raw file (fail if missing)
 * 2. Parse YAML (fail on parse error)
 * 3. Substitute env vars (fail on unresolved `${VAR}`)
 * 4. Validate against Zod schema (fail on schema violation)
 * 5. Build the resolved provider catalog
 *
 * @param options - Optional config overrides.
 * @param options.configPath - Explicit path to the config file.
 * @param options.env - Environment object for env var substitution (default `process.env`).
 * @returns The resolved provider catalog.
 * @throws {ConfigFileNotFoundError} If the config file is missing.
 * @throws {ConfigParseError} If the YAML cannot be parsed.
 * @throws {ConfigValidationError} If schema validation or env substitution fails.
 */
export async function loadLlmProvidersConfig(options?: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedProviderCatalog> {
  const configPath = resolveConfigPath(options?.configPath);
  const env = options?.env ?? process.env;

  // ── Step 1: Read raw file ──────────────────────────────────────
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch (error: unknown) {
    const errCode =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code: string }).code
        : undefined;
    if (errCode === "ENOENT") {
      throw new ConfigFileNotFoundError(configPath);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigFileNotFoundError(
      `${configPath} (${message})`,
    );
  }

  // ── Step 2: Parse YAML ─────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigParseError(configPath, message);
  }

  if (parsed === null || parsed === undefined || typeof parsed !== "object") {
    throw new ConfigParseError(
      configPath,
      "Config file is empty or not a YAML object.",
    );
  }

  // ── Step 3: Env substitution ───────────────────────────────────
  try {
    substituteConfigEnvVars(parsed, env);
  } catch (error: unknown) {
    if (error instanceof ConfigValidationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(
      `Env substitution failed: ${message}`,
    );
  }

  // ── Step 4: Schema validation ──────────────────────────────────
  const validation = LlmProvidersFileSchema.safeParse(parsed);
  if (!validation.success) {
    throw new ConfigValidationError(
      validation.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  }

  const config: LlmProvidersFile = validation.data;

  // ── Step 5: Build resolved catalog ─────────────────────────────
  const providers = new Map<string, AdapterProviderConfig>();
  const allClientIds: string[] = [];

  for (const [providerId, providerConfig] of Object.entries(
    config.llm_providers,
  )) {
    const models: Record<string, { apiModelId: string }> = {};
    for (const [modelSlug, modelEntry] of Object.entries(
      (providerConfig as ProviderConfigParsed).models,
    )) {
      models[modelSlug] = {
        apiModelId: (modelEntry as { api_model_id: string }).api_model_id,
      };
      allClientIds.push(`${providerId}:${modelSlug}`);
    }

    providers.set(providerId, {
      apiKey: (providerConfig as ProviderConfigParsed).api_key,
      baseUrl: (providerConfig as ProviderConfigParsed).base_url,
      models,
    });
  }

  return { providers, allClientIds };
}
