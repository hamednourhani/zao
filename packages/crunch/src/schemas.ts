/**
 * Crunch pipeline schemas — Zod contracts for the research pipeline outputs.
 *
 * Defines the types for the multi-step LLM-driven research pipeline:
 * 1. ResearchStep — individual perspective findings
 * 2. SynthesisResult — combined analysis and recommendation
 * 3. CrunchOutput — full pipeline output including emitted blueprint
 *
 * All schemas use `.strict()` for fail-closed validation.
 *
 * @module schemas
 */

import { z } from "zod";
import {
  BlueprintSchema as _BlueprintSchema,
  BlueprintStepSchema,
} from "@zao/blueprint";
import type {
  Blueprint as _Blueprint,
  BlueprintStep,
} from "@zao/blueprint";

// ── Re-exports for backward compatibility ──────────────────────────

/**
 * Re-exported from @zao/blueprint — the canonical blueprint schema.
 * Crunch emits blueprints that pass full BlueprintStepSchema validation
 * (including tools, loop, output_spec fields).
 */
export const BlueprintSchema = _BlueprintSchema;
export type Blueprint = _Blueprint;

/**
 * Re-exported BlueprintStepSchema as CrunchBlueprintStepSchema for
 * backward-compatible public API. Crunch consumers can import either name.
 */
export const CrunchBlueprintStepSchema = BlueprintStepSchema;
export type CrunchBlueprintStep = BlueprintStep;

// ── Research Step ──────────────────────────────────────────────────

/**
 * Schema for a single research step — findings from one perspective
 * (e.g., architecture, security, testing).
 */
export const ResearchStepSchema = z
  .object({
    /** The perspective taken (e.g., "architecture_analysis", "security_review", "testing_strategy"). */
    perspective: z.string().min(1),
    /** What this perspective discovered about the problem. */
    findings: z.string().min(1),
  })
  .strict();

export type ResearchStep = z.infer<typeof ResearchStepSchema>;

// ── Synthesis Result ───────────────────────────────────────────────

/** Schema for the synthesis result — combines all research perspectives. */
export const SynthesisResultSchema = z
  .object({
    /** Executive summary of the research. */
    summary: z.string().min(1),
    /** The recommended approach / decision. */
    decision: z.string().min(1),
    /** Rejected alternatives with reasons. */
    alternatives: z.array(z.string()),
    /** Identified risks. */
    risks: z.array(z.string()),
  })
  .strict();

export type SynthesisResult = z.infer<typeof SynthesisResultSchema>;

// ── Crunch Output ──────────────────────────────────────────────────

/** Schema for the full pipeline output including metadata. */
export const CrunchOutputSchema = z
  .object({
    /** The emitted blueprint (controller-readable format). */
    blueprint: BlueprintSchema,
    /** All research steps from the pipeline. */
    researchSteps: z.array(ResearchStepSchema),
    /** The synthesis combining all perspectives. */
    synthesis: SynthesisResultSchema,
    /** Pipeline execution metadata. */
    metadata: z
      .object({
        /** Model identifier used for LLM calls. */
        modelUsed: z.string(),
        /** Estimated token usage. */
        tokensUsed: z.number().int().nonnegative(),
        /** Pipeline duration in milliseconds. */
        duration: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type CrunchOutput = z.infer<typeof CrunchOutputSchema>;
