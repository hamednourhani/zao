/**
 * Blueprint Package — advisory-plane compiler.
 *
 * Compiles blueprint packages (parameterized development-process templates)
 * into self-contained flow packages that the controller can execute.
 *
 * ## Exports
 *
 * - {@link loadBlueprintPackage} / {@link LoadedBlueprintPackage} — load + validate
 * - {@link resolveBlueprintPackage} — resolve by ID with path-traversal hardening
 * - {@link compileBlueprint} / {@link CompiledBlueprint} — compile to flow package
 * - {@link parseWhenExpression} — v1 `when` expression grammar parser
 * - All schemas: {@link BlueprintSchema}, {@link BlueprintStepSchema},
 *   {@link BlueprintPackageMetadataSchema}, {@link RolesFileSchema}
 *
 * @module blueprint
 */

export {
  loadBlueprintPackage,
} from "./blueprint-loader.ts";
export type { LoadedBlueprintPackage } from "./blueprint-loader.ts";

export {
  resolveBlueprintPackage,
} from "./blueprint-registry.ts";

export {
  compileBlueprint,
} from "./blueprint-compiler.ts";
export type { CompiledBlueprint } from "./blueprint-compiler.ts";

export { parseWhenExpression } from "./when-parser.ts";

export {
  BlueprintSchema,
  BlueprintStepSchema,
  BlueprintPackageMetadataSchema,
  RolesFileSchema,
  ToolDeclarationSchema,
  VALID_TOOL_NAMES,
} from "./schemas.ts";
export type {
  Blueprint,
  BlueprintStep,
  BlueprintPackageMetadata,
  RolesFile,
  RoleDefinition,
  CompiledStep,
  ToolDeclaration,
  ValidToolName,
} from "./schemas.ts";
