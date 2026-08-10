/**
 * Package Loader tests — R-006A.
 *
 * Covers:
 * - Loading a valid flow package from disk
 * - Validation fails on missing files
 * - Validation fails on invalid YAML
 * - Validation fails on schema violations
 *
 * @module package-loader.test
 */

import { describe, expect, test, afterAll } from "bun:test";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadFlowPackage } from "../../src/flow-package/package-loader.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-pkgloader-${crypto.randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

afterAll(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
});

/** Creates a minimal valid flow package on disk and returns the dir path. */
async function createValidPackage(): Promise<string> {
  const dir = makeTempDir();
  await ensureDir(dir);

  await writeFile(
    join(dir, "package.yaml"),
    `schema_version: "0.1.0"\npackage:\n  id: "test-pkg"\n  version: "1.0.0"\n  type: flow\n  name: "Test Package"\n  description: "Test package"\n`,
  );

  await writeFile(
    join(dir, "flow.yaml"),
    `schema_version: "0.2.0"\nsteps:\n  - id: plan\n    role: planner\n    task: "Plan the work"\n  - id: implement\n    role: developer\n    task: "Implement the feature"\n`,
  );

  await writeFile(
    join(dir, "roles.yaml"),
    `schema_version: "0.3.0"\nmodel_defaults:\n  default_llm_id: "deepseek:deepseek-chat"\nroles:\n  planner:\n    prompt_template: "Plan"\n    context_budget: 0.5\n    llm_id: null\n  developer:\n    prompt_template: "Dev"\n    context_budget: 0.5\n    llm_id: null\n`,
  );

  return dir;
}

describe("loadFlowPackage", () => {
  test("loads a valid package from disk", async () => {
    const dir = await createValidPackage();
    const pkg = await loadFlowPackage(dir);

    expect(pkg.packageId).toBe("test-pkg");
    expect(pkg.packageVersion).toBe("1.0.0");
    expect(pkg.packageDir).toBe(dir);
    expect(pkg.flow.schema_version).toBe("0.2.0");
    expect(pkg.flow.steps).toHaveLength(2);
    expect(pkg.flow.steps[0]!.id).toBe("plan");
    expect(pkg.flow.steps[1]!.id).toBe("implement");
    expect(pkg.roles.schema_version).toBe("0.3.0");
    expect(pkg.roles.model_defaults.default_llm_id).toBe("deepseek:deepseek-chat");
    expect(Object.keys(pkg.roles.roles)).toContain("planner");
    expect(Object.keys(pkg.roles.roles)).toContain("developer");
  });

  test("returns raw data for snapshot serialization", async () => {
    const dir = await createValidPackage();
    const pkg = await loadFlowPackage(dir);

    expect(pkg.rawFlow).toBeDefined();
    expect(pkg.rawRoles).toBeDefined();
    expect((pkg.rawFlow as Record<string, unknown>)["schema_version"]).toBe("0.2.0");
    expect((pkg.rawRoles as Record<string, unknown>)["schema_version"]).toBe("0.3.0");
  });

  test("throws when package.yaml is missing", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    await writeFile(join(dir, "flow.yaml"), "schema_version: \"0.2.0\"\nsteps:\n  - id: plan\n    role: planner\n    task: \"Plan the work\"\n");
    await writeFile(join(dir, "roles.yaml"), "schema_version: \"0.3.0\"\nmodel_defaults:\n  default_llm_id: test\nroles:\n  planner:\n    prompt_template: p\n    context_budget: 0.5\n    llm_id: null\n");

    await expect(loadFlowPackage(dir)).rejects.toThrow(/package metadata/);
  });

  test("throws when flow.yaml is missing", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    await writeFile(join(dir, "package.yaml"), "schema_version: \"0.1.0\"\npackage:\n  id: test\n  version: \"1.0.0\"\n  type: flow\n  name: \"Test\"\n");
    await writeFile(join(dir, "roles.yaml"), "schema_version: \"0.3.0\"\nmodel_defaults:\n  default_llm_id: test\nroles:\n  planner:\n    prompt_template: p\n    context_budget: 0.5\n    llm_id: null\n");

    await expect(loadFlowPackage(dir)).rejects.toThrow(/flow definition/);
  });

  test("throws when roles.yaml is missing", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    await writeFile(join(dir, "package.yaml"), "schema_version: \"0.1.0\"\npackage:\n  id: test\n  version: \"1.0.0\"\n  type: flow\n  name: \"Test\"\n");
    await writeFile(join(dir, "flow.yaml"), "schema_version: \"0.2.0\"\nsteps:\n  - id: plan\n    role: planner\n    task: \"Plan the work\"\n");

    await expect(loadFlowPackage(dir)).rejects.toThrow(/role definitions/);
  });

  test("throws on invalid YAML in package.yaml", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    await writeFile(join(dir, "package.yaml"), "::: invalid :::");
    await writeFile(join(dir, "flow.yaml"), "schema_version: \"0.2.0\"\nsteps:\n  - id: plan\n    role: planner\n    task: \"Plan the work\"\n");
    await writeFile(join(dir, "roles.yaml"), "schema_version: \"0.3.0\"\nmodel_defaults:\n  default_llm_id: test\nroles:\n  planner:\n    prompt_template: p\n    context_budget: 0.5\n    llm_id: null\n");

    await expect(loadFlowPackage(dir)).rejects.toThrow(/Invalid YAML/);
  });

  test("throws on invalid YAML in flow.yaml", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    await writeFile(join(dir, "package.yaml"), "schema_version: \"0.1.0\"\npackage:\n  id: test\n  version: \"1.0.0\"\n  type: flow\n  name: \"Test\"\n");
    await writeFile(join(dir, "flow.yaml"), "::: invalid :::");
    await writeFile(join(dir, "roles.yaml"), "schema_version: \"0.3.0\"\nmodel_defaults:\n  default_llm_id: test\nroles:\n  planner:\n    prompt_template: p\n    context_budget: 0.5\n    llm_id: null\n");

    await expect(loadFlowPackage(dir)).rejects.toThrow(/Invalid YAML/);
  });

  test("throws on schema violation in package.yaml", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    // Missing required 'version' field
    await writeFile(join(dir, "package.yaml"), "schema_version: \"0.1.0\"\npackage:\n  id: test\n");
    await writeFile(join(dir, "flow.yaml"), "schema_version: \"0.2.0\"\nsteps:\n  - id: plan\n    role: planner\n    task: \"Plan the work\"\n");
    await writeFile(join(dir, "roles.yaml"), "schema_version: \"0.3.0\"\nmodel_defaults:\n  default_llm_id: test\nroles:\n  planner:\n    prompt_template: p\n    context_budget: 0.5\n    llm_id: null\n");

    await expect(loadFlowPackage(dir)).rejects.toThrow(/Schema validation/);
  });
});
