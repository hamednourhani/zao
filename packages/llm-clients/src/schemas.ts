/**
 * Zod schemas for the `llm-providers.yaml` configuration file.
 *
 * Validated on load — fail-closed: any schema violation throws
 * {@link ConfigValidationError}.
 *
 * @module schemas
 */

import { z } from "zod";

/** Schema for a single model entry under a provider. */
export const ModelEntrySchema = z
  .object({
    api_model_id: z.string().min(1),
  })
  .strict();

/** Inferred type for a single model entry. */
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

/** Schema for a single provider configuration block. */
export const ProviderConfigSchema = z
  .object({
    api_key: z.string().optional(),
    base_url: z.string().optional(),
    models: z.record(z.string().min(1), ModelEntrySchema),
  })
  .strict()
  .refine(
    (data) => Object.keys(data.models).length >= 1,
    { message: "Each provider must have at least one model configured." },
  );

/** Inferred type for a provider configuration. */
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/** Schema for the complete `llm-providers.yaml` file. */
export const LlmProvidersFileSchema = z
  .object({
    llm_providers: z
      .record(z.string().min(1), ProviderConfigSchema)
      .refine(
        (data) => Object.keys(data).length >= 1,
        { message: "At least one LLM provider must be configured." },
      ),
  })
  .strict();

/** Inferred type for the complete config file. */
export type LlmProvidersFile = z.infer<typeof LlmProvidersFileSchema>;
