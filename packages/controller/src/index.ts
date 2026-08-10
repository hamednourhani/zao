/**
 * @zao/controller — orchestration layer for the mo platform.
 *
 * Public entry point. Exports:
 * - Role registry (resolveRole, generateOrchestrationSpec, etc.)
 * - Flow loader types & parseWhenExpression
 * - Flow package system (loadFlowPackage, compileFlowPackage, etc.)
 * - Execution store (initExecution, readExecutionManifest, etc.)
 * - Execution runner (execute, HarnessClient, MockHarnessClient, etc.)
 * - Harness client (DefaultHarnessClient)
 * - Execution resume (resumeExecution, buildResumeExecuteParams)
 */

// Role registry (TD-029-A, R-006A cleaned)
export {
  resolveRole,
  generateOrchestrationSpec,
  UnknownRoleError,
  OrchestrationSpecSchema,
} from "./role-registry.ts";
export type { RoleRegistry, OrchestrationSpec } from "./role-registry.ts";

export type { ResolvedRoleDefinition } from "./schemas/role-definition.ts";

// Flow loader (types + parseWhenExpression only — R-006A cleaned)
export { parseWhenExpression, FlowSchema, FlowStepSchema, FlowAggregateResultSchema } from "./flow-loader.ts";
export type { Flow, FlowStep, ResolvedFlow, FlowAggregateResult } from "./flow-loader.ts";

// Flow package system (R-006A)
export {
  loadFlowPackage,
  PackageMetadataSchema,
  resolveFlowPackage,
  resolveAndCompileFlowPackage,
  compileFlowPackage,
  snapshotCompiledPackage,
  deserializeCompiledPackage,
  extractPackageSnapshotFromSpec,
} from "./flow-package/index.ts";
export type {
  LoadedFlowPackage,
  PackageMetadata,
  CompiledFlowPackage,
  FlowPackageSnapshot,
} from "./flow-package/index.ts";

// Execution store
export {
  initExecution,
  readExecutionManifest,
  writeExecutionManifest,
  appendExecutionIndexLine,
  readExecutionIndex,
  appendExecutionEvent,
  resolveExecutionStoreRoot,
} from "./execution-store.ts";
export type {
  ExecutionManifest,
  ExecutionIndexLine,
  ExecutionEvent,
  InitExecutionParams,
} from "./execution-store.ts";

// Execution runner (TD-029-C, R-006A rewired)
export {
  execute,
  MockHarnessClient,
} from "./execution-runner.ts";
export type {
  ExecuteParams,
  ExecutionResult,
  HarnessClient,
  ResumeContext,
  MockHarnessJobResponse,
} from "./execution-runner.ts";

// Harness client (TD-029-DE)
export { DefaultHarnessClient } from "./harness-client.ts";

// Execution resume (TD-029-DE, R-006A rewired)
export {
  resumeExecution,
  buildResumeExecuteParams,
} from "./execution-resume.ts";
export type {
  ResumeExecutionOptions,
  ResumeExecutionResult,
} from "./execution-resume.ts";
