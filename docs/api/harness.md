# harness API Reference

The harness is the single-job LLM execution engine. It manages sessions, token budgets, compaction, and tool execution.

## CLI Commands

```bash
zao run [--yes] [--role <name>] <task>
zao continue <session_id> [--yes] [--recent-events N]
zao branch <session_id> [--from-checkpoint <id>]
zao session list [--status ...] [--repo ...] [--since ...] [--limit N]
zao session show <session_id> [--format json]
zao session tree <session_id>
```

## Core Exports

### Session Lifecycle

```typescript
// Initialize a new session (root or child)
import { initSession } from "@zao/harness";

const { sessionDir, sessionId, isRoot } = await initSession({
  role: "developer",
  taskSummary: "Fix the login bug",
  parentSessionDir?: string,  // for child sessions
  nodeId?: string,
  modelId?: string,
  projectDir?: string,
});
```

### Session Branching

```typescript
// Create a peer branch from an existing session
import { branchSession } from "@zao/harness";

const branchId = await branchSession(sourceSessionId, {
  fromCheckpoint?: string,  // optional checkpoint id
});
```

### Automatic Checkpoints

```typescript
// Checkpoint manager for automatic periodic checkpoints
import { CheckpointManager } from "@zao/harness";

const manager = new CheckpointManager(sessionDir, {
  interval_events: 50,       // events between checkpoints
  interval_minutes: 30,      // minutes between checkpoints
  retention_count: 5,        // max checkpoints to retain
});

// Call after each event to trigger checkpoint if threshold met
await manager.maybeCheckpoint(eventCount);
```

### Context Compaction

```typescript
// Strategy selection for context compaction
import {
  AbstractiveStrategy,
  ExtractiveStrategy,
  HierarchicalStrategy,
  resolveCompactionStrategy,
} from "@zao/harness";

const strategy = resolveCompactionStrategy("extractive-events", generateFn);
const result = await strategy.compact({
  task: "Fix the bug",
  role: "developer",
  contextWindow: 128000,
  estimatedTokens: 100000,
  threshold: 0.65,
  events: [...],
});
```

### Compaction Fallback

```typescript
import { FallbackStrategy, applyFallback } from "@zao/harness";

const result = applyFallback(
  FallbackStrategy.Truncate,
  eventCount,
  "LLM rate limit exceeded",
);
// result.shouldContinue, result.requiresHitl, result.hitlQuestion
```

### Configuration

```yaml
# .zao/config.yaml
temperature: 0.1
max_tokens: 4096
context_window: 128000
compaction_threshold: 0.65
compaction_strategy: abstractive-llm
compaction_fallback: halt
checkpoint_interval_events: 50
checkpoint_interval_minutes: 30
checkpoint_retention_count: 5
tokenizer: auto
```

### Token Estimation

```typescript
import { estimateTokens, TokenEstimator } from "@zao/harness";

const tokens = estimateTokens("Hello world", "openai", "gpt-4o");
```

### Event Logging

```typescript
import { appendEvent, readEvents } from "@zao/harness";

await appendEvent(sessionDir, {
  schema_version: "0.2.0",
  event_id: generateSessionId(),
  session_id: sessionId,
  parent_session_id: null,
  timestamp: new Date().toISOString(),
  agent_role: "developer",
  model_id: "deepseek-chat",
  prompt_tokens: 150,
  completion_tokens: 50,
  cache_hit: false,
  action: "task_complete",
});
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Run failed (LLM error) |
| 2 | Usage error (bad flags, missing task) |
| 3 | Validation error (unknown session) |
