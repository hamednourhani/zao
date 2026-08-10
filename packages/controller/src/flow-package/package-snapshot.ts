/**
 * Flow Package Snapshot — serializes and deserializes {@link CompiledFlowPackage}
 * for execution resume and provenance tracking.
 *
 * ## Purpose
 *
 * When an execution starts, a snapshot of the compiled flow package is
 * embedded in the orchestration spec. On resume, the snapshot is used to
 * reconstruct the exact same {@link CompiledFlowPackage} that was used
 * at execution start — avoiding config drift.
 *
 * ## Fail-closed
 *
 * - Invalid snapshot data → error (cannot resume with corrupt state)
 * - Missing required fields → error
 *
 * @module package-snapshot
 */

import { cp } from "node:fs/promises";
import { join } from "node:path";
import type { CompiledFlowPackage } from "./package-compiler.ts";
import type { RoleRegistry } from "../role-registry.ts";
import type { ResolvedRoleDefinition } from "../schemas/role-definition.ts";
import type { FlowStep } from "../schemas/flow.ts";

// ── Snapshot Format ──────────────────────────────────────────────────

/**
 * JSON-serializable representation of a CompiledFlowPackage.
 * This is embedded in the orchestration spec snapshot.
 */
export interface FlowPackageSnapshot {
  package_id: string;
  package_version: string;
  package_dir: string;
  /**
   * Structured provenance: when this package was produced by compiling
   * a blueprint, records the source blueprint id and version.
   * Absent for hand-authored flow packages. The human-readable
   * `flow.provenance` string is always kept alongside this field.
   */
  derived_from?: {
    blueprint_id: string;
    blueprint_version: string;
  };
  flow: {
    schema_version: string;
    provenance: string;
    steps: Array<{
      id: string;
      role: string;
      task: string;
      when?: string | null;
      context?: string | null;
      /** Optional tool declarations for this step (R-009). */
      tools?: Array<{ tool: string; scope: string; requires_approval?: boolean }> | null;
    }>;
  };
  roles: Record<string, {
    prompt_template: string;
    context_budget: number;
    model: string;
    llm_id: string;
    provenance: string;
    model_provenance: string;
  }>;
  default_model: string;
}

/**
 * Serializes a {@link CompiledFlowPackage} to a JSON-safe snapshot.
 *
 * @param compiled - The compiled flow package to snapshot.
 * @returns A plain object suitable for JSON serialization.
 */
export function snapshotCompiledPackage(
  compiled: CompiledFlowPackage,
): FlowPackageSnapshot {
  const roles: FlowPackageSnapshot["roles"] = {};
  for (const [name, def] of compiled.roleRegistry.roles) {
    roles[name] = {
      prompt_template: def.prompt_template,
      context_budget: def.context_budget,
      model: def.model,
      llm_id: def.llm_id,
      provenance: def.provenance,
      model_provenance: def.model_provenance,
    };
  }

  return {
    package_id: compiled.packageId,
    package_version: compiled.packageVersion,
    package_dir: compiled.packageDir,
    ...(compiled.derivedFrom
      ? { derived_from: compiled.derivedFrom }
      : {}),
    flow: {
      schema_version: compiled.resolvedFlow.schema_version,
      provenance: compiled.resolvedFlow.provenance,
      steps: compiled.resolvedFlow.steps.map((s) => ({
        id: s.id,
        role: s.role,
        task: s.task,
        when: s.when ?? null,
        context: s.context ?? null,
        tools: ((s as Record<string, unknown>)["tools"] as FlowPackageSnapshot["flow"]["steps"][0]["tools"]) ?? null,
      })),
    },
    roles,
    default_model: compiled.roleRegistry.defaultModel,
  };
}

/**
 * Reconstructs a {@link CompiledFlowPackage} from a snapshot.
 *
 * Used during execution resume to recreate the exact same compiled
 * package that was used at execution start.
 *
 * @param snapshot - The serialized snapshot data.
 * @returns A reconstructed compiled flow package.
 * @throws If required fields are missing from the snapshot.
 */
export function deserializeCompiledPackage(
  snapshot: FlowPackageSnapshot,
): CompiledFlowPackage {
  // ── Required field checks: throw, no silent defaults ──────────
  if (!snapshot.package_id) {
    throw new Error(
      "Cannot deserialize compiled package: snapshot is missing package_id.",
    );
  }
  if (!snapshot.package_dir) {
    throw new Error(
      "Cannot deserialize compiled package: snapshot is missing package_dir.",
    );
  }
  if (!snapshot.roles) {
    throw new Error(
      "Cannot deserialize compiled package: snapshot is missing roles.",
    );
  }

  // Reconstruct role registry
  const roles = new Map<string, ResolvedRoleDefinition>();
  for (const [name, roleData] of Object.entries(snapshot.roles)) {
    const rd = roleData!;
    // Each role entry must have at minimum prompt_template and model
    if (!rd.prompt_template && rd.prompt_template !== "") {
      throw new Error(
        `Cannot deserialize compiled package: role "${name}" is missing prompt_template.`,
      );
    }
    if (!rd.model && rd.model !== "") {
      throw new Error(
        `Cannot deserialize compiled package: role "${name}" is missing model.`,
      );
    }
    const resolved: ResolvedRoleDefinition = {
      prompt_template: rd.prompt_template,
      context_budget: rd.context_budget ?? 0,
      model: rd.model,
      llm_id: rd.llm_id ?? "",
      provenance: rd.provenance ?? "snapshot",
      model_provenance: rd.model_provenance ?? "snapshot",
    };
    roles.set(name, resolved);
  }

  const roleRegistry: RoleRegistry = {
    roles,
    defaultModel: snapshot.default_model ?? "",
  };

  // Reconstruct flow steps
  if (!snapshot.flow || !snapshot.flow.steps) {
    throw new Error(
      "Cannot deserialize compiled package: snapshot is missing flow.steps.",
    );
  }

  const steps: FlowStep[] = snapshot.flow.steps.map((s) => {
    if (!s.id) {
      throw new Error(
        "Cannot deserialize compiled package: a flow step is missing an id.",
      );
    }
    if (!s.role) {
      throw new Error(
        `Cannot deserialize compiled package: step "${s.id}" is missing a role.`,
      );
    }
    if (!s.task) {
      throw new Error(
        `Cannot deserialize compiled package: step "${s.id}" is missing a task.`,
      );
    }
    const step: FlowStep = {
      id: s.id,
      role: s.role,
      task: s.task,
    };
    if (s.when !== null && s.when !== undefined) step.when = s.when;
    if (s.context !== null && s.context !== undefined) step.context = s.context;
    if (s.tools !== null && s.tools !== undefined) {
      (step as Record<string, unknown>)["tools"] = s.tools;
    }
    return step;
  });

  return {
    resolvedFlow: {
      schema_version: snapshot.flow?.schema_version ?? "0.2.0",
      steps,
      provenance: snapshot.flow?.provenance ?? "snapshot",
    },
    roleRegistry,
    packageDir: snapshot.package_dir,
    packageId: snapshot.package_id,
    packageVersion: snapshot.package_version ?? "unknown",
    ...(snapshot.derived_from
      ? { derivedFrom: snapshot.derived_from }
      : {}),
  };
}

/**
 * Extracts a {@link FlowPackageSnapshot} from a legacy orchestration spec
 * that was stored as `roles` + `flow` at the top level (pre-package format).
 *
 * Used for backward-compatible resume: if the snapshot lacks a
 * `flow_package` key, reconstruct one from the legacy `roles` + `flow` keys.
 *
 * @param spec - The full orchestration spec (may be legacy format).
 * @returns A FlowPackageSnapshot, or null if insufficient data.
 */
export function extractPackageSnapshotFromSpec(
  spec: Record<string, unknown>,
): FlowPackageSnapshot | null {
  // Try the new format first
  const fp = spec["flow_package"] as FlowPackageSnapshot | undefined;
  if (fp?.package_id && fp?.roles) {
    return fp;
  }

  // Legacy format: reconstruct from roles + flow + default_model
  const specRoles = spec["roles"] as Record<string, Record<string, unknown>> | undefined;
  const specFlow = spec["flow"] as
    | { schema_version?: string; provenance?: string; steps?: Array<{ id: string; role: string; task?: string; when?: string | null; context?: string | null }> }
    | undefined;
  const specModel = spec["default_model"] as string | undefined;

  if (!specRoles) return null;

  const roles: FlowPackageSnapshot["roles"] = {};
  for (const [name, r] of Object.entries(specRoles)) {
    roles[name] = {
      prompt_template: (r["prompt_template"] as string) ?? "",
      context_budget: (r["context_budget"] as number) ?? 0,
      model: (r["model"] as string) ?? "",
      llm_id: (r["llm_id"] as string) ?? `${r["provider"] ?? "deepseek"}:${r["model"] ?? "deepseek-chat"}`,
      provenance: (r["provenance"] as string) ?? "snapshot",
      model_provenance: (r["model_provenance"] as string) ?? "snapshot",
    };
  }

  return {
    package_id: "legacy-snapshot",
    package_version: "0.0.0",
    package_dir: "snapshot",
    flow: {
      schema_version: specFlow?.schema_version ?? "0.2.0",
      provenance: specFlow?.provenance ?? "snapshot",
      steps: specFlow?.steps?.map((s) => ({
        id: s.id,
        role: s.role,
        task: s.task ?? "Flow step",
        when: s.when ?? null,
        context: s.context ?? null,
      })) ?? [],
    },
    roles,
    default_model: specModel ?? "",
  };
}

// ── Filesystem Snapshot ───────────────────────────────────────────────

/**
 * Copies the entire flow package directory into the execution directory
 * for provenance and future replayability.
 *
 * Per ADR-008 Decision 7: a copy of the flow package that produced this
 * execution is stored alongside the orchestration spec inside the
 * execution directory. This provides a stable replay reference that is
 * immune to later changes to the original package.
 *
 * ## Fail-closed
 *
 * If the copy fails for any reason (source missing, permissions, disk full),
 * the error propagates — execution does not proceed with an incomplete
 * execution directory.
 *
 * @param packageDir - Absolute path to the source flow package directory.
 * @param executionDir - Absolute path to the execution directory.
 * @throws If the copy fails.
 */
export async function copyPackageToExecutionDir(
  packageDir: string,
  executionDir: string,
): Promise<void> {
  const dest = join(executionDir, "flow-package");

  try {
    await cp(packageDir, dest, { recursive: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to copy flow package from "${packageDir}" to "${dest}": ${message}. ` +
        "The execution cannot proceed without a stable snapshot of the flow package.",
    );
  }
}
