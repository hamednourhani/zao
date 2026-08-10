/**
 * Blueprint Registry tests — R-006B.
 *
 * Covers:
 * - Resolving shipped default blueprints by ID
 * - Resolving a global blueprint from ~/.zao/blueprints/
 * - Resolving by explicit path
 * - Validation: path-traversal hardening
 * - Validation: invalid package IDs rejected
 *
 * @module blueprint-registry.test
 */

import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBlueprintPackage } from "../src/blueprint-registry.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-bpreg-${crypto.randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

let testStoreRoot: string;

beforeAll(async () => {
  testStoreRoot = makeTempDir();
  await ensureDir(testStoreRoot);
  process.env["ZAO_HOME"] = testStoreRoot;
});

afterAll(async () => {
  delete process.env["ZAO_HOME"];
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
});

/** Creates a blueprint package under ~/.zao/blueprints/<pkgId>/ */
async function createGlobalBlueprintPackage(
  pkgId: string,
): Promise<string> {
  const dir = join(testStoreRoot, "blueprints", pkgId);
  await ensureDir(dir);

  await writeFile(
    join(dir, "package.yaml"),
    `schema_version: "0.1.0"\npackage:\n  id: "${pkgId}"\n  version: "1.0.0"\n  type: blueprint\n  name: "Test ${pkgId}"\n`,
  );
  await writeFile(
    join(dir, "blueprint.yaml"),
    `schema_version: "0.2.0"\nblueprint_id: "${pkgId}"\nsteps:\n  - id: plan\n    role: planner\n    task_template: "Plan {task}"\n`,
  );
  await writeFile(
    join(dir, "roles.yaml"),
    `schema_version: "0.3.0"\nmodel_defaults:\n  default_llm_id: "deepseek:deepseek-chat"\nroles:\n  planner:\n    prompt_template: "Plan"\n    context_budget: 0.7\n    llm_id: null\n`,
  );

  return dir;
}

describe("resolveBlueprintPackage", () => {
  test("resolves shipped default blueprints — feature-development", async () => {
    const pkg = await resolveBlueprintPackage({
      packageId: "feature-development",
    });

    expect(pkg.packageId).toBe("feature-development");
    expect(pkg.blueprint.steps.length).toBeGreaterThan(0);
    expect(pkg.roles.roles).toHaveProperty("planner");
    expect(pkg.roles.roles).toHaveProperty("developer");
    expect(pkg.roles.roles).toHaveProperty("reviewer");
  });

  test("resolves shipped default blueprints — code-review", async () => {
    const pkg = await resolveBlueprintPackage({
      packageId: "code-review",
    });

    expect(pkg.packageId).toBe("code-review");
    expect(pkg.blueprint.steps.length).toBeGreaterThan(0);
    expect(pkg.roles.roles).toHaveProperty("reviewer");
  });

  test("resolves shipped default blueprints — bug-fix", async () => {
    const pkg = await resolveBlueprintPackage({
      packageId: "bug-fix",
    });

    expect(pkg.packageId).toBe("bug-fix");
    expect(pkg.blueprint.steps.length).toBeGreaterThan(0);
    expect(pkg.roles.roles).toHaveProperty("developer");
    expect(pkg.roles.roles).toHaveProperty("reviewer");
  });

  test("resolves a global blueprint from ~/.zao/blueprints/", async () => {
    await createGlobalBlueprintPackage("custom-bp");

    const pkg = await resolveBlueprintPackage({
      packageId: "custom-bp",
    });

    expect(pkg.packageId).toBe("custom-bp");
  });

  test("rejects nonexistent blueprint ID", async () => {
    await expect(
      resolveBlueprintPackage({ packageId: "nonexistent-blueprint" }),
    ).rejects.toThrow(/not found/);
  });

  test("resolves by explicit path", async () => {
    const dir = await createGlobalBlueprintPackage("explicit-bp");

    const pkg = await resolveBlueprintPackage({
      explicitPath: dir,
    });

    expect(pkg.packageId).toBe("explicit-bp");
    expect(pkg.packageDir).toBe(dir);
  });

  test("rejects path-like package IDs (path traversal hardening)", async () => {
    await expect(
      resolveBlueprintPackage({ packageId: "../../../etc/passwd" }),
    ).rejects.toThrow(/Invalid blueprint identifier/);
  });

  test("rejects explicit path that doesn't exist", async () => {
    await expect(
      resolveBlueprintPackage({ explicitPath: "/tmp/does-not-exist-bp" }),
    ).rejects.toThrow(/not found/);
  });

  test("rejects resolution without packageId or explicitPath", async () => {
    await expect(
      resolveBlueprintPackage({}),
    ).rejects.toThrow(/requires either/);
  });
});
