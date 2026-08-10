/**
 * Flow Package System — self-contained flow + role definitions.
 *
 * Replaces the multi-layer config resolution (loadFlow + loadRoleRegistry)
 * with a package-based model. Each flow package bundles its own flow
 * definition and role definitions into a single directory.
 *
 * ## Exports
 *
 * - {@link loadFlowPackage} / {@link LoadedFlowPackage} — load a package from disk
 * - {@link resolveFlowPackage} / {@link resolveAndCompileFlowPackage} — resolve by ID
 * - {@link compileFlowPackage} / {@link CompiledFlowPackage} — compile for execution
 * - {@link snapshotCompiledPackage} / {@link deserializeCompiledPackage} — snapshot serialization
 * - {@link extractPackageSnapshotFromSpec} / {@link FlowPackageSnapshot} — legacy snapshot compat
 * - {@link PackageMetadataSchema} / {@link PackageMetadata} — package.yaml schema
 *
 * @module flow-package
 */

export {
  loadFlowPackage,
  PackageMetadataSchema,
} from "./package-loader.ts";
export type { LoadedFlowPackage, PackageMetadata } from "./package-loader.ts";

export {
  resolveFlowPackage,
  resolveAndCompileFlowPackage,
} from "./package-registry.ts";

export {
  compileFlowPackage,
  validateCompiledPackageSemantics,
  emitCompiledFlowPackage,
} from "./package-compiler.ts";
export type { CompiledFlowPackage } from "./package-compiler.ts";

export {
  snapshotCompiledPackage,
  deserializeCompiledPackage,
  extractPackageSnapshotFromSpec,
  copyPackageToExecutionDir,
} from "./package-snapshot.ts";
export type { FlowPackageSnapshot } from "./package-snapshot.ts";
