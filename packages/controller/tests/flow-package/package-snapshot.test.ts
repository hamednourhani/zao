/**
 * Package Snapshot tests — R-006A.
 *
 * Covers:
 * - Serializing CompiledFlowPackage to snapshot
 * - Deserializing snapshot back to CompiledFlowPackage
 * - Round-trip integrity
 * - Legacy spec extraction
 *
 * @module package-snapshot.test
 */

import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { compileFlowPackage } from "../../src/flow-package/package-compiler.ts";
import type { LoadedFlowPackage } from "../../src/flow-package/package-loader.ts";
import {
  snapshotCompiledPackage,
  deserializeCompiledPackage,
  extractPackageSnapshotFromSpec,
} from "../../src/flow-package/package-snapshot.ts";
import type { RolesFile } from "../../src/schemas/role-definition.ts";
import type { Flow } from "../../src/schemas/flow.ts";
import { FlowSchema } from "../../src/schemas/flow.ts";
import { resolveRole } from "../../src/role-registry.ts";

const TEST_ROLES: RolesFile = {
  schema_version: "0.3.0" as const,
  model_defaults: { default_llm_id: "deepseek:deepseek-chat" },
  roles: {
    planner: {
      prompt_template: "Plan carefully.",
      context_budget: 0.70,
      llm_id: null,
    },
    developer: {
      prompt_template: "Write good code.",
      context_budget: 0.65,
      llm_id: "openai:gpt-4-turbo",
    },
  },
};

function makeCompiledPackage(flowYaml: string) {
  const raw = parseYaml(flowYaml);
  const flow = FlowSchema.parse(raw) as Flow;

  const loaded: LoadedFlowPackage = {
    packageId: "snapshot-test",
    packageVersion: "2.0.0",
    packageDir: "/tmp/snapshot-test",
    flow,
    roles: TEST_ROLES,
    rawFlow: flow as unknown as Record<string, unknown>,
    rawRoles: TEST_ROLES as unknown as Record<string, unknown>,
  };

  return compileFlowPackage(loaded);
}

describe("snapshotCompiledPackage", () => {
  test("serializes to a plain object", () => {
    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
  - id: implement
    role: developer
    task: "Implement the feature"
`);

    const snapshot = snapshotCompiledPackage(compiled);

    expect(snapshot.package_id).toBe("snapshot-test");
    expect(snapshot.package_version).toBe("2.0.0");
    expect(snapshot.package_dir).toBe("/tmp/snapshot-test");
    expect(snapshot.flow.steps).toHaveLength(2);
    expect(snapshot.flow.steps[0]!.id).toBe("plan");
    expect(snapshot.default_model).toBe("deepseek:deepseek-chat");
    expect(Object.keys(snapshot.roles)).toContain("planner");
    expect(Object.keys(snapshot.roles)).toContain("developer");
    expect(snapshot.roles.developer!.llm_id).toBe("openai:gpt-4-turbo");
  });

  test("includes role provenance in snapshot", () => {
    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
`);

    const snapshot = snapshotCompiledPackage(compiled);
    expect(snapshot.roles.planner!.provenance).toBeDefined();
    expect(snapshot.roles.planner!.model_provenance).toBeDefined();
  });

  test("omits derived_from when the package was not blueprint-derived", () => {
    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
`);

    const snapshot = snapshotCompiledPackage(compiled);
    expect(snapshot.derived_from).toBeUndefined();
  });

  test("serializes derived_from when present (LOW-001)", () => {
    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
`);
    compiled.derivedFrom = {
      blueprint_id: "feature-development",
      blueprint_version: "0.1.0",
    };

    const snapshot = snapshotCompiledPackage(compiled);
    expect(snapshot.derived_from).toEqual({
      blueprint_id: "feature-development",
      blueprint_version: "0.1.0",
    });
  });
});

describe("deserializeCompiledPackage", () => {
  test("round-trips correctly", () => {
    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
    context: "Focus on auth"
  - id: implement
    role: developer
    task: "Implement the feature"
    when: plan.status == "success"
`);

    const snapshot = snapshotCompiledPackage(compiled);
    const restored = deserializeCompiledPackage(snapshot);

    expect(restored.packageId).toBe(compiled.packageId);
    expect(restored.packageVersion).toBe(compiled.packageVersion);
    expect(restored.packageDir).toBe(compiled.packageDir);
    expect(restored.resolvedFlow.steps).toHaveLength(2);
    expect(restored.resolvedFlow.steps[0]!.id).toBe("plan");
    expect(restored.resolvedFlow.steps[0]!.context).toBe("Focus on auth");
    expect(restored.resolvedFlow.steps[1]!.when).toBe('plan.status == "success"');

    // Verify role resolution works after deserialization
    const planner = resolveRole(restored.roleRegistry, "planner");
    expect(planner.model).toBe("deepseek-chat");
    expect(planner.llm_id).toBe("deepseek:deepseek-chat");

    const developer = resolveRole(restored.roleRegistry, "developer");
    expect(developer.model).toBe("gpt-4-turbo");
    expect(developer.llm_id).toBe("openai:gpt-4-turbo");
  });

  test("round-trips derived_from provenance (LOW-001)", () => {
    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
`);
    compiled.derivedFrom = {
      blueprint_id: "feature-development",
      blueprint_version: "0.1.0",
    };

    const snapshot = snapshotCompiledPackage(compiled);
    const restored = deserializeCompiledPackage(snapshot);

    expect(restored.derivedFrom).toEqual({
      blueprint_id: "feature-development",
      blueprint_version: "0.1.0",
    });
  });

  test("deserialize tolerates snapshots without derived_from", () => {
    const compiled = makeCompiledPackage(`
schema_version: "0.2.0"
steps:
  - id: plan
    role: planner
    task: "Plan the work"
`);

    const restored = deserializeCompiledPackage(snapshotCompiledPackage(compiled));
    expect(restored.derivedFrom).toBeUndefined();
  });

  test("throws on missing required fields", () => {
    expect(() =>
      deserializeCompiledPackage({
        package_id: "",
        package_version: "",
        package_dir: "",
        flow: { schema_version: "", provenance: "", steps: [] },
        roles: {},
        default_model: "",
      } as unknown as ReturnType<typeof snapshotCompiledPackage>),
    ).toThrow(/missing/);
  });
});

describe("extractPackageSnapshotFromSpec", () => {
  test("extracts from legacy spec format", () => {
    const legacySpec = {
      schema_version: "0.2.0",
      generated_at: "2026-01-01T00:00:00Z",
      default_model: "deepseek:deepseek-chat",
      roles: {
        planner: {
          prompt_template: "Plan",
          context_budget: 0.70,
          model: "deepseek-chat",
          llm_id: "deepseek:deepseek-chat",
          provenance: "defaults",
          model_provenance: "defaults",
        },
      },
      flow: {
        schema_version: "0.2.0",
        provenance: "defaults",
        steps: [{ id: "default", role: "planner", task: "Plan the work", when: null, context: null }],
      },
    };

    const snapshot = extractPackageSnapshotFromSpec(legacySpec);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.package_id).toBe("legacy-snapshot");
    expect(snapshot!.default_model).toBe("deepseek:deepseek-chat");
    expect(Object.keys(snapshot!.roles)).toContain("planner");
  });

  test("returns null for invalid spec", () => {
    const invalidSpec = {
      schema_version: "0.2.0",
      // no roles
    };

    const snapshot = extractPackageSnapshotFromSpec(invalidSpec);
    expect(snapshot).toBeNull();
  });
});
