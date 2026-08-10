/**
 * Blueprint Loader — loads a blueprint package from a directory on disk.
 *
 * A blueprint package is a self-contained directory containing:
 * - `package.yaml` — metadata (id, version, type="blueprint")
 * - `blueprint.yaml` — parameterized blueprint steps with `{task}` templates
 * - `roles.yaml` — role definitions for the blueprint's steps
 *
 * ## Validation (fail-closed)
 *
 * - Invalid YAML → error
 * - Schema violations → error
 * - Missing required files → error
 * - `blueprint_id` must match `package.id` → error
 * - All files must validate before a LoadedBlueprintPackage is returned
 *
 * ## Zero LLM calls
 *
 * All validation is structural and performed at load time.
 *
 * @module blueprint-loader
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  BlueprintSchema,
  type Blueprint,
  BlueprintPackageMetadataSchema,
  RolesFileSchema,
  type RolesFile,
} from "./schemas.ts";

// ── Loaded Blueprint Package ────────────────────────────────────────

/**
 * A fully loaded and validated blueprint package from disk.
 * All three files have been parsed and validated against schemas.
 */
export interface LoadedBlueprintPackage {
  /** Package identifier from package.yaml. */
  packageId: string;
  /** Package version from package.yaml. */
  packageVersion: string;
  /** Absolute path to the package directory. */
  packageDir: string;
  /** The parsed and validated blueprint definition. */
  blueprint: Blueprint;
  /** The parsed and validated role definitions. */
  roles: RolesFile;
  /** Raw parsed blueprint object (for provenance). */
  rawBlueprint: Record<string, unknown>;
  /** Raw parsed roles object (for provenance). */
  rawRoles: Record<string, unknown>;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Parses a raw YAML string using the `yaml` library.
 */
function parseYamlSafe(raw: string): unknown {
  return parseYaml(raw);
}

/**
 * Reads a file and parses it as YAML, validating against a Zod schema.
 *
 * @param filePath - Absolute path to the file.
 * @param schema - Zod schema to validate against.
 * @param label - Human-readable label for error messages.
 * @returns The validated data.
 * @throws If the file is missing, invalid YAML, or fails schema validation.
 */
async function readAndValidate<T>(
  filePath: string,
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to read ${label} from "${filePath}": ${message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYamlSafe(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid YAML in ${label} at "${filePath}": ${message}`,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Schema validation failed for ${label} at "${filePath}": ${result.error.message}`,
    );
  }

  return result.data;
}

// ── Core Loader ─────────────────────────────────────────────────────

/**
 * Loads a blueprint package from a directory on disk.
 *
 * Reads and validates `package.yaml`, `blueprint.yaml`, and `roles.yaml`
 * from the given directory. All three files must exist and validate
 * before a `LoadedBlueprintPackage` is returned.
 *
 * ## Cross-file validation
 *
 * The `blueprint_id` in `blueprint.yaml` must match the `package.id`
 * in `package.yaml`. This prevents copy-paste errors where a blueprint
 * claims to be one package but carries a different identifier.
 *
 * ## Fail-closed
 *
 * - Missing files → error (names the missing file)
 * - Invalid YAML → error (with file path and parse error)
 * - Schema violations → error (with field paths)
 * - blueprint_id mismatch → error
 *
 * @param packageDir - Absolute path to the package directory.
 * @returns A fully loaded and validated blueprint package.
 */
export async function loadBlueprintPackage(
  packageDir: string,
): Promise<LoadedBlueprintPackage> {
  // Load metadata
  const metadata = await readAndValidate(
    join(packageDir, "package.yaml"),
    BlueprintPackageMetadataSchema,
    "package metadata",
  );

  // Load blueprint
  const blueprint = await readAndValidate(
    join(packageDir, "blueprint.yaml"),
    BlueprintSchema,
    "blueprint definition",
  );

  // Cross-file validation: blueprint_id must match package.id
  if (blueprint.blueprint_id !== metadata.package.id) {
    throw new Error(
      `Blueprint id mismatch: blueprint.yaml has blueprint_id "${
        blueprint.blueprint_id
      }" but package.yaml has package.id "${
        metadata.package.id
      }". These must match.`,
    );
  }

  // Load roles (raw for snapshot, validated for type safety)
  const rolesRaw = await readAndValidate(
    join(packageDir, "roles.yaml"),
    z.unknown(),
    "role definitions",
  );
  const roles = RolesFileSchema.parse(rolesRaw);

  return {
    packageId: metadata.package.id,
    packageVersion: metadata.package.version,
    packageDir,
    blueprint,
    roles,
    rawBlueprint: blueprint as unknown as Record<string, unknown>,
    rawRoles: rolesRaw as Record<string, unknown>,
  };
}
