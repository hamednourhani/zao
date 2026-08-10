/**
 * Blueprint Loader tests — R-006B.
 *
 * Covers:
 * - Loading a valid blueprint package from disk
 * - Validation fails on missing files
 * - Validation fails on invalid YAML
 * - Validation fails on schema violations
 * - blueprint_id mismatch detection
 *
 * @module blueprint-loader.test
 */

import { describe, expect, test, afterAll } from "bun:test";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadBlueprintPackage } from "../src/blueprint-loader.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-bploader-${crypto.randomUUID()}`);
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

/** Creates a minimal valid blueprint package on disk and returns the dir path. */
async function createValidBlueprintPackage(): Promise<string> {
  const dir = makeTempDir();
  await ensureDir(dir);

  await writeFile(
    join(dir, "package.yaml"),
    `schema_version: "0.1.0"\npackage:\n  id: "test-bp"\n  version: "1.0.0"\n  type: blueprint\n  name: "Test Blueprint"\n  description: "Test blueprint"\n`,
  );

  await writeFile(
    join(dir, "blueprint.yaml"),
    `schema_version: "0.2.0"\nblueprint_id: "test-bp"\nsteps:\n  - id: plan\n    role: planner\n    task_template: "Plan {task}"\n  - id: implement\n    role: developer\n    task_template: "Implement {task}"\n`,
  );

  await writeFile(
    join(dir, "roles.yaml"),
    `schema_version: "0.3.0"\nmodel_defaults:\n  default_llm_id: "deepseek:deepseek-chat"\nroles:\n  planner:\n    prompt_template: "Plan"\n    context_budget: 0.7\n    llm_id: null\n  developer:\n    prompt_template: "Dev"\n    context_budget: 0.65\n    llm_id: null\n`,
  );

  return dir;
}

describe("loadBlueprintPackage", () => {
  test("loads a valid blueprint package", async () => {
    const dir = await createValidBlueprintPackage();
    const pkg = await loadBlueprintPackage(dir);

    expect(pkg.packageId).toBe("test-bp");
    expect(pkg.packageVersion).toBe("1.0.0");
    expect(pkg.packageDir).toBe(dir);
    expect(pkg.blueprint.blueprint_id).toBe("test-bp");
    expect(pkg.blueprint.steps).toHaveLength(2);
    expect(pkg.blueprint.steps[0]!.id).toBe("plan");
    expect(pkg.blueprint.steps[0]!.task_template).toContain("{task}");
    expect(pkg.roles.roles).toHaveProperty("planner");
    expect(pkg.roles.roles).toHaveProperty("developer");
  });

  test("rejects missing package.yaml", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    await writeFile(
      join(dir, "blueprint.yaml"),
      `schema_version: "0.2.0"\nblueprint_id: "test-bp"\nsteps:\n  - id: plan\n    role: planner\n    task_template: "Plan {task}"\n`,
    );
    await writeFile(
      join(dir, "roles.yaml"),
      `schema_version: "0.3.0"\nmodel_defaults:\n  default_llm_id: "deepseek:deepseek-chat"\nroles:\n  planner:\n    prompt_template: "Plan"\n    context_budget: 0.7\n    llm_id: null\n`,
    );

    await expect(loadBlueprintPackage(dir)).rejects.toThrow(/package metadata/);
  });

  test("rejects invalid YAML in blueprint.yaml", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    await writeFile(
      join(dir, "package.yaml"),
      `schema_version: "0.1.0"\npackage:\n  id: "test-bp"\n  version: "1.0.0"\n  type: blueprint\n  name: "Test"\n`,
    );
    await writeFile(join(dir, "blueprint.yaml"), "invalid: [::: yaml");
    await writeFile(
      join(dir, "roles.yaml"),
      `schema_version: "0.3.0"\nmodel_defaults:\n  default_llm_id: "deepseek:deepseek-chat"\nroles:\n  planner:\n    prompt_template: "Plan"\n    context_budget: 0.7\n    llm_id: null\n`,
    );

    await expect(loadBlueprintPackage(dir)).rejects.toThrow(/Invalid YAML/);
  });

  test("rejects schema violations in blueprint steps", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    await writeFile(
      join(dir, "package.yaml"),
      `schema_version: "0.1.0"\npackage:\n  id: "test-bp"\n  version: "1.0.0"\n  type: blueprint\n  name: "Test"\n`,
    );
    // Missing task_template on the step
    await writeFile(
      join(dir, "blueprint.yaml"),
      `schema_version: "0.2.0"\nblueprint_id: "test-bp"\nsteps:\n  - id: plan\n    role: planner\n`,
    );
    await writeFile(
      join(dir, "roles.yaml"),
      `schema_version: "0.3.0"\nmodel_defaults:\n  default_llm_id: "deepseek:deepseek-chat"\nroles:\n  planner:\n    prompt_template: "Plan"\n    context_budget: 0.7\n    llm_id: null\n`,
    );

    await expect(loadBlueprintPackage(dir)).rejects.toThrow(/Schema validation/);
  });

  test("rejects blueprint_id mismatch with package.id", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    await writeFile(
      join(dir, "package.yaml"),
      `schema_version: "0.1.0"\npackage:\n  id: "test-bp"\n  version: "1.0.0"\n  type: blueprint\n  name: "Test"\n`,
    );
    await writeFile(
      join(dir, "blueprint.yaml"),
      `schema_version: "0.2.0"\nblueprint_id: "different-id"\nsteps:\n  - id: plan\n    role: planner\n    task_template: "Plan {task}"\n`,
    );
    await writeFile(
      join(dir, "roles.yaml"),
      `schema_version: "0.3.0"\nmodel_defaults:\n  default_llm_id: "deepseek:deepseek-chat"\nroles:\n  planner:\n    prompt_template: "Plan"\n    context_budget: 0.7\n    llm_id: null\n`,
    );

    await expect(loadBlueprintPackage(dir)).rejects.toThrow(/mismatch/);
  });

  test("rejects missing roles.yaml", async () => {
    const dir = makeTempDir();
    await ensureDir(dir);

    await writeFile(
      join(dir, "package.yaml"),
      `schema_version: "0.1.0"\npackage:\n  id: "test-bp"\n  version: "1.0.0"\n  type: blueprint\n  name: "Test"\n`,
    );
    await writeFile(
      join(dir, "blueprint.yaml"),
      `schema_version: "0.2.0"\nblueprint_id: "test-bp"\nsteps:\n  - id: plan\n    role: planner\n    task_template: "Plan {task}"\n`,
    );

    await expect(loadBlueprintPackage(dir)).rejects.toThrow(/role definitions/);
  });
});
