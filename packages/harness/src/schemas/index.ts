/**
 * Barrel export for all zao schema contracts.
 *
 * Each module exports both the Zod schema (for runtime validation) and
 * the inferred TypeScript type (for compile-time safety).
 *
 * @module schemas
 */

export {
  HandoffRequestSchema,
  type HandoffRequest,
  HandoffResponseSchema,
  type HandoffResponse,
  ProvenanceSchema,
  type Provenance,
  ResultArtifactSchema,
  type ResultArtifact,
} from "./handoff.ts";

export {
  ToolExecutionRequestSchema,
  type ToolExecutionRequest,
} from "./tool-execution.ts";

export {
  MemoryStateSchema,
  type MemoryState,
  PhaseEntrySchema,
  type PhaseEntry,
} from "./memory.ts";

export {
  EventLogEntrySchema,
  type EventLogEntry,
} from "./event-log.ts";

export {
  ResolvedRoleDefinitionSchema,
  type ResolvedRoleDefinition,
  renderPromptTemplate,
} from "./role-definition.ts";

export type { RoleRegistry } from "./role-definition.ts";

export {
  SessionConfigSchema,
  type SessionConfig,
} from "./session-config.ts";

export {
  FlowStepSchema,
  type FlowStep,
  FlowSchema,
  type Flow,
  type ResolvedFlow,
} from "./flow.ts";

export {
  ToolCallSchema,
  type ToolCall,
  HandoffWithToolsSchema,
  type HandoffWithTools,
  TOOL_NAMES,
} from "./tool-call.ts";
