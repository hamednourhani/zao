/**
 * Blueprint Compiler — compiles a blueprint package + user task into a
 * concrete flow package structure.
 *
 * ## Compilation steps
 *
 * 1. Validate blueprint semantics (duplicate ids, when refs, role existence,
 *    loop targets)
 * 2. Substitute `{task}` placeholders in `task_template` → `task`
 * 3. Map `context_spec` → flow step `context`
 * 4. Build a concrete flow definition with compiled steps
 * 5. Return a CompiledBlueprint ready for controller integration
 *
 * ## Fail-closed
 *
 * - Missing `{task}` in a task_template → error
 * - Invalid when expressions → error (validated against earlier steps)
 * - Unknown role references → error
 * - Loop target referencing nonexistent steps → error
 * - All errors throw before any flow package is generated
 *
 * ## Zero LLM calls
 *
 * Compilation is pure template substitution + structural validation.
 *
 * @module blueprint-compiler
 */

import type { LoadedBlueprintPackage } from "./blueprint-loader.ts";
import type { Blueprint, BlueprintStep } from "./schemas.ts";
import type { RolesFile } from "./schemas.ts";
import { parseWhenExpression } from "./when-parser.ts";

// ── Compiled Blueprint ──────────────────────────────────────────────

/**
 * The result of compiling a blueprint package with a user task.
 *
 * Contains a concrete flow definition with all `{task}` placeholders
 * substituted, ready to be loaded as a flow package by the controller.
 */
export interface CompiledBlueprint {
  /** The concrete flow definition produced by compilation. */
    flow: {
      schema_version: string;
      steps: Array<{
        id: string;
        role: string;
        /** The concrete task after `{task}` substitution (REQUIRED). */
        task: string;
        /** The optional static context for this step. */
        context?: string;
        /** Optional receive_from from context_spec (R-010). */
        receive_from?: string[];
        when?: string;
        /** Optional tool declarations inherited from the blueprint step (R-009). */
        tools?: import("./schemas.ts").ToolDeclaration[];
        /** Optional loop configuration (R-010). */
        loop?: import("./schemas.ts").LoopConfig;
        /** Optional output specification (R-010). */
        output_spec?: import("./schemas.ts").OutputSpec;
      }>;
    };
  /** The role definitions from the blueprint (unchanged). */
  roles: RolesFile;
  /** The blueprint package identifier. */
  blueprintId: string;
  /** The blueprint package version. */
  blueprintVersion: string;
  /** The absolute path to the blueprint package directory. */
  blueprintDir: string;
  /** The raw task string provided by the user. */
  userTask: string;
}

// ── Template Substitution ───────────────────────────────────────────

/**
 * Substitutes `{task}` in a `task_template` string with the user's task.
 *
 * ## Safety
 *
 * - Only `{task}` is recognized as a placeholder
 * - Templates containing `{eval`, `{exec`, or other dangerous patterns
 *   are rejected with a typed error (never passed to the LLM)
 * - The user task itself is checked with the SAME dangerous-pattern
 *   regex (defense-in-depth: it is substituted verbatim into every
 *   step task, so it must not smuggle patterns past the template check)
 * - A user task containing the literal `{task}` placeholder is rejected:
 *   `replaceAll` would otherwise re-substitute it and produce a
 *   misleading double-substituted prompt
 * - Multiple occurrences of `{task}` are all replaced
 *
 * @param template - The task_template string from the blueprint step.
 * @param userTask - The user's command-line task string.
 * @returns The substituted concrete task.
 * @throws If the template or user task contains forbidden patterns.
 */
function substituteTask(template: string, userTask: string): string {
  // Fail-closed: reject dangerous patterns.
  // Word-boundary matching prevents false positives on safe substrings
  // (e.g., "requires_actions" contains "require" but is safe; "\brequire\b"
  // only matches standalone "require" like "require('fs')").
  // Double-underscore, constructor, and prototype are always dangerous
  // regardless of position, so they stay as substring matches.
  const dangerous = /(?:\beval\b|\bexec\b|\brequire\b|\bimport\b|\bprocess\b|\bglobal\b|\bwindow\b|__|constructor|prototype)/i;
  if (dangerous.test(template)) {
    throw new Error(
      `Blueprint task_template contains forbidden patterns: "${template}". ` +
        "Only {task} substitution is supported.",
    );
  }

  // Defense-in-depth: the user task is inserted verbatim into every
  // compiled step task. Apply the same check so a crafted task cannot
  // smuggle forbidden patterns past the template-level validation.
  if (dangerous.test(userTask)) {
    throw new Error(
      "User task contains forbidden patterns. " +
        "Only plain text task descriptions are supported.",
    );
  }

  // A user task containing the literal {task} placeholder would collide
  // with the substitution: the inserted text would itself be substituted
  // again on a recompile, producing a confusing double-substituted prompt.
  // Reject it clearly instead of guessing intent.
  if (userTask.includes("{task}")) {
    throw new Error(
      'User task must not contain the literal "{task}" placeholder. ' +
        "Only plain text task descriptions are supported.",
    );
  }

  if (!template.includes("{task}")) {
    throw new Error(
      `Blueprint task_template must contain the {task} placeholder: "${template}". ` +
        "Add {task} where the user's task should be inserted.",
    );
  }

  return template.replaceAll("{task}", userTask);
}

// ── Semantic Validation ─────────────────────────────────────────────

/**
 * Validates the semantic rules of a blueprint after schema parsing:
 *
 * 1. No duplicate step `id` values.
 * 2. All `when` references point to existing, EARLIER steps.
 * 3. All `{task}` templates contain the placeholder.
 *
 * @param blueprint - The parsed (schema-valid) blueprint to check.
 * @param blueprintId - The blueprint identifier for error messages.
 * @throws If any semantic rule is violated.
 */
function validateBlueprintSemantics(
  blueprint: Blueprint,
  blueprintId: string,
): void {
  // Check 1: Duplicate ids
  const seenIds = new Set<string>();
  for (const step of blueprint.steps) {
    if (seenIds.has(step.id)) {
      throw new Error(
        `Duplicate step id "${step.id}" in blueprint "${blueprintId}". ` +
          "Each step id must be unique.",
      );
    }
    seenIds.add(step.id);
  }

  // Check 2: when references
  const stepIds = new Set(blueprint.steps.map((s) => s.id));

  for (let i = 0; i < blueprint.steps.length; i++) {
    const step = blueprint.steps[i]!;
    if (!step.when) continue;

    const parsed = parseWhenExpression(step.when);

    if (!parsed) {
      throw new Error(
        `Step "${step.id}" has invalid when expression: "${step.when}". ` +
          `Expected format: "<step-id>.status == \"success\"" or ` +
          `"<step-id>.status == \"failed\"" (blueprint "${blueprintId}").`,
      );
    }

    const { refId } = parsed;

    if (!stepIds.has(refId)) {
      throw new Error(
        `Step "${step.id}" references unknown step "${refId}" in when: "${step.when}". ` +
          `Available steps: ${[...stepIds].join(", ") || "(none)"} (blueprint "${blueprintId}").`,
      );
    }

    const refIndex = blueprint.steps.findIndex((s) => s.id === refId);
    if (refIndex >= i) {
      throw new Error(
        `Step "${step.id}" references step "${refId}" in when, ` +
          `but "${refId}" is at position ${refIndex} while "${step.id}" is at position ${i}. ` +
          `when can only reference earlier steps (blueprint "${blueprintId}").`,
      );
    }
  }

  // Check 3: All task_templates contain {task}
  for (const step of blueprint.steps) {
    if (!step.task_template.includes("{task}")) {
      throw new Error(
        `Step "${step.id}" task_template must contain the {task} placeholder. ` +
          `Found: "${step.task_template}" (blueprint "${blueprintId}").`,
      );
    }
  }

  // Check 4: Loop target validation (R-010)
  for (let i = 0; i < blueprint.steps.length; i++) {
    const step = blueprint.steps[i]!;
    if (!step.loop) continue;

    const { target } = step.loop;

    // Loop target must reference an existing step in the SAME flow
    if (!stepIds.has(target)) {
      throw new Error(
        `Step "${step.id}" has loop.target "${target}" which does not exist ` +
          `in blueprint "${blueprintId}". ` +
          `Available steps: ${[...stepIds].join(", ") || "(none)"}.`,
      );
    }

    // Loop target must be at or before the loop step (cannot jump forward)
    const targetIndex = blueprint.steps.findIndex((s) => s.id === target);
    if (targetIndex > i) {
      throw new Error(
        `Step "${step.id}" has loop.target "${target}" at position ${targetIndex}, ` +
          `but "${step.id}" is at position ${i}. ` +
          `Loop target must be the loop step itself or an earlier step ` +
          `(blueprint "${blueprintId}").`,
      );
    }
  }

  // Check 5: Validate receive_from references (H-002 fix)
  for (const step of blueprint.steps) {
    const contextSpec = step.context_spec;
    if (!contextSpec) continue;

    // receive_from exists only on object-style context_spec
    if (typeof contextSpec === "string") continue;

    const receiveFrom = contextSpec.receive_from;
    if (!receiveFrom || !Array.isArray(receiveFrom)) continue;

    for (const ref of receiveFrom) {
      // receive_from format: "step_id.field" — extract step_id
      const refStepId = ref.split(".")[0];
      if (!refStepId || !stepIds.has(refStepId)) {
        throw new Error(
          `Step "${step.id}": receive_from references unknown step "${refStepId ?? "(empty)"}". ` +
            `Valid steps: ${[...stepIds].join(", ") || "(none)"} (blueprint "${blueprintId}").`,
        );
      }
    }
  }
}

// ── Role Validation ──────────────────────────────────────────────────

/**
 * Validates that all roles referenced by blueprint steps exist in the
 * given roles file.
 *
 * @param blueprint - The parsed blueprint.
 * @param roles - The roles file from the blueprint package.
 * @param blueprintId - The blueprint identifier for error messages.
 * @throws If any referenced role is not found.
 */
function validateRoleReferences(
  blueprint: Blueprint,
  roles: RolesFile,
  blueprintId: string,
): void {
  for (const step of blueprint.steps) {
    if (!(step.role in roles.roles)) {
      throw new Error(
        `Step "${step.id}" references unknown role "${step.role}" ` +
          `(blueprint "${blueprintId}"). ` +
          `Available roles: ${Object.keys(roles.roles).join(", ") || "(none)"}.`,
      );
    }
  }
}

// ── Core Compiler ────────────────────────────────────────────────────

/**
 * Compiles a loaded blueprint package + user task into a
 * {@link CompiledBlueprint}.
 *
 * ## Compilation steps
 *
 * 1. Validate blueprint semantics (duplicates, when refs, {task} required)
 * 2. Validate all role references
 * 3. Substitute `{task}` placeholders in every `task_template`
 * 4. Build concrete flow steps with `task`, `context`, and `when`
 * 5. Return the compiled blueprint
 *
 * ## Fail-closed
 *
 * Any validation or substitution failure throws an error. No partial
 * output is produced. No flow package is generated.
 *
 * @param pkg - The loaded blueprint package to compile.
 * @param userTask - The user's task string for `{task}` substitution.
 * @returns A compiled blueprint ready for flow package generation.
 */
export function compileBlueprint(
  pkg: LoadedBlueprintPackage,
  userTask: string,
): CompiledBlueprint {
  // Step 1: Validate blueprint semantics
  validateBlueprintSemantics(pkg.blueprint, pkg.packageId);

  // Step 2: Validate role references
  validateRoleReferences(pkg.blueprint, pkg.roles, pkg.packageId);

  // Step 3-4: Substitute {task} and build concrete flow steps
  const compiledSteps = pkg.blueprint.steps.map((step: BlueprintStep) => {
    const concreteTask = substituteTask(step.task_template, userTask);

    // Resolve context_spec: string → context; object → context + receive_from
    let context: string | undefined;
    let receive_from: string[] | undefined;
    if (step.context_spec) {
      if (typeof step.context_spec === "string") {
        context = step.context_spec;
      } else {
        context = step.context_spec.text;
        receive_from = step.context_spec.receive_from;
      }
    }

    return {
      id: step.id,
      role: step.role,
      task: concreteTask,
      context,
      receive_from, // R-010: passthrough from context_spec object
      when: step.when,
      tools: step.tools, // R-009: copy tools unchanged from blueprint to flow
      loop: step.loop, // R-010: copy loop config to compiled step
      output_spec: step.output_spec, // R-010: copy output_spec to compiled step
    };
  });

  // Step 5: Return compiled blueprint
  return {
    flow: {
      schema_version: "0.2.0" as const,
      steps: compiledSteps,
    },
    roles: pkg.roles,
    blueprintId: pkg.packageId,
    blueprintVersion: pkg.packageVersion,
    blueprintDir: pkg.packageDir,
    userTask,
  };
}
