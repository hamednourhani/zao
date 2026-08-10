/**
 * Output Validator — validates LLM output against a step's output_spec.
 *
 * When a blueprint step has `output_spec`, the LLM's final response must be
 * validated against it before using for routing. Without this, the controller
 * trusts LLM output blindly — if the LLM returns `{ status: "garbage" }`,
 * the controller crashes or misroutes.
 *
 * ## Design
 *
 * - `validateStepOutput` is the main entry point. It takes the raw LLM output,
 *   the step's `output_spec`, and the step ID.
 * - `buildSchemaFromOutputSpec` dynamically builds a Zod schema from the
 *   `output_spec`. The schema requires `status` (enum of valid values),
 *   makes `findings` and `recommended_next` optional, and is **not strict**
 *   (extra fields are allowed).
 * - When `output_spec` is `undefined`, validation is a no-op — the output
 *   passes through unchanged.
 *
 * ## Usage in execution-runner
 *
 * ```typescript
 * import { validateStepOutput } from "./output-validator.ts";
 *
 * // After harness returns result
 * const validation = validateStepOutput(
 *   result.result,
 *   step.output_spec,
 *   step.id,
 * );
 *
 * if (!validation.valid) {
 *   stepResults.push({
 *     id: step.id,
 *     status: "failed",
 *     error: validation.error,
 *   });
 *   continue;
 * }
 *
 * // Use validated output for routing
 * const reviewerOutput = validation.output;
 * ```
 *
 * @module output-validator
 */

import { z } from "zod";

// ── Types ───────────────────────────────────────────────────────────

/**
 * Structured output specification for reviewer/critic steps.
 *
 * Defines the expected shape of LLM output when a step has `output_spec`.
 * The status field is required; findings and recommended_next are optional.
 *
 * Mirrors the OutputSpec interface in schemas/flow.ts but is defined here
 * so the validator is self-contained.
 */
export interface OutputSpec {
  /** The review verdict status. */
  status: "success" | "failed" | "requires_actions";
  /** Optional list of specific findings. */
  findings?: string[];
  /** Optional recommended next step ID. */
  recommended_next?: string;
}

/**
 * Result of output validation.
 *
 * - When `valid` is `true`, `output` contains the validated (parsed) data.
 * - When `valid` is `false`, `error` describes what failed.
 */
export interface ValidationResult {
  /** Whether the output passed validation. */
  valid: boolean;
  /** The validated output (only set when `valid` is `true`). */
  output?: unknown;
  /** Human-readable error message (only set when `valid` is `false`). */
  error?: string;
}

// ── Zod Schema Builder ──────────────────────────────────────────────

/**
 * Builds a Zod schema from an {@link OutputSpec}.
 *
 * The returned schema:
 * - Requires `status` as an enum of the three valid values
 *   (`"success"`, `"failed"`, `"requires_actions"`).
 * - Makes `findings` an optional array of strings.
 * - Makes `recommended_next` an optional string.
 * - Is **not strict** — extra fields beyond the spec are allowed.
 *
 * This is intentionally permissive about unknown fields. The output_spec
 * defines the *minimum* contract the LLM must satisfy. The LLM may add
 * additional metadata fields without violating the spec.
 *
 * @param _outputSpec - The output specification to build a schema from.
 *   Currently unused (the schema is always the same shape), but kept as
 *   a parameter for future extensibility (e.g., adding custom field
 *   validation based on spec values).
 * @returns A Zod object schema for validating output against the spec.
 */
export function buildSchemaFromOutputSpec(
  _outputSpec: OutputSpec,
) {
  return z
    .object({
      status: z.enum(["success", "failed", "requires_actions"]),
      findings: z.array(z.string()).optional(),
      recommended_next: z.string().optional(),
    })
    .passthrough();
  // NOTE: .passthrough() keeps extra fields in the parsed output.
  // The output_spec defines the minimum contract. Additional fields
  // (e.g., confidence scores, metadata) are permitted.
  // .strict() would reject extras; the default (no modifier) strips them.
}

// ── Main Validator ───────────────────────────────────────────────────

/**
 * Validates LLM output against a step's output_spec.
 *
 * ## Behavior
 *
 * | Condition | Result |
 * |---|---|
 * | No `output_spec` | Passes through — returns `{ valid: true, output }` |
 * | Valid output (matches spec) | Returns `{ valid: true, output: parsedData }` |
 * | Missing required field (`status`) | Returns `{ valid: false, error: "..." }` |
 * | Wrong types | Returns `{ valid: false, error: "..." }` |
 * | `null` / `undefined` output (with spec) | Returns `{ valid: false, error: "..." }` |
 * | Extra fields outside spec | Allowed — returns `{ valid: true, ... }` |
 *
 * ## Error message format
 *
 * Error messages include the step ID and the Zod issue path + message
 * for each validation failure:
 *
 * `"Step \"review\" output validation failed: status: Invalid enum value. Expected 'success' | 'failed' | 'requires_actions', received 'garbage'"`.
 *
 * @param output - The raw LLM output to validate.
 * @param outputSpec - The step's output specification, or `undefined` to skip validation.
 * @param stepId - The step identifier for error messages.
 * @returns A {@link ValidationResult} with either validated output or an error message.
 */
export function validateStepOutput(
  output: unknown,
  outputSpec: OutputSpec | undefined,
  stepId: string,
): ValidationResult {
  // No spec = no validation — pass through unchanged.
  if (!outputSpec) {
    return { valid: true, output };
  }

  // Build the Zod schema from the output spec.
  const schema = buildSchemaFromOutputSpec(outputSpec);
  const result = schema.safeParse(output);

  if (!result.success) {
    // Build a descriptive error message including the step ID and each
    // field-level issue from Zod's error report.
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");

    return {
      valid: false,
      error: `Step "${stepId}" output validation failed: ${issues}`,
    };
  }

  // Validation passed — return the parsed (validated) output.
  return { valid: true, output: result.data };
}
