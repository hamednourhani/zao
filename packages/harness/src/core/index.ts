/**
 * Barrel export for all mo core modules.
 *
 * @module core
 */

export {
  logger,
  type LogLevel,
} from "./logger.ts";

export {
  progress,
  type ProgressState,
  type ProgressPhase,
} from "./progress.ts";

export { boot, type BootOptions } from "./boot.ts";

export { isClackAvailable, showClackPrompt, type ClackResult } from "./clack-hitl.ts";

export {
  generateStructuredResponse,
  type ModelOptions,
  type StructuredResult,
  type StructuredResultSuccess,
  type StructuredResultFailure,
} from "./llm.ts";

export {
  writeArtifact,
  readArtifact,
  appendEvent,
  initSession,
  redactSecrets,
  readEvents,
  type ArtifactReadResult,
  type ArtifactReadSuccess,
  type ArtifactReadFailure,
  type ReadEventsResult,
  type ReadEventsTruncatedResult,
  type ReadEventsFailure,
} from "./artifacts.ts";

export {
  buildContext,
  type ContextModelConfig,
  type ContextRoleDef,
  type BuildContextParams,
  type BuildContextResult,
} from "./context.ts";

export {
  delegateToSubagent,
  readDelegationResult,
} from "./delegation.ts";

export {
  loadConfig,
  type LoopConfig,
} from "./config.ts";

export {
  runLoop,
  type RunLoopParams,
  type RunLoopResult,
} from "./loop.ts";

export {
  classifyCommand,
  sanitizeTerminalString,
  deriveCommandClass,
  TrustTier,
  type ClassificationVerdict,
  type ClassificationContext,
} from "./command-guard.ts";

export {
  promptForPermission,
  formatPermissionPrompt,
  PermissionSession,
  HITLResponse,
  type HITLContext,
  type HITLResult,
  type InputReader,
} from "./hitl.ts";

export {
  executeTool,
  executeShell,
  readFile,
  writeFile,
  type ToolResult,
  type ExecutorConfig,
} from "./executor.ts";

export {
  resolveContextWindow,
  type ModelMetadata,
} from "./model-registry.ts";

export {
  computeUnifiedDiff,
  renderDiffForTerminal,
  capDiff,
} from "./diff-renderer.ts";

export {
  ContextCompactionNeeded,
  detectCompactionNeed,
  runCompactionFlow,
  buildCompactionPrompt,
  type CompactionParams,
  type CompactionHITLDetails,
  type CompactorGenerateFn,
  type CompactionHITLPrompter,
  type CompactorResponse,
} from "./compaction.ts";
