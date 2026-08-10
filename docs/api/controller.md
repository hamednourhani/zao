# controller API Reference

The controller orchestrates multi-step flows by loading blueprints and dispatching steps to the harness.

## CLI Commands

```bash
zao run --flow <package-id|path> [--task <task>] [--yes] [--verbose|--quiet]
zao run --blueprint <id|path> --task <task> [--yes] [--verbose|--quiet]
zao run --flow dev-cycle --task "Fix the subtraction bug"
zao run --blueprint bug-fix --task "Resolve null pointer in auth"
```

## Core Exports

### Flow Execution

```typescript
import { execute } from "@zao/controller";

const result = await execute({
  task: "Fix the subtraction bug",
  flowPackage: "dev-cycle",  // or blueprintPackage: "dev-cycle"
  projectDir: "/path/to/project",
  harnessClient?: HarnessClient,  // injectable for testing
  autoYes?: boolean,
  sandbox?: boolean,  // default true
  onLoopClose?: (state) => Promise<"continue" | "stop">,
  onToolApproval?: (request) => Promise<ToolApprovalResponse>,
});
// result: { success, steps, executionId, tokenUsage, error?, isValidationFailure? }
```

### Human Gate

```typescript
import { requestToolApproval } from "@zao/controller";

const approved = await requestToolApproval({
  tool: "executeShell",
  command: "npm test",
  reasoning: "Run tests to verify the fix",
});
```

### Logger

```typescript
import { logger } from "@zao/controller";

logger.error("Fatal error");
logger.warn("Deprecated API used");
logger.info("Step completed");
logger.debug("Context token count: 45000");

// Initialize with level
import { initLogger } from "@zao/controller";
initLogger({ level: "debug" });  // or "error", "warn", "info"
```

### Verbosity Flags

```bash
zao run --verbose "Task"     # Debug-level logging
zao run --quiet "Task"       # Error-only logging
zao run "Task"               # Default: info-level
```

## Step Result Structure

```typescript
interface StepResult {
  id: string;           // Step id from blueprint (e.g., "read", "implement")
  role: string;         // Role that executed the step
  status: string;       // "success", "failed", "requires_actions", "skipped", "not-run"
  sessionId?: string;   // Harness session id for this step
}
```

## Execution Result Structure

```typescript
interface ExecutionResult {
  success: boolean;
  steps: StepResult[];
  executionId: string;   // Unique execution identifier
  tokenUsage?: number;   // Total tokens consumed
  error?: string;
  isValidationFailure?: boolean;  // Exit code 3 — blueprint validation error
}
```

## Testing

```typescript
import { MockHarnessClient } from "@zao/controller";

const mock = new MockHarnessClient([
  { success: true, events: [...] },  // response for step 1
  { success: true, events: [...] },  // response for step 2
]);

const result = await execute({
  task: "Test task",
  blueprintPackage: "dev-cycle",
  projectDir: "/tmp/test",
  harnessClient: mock,
});
```
