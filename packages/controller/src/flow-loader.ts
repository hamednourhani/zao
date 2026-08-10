/**
 * Flow Loader — types and utilities for flow definitions.
 *
 * ## R-006A Cleanup
 *
 * `loadFlow()` (the 4-layer resolver) has been removed. Flow resolution
 * now uses the flow-package system (`packages/controller/src/flow-package/`).
 *
 * This module retains:
 * - Type re-exports from `schemas/flow.ts` (FlowSchema, FlowStepSchema, Flow, FlowStep, ResolvedFlow)
 * - `parseWhenExpression()` — the v1 `when` expression grammar parser
 * - `FlowAggregateResultSchema` / `FlowAggregateResult` — aggregate result type
 *
 * @module flow-loader
 */

import { z } from "zod";

// ── Re-exports from schemas ─────────────────────────────────────────

export { FlowSchema, FlowStepSchema } from "./schemas/flow.ts";
export type { Flow, FlowStep, ResolvedFlow } from "./schemas/flow.ts";

// ── When Expression Parser ──────────────────────────────────────────

/**
 * Parses a `when` expression and extracts the referenced step id and
 * expected status, or returns null if the expression is malformed.
 *
 * ## Grammar v1 (total):
 * ```
 * "<step-id>.status == \"success\""
 * "<step-id>.status == \"failed\""
 * ```
 *
 * @param expr - The raw when expression string from the flow YAML.
 * @returns The parsed refId and expectedStatus, or null if malformed.
 */
export function parseWhenExpression(
  expr: string,
): { refId: string; expectedStatus: "success" | "failed" } | null {
  // Match: <step-id>.status == "success"
  // Step id pattern: starts with a-z or 0-9, then a-z, 0-9, _, or -
  const successMatch = expr.match(
    /^([a-z0-9][a-z0-9_-]*)\.status\s*==\s*"success"$/,
  );
  if (successMatch) {
    return { refId: successMatch[1]!, expectedStatus: "success" };
  }

  // Match: <step-id>.status == "failed"
  const failedMatch = expr.match(
    /^([a-z0-9][a-z0-9_-]*)\.status\s*==\s*"failed"$/,
  );
  if (failedMatch) {
    return { refId: failedMatch[1]!, expectedStatus: "failed" };
  }

  return null;
}

// ── Aggregate Result Schema ─────────────────────────────────────────

/** Schema for the aggregate result.json written by the flow runner. */
export const FlowAggregateResultSchema = z
  .object({
    schema_version: z.literal("0.2.0"),
    timestamp: z.string().min(1),
    flow_provenance: z.string().min(1),
    overall_success: z.boolean(),
    error: z.string().nullable(),
    /** Absolute path to the compiled flow package directory (added R-006B Q1). */
    compiled_flow_package_dir: z.string().min(1).optional(),
    steps: z.array(
      z
        .object({
          id: z.string().min(1),
          status: z.enum(["success", "failed", "skipped"]),
          error: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type FlowAggregateResult = z.infer<typeof FlowAggregateResultSchema>;
