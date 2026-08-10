/**
 * Shared roles schemas — canonical Zod contracts for roles configuration.
 *
 * These schemas are the single source of truth for the roles file format.
 * They mirror the JSON Schema at `roles.schema.json` and are shared by
 * the controller, blueprint, and any other packages that need to validate
 * or construct role configurations.
 *
 * ## v0.3.0 (TD-033)
 *
 * - `llm_id` field (nullable = inherit default) replaces the old `model` field.
 * - `model_defaults.default_llm_id` replaces `model_defaults.default`.
 * - `model_config` removed (replaced by `@zao/llm-clients` registry).
 *
 * @module role-schemas
 */

import { z } from "zod";

// ── Role Definition ──────────────────────────────────────────────

/** Schema for a single role's definition. Strict — no extra fields allowed. */
export const RoleDefinitionSchema = z
  .object({
    /** System prompt template. Supports `{{variable}}` substitution only. */
    prompt_template: z.string().min(1),
    /** Fraction of the model context window allocated to this role (0-1). */
    context_budget: z.number().min(0).max(1),
    /** Canonical LLM identifier (provider:model-slug). `null` means inherit default. */
    llm_id: z.string().min(1).nullable(),
  })
  .strict();

export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;

// ── Model Defaults ────────────────────────────────────────────────

/** Schema for the model_defaults section of a roles file. */
export const ModelDefaultsSchema = z
  .object({
    default_llm_id: z.string().min(1),
  })
  .strict();

export type ModelDefaults = z.infer<typeof ModelDefaultsSchema>;

// ── Roles File ────────────────────────────────────────────────────

/** Validated role name pattern. Must start with a letter (a-z), then letters/numbers/underscores/hyphens. */
const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Schema for the complete roles configuration file. */
export const RolesFileSchema = z
  .object({
    schema_version: z.literal("0.3.0"),
    model_defaults: ModelDefaultsSchema,
    roles: z.record(
      z.string().min(1).regex(ROLE_NAME_PATTERN, "Role names must use only a-z, 0-9, _, - (and start with a-z or 0-9)"),
      RoleDefinitionSchema,
    ),
  })
  .strict();

export type RolesFile = z.infer<typeof RolesFileSchema>;
