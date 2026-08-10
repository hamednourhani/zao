/**
 * Blueprint unit tests for the dev-cycle blueprint.
 *
 * Covers:
 * - Compiling the shipped dev-cycle blueprint package
 * - Step order verification
 * - Tool declarations per step
 * - Loop configuration
 * - Output spec
 * - When gates
 * - Context receive_from
 * - {task} substitution
 *
 * @module dev-cycle.test
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileBlueprint } from "../src/blueprint-compiler.ts";
import type { CompiledBlueprint } from "../src/blueprint-compiler.ts";
import type { CompiledStep } from "../src/schemas.ts";
import type { ToolDeclaration } from "../src/schemas.ts";
import { loadBlueprintPackage } from "../src/blueprint-loader.ts";

const DEV_CYCLE_DIR = join(
  import.meta.dirname,
  "..",
  "defaults",
  "blueprints",
  "dev-cycle",
);

describe("dev-cycle blueprint", () => {
  let compiled: CompiledBlueprint;

  beforeAll(async () => {
    const resolved = await loadBlueprintPackage(DEV_CYCLE_DIR);
    compiled = compileBlueprint(resolved, "test task");
  });

  test("compileBlueprint succeeds for dev-cycle package", () => {
    expect(compiled.blueprintId).toBe("dev-cycle");
    expect(compiled.blueprintVersion).toBe("0.1.0");
    expect(compiled.userTask).toBe("test task");
  });

  test("step order is read → plan → implement → review", () => {
    const stepIds = compiled.flow.steps.map((s: CompiledStep) => s.id);
    expect(stepIds).toEqual(["read", "plan", "implement", "review"]);
  });

  test("read step has readFile tool with no requires_approval", () => {
    const readStep = compiled.flow.steps[0]!;
    expect(readStep.id).toBe("read");
    expect(readStep.tools).toBeDefined();
    expect(readStep.tools!).toHaveLength(1);
    expect(readStep.tools![0]!.tool).toBe("readFile");
    expect(readStep.tools![0]!.scope).toBe("agent_decides");
    expect(readStep.tools![0]!.requires_approval).toBeUndefined();
  });

  test("plan step has NO tools (pure thinking step)", () => {
    const planStep = compiled.flow.steps[1]!;
    expect(planStep.id).toBe("plan");
    expect(planStep.tools).toBeUndefined();
  });

  test("implement step has readFile, writeFile (requires_approval: false), executeShell (requires_approval: true)", () => {
    const implStep = compiled.flow.steps[2]!;
    expect(implStep.id).toBe("implement");
    expect(implStep.tools).toBeDefined();
    expect(implStep.tools!).toHaveLength(3);

    // readFile
    const readTool = implStep.tools!.find((t: ToolDeclaration) => t.tool === "readFile");
    expect(readTool).toBeDefined();
    expect(readTool!.scope).toBe("agent_decides");

    // writeFile — requires_approval: false
    const writeTool = implStep.tools!.find((t: ToolDeclaration) => t.tool === "writeFile");
    expect(writeTool).toBeDefined();
    expect(writeTool!.scope).toBe("agent_decides");
    expect(writeTool!.requires_approval).toBe(false);

    // executeShell — requires_approval: true
    const shellTool = implStep.tools!.find((t: ToolDeclaration) => t.tool === "executeShell");
    expect(shellTool).toBeDefined();
    expect(shellTool!.scope).toBe("agent_decides");
    expect(shellTool!.requires_approval).toBe(true);
  });

  test("review step has readFile, executeShell (requires_approval: true)", () => {
    const reviewStep = compiled.flow.steps[3]!;
    expect(reviewStep.id).toBe("review");
    expect(reviewStep.tools).toBeDefined();
    expect(reviewStep.tools!).toHaveLength(2);

    // readFile
    const readTool = reviewStep.tools!.find((t: ToolDeclaration) => t.tool === "readFile");
    expect(readTool).toBeDefined();

    // executeShell
    const shellTool = reviewStep.tools!.find((t: ToolDeclaration) => t.tool === "executeShell");
    expect(shellTool).toBeDefined();
    expect(shellTool!.requires_approval).toBe(true);
  });

  test("implement step has loop block: target=implement, max_iterations=5, exit_when references review", () => {
    const implStep = compiled.flow.steps[2]!;
    expect(implStep.loop).toBeDefined();
    expect(implStep.loop!.target).toBe("implement");
    expect(implStep.loop!.max_iterations).toBe(5);
    expect(implStep.loop!.exit_when).toBe('review.status == "success"');
  });

  test("review step has output_spec: status=requires_actions, recommended_next=implement", () => {
    const reviewStep = compiled.flow.steps[3]!;
    expect(reviewStep.output_spec).toBeDefined();
    expect(reviewStep.output_spec!.status).toBe("requires_actions");
    expect(reviewStep.output_spec!.recommended_next).toBe("implement");
  });

  test("all when gates reference earlier steps", () => {
    // plan.when → read
    expect(compiled.flow.steps[1]!.when).toBe('read.status == "success"');
    // implement.when → plan
    expect(compiled.flow.steps[2]!.when).toBe('plan.status == "success"');
    // review.when → implement
    expect(compiled.flow.steps[3]!.when).toBe('implement.status == "success"');
  });

  test("implement step's receive_from includes plan and review", () => {
    const implStep = compiled.flow.steps[2]!;
    expect(implStep.receive_from).toBeDefined();
    expect(implStep.receive_from!).toContain("plan");
    expect(implStep.receive_from!).toContain("review");
  });

  test("{task} substitution works in all step tasks", () => {
    for (const step of compiled.flow.steps) {
      expect(step.task).not.toContain("{task}");
      expect(step.task.length).toBeGreaterThan(0);
    }
    // Verify the user task is present in each step's task
    expect(compiled.flow.steps[0]!.task).toContain("test task");
    expect(compiled.flow.steps[1]!.task).toContain("test task");
    expect(compiled.flow.steps[2]!.task).toContain("test task");
    expect(compiled.flow.steps[3]!.task).toContain("test task");
  });

  test("package id is dev-cycle and version is 0.1.0", () => {
    const pkgRaw = readFileSync(join(DEV_CYCLE_DIR, "package.yaml"), "utf-8");
    expect(pkgRaw).toContain("id: \"dev-cycle\"");
    expect(pkgRaw).toContain("version: \"0.1.0\"");
    expect(pkgRaw).toContain("type: blueprint");
  });
});
