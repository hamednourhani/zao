/**
 * Harness Client — real implementation of the {@link HarnessClient} interface.
 *
 * Imports `runJob` from the harness API and wraps it in a class that
 * satisfies the controller's {@link HarnessClient} contract. This replaces
 * the {@link MockHarnessClient} in production.
 *
 * ## Contract (ADR-008)
 *
 * The controller communicates with the harness ONLY through this client.
 * No harness internals (loop.ts, session-store.ts, etc.) are imported.
 * The boundary is the `harness/src/api/run-job.ts` entry point.
 *
 * @module harness-client
 */

import { runJob } from "../../harness/src/api/run-job.ts";
import type { RunJobInput, RunJobOutput } from "../../harness/src/api/run-job.ts";
import type { HarnessClient, ResumeContext } from "./execution-runner.ts";
import type { ResolvedRoleDefinition } from "./schemas/role-definition.ts";
import type { ToolApprovalCallback } from "./human-gate.ts";

/**
 * Production implementation of {@link HarnessClient}.
 *
 * Each call to {@link runJob} invokes the harness via its public API entry
 * point, mapping the controller's parameter shape to the ADR-008 input
 * contract.
 *
 * The constructor accepts an optional `runJob` override so tests can inject
 * a fake harness without reaching the real LLM layer.
 */
export class DefaultHarnessClient implements HarnessClient {
  constructor(
    private _runJob: (input: unknown) => Promise<RunJobOutput> = runJob,
  ) {}

  async runJob(params: {
    sessionId?: string;
    roleId: string;
    resolvedRole: ResolvedRoleDefinition;
    task: string;
    projectDir: string;
    config: { autoYes?: boolean; format?: string };
    resumeContext?: ResumeContext;
    tools?: import("./schemas/flow.ts").ToolDeclaration[];
    onToolApproval?: ToolApprovalCallback;
  }): Promise<{
    success: boolean;
    sessionId: string;
    sessionDir: string;
    result?: Record<string, unknown>;
    events: Array<Record<string, unknown>>;
    error?: string;
  }> {
    const { resolvedRole, roleId } = params;
    const llmId = resolvedRole.llm_id;

    if (!llmId || llmId.length === 0) {
      return {
        success: false,
        sessionId: "",
        sessionDir: "",
        result: undefined,
        events: [],
        error:
          `Cannot run job for role "${roleId}": missing llm_id. ` +
          "Add an llm_id to the role definition or set a default_llm_id.",
      };
    }

    // Basic format validation: must be "provider:model-slug"
    const colonIdx = llmId.indexOf(":");
    if (colonIdx < 1 || colonIdx >= llmId.length - 1) {
      return {
        success: false,
        sessionId: "",
        sessionDir: "",
        result: undefined,
        events: [],
        error:
          `Cannot run job for role "${roleId}": invalid llm_id "${llmId}". ` +
          `Expected format: "provider:model-slug" (e.g. "deepseek:deepseek-chat").`,
      };
    }

    // Build the ADR-008 input from the controller's parameter shape
    const input: RunJobInput = {
      role: {
        role_id: roleId,
        description: resolvedRole.prompt_template,
        prompt_template: resolvedRole.prompt_template,
        llm_id: llmId,
      },
      task: params.task,
      project_dir: params.projectDir,
      config: {
        auto_yes: params.config.autoYes ?? false,
        format: (params.config.format as "table" | "json") ?? "table",
      },
      session_id: params.sessionId ?? null,
      resume_context: params.resumeContext
        ? {
            recent_events: params.resumeContext.recentEvents?.length,
            summary: params.resumeContext.summary,
          }
        : null,
      tools: params.tools, // R-009: forward tool declarations to harness
    };

    // Call the harness API (returns snake_case per ADR-008)
    const output = await this._runJob(input);

    // Map snake_case API output to camelCase controller interface
    return {
      success: output.success,
      sessionId: output.session_id,
      sessionDir: output.session_dir,
      result: output.result,
      events: output.events,
      error: output.error,
    };
  }
}
