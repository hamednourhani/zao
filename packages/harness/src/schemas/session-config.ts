/**
 * Session config schema — the immutable session configuration written
 * exactly once when a session is created.
 *
 * ## SECURITY: ADR-009
 *
 * This schema BANS all credential fields. No apiKey, api_key, apiSecret,
 * token, or baseURL may appear in session files. Credentials are loaded
 * from the live config at runtime.
 *
 * ## Schema version: 1.0
 *
 * Bumped from 0.2.0 because the `model_config` block was removed entirely
 * in favor of the canonical `llm_id` field.
 *
 * @module session-config
 */

import { z } from "zod";
import { ResolvedRoleDefinitionSchema } from "./role-definition.ts";

/**
 * Schema for the immutable session configuration written to
 * `session-config.json` at session creation time.
 *
 * Explicitly NOT stored (ADR-009):
 * - apiKey, api_key, apiSecret, token, baseURL
 */
export const SessionConfigSchema = z
  .object({
    /** Schema contract version. */
    schema_version: z.literal("1.0"),
    /** The agent role name for display and logging. */
    role_name: z.string().min(1),
    /** The fully resolved role definition (prompt, budget, model, provenance). */
    resolved_role: ResolvedRoleDefinitionSchema,
    /** Canonical LLM identifier: "provider:model" (e.g. "openai:gpt-4o"). */
    llm_id: z.string().min(1),
    /** Sampling temperature at session creation time. */
    temperature: z.number().min(0).max(2),
    /** ISO 8601 timestamp of session creation. */
    created_at: z.string().min(1),
    /** Legacy model_id field — kept for backward compatibility. */
    model_id: z.string().optional(),
  })
  .strict();
// NO extra fields allowed — by design, credential fields are banned.

/** Inferred type for SessionConfig. */
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
