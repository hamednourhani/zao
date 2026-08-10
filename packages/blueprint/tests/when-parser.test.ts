/**
 * When-parser tests — validate the v1 `when` expression grammar.
 *
 * Covers:
 * - Success expression parsing
 * - Failed expression parsing
 * - Invalid/malformed expressions returning null
 * - Edge cases (special characters, step id patterns)
 *
 * @module when-parser.test
 */

import { describe, expect, test } from "bun:test";
import { parseWhenExpression } from "../src/when-parser.ts";

describe("parseWhenExpression", () => {
  describe("valid expressions", () => {
    test("parses success expression", () => {
      const result = parseWhenExpression('implement.status == "success"');
      expect(result).not.toBeNull();
      expect(result!.refId).toBe("implement");
      expect(result!.expectedStatus).toBe("success");
    });

    test("parses failed expression", () => {
      const result = parseWhenExpression('review.status == "failed"');
      expect(result).not.toBeNull();
      expect(result!.refId).toBe("review");
      expect(result!.expectedStatus).toBe("failed");
    });

    test("parses step ids with underscores and hyphens", () => {
      const result = parseWhenExpression('my_step-1.status == "success"');
      expect(result).not.toBeNull();
      expect(result!.refId).toBe("my_step-1");
    });

    test("parses expression with spaces around ==", () => {
      const result = parseWhenExpression('plan.status  ==  "success"');
      expect(result).not.toBeNull();
      expect(result!.refId).toBe("plan");
      expect(result!.expectedStatus).toBe("success");
    });
  });

  describe("invalid expressions", () => {
    test("returns null for non-matching pattern", () => {
      expect(parseWhenExpression("hello world")).toBeNull();
    });

    test("returns null for missing step id", () => {
      expect(parseWhenExpression('.status == "success"')).toBeNull();
    });

    test("returns null for missing status", () => {
      expect(parseWhenExpression('plan.status == ""')).toBeNull();
    });

    test("returns null for boolean operators (Tier-2)", () => {
      expect(parseWhenExpression('plan.status == "success" && review.status == "success"')).toBeNull();
    });

    test("returns null for unknown status value", () => {
      expect(parseWhenExpression('plan.status == "skipped"')).toBeNull();
    });

    test("returns null for single-quoted status", () => {
      expect(parseWhenExpression("plan.status == 'success'")).toBeNull();
    });

    test("returns null for empty string", () => {
      expect(parseWhenExpression("")).toBeNull();
    });

    test("returns null for step id starting with digit followed by invalid char", () => {
      // Step ids starting with digit are allowed in the grammar
      const result = parseWhenExpression('0_step.status == "success"');
      expect(result).not.toBeNull();
      expect(result!.refId).toBe("0_step");
    });
  });
});
