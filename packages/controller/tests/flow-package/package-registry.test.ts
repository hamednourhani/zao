/**
 * Package Registry tests — R-006A.
 *
 * Covers:
 * - Resolving the shipped "default" package
 * - Resolving a project-level package
 * - Falling back to defaults when package not found
 * - Fail-closed on nonexistent package
 *
 * @module package-registry.test
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveFlowPackage,
  resolveAndCompileFlowPackage,
} from "../../src/flow-package/package-registry.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join("/tmp", `zao-test-pkgreg-${crypto.randomUUID()}`);
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

/** Creates a project-level flow package under <dir>/.zao/flows/<pkgId>/ */
async function createProjectPackage(
  dir: string,
  pkgId: string,
): Promise<void> {
  const pkgDir = join(dir, ".zao", "flows", pkgId);
  await ensureDir(pkgDir);

  await writeFile(
    join(pkgDir, "package.yaml"),
    `schema_version: "0.1.0"\npackage:\n  id: "${pkgId}"\n  version: "1.0.0"\n  type: flow\n  name: "Test ${pkgId}"\n`,
  );
  await writeFile(
    join(pkgDir, "flow.yaml"),
    `schema_version: "0.2.0"\nsteps:\n  - id: custom_step\n    role: developer\n    task: "Implement the feature"\n`,
  );
  await writeFile(
    join(pkgDir, "roles.yaml"),
    `schema_version: "0.3.0"\nmodel_defaults:\n  default_llm_id: "openai:gpt-4o"\nroles:\n  developer:\n    prompt_template: "Dev"\n    context_budget: 0.5\n    llm_id: null\n`,
  );
}

describe("resolveAndCompileFlowPackage", () => {
  test("resolves the shipped default package", async () => {
    const compiled = await resolveAndCompileFlowPackage({
      packageId: "default",
      projectRoot: testStoreRoot,
    });

    expect(compiled.packageId).toBe("default");
    expect(compiled.resolvedFlow.steps).toHaveLength(1);
    expect(compiled.resolvedFlow.steps[0]!.id).toBe("default");
    expect(compiled.roleRegistry.roles.size).toBe(4); // planner, developer, reviewer, architect
    expect(compiled.roleRegistry.defaultModel).toBe("deepseek:deepseek-chat");
  });

  test("defaults to 'default' package when no ID specified", async () => {
    const compiled = await resolveAndCompileFlowPackage({
      projectRoot: testStoreRoot,
    });

    expect(compiled.packageId).toBe("default");
  });

  test("resolves a project-level package", async () => {
    const projectDir = makeTempDir();
    await createProjectPackage(projectDir, "my-flow");

    const compiled = await resolveAndCompileFlowPackage({
      packageId: "my-flow",
      projectRoot: projectDir,
    });

    expect(compiled.packageId).toBe("my-flow");
    expect(compiled.resolvedFlow.steps[0]!.id).toBe("custom_step");
    expect(compiled.roleRegistry.defaultModel).toBe("openai:gpt-4o");
  });

  test("throws for nonexistent package", async () => {
    await expect(
      resolveAndCompileFlowPackage({
        packageId: "nonexistent-package",
        projectRoot: testStoreRoot,
      }),
    ).rejects.toThrow(/not found/);
  });

  test("resolveFlowPackage returns non-compiled package", async () => {
    const loaded = await resolveFlowPackage({
      packageId: "default",
      projectRoot: testStoreRoot,
    });

    expect(loaded.packageId).toBe("default");
    expect(loaded.flow.steps).toHaveLength(1);
    expect(loaded.roles.roles).toBeDefined();
  });
});
