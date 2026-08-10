/**
 * Flow loader tests — TD-029-B, updated for R-006A.
 *
 * R-006A Cleanup: `loadFlow()` has been removed. Flow resolution now uses
 * the flow-package system. This test file retains:
 * - FlowSchema validation (valid/invalid flows, strict rejection)
 * - parseWhenExpression grammar tests
 * - Contracts JSON Schema validation
 *
 * @module flow-loader.test
 */

import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { rm } from "node:fs/promises";
import Ajv from "ajv";
import { FlowSchema } from "../src/schemas/flow.ts";
import { parseWhenExpression } from "../src/flow-loader.ts";

// ── Contracts Schema for Test Validation ───────────────────────────

async function loadContractsSchema(): Promise<Record<string, unknown>> {
  const { readFile } = await import("node:fs/promises");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const schemaPath = resolve(
    moduleDir,
    "..",
    "..",
    "contracts",
    "schemas",
    "flow.schema.json",
  );

  const raw = await readFile(schemaPath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

// ── Temp Directories ───────────────────────────────────────────────

const tempDirs: string[] = [];

beforeAll(async () => {
  // no-op; temp dirs created per-test
});

afterAll(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ── FlowSchema Tests ────────────────────────────────────────────────

describe("FlowSchema", () => {
  describe("valid flows", () => {
    test("accepts minimal single-step flow", () => {
      const parsed = {
        schema_version: "0.2.0" as const,
        steps: [{ id: "implement", role: "developer", task: "Implement the feature" }],
      };
      const result = FlowSchema.safeParse(parsed);
      expect(result.success).toBe(true);
    });

    test("accepts 0.3.0 schema_version", () => {
      const parsed = {
        schema_version: "0.3.0" as const,
        steps: [{ id: "implement", role: "developer", task: "Implement the feature" }],
      };
      const result = FlowSchema.safeParse(parsed);
      expect(result.success).toBe(true);
    });

    test("accepts multi-step flow with when gates", () => {
      const parsed = {
        schema_version: "0.2.0" as const,
        steps: [
          { id: "plan", role: "planner", task: "Plan the work" },
          { id: "implement", role: "developer", task: "Implement the feature" },
          {
            id: "review",
            role: "reviewer", task: "Review the code",
            when: 'implement.status == "success"',
          },
        ],
      };
      const result = FlowSchema.safeParse(parsed);
      expect(result.success).toBe(true);
    });

    test("accepts steps with context", () => {
      const parsed = {
        schema_version: "0.2.0" as const,
        steps: [
          { id: "plan", role: "planner", task: "Plan the work", context: "Focus on auth module." },
          { id: "implement", role: "developer", task: "Implement the feature" },
        ],
      };
      const result = FlowSchema.safeParse(parsed);
      expect(result.success).toBe(true);
    });

    test("accepts steps with all optional fields", () => {
      const parsed = {
        schema_version: "0.2.0" as const,
        steps: [
          {
            id: "plan",
            role: "planner", task: "Plan the work",
            when: undefined,
            context: undefined,
          },
        ],
      };
      const result = FlowSchema.safeParse(parsed);
      expect(result.success).toBe(true);
    });
  });

  describe("invalid schema_version", () => {
    test("rejects wrong schema version", () => {
      const parsed = {
        schema_version: "0.1.0",
        steps: [{ id: "implement", role: "developer", task: "Implement the feature" }],
      };
      const result = FlowSchema.safeParse(parsed);
      expect(result.success).toBe(false);
    });

    test("rejects missing schema_version", () => {
      const parsed = {
        steps: [{ id: "implement", role: "developer", task: "Implement the feature" }],
      };
      const result = FlowSchema.safeParse(parsed);
      expect(result.success).toBe(false);
    });
  });

  describe("strict schema rejection", () => {
    test("rejects unknown top-level field", () => {
      const parsed = {
        schema_version: "0.2.0",
        steps: [{ id: "implement", role: "developer", task: "Implement the feature" }],
        parallel: true,
      };
      const result = FlowSchema.safeParse(parsed);
      expect(result.success).toBe(false);
    });

    test("rejects unknown step field", () => {
      const parsed = {
        schema_version: "0.2.0" as const,
        steps: [
          {
            id: "implement",
            role: "developer", task: "Implement the feature",
            retry: 3,
          },
        ],
      };
      const result = FlowSchema.safeParse(parsed);
      expect(result.success).toBe(false);
    });

    test("rejects empty steps array", () => {
      const parsed = {
        schema_version: "0.2.0" as const,
        steps: [],
      };
      const result = FlowSchema.safeParse(parsed);
      expect(result.success).toBe(false);
    });

    test("rejects invalid step id format", () => {
      const parsed = {
        schema_version: "0.2.0" as const,
        steps: [{ id: "INVALID", role: "developer", task: "Implement the feature" }],
      };
      const result = FlowSchema.safeParse(parsed);
      expect(result.success).toBe(false);
    });
  });
});

// ── parseWhenExpression ────────────────────────────────────────────

describe("parseWhenExpression", () => {
  test("parses success gate", () => {
    const result = parseWhenExpression('implement.status == "success"');
    expect(result).not.toBeNull();
    expect(result!.refId).toBe("implement");
    expect(result!.expectedStatus).toBe("success");
  });

  test("parses success gate with whitespace around operator", () => {
    const result = parseWhenExpression('implement.status  ==  "success"');
    expect(result).not.toBeNull();
    expect(result!.refId).toBe("implement");
    expect(result!.expectedStatus).toBe("success");
  });

  test("parses failed gate", () => {
    const result = parseWhenExpression('implement.status == "failed"');
    expect(result).not.toBeNull();
    expect(result!.refId).toBe("implement");
    expect(result!.expectedStatus).toBe("failed");
  });

  test("rejects invalid grammar", () => {
    expect(parseWhenExpression("implement.status > 0")).toBeNull();
    expect(parseWhenExpression("foo == bar")).toBeNull();
    expect(parseWhenExpression("")).toBeNull();
    expect(parseWhenExpression("implement")).toBeNull();
  });
});

// ── Contracts JSON Schema Validation Tests ─────────────────────────

describe("Contracts JSON Schema validation", () => {
  test("valid flow shape passes contracts schema", async () => {
    const schema = await loadContractsSchema();
    const { $schema: _, ...schemaWithoutMeta } = schema as Record<string, unknown>;
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schemaWithoutMeta);

    const data = {
      schema_version: "0.2.0",
      steps: [
        { id: "plan", role: "planner", task: "Plan the work" },
        { id: "implement", role: "developer", task: "Implement the feature" },
        {
          id: "review",
          role: "reviewer", task: "Review the code",
          when: 'implement.status == "success"',
        },
      ],
    };

    const valid = validate(data);
    if (!valid && validate.errors) {
      console.error("Validation errors:", JSON.stringify(validate.errors, null, 2));
    }
    expect(valid).toBe(true);
  });

  test("0.3.0 schema version passes contracts schema", async () => {
    const schema = await loadContractsSchema();
    const { $schema: _, ...schemaWithoutMeta } = schema as Record<string, unknown>;
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schemaWithoutMeta);

    const data = {
      schema_version: "0.3.0",
      steps: [{ id: "plan", role: "planner", task: "Plan the work" }],
    };

    const valid = validate(data);
    expect(valid).toBe(true);
  });

  test("extra step field fails contracts validation", async () => {
    const schema = await loadContractsSchema();
    const { $schema: _, ...schemaWithoutMeta } = schema as Record<string, unknown>;
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schemaWithoutMeta);

    const data = {
      schema_version: "0.2.0",
      steps: [
        {
          id: "plan",
          role: "planner", task: "Plan the work",
          retry: 3,
        },
      ],
    };

    const valid = validate(data);
    expect(valid).toBe(false);
  });

  test("missing schema_version fails contracts validation", async () => {
    const schema = await loadContractsSchema();
    const { $schema: _, ...schemaWithoutMeta } = schema as Record<string, unknown>;
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schemaWithoutMeta);

    const data = {
      steps: [{ id: "plan", role: "planner", task: "Plan the work" }],
    };

    const valid = validate(data);
    expect(valid).toBe(false);
  });

  test("empty steps array fails contracts validation", async () => {
    const schema = await loadContractsSchema();
    const { $schema: _, ...schemaWithoutMeta } = schema as Record<string, unknown>;
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schemaWithoutMeta);

    const data = {
      schema_version: "0.2.0",
      steps: [],
    };

    const valid = validate(data);
    expect(valid).toBe(false);
  });
});
