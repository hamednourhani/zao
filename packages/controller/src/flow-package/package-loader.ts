/**
 * Flow Package Loader — loads a flow package from a directory on disk.
 *
 * A flow package is a self-contained directory containing:
 * - `package.yaml` — metadata (id, version, description)
 * - `flow.yaml` — flow definition (steps, roles, gates)
 * - `roles.yaml` — role definitions for the flow
 *
 * ## Validation (fail-closed)
 *
 * - Invalid YAML → error
 * - Schema violations → error
 * - Missing required files → error
 * - All three files must validate before a LoadedFlowPackage is returned
 *
 * ## Zero LLM calls
 *
 * All validation is structural and performed at load time before any
 * execution begins.
 *
 * @module package-loader
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { FlowSchema, type Flow } from "../schemas/flow.ts";
import { RolesFileSchema, type RolesFile } from "../schemas/role-definition.ts";

// ── Package Metadata Schema ────────────────────────────────────────

/** Schema for the `package.yaml` metadata file. */
export const PackageMetadataSchema = z.object({
  schema_version: z.literal("0.1.0"),
  package: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    type: z.literal("flow"),
    name: z.string().min(1),
    description: z.string().optional(),
  }).strict(),
}).strict();

export type PackageMetadata = z.infer<typeof PackageMetadataSchema>;

// ── Loaded Flow Package ────────────────────────────────────────────

/**
 * A fully loaded and validated flow package from disk.
 * All three files have been parsed and validated against schemas.
 */
export interface LoadedFlowPackage {
  /** Package identifier from package.yaml. */
  packageId: string;
  /** Package version from package.yaml. */
  packageVersion: string;
  /** Absolute path to the package directory. */
  packageDir: string;
  /** The parsed and validated flow definition. */
  flow: Flow;
  /** The parsed and validated role definitions. */
  roles: RolesFile;
  /** Raw parsed flow object (for snapshot serialization). */
  rawFlow: Record<string, unknown>;
  /** Raw parsed roles object (for snapshot serialization). */
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
 * Loads a flow package from a directory on disk.
 *
 * Reads and validates `package.yaml`, `flow.yaml`, and `roles.yaml`
 * from the given directory. All three files must exist and validate
 * before a `LoadedFlowPackage` is returned.
 *
 * ## Fail-closed
 *
 * - Missing files → error (names the missing file)
 * - Invalid YAML → error (with file path and parse error)
 * - Schema violations → error (with field paths)
 *
 * @param packageDir - Absolute path to the package directory.
 * @returns A fully loaded and validated flow package.
 */
export async function loadFlowPackage(
  packageDir: string,
): Promise<LoadedFlowPackage> {
  // Load metadata
  const metadata = await readAndValidate(
    join(packageDir, "package.yaml"),
    PackageMetadataSchema,
    "package metadata",
  );

  // Load flow
  const flow = await readAndValidate(
    join(packageDir, "flow.yaml"),
    FlowSchema,
    "flow definition",
  );

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
    flow,
    roles,
    rawFlow: flow as unknown as Record<string, unknown>,
    rawRoles: rolesRaw as Record<string, unknown>,
  };
}
