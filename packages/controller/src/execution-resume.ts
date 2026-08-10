/**
 * Execution Resume — `zao controller resume execution` implementation.
 *
 * ## R-006A Changes
 *
 * - Replaced `loadRoleRegistry()` with flow-package resolution.
 * - Uses `deserializeCompiledPackage()` to reconstruct from snapshot.
 * - `buildResumeExecuteParams` now produces `_compiledPackage` instead
 *   of `_roleRegistry` + `_preloadedFlow`.
 *
 * ## Core guarantees (ADR-005 / ADR-008)
 *
 * - **A run = one spec.** Resume ALWAYS replays the original
 *   `orchestration-spec.json`. No flag to override config.
 * - **Complete is terminal.** Completed runs are refused with a clear
 *   error; no `--force` flag exists.
 * - **Config drift = a note, not a gate.** Informational note printed;
 *   original spec always used.
 * - **Fail-closed on unreplayable spec.** Deleted role/model → error
 *   naming the missing entry.
 * - **Ground truth on disk.** Completed steps' results never re-run.
 *
 * @module execution-resume
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { execute } from "./execution-runner.ts";
import type { ExecuteParams, ExecutionResult } from "./execution-runner.ts";
import {
  resolveExecutionStoreRoot,
  readExecutionManifest,
  writeExecutionManifest,
  readExecutionIndex,
  appendExecutionEvent,
} from "./execution-store.ts";
import {
  deserializeCompiledPackage,
  extractPackageSnapshotFromSpec,
} from "./flow-package/package-snapshot.ts";
import { resolveAndCompileFlowPackage } from "./flow-package/package-registry.ts";
import type { CompiledFlowPackage } from "./flow-package/package-compiler.ts";
import { validateCompiledPackageSemantics } from "./flow-package/package-compiler.ts";

// ── Types ───────────────────────────────────────────────────────────

export interface ResumeExecutionOptions {
  recentEvents?: number;
}

export interface ResumeExecutionResult {
  success: boolean;
  executionDir: string;
  executionId: string;
  error?: string;
  executionResult?: ExecutionResult;
  completed: boolean;
  isValidationError?: boolean;
  resumeFromStepId?: string;
  spec?: Record<string, unknown>;
  resumeContext?: { summary?: string; recentEvents?: string[] };
}

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_RECENT_EVENTS = 3;

// ── Internal Helpers ────────────────────────────────────────────────

/**
 * Validates that every role referenced in the original orchestration
 * spec still resolves from the flow package snapshot. Fail-closed per ADR-005.
 *
 * @param spec - The parsed orchestration spec snapshot.
 * @returns Validation result with error and classification.
 */
function validateSpecRolesFromSnapshot(
  spec: Record<string, unknown>,
): { ok: true } | { ok: false; error: string; isValidationError: boolean } {
  // Reconstruct the registry from the spec to check it's valid
  const fpSnapshot = extractPackageSnapshotFromSpec(spec);
  if (!fpSnapshot) {
    return {
      ok: false,
      error:
        "Cannot replay execution: orchestration-spec.json has no valid role definitions. " +
        "The spec may be from an older version of zao.",
      isValidationError: true,
    };
  }

  try {
    deserializeCompiledPackage(fpSnapshot);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Cannot replay execution: ${message}`,
      isValidationError: true,
    };
  }

  return { ok: true };
}

/**
 * Compares the orchestration spec snapshot against the current flow
 * package's registry. Informational only — the original spec is always
 * used for resume (ADR-005 addendum #3).
 *
 * @param spec - The parsed orchestration spec snapshot.
 * @returns Whether drift was detected and an informational note.
 */
function compareSpecToCurrent(
  compiledPkg: CompiledFlowPackage | null,
  spec: Record<string, unknown>,
): { drift: boolean; note: string } {
  if (!compiledPkg) {
    return {
      drift: true,
      note:
        "Config changed since execution start — replaying original spec. " +
        "(Could not resolve current package for comparison.)",
    };
  }

  const rawSpecRoles =
    (spec["roles"] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const currentRegistry = compiledPkg.roleRegistry;

  if (currentRegistry.roles.size !== Object.keys(rawSpecRoles).length) {
    return {
      drift: true,
      note:
        "Config changed since execution start — replaying original spec. " +
        `Original: ${Object.keys(rawSpecRoles).length} roles, ` +
        `current: ${currentRegistry.roles.size} roles.`,
    };
  }

  for (const [name, currentDef] of currentRegistry.roles) {
    const specDef = rawSpecRoles[name];
    if (!specDef) {
      return {
        drift: true,
        note:
          "Config changed since execution start — replaying original spec. " +
          `Role "${name}" exists in current config but not in snapshot.`,
      };
    }
    if (
      (specDef["model"] as string) !== currentDef.model ||
      (specDef["prompt_template"] as string) !== currentDef.prompt_template
    ) {
      return {
        drift: true,
        note:
          "Config changed since execution start — replaying original spec. " +
          `Role "${name}" has drifted (model or prompt).`,
      };
    }
  }

  return { drift: false, note: "" };
}

// ── Core Function ───────────────────────────────────────────────────

/**
 * Resumes an interrupted or failed execution at the first unfinished step.
 *
 * ## R-006A Changes
 *
 * Uses flow-package snapshots for role validation and replay-ability checks
 * instead of calling `loadRoleRegistry()`.
 *
 * @param executionId - The execution identifier to resume.
 * @param options - Resume options (recentEvents).
 * @returns A {@link ResumeExecutionResult} with success status and details.
 */
export async function resumeExecution(
  executionId: string,
  options: ResumeExecutionOptions = {},
): Promise<ResumeExecutionResult> {
  const storeRoot = await resolveExecutionStoreRoot();
  const recentEventsCount = options.recentEvents ?? DEFAULT_RECENT_EVENTS;
  const executionDir = join(storeRoot, executionId);

  // ── Step 1: Read execution.json ─────────────────────────────────
  let manifest;
  try {
    manifest = await readExecutionManifest(executionDir);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      executionDir,
      executionId,
      error: `Cannot resume: ${message}`,
      completed: false,
      isValidationError: true,
    };
  }

  if (!manifest) {
    return {
      success: false,
      executionDir,
      executionId,
      error:
        `Execution "${executionId}" not found at "${executionDir}". ` +
        'Check the id or run "zao controller list".',
      completed: false,
      isValidationError: true,
    };
  }

  // ── Step 2: Terminal-state gate ─────────────────────────────────
  if (manifest.status === "complete") {
    return {
      success: false,
      executionDir,
      executionId,
      error: "Execution complete. Completed runs are terminal.",
      completed: false,
      isValidationError: true,
    };
  }

  // ── Step 3: Read original orchestration-spec.json ────────────────
  let spec: Record<string, unknown>;
  try {
    const specRaw = await readFile(
      join(executionDir, "orchestration-spec.json"),
      "utf-8",
    );
    spec = JSON.parse(specRaw);
  } catch {
    return {
      success: false,
      executionDir,
      executionId,
      error:
        "Cannot resume: orchestration-spec.json is missing or corrupt. " +
        "The execution cannot be replayed without the original spec.",
      completed: false,
      isValidationError: true,
    };
  }

  // ── Step 3b: Fail-closed replay-ability check ──────────────────
  const replayCheck = validateSpecRolesFromSnapshot(spec);
  if (!replayCheck.ok) {
    return {
      success: false,
      executionDir,
      executionId,
      error: replayCheck.error,
      completed: false,
      isValidationError: replayCheck.isValidationError,
    };
  }

  // ── Step 3c: Config drift NOTE (informational, not a gate) ─────
  try {
    const currentPkg = await resolveAndCompileFlowPackage({
      packageId: (spec["flow_package_package_id"] as string) ?? "default",
      projectRoot: manifest.repo_root,
    });
    const driftResult = compareSpecToCurrent(currentPkg, spec);
    if (driftResult.drift) {
      process.stderr.write(`\n[zao] NOTE: ${driftResult.note}\n\n`);
    }
  } catch {
    // Best-effort: if current package can't be resolved, skip drift check
    const driftResult = compareSpecToCurrent(null, spec);
    if (driftResult.drift) {
      process.stderr.write(`\n[zao] NOTE: ${driftResult.note}\n\n`);
    }
  }

  // ── Step 4: Determine completed steps from index.jsonl ──────────
  const specFlow = spec["flow"] as
    | { steps: Array<{ id: string; role: string; when?: string | null; context?: string | null }> }
    | undefined;

  if (!specFlow || !specFlow.steps || specFlow.steps.length === 0) {
    return {
      success: false,
      executionDir,
      executionId,
      error:
        "Cannot resume: orchestration-spec.json has no flow definition.",
      completed: false,
      isValidationError: true,
    };
  }

  const indexLines = await readExecutionIndex(executionDir);
  const completedStepIds = new Set<string>();
  let resumeFromStepId: string | undefined;

  for (let i = 0; i < specFlow.steps.length; i++) {
    const step = specFlow.steps[i]!;
    const indexLine = indexLines[i];

    if (indexLine && indexLine.status === "complete") {
      completedStepIds.add(step.id);
    } else {
      resumeFromStepId = step.id;
      break;
    }
  }

  if (resumeFromStepId === undefined) {
    try {
      await writeExecutionManifest(executionDir, {
        ...manifest,
        status: "complete",
      });
    } catch {
      // Best-effort
    }

    return {
      success: true,
      executionDir,
      executionId,
      error: "All steps already completed. Execution is complete.",
      completed: true,
    };
  }

  // ── Step 5: Reconstruct resume context ──────────────────────────
  const priorStepSummaries: string[] = [];
  for (let i = 0; i < completedStepIds.size; i++) {
    const step = specFlow.steps[i]!;
    priorStepSummaries.push(
      `Step "${step.id}" (role: ${step.role}) — completed.`,
    );
  }

  const recentEventLines: string[] = [];
  try {
    const eventsRaw = await readFile(
      join(executionDir, "events.jsonl"),
      "utf-8",
    );
    const lines = eventsRaw.split("\n").filter((l) => l.trim().length > 0);
    const recentLines = lines.slice(-recentEventsCount);
    for (const line of recentLines) {
      try {
        const event = JSON.parse(line);
        const type = typeof event["type"] === "string" ? event["type"] : "?";
        const timestamp =
          typeof event["timestamp"] === "string"
            ? event["timestamp"].slice(11, 19)
            : "????";
        recentEventLines.push(`[${timestamp}] ${type}`);
      } catch {
        // Skip unparseable lines
      }
    }
  } catch {
    // No events.jsonl — fine
  }

  const resumeContextData = {
    summary: priorStepSummaries.length > 0
      ? `Prior steps:\n${priorStepSummaries.join("\n")}`
      : undefined,
    recentEvents: recentEventLines,
  };

  // ── Step 6: Update execution manifest ───────────────────────────
  try {
    await writeExecutionManifest(executionDir, {
      ...manifest,
      status: "active",
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      executionDir,
      executionId,
      error: `Failed to update execution manifest before resume: ${message}`,
      completed: false,
    };
  }

  // ── Step 7: Append execution_resumed event ──────────────────────
  try {
    await appendExecutionEvent(executionDir, {
      type: "execution_resumed",
      execution_id: executionId,
      timestamp: new Date().toISOString(),
      detail: {
        resume_from_step: resumeFromStepId,
        completed_steps: completedStepIds.size,
        total_steps: specFlow.steps.length,
      },
    });
  } catch {
    // Best-effort
  }

  return {
    success: true,
    executionDir,
    executionId,
    completed: false,
    resumeFromStepId,
    spec,
    resumeContext: resumeContextData,
    executionResult: {
      success: true,
      executionId,
      executionDir,
      sessionIds: [],
      steps: [],
      tokenUsage: { prompt: 0, completion: 0 },
    },
  };
}

/**
 * Reconstructs the {@link ExecuteParams} needed to re-enter {@link execute}
 * for a resumed execution. The caller provides the harness client; the
 * function returns the full parameter block.
 *
 * ## R-006A Changes
 *
 * Uses `_compiledPackage` instead of `_roleRegistry` + `_preloadedFlow`.
 *
 * @param executionId - The execution identifier.
 * @param spec - The parsed orchestration spec snapshot.
 * @param resumeFromStepId - The step id to resume from.
 * @param task - The original task from the execution manifest.
 * @param projectDir - The repo root from the execution manifest.
 * @param resumeContext - Optional resume context with summary and recent events.
 * @returns The parameters needed to call {@link execute}.
 */
export function buildResumeExecuteParams(
  executionId: string,
  spec: Record<string, unknown>,
  resumeFromStepId: string,
  task: string,
  projectDir: string,
  resumeContext?: { summary?: string; recentEvents?: string[] },
): ExecuteParams {
  // Reconstruct CompiledFlowPackage from the spec snapshot
  const fpSnapshot = extractPackageSnapshotFromSpec(spec);
  if (!fpSnapshot) {
    throw new Error(
      "Cannot build resume params: orchestration spec has no flow_package snapshot. " +
      "This execution may be from an older version of zao and cannot be resumed.",
    );
  }

  const compiledPkg = deserializeCompiledPackage(fpSnapshot);
  // Re-validate semantics: deserialized packages may be corrupted
  validateCompiledPackageSemantics(compiledPkg);

  return {
    task,
    projectDir,
    _compiledPackage: compiledPkg,
    _executionId: executionId,
    resumeFromStepId,
    resumeContext: resumeContext
      ? { summary: resumeContext.summary, recentEvents: resumeContext.recentEvents }
      : undefined,
  };
}
