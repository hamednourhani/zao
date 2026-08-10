/**
 * When Expression Parser — v1 grammar for `when` gate conditions.
 *
 * This is a self-contained copy of the `parseWhenExpression()` function
 * from `packages/controller/src/flow-loader.ts`. The blueprint package
 * maintains its own copy to avoid importing from the controller.
 *
 * ## Grammar v1 (total):
 * ```
 * "<step-id>.status == \"success\""
 * "<step-id>.status == \"failed\""
 * ```
 *
 * @module when-parser
 */

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
 * @param expr - The raw when expression string.
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
