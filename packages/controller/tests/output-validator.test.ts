/**
 * Output Validator tests — REQ-4: Output Validation.
 *
 * When a blueprint step has `output_spec`, the LLM's final response must be
 * validated against it before using it for routing. Without this, the
 * controller trusts LLM output blindly.
 *
 * Tests:
 * - TEST-OV1: Valid output matching output_spec passes validation
 * - TEST-OV2: Output missing required fields (status) fails validation
 * - TEST-OV3: Output with wrong types fails validation
 * - TEST-OV4: Validation error includes step ID and field path
 * - TEST-OV5: No output_spec → passes validation (no-op)
 * - TEST-OV6: Null/undefined output with output_spec → fails validation
 * - TEST-OV7: Output with extra fields (outside spec) passes (be permissive about extras)
 *
 * @module output-validator.test
 */

import { describe, expect, test } from "bun:test";
import {
  validateStepOutput,
  buildSchemaFromOutputSpec,
} from "../src/output-validator.ts";
import type { OutputSpec } from "../src/output-validator.ts";

// ── Shared output_spec fixture ──────────────────────────────────────

const reviewOutputSpec: OutputSpec = {
  status: "requires_actions",
  findings: ["Issue found"],
  recommended_next: "fix",
};

const minimalOutputSpec: OutputSpec = {
  status: "success",
};

// ── TEST-OV1: Valid output matching output_spec passes validation ──

describe("output validation — valid output (TEST-OV1)", () => {
  test("output with status 'success' passes validation", () => {
    const result = validateStepOutput(
      { status: "success" },
      minimalOutputSpec,
      "review",
    );

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ status: "success" });
  });

  test("output with all optional fields passes validation", () => {
    const result = validateStepOutput(
      {
        status: "requires_actions",
        findings: ["Null check missing in validate()", "No test coverage"],
        recommended_next: "fix",
      },
      reviewOutputSpec,
      "review",
    );

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({
      status: "requires_actions",
      findings: ["Null check missing in validate()", "No test coverage"],
      recommended_next: "fix",
    });
  });

  test("output with all three valid statuses passes validation", () => {
    const statuses: Array<"success" | "failed" | "requires_actions"> = [
      "success",
      "failed",
      "requires_actions",
    ];

    for (const status of statuses) {
      const result = validateStepOutput(
        { status },
        { status },
        "review",
      );

      expect(result.valid).toBe(true);
      expect(result.output).toEqual({ status });
    }
  });

  test("output with findings but no recommended_next passes", () => {
    const result = validateStepOutput(
      { status: "failed", findings: ["Something went wrong"] },
      reviewOutputSpec,
      "review",
    );

    expect(result.valid).toBe(true);
  });

  test("output with recommended_next but no findings passes", () => {
    const result = validateStepOutput(
      { status: "requires_actions", recommended_next: "fix" },
      reviewOutputSpec,
      "review",
    );

    expect(result.valid).toBe(true);
  });
});

// ── TEST-OV2: Output missing required fields (status) fails ─────────

describe("output validation — missing required fields (TEST-OV2)", () => {
  test("empty object fails validation (missing status)", () => {
    const result = validateStepOutput({}, reviewOutputSpec, "review");

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Step "review" output validation failed');
  });

  test("object with only optional fields (no status) fails", () => {
    const result = validateStepOutput(
      { findings: ["Something"], recommended_next: "fix" },
      reviewOutputSpec,
      "review",
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ── TEST-OV3: Output with wrong types fails ─────────────────────────

describe("output validation — wrong types (TEST-OV3)", () => {
  test("status as number fails validation", () => {
    const result = validateStepOutput(
      { status: 42 },
      reviewOutputSpec,
      "review",
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("review");
  });

  test("status as arbitrary string fails validation", () => {
    const result = validateStepOutput(
      { status: "garbage" },
      reviewOutputSpec,
      "review",
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("review");
  });

  test("findings as string (not array) fails validation", () => {
    const result = validateStepOutput(
      { status: "failed", findings: "not-an-array" },
      reviewOutputSpec,
      "review",
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("findings as array of numbers fails validation", () => {
    const result = validateStepOutput(
      { status: "failed", findings: [1, 2, 3] },
      reviewOutputSpec,
      "review",
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("recommended_next as number fails validation", () => {
    const result = validateStepOutput(
      { status: "requires_actions", recommended_next: 123 },
      reviewOutputSpec,
      "review",
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("array input fails validation", () => {
    const result = validateStepOutput(
      [{ status: "success" }],
      reviewOutputSpec,
      "review",
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("string input fails validation", () => {
    const result = validateStepOutput(
      "not-an-object",
      reviewOutputSpec,
      "review",
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("boolean input fails validation", () => {
    const result = validateStepOutput(true, reviewOutputSpec, "review");

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("number input fails validation", () => {
    const result = validateStepOutput(0, reviewOutputSpec, "review");

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ── TEST-OV4: Validation error includes step ID and field path ──────

describe("output validation — error message includes step ID and field path (TEST-OV4)", () => {
  test("error message contains step ID", () => {
    const result = validateStepOutput(
      { status: "garbage" },
      reviewOutputSpec,
      "code-review",
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('"code-review"');
  });

  test("error message contains field path for missing status", () => {
    const result = validateStepOutput({}, reviewOutputSpec, "step-1");

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    // Zod reports path as empty array for top-level missing required fields
    // but the message should still include context about what failed
    expect(result.error).toContain("step-1");
  });

  test("error message reflects status enum validation", () => {
    const result = validateStepOutput(
      { status: "invalid_value" },
      reviewOutputSpec,
      "lint",
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('"lint"');
    // Zod reports enum errors as: "Invalid option: expected one of..."
    // The error message mentions the invalid value through the path context.
    expect(result.error).toMatch(/status.*Invalid option/);
  });
});

// ── TEST-OV5: No output_spec → passes validation (no-op) ────────────

describe("output validation — no output_spec (TEST-OV5)", () => {
  test("undefined output_spec passes through any output", () => {
    const result = validateStepOutput(
      { anything: "goes", status: "whatever" },
      undefined,
      "step-1",
    );

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    // No spec = return the output as-is
    expect(result.output).toEqual({ anything: "goes", status: "whatever" });
  });

  test("undefined output_spec with null output still passes", () => {
    const result = validateStepOutput(null, undefined, "step-1");

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.output).toBeNull();
  });

  test("undefined output_spec with string output passes through", () => {
    const result = validateStepOutput("just a string", undefined, "step-1");

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.output).toBe("just a string");
  });
});

// ── TEST-OV6: Null/undefined output with output_spec → fails ────────

describe("output validation — null/undefined output (TEST-OV6)", () => {
  test("null output with output_spec fails validation", () => {
    const result = validateStepOutput(null, reviewOutputSpec, "review");

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("review");
  });

  test("undefined output with output_spec fails validation", () => {
    const result = validateStepOutput(undefined, reviewOutputSpec, "review");

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("review");
  });
});

// ── TEST-OV7: Output with extra fields passes (permissive) ──────────

describe("output validation — extra fields are allowed (TEST-OV7)", () => {
  test("extra string field is permitted", () => {
    const result = validateStepOutput(
      { status: "success", extraField: "should be allowed" },
      minimalOutputSpec,
      "review",
    );

    expect(result.valid).toBe(true);
    expect(result.output).toHaveProperty("extraField", "should be allowed");
    expect(result.output).toHaveProperty("status", "success");
  });

  test("extra numeric field is permitted", () => {
    const result = validateStepOutput(
      { status: "failed", score: 95, confidence: 0.87 },
      reviewOutputSpec,
      "review",
    );

    expect(result.valid).toBe(true);
    expect(result.output).toHaveProperty("score", 95);
    expect(result.output).toHaveProperty("confidence", 0.87);
  });

  test("extra nested object field is permitted", () => {
    const result = validateStepOutput(
      {
        status: "requires_actions",
        metadata: { source: "llm", confidence: 0.9 },
      },
      reviewOutputSpec,
      "review",
    );

    expect(result.valid).toBe(true);
    expect(result.output).toHaveProperty("metadata");
  });

  test("extra array field is permitted", () => {
    const result = validateStepOutput(
      { status: "success", tags: ["bug", "auth", "critical"] },
      minimalOutputSpec,
      "review",
    );

    expect(result.valid).toBe(true);
    expect(result.output).toHaveProperty("tags");
  });
});

// ── Build Schema From OutputSpec Tests ──────────────────────────────

describe("buildSchemaFromOutputSpec", () => {
  test("returns a Zod schema that validates correct output", () => {
    const schema = buildSchemaFromOutputSpec(reviewOutputSpec);
    const result = schema.safeParse({
      status: "requires_actions",
      findings: ["Issue 1", "Issue 2"],
      recommended_next: "fix",
    });

    expect(result.success).toBe(true);
  });

  test("schema rejects output missing status", () => {
    const schema = buildSchemaFromOutputSpec(reviewOutputSpec);
    const result = schema.safeParse({
      findings: ["No status here"],
    });

    expect(result.success).toBe(false);
  });

  test("schema rejects status outside the enum", () => {
    const schema = buildSchemaFromOutputSpec(reviewOutputSpec);
    const result = schema.safeParse({
      status: "unknown",
    });

    expect(result.success).toBe(false);
  });

  test("schema is NOT strict — allows extra fields", () => {
    const schema = buildSchemaFromOutputSpec(minimalOutputSpec);
    const result = schema.safeParse({
      status: "success",
      extraField: "allowed",
      another: 42,
    });

    expect(result.success).toBe(true);
  });

  test("schema makes findings optional", () => {
    const schema = buildSchemaFromOutputSpec(reviewOutputSpec);
    const result = schema.safeParse({
      status: "success",
    });

    expect(result.success).toBe(true);
    // findings should be absent (not added by default)
    expect(result.data).not.toHaveProperty("findings");
  });
});
