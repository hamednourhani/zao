# contracts API Reference

Shared Zod schemas — the single source of truth for all inter-package contracts.

## Session Manifest Schema

```typescript
import { ParentManifestSchema, ChildManifestSchema } from "@zao/contracts";

// Parent (root) session manifest
const ParentManifestSchema = z.object({
  schema_version: z.literal("0.2.0"),
  session_id: z.string(),
  parent_session_id: z.null(),
  created_at: z.string(),
  updated_at: z.string(),
  status: SessionStatusEnum,  // "active" | "complete" | "failed" | "interrupted"
  task: z.string(),
  role: z.string(),
  model_config: ModelConfigSchema,
  repo_root: z.string().nullable(),
  repo_remote: z.string().nullable(),
  braned_from: BranchedFromSchema.nullable(),
  resume_count: z.number(),
  compaction_history: z.array(z.unknown()),
});

// BranchedFrom
const BranchedFromSchema = z.object({
  session_id: z.string(),
  checkpoint_id: z.string().nullable(),
});
```

## Event Log Schema

```typescript
import { EventLogEntrySchema } from "@zao/contracts";

const EventLogEntrySchema = z.object({
  schema_version: z.literal("0.2.0"),
  event_id: z.string(),
  session_id: z.string(),
  parent_session_id: z.string().nullable(),
  timestamp: z.string(),
  agent_role: z.string(),
  model_id: z.string(),
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  cache_hit: z.boolean(),
  action: z.string(),
});
```

## Session Index Schema

```typescript
import {
  GlobalIndexCreateEntrySchema,
  GlobalIndexCompleteEntrySchema,
  AgentsIndexEntrySchema,
} from "@zao/contracts";

// Creation line (appended when session starts)
const create = {
  session_id: "uuidv7",
  created_at: "2026-01-01T00:00:00Z",
  status: "active",
  branched_from: null,  // or BranchedFrom object
};

// Completion line (appended when session ends)
const complete = {
  session_id: "uuidv7",
  completed_at: "2026-01-01T01:00:00Z",
  status: "complete",
  agents_spawned: 3,
  models: ["deepseek-chat"],
  tokens: { prompt: 1000, completion: 500 },
};
```

## Blueprint Schema

```typescript
import { BlueprintSchema, BlueprintStepSchema } from "@zao/contracts";
// Re-exported from @zao/blueprint
```

## Role Definition Schema

```typescript
import { ResolvedRoleDefinitionSchema } from "@zao/contracts";

const ResolvedRoleDefinitionSchema = z.object({
  prompt_template: z.string(),
  context_budget: z.number(),
  model: z.string(),
  llm_id: z.string(),
  provenance: z.string(),
  model_provenance: z.string(),
});
```
