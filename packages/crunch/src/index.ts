/**
 * Public API for `@zao/crunch` — the research pipeline.
 *
 * Takes a user question, researches the codebase from multiple LLM
 * perspectives, synthesizes findings, and emits a Blueprint that
 * the controller can execute.
 *
 * ## Quick start
 *
 * ```typescript
 * import { crunch } from "@zao/crunch";
 * import { createDefaultRegistry } from "@zao/llm-clients";
 *
 * const registry = await createDefaultRegistry();
 * const output = await crunch(
 *   { question: "How do I add rate limiting?", projectDir: "./src" },
 *   registry,
 * );
 * ```
 *
 * ## Test injection
 *
 * ```typescript
 * const output = await crunch(input, registry, {
 *   _generate: myMockGenerateFn,
 * });
 * ```
 *
 * @module crunch
 */

// ── Pipeline ───────────────────────────────────────────────────────
export {
  validateInput,
  readContext,
  research,
  synthesize,
  emitBlueprint,
  crunch,
  setLogger,
} from "./pipeline.ts";
export type {
  CrunchInput,
  GenerateStructuredFn,
  CrunchOptions,
} from "./pipeline.ts";

// ── Human Gate ────────────────────────────────────────────────────
export { requestApproval } from "./human-gate.ts";

// ── Schemas ────────────────────────────────────────────────────────
export {
  ResearchStepSchema,
  SynthesisResultSchema,
  BlueprintSchema,
  CrunchOutputSchema,
  CrunchBlueprintStepSchema,
} from "./schemas.ts";
export type {
  ResearchStep,
  SynthesisResult,
  Blueprint,
  CrunchOutput,
  CrunchBlueprintStep,
} from "./schemas.ts";
