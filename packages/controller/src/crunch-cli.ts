/**
 * Crunch CLI — runs the research pipeline and executes the emitted
 * blueprint via the controller's {@link execute} function.
 *
 * ## Flow
 *
 * 1. Run {@link crunch} from `@zao/crunch` with the user's question.
 * 2. Pass the emitted blueprint to {@link execute} with `blueprint`
 *    param (skips disk resolution).
 * 3. Return the execution result.
 *
 * The crunch research phase runs OUTSIDE the sandbox (reads from real
 * projectDir). The execution phase runs INSIDE the sandbox (via
 * execute's default sandboxing).
 *
 * @module crunch-cli
 */

import { crunch, type GenerateStructuredFn } from "@zao/crunch";
import type { CrunchOutput } from "@zao/crunch";
import { createDefaultRegistry } from "@zao/llm-clients";
import { generateObject } from "ai";
import { execute } from "./execution-runner.ts";
import type { ExecutionResult } from "./execution-runner.ts";
import type { ToolApprovalRequest, ToolApprovalResponse } from "./human-gate.ts";
import type { LoopCloseState } from "./schemas/flow.ts";

/**
 * Options for {@link runCrunchCLI}.
 */
export interface CrunchCLIOptions {
  /** The user's question to research. */
  question: string;
  /** Path to the project directory. @default process.cwd() */
  projectDir?: string;
  /** Whether to enable sandboxing for the execution phase. @default true */
  sandbox?: boolean;
  /** Whether --yes flag is active. @default false */
  autoYes?: boolean;
  /** Output format. @default "table" */
  format?: "table" | "json";
  /** Tool approval callback for the execution phase. */
  onToolApproval?: (req: ToolApprovalRequest) => Promise<ToolApprovalResponse>;
  /** Loop close callback for blueprint execution loops. */
  onLoopClose?: (state: LoopCloseState) => Promise<"continue" | "exit">;
  /**
   * **Internal/test-only.** Override the `execute` function for
   * deterministic testing without real LLM calls.
   */
  _execute?: typeof execute;
  /**
   * **Internal/test-only.** Override the `crunch` function.
   */
  _crunch?: typeof crunch;
  /**
   * **Internal/test-only.** Override the `createDefaultRegistry` function.
   */
  _createRegistry?: typeof createDefaultRegistry;
}

/**
 * Runs the full crunch pipeline: research → blueprint → execute.
 *
 * @param options - CLI options (question, projectDir, etc.).
 * @returns The execution result from the controller.
 */
export async function runCrunchCLI(
  options: CrunchCLIOptions,
): Promise<ExecutionResult> {
  const projectDir = options.projectDir ?? process.cwd();

  // ── Phase 1: Research (outside sandbox) ──────────────────────────
  const registryFn = options._createRegistry ?? createDefaultRegistry;
  const crunchFn = options._crunch ?? crunch;
  const registry = await registryFn();

  // Wire up real LLM generation via Vercel AI SDK
  const generateFn: GenerateStructuredFn = async (
    prompt, schema, client, genOptions,
  ) => {
    try {
      const model = client.createModel(genOptions ?? {});
      const result = await generateObject({
        model,
        schema,
        prompt,
        ...(genOptions?.maxTokens ? { maxTokens: genOptions.maxTokens } : {}),
      });
      return { success: true, result: result.object };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  };

  const crunchOutput: CrunchOutput = await crunchFn(
    { question: options.question, projectDir },
    registry,
    { _generate: generateFn },
  );

  // ── Phase 2: Execute blueprint (inside sandbox by default) ───────
  const executeFn = options._execute ?? execute;
  const result = await executeFn({
    task: options.question,
    blueprint: crunchOutput.blueprint,
    autoYes: options.autoYes ?? false,
    projectDir,
    format: options.format ?? "table",
    sandbox: options.sandbox !== false,
    onToolApproval: options.onToolApproval,
    onLoopClose: options.onLoopClose,
  });

  return result;
}
