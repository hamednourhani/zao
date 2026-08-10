/**
 * Flow Package Compiler — compiles a LoadedFlowPackage into a runtime-ready
 * CompiledFlowPackage with resolved roles and validated flow semantics.
 *
 * ## Compilation steps
 *
 * 1. Build a RoleRegistry from the package's roles (inherit llm_id from defaults)
 * 2. Validate flow semantics (duplicate ids, when refs, role existence)
 * 3. Return CompiledFlowPackage
 *
 * ## Zero LLM calls
 *
 * Compilation is structural and performed before any execution begins.
 *
 * @module package-compiler
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import type { LoadedFlowPackage } from "./package-loader.ts";
import type { RoleRegistry } from "../role-registry.ts";
import type { ResolvedRoleDefinition, RolesFile, RoleDefinition } from "../schemas/role-definition.ts";
import { parseWhenExpression } from "../flow-loader.ts";
import type { Flow, FlowStep } from "../schemas/flow.ts";

// ── Compiled Flow Package ───────────────────────────────────────────

/**
 * A compiled flow package ready for execution.
 *
 * Contains a resolved RoleRegistry and a semantically validated flow.
 * This is the runtime representation — all config has been flattened,
 * defaults inherited, and references validated.
 */
export interface CompiledFlowPackage {
  /** The fully resolved and validated flow. */
  resolvedFlow: {
    schema_version: string;
    steps: FlowStep[];
    provenance: string;
  };
  /** The role registry with all roles resolved (llm_id inherited). */
  roleRegistry: RoleRegistry;
  /** Absolute path to the package directory (for provenance). */
  packageDir: string;
  /** The package identifier. */
  packageId: string;
  /** The package version. */
  packageVersion: string;
  /**
   * Structured provenance: when this compiled flow package was produced
   * by compiling a blueprint, records which blueprint and version it was
   * derived from. Absent for hand-authored flow packages.
   * The human-readable `resolvedFlow.provenance` string is always kept
   * in addition to this structured field.
   */
  derivedFrom?: {
    blueprint_id: string;
    blueprint_version: string;
  };
}

// ── Role Registry Builder ───────────────────────────────────────────

/**
 * Builds a RoleRegistry from a package's roles and model defaults.
 *
 * Handles llm_id inheritance: roles with `llm_id: null` inherit the
 * package's `default_llm_id`. The registry is a flat map of role name
 * → {@link ResolvedRoleDefinition}.
 *
 * @param roles - The parsed roles file from the package.
 * @param packageDir - The package directory (for provenance tracking).
 * @returns A fully resolved RoleRegistry.
 */
function buildRoleRegistry(
  roles: RolesFile,
  packageDir: string,
): RoleRegistry {
  const resolvedRoles = new Map<string, ResolvedRoleDefinition>();
  const defaultLlmId = roles.model_defaults.default_llm_id;

  for (const [roleName, roleDef] of Object.entries(roles.roles)) {
    const r = roleDef as RoleDefinition;
    // Handle llm_id: null → inherit default, string → use directly
    const effectiveLlmId = r.llm_id ?? defaultLlmId;

    // Derive model slug from llm_id (see execution-runner.deriveModelSlug
    // for the shared heuristic: "provider:model-slug" → "model-slug").
    const colonIdx = effectiveLlmId.indexOf(":");
    const effectiveModel = colonIdx >= 0
      ? effectiveLlmId.slice(colonIdx + 1)
      : effectiveLlmId;

    // model_provenance: was the llm_id explicitly set on the role or inherited?
    const modelProvenance = r.llm_id !== null && r.llm_id !== undefined
      ? `package:${packageDir} (role-level)`
      : `package:${packageDir} (inherited default)`;

    resolvedRoles.set(roleName, {
      prompt_template: r.prompt_template,
      context_budget: r.context_budget,
      model: effectiveModel,
      llm_id: effectiveLlmId,
      provenance: `package:${packageDir}`,
      model_provenance: modelProvenance,
    });
  }

  return {
    roles: resolvedRoles,
    defaultModel: defaultLlmId,
  };
}

// ── Semantic Validation ──────────────────────────────────────────────

/**
 * Validates the semantic rules of a flow after schema parsing:
 *
 * 1. No duplicate step `id` values.
 * 2. All `when` references point to existing, EARLIER steps.
 * 3. All roles referenced by steps exist in the given registry.
 *
 * @param flow - The parsed (schema-valid) flow to check.
 * @param registry - The resolved role registry.
 * @param packageId - The package identifier for error messages.
 * @throws If any semantic rule is violated.
 */
function validateFlowSemantics(
  flow: Flow,
  registry: RoleRegistry,
  packageId: string,
): void {
  // Check 1: Duplicate ids
  const seenIds = new Set<string>();
  for (const step of flow.steps) {
    if (seenIds.has(step.id)) {
      throw new Error(
        `Duplicate step id "${step.id}" in flow package "${packageId}". ` +
          "Each step id must be unique.",
      );
    }
    seenIds.add(step.id);
  }

  // Check 2: when references
  const stepIds = new Set(flow.steps.map((s) => s.id));

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i]!;
    if (!step.when) continue;

    const parsed = parseWhenExpression(step.when);

    if (!parsed) {
      throw new Error(
        `Step "${step.id}" has invalid when expression: "${step.when}". ` +
          `Expected format: "<step-id>.status == \"success\"" or ` +
          `"<step-id>.status == \"failed\"" (package "${packageId}").`,
      );
    }

    const { refId } = parsed;

    if (!stepIds.has(refId)) {
      throw new Error(
        `Step "${step.id}" references unknown step "${refId}" in when: "${step.when}". ` +
          `Available steps: ${[...stepIds].join(", ") || "(none)"} (package "${packageId}").`,
      );
    }

    const refIndex = flow.steps.findIndex((s) => s.id === refId);
    if (refIndex >= i) {
      throw new Error(
        `Step "${step.id}" references step "${refId}" in when, ` +
          `but "${refId}" is at position ${refIndex} while "${step.id}" is at position ${i}. ` +
          `when can only reference earlier steps (package "${packageId}").`,
      );
    }
  }

  // Check 3: All roles exist in registry
  for (const step of flow.steps) {
    if (!registry.roles.has(step.role)) {
      throw new Error(
        `Step "${step.id}" references unknown role "${step.role}" ` +
          `(package "${packageId}"). ` +
          `Available roles: ${[...registry.roles.keys()].join(", ") || "(none)"}.`,
      );
    }
  }
}

/**
 * Validates the semantics of an already-compiled flow package.
 *
 * This is the re-validation entry point for packages that bypassed the
 * normal compile path: test-mode `_compiledPackage` overrides and
 * deserialized snapshots.
 *
 * Checks performed:
 * 1. No duplicate step `id` values.
 * 2. All `when` references point to existing, EARLIER steps.
 * 3. All roles referenced by steps exist in the package's role registry.
 *
 * @param compiled - The compiled flow package to validate.
 * @throws If any semantic rule is violated.
 */
export function validateCompiledPackageSemantics(
  compiled: CompiledFlowPackage,
): void {
  const flow: Flow = {
    schema_version: compiled.resolvedFlow.schema_version as "0.2.0" | "0.3.0",
    steps: compiled.resolvedFlow.steps,
  };

  validateFlowSemantics(flow, compiled.roleRegistry, compiled.packageId);
}

// ── Core Compiler ────────────────────────────────────────────────────

/**
 * Compiles a loaded flow package into a runtime-ready
 * {@link CompiledFlowPackage}.
 *
 * ## Compilation steps
 *
 * 1. Build a {@link RoleRegistry} from the package's roles.
 * 2. Validate flow semantics against the registry.
 * 3. Return the compiled package.
 *
 * ## Fail-closed
 *
 * - Missing required roles → error
 * - Duplicate step ids → error
 * - Invalid `when` references → error
 * - None of these errors reach the LLM
 *
 * @param pkg - The loaded flow package to compile.
 * @returns A compiled flow package ready for execution.
 */
export function compileFlowPackage(
  pkg: LoadedFlowPackage,
): CompiledFlowPackage {
  // Step 1: Build role registry
  const roleRegistry = buildRoleRegistry(pkg.roles, pkg.packageDir);

  // Step 2: Validate flow semantics
  validateFlowSemantics(pkg.flow, roleRegistry, pkg.packageId);

  // Step 3: Return compiled package
  return {
    resolvedFlow: {
      schema_version: pkg.flow.schema_version,
      steps: pkg.flow.steps,
      provenance: `package:${pkg.packageId}@${pkg.packageVersion} (${pkg.packageDir})`,
    },
    roleRegistry,
    packageDir: pkg.packageDir,
    packageId: pkg.packageId,
    packageVersion: pkg.packageVersion,
  };
}

// ── Compiled Package Emission ────────────────────────────────────────

/**
 * Writes a compiled flow package to disk as YAML files.
 *
 * Emits three files into `destDir`:
 * - `package.yaml` — compiled metadata with `derived_from` provenance
 * - `flow.yaml` — flow steps with fully substituted tasks (no `{task}` placeholders)
 * - `roles.yaml` — resolved roles with model overrides applied
 *
 * This is used after blueprint compilation to produce a self-describing
 * flow package in the execution directory, so analyzers and resume logic
 * see the compiled content, not the template source.
 *
 * @param compiledPkg - The compiled flow package to emit.
 * @param destDir - Absolute path to the target directory.
 * @returns A promise that resolves when all files are written.
 * @throws If any file write fails.
 */
export async function emitCompiledFlowPackage(
  compiledPkg: CompiledFlowPackage,
  destDir: string,
): Promise<void> {
  // Ensure the destination directory exists
  await mkdir(destDir, { recursive: true });

  // ── package.yaml ─────────────────────────────────────────────────
  const packageYaml: Record<string, unknown> = {
    schema_version: "0.1.0",
    package: {
      id: compiledPkg.packageId,
      version: compiledPkg.packageVersion,
      type: "flow",
      name: compiledPkg.packageId,
    },
  };
  if (compiledPkg.derivedFrom) {
    packageYaml["derived_from"] = compiledPkg.derivedFrom;
  }

  await writeFile(
    join(destDir, "package.yaml"),
    stringify(packageYaml),
    "utf-8",
  );

  // ── flow.yaml ─────────────────────────────────────────────────────
  const flowYaml = {
    schema_version: compiledPkg.resolvedFlow.schema_version,
    steps: compiledPkg.resolvedFlow.steps.map((s) => ({
      id: s.id,
      role: s.role,
      task: s.task,
      ...(s.when ? { when: s.when } : {}),
      ...(s.context ? { context: s.context } : {}),
      ...(s.tools ? { tools: s.tools } : {}),
    })),
  };

  await writeFile(
    join(destDir, "flow.yaml"),
    stringify(flowYaml),
    "utf-8",
  );

  // ── roles.yaml ────────────────────────────────────────────────────
  const roles: Record<string, { prompt_template: string; context_budget: number; llm_id: string | null }> = {};
  for (const [name, def] of compiledPkg.roleRegistry.roles) {
    roles[name] = {
      prompt_template: def.prompt_template,
      context_budget: def.context_budget,
      llm_id: def.llm_id,
    };
  }

  const rolesYaml = {
    schema_version: "0.3.0",
    model_defaults: {
      default_llm_id: compiledPkg.roleRegistry.defaultModel,
    },
    roles,
  };

  await writeFile(
    join(destDir, "roles.yaml"),
    stringify(rolesYaml),
    "utf-8",
  );
}
