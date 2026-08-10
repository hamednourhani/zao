# controller API Reference

The controller orchestrates multi-step flows by loading blueprints and dispatching steps to the harness.

## CLI Commands

```bash
zao run [--blueprint <name>] [--yes] [--verbose|--quiet] <task>
zao run --flow dev-cycle "Fix the subtraction bug"
zao run --flow bug-fix "Resolve null pointer in auth"
```

## Core Exports

### Flow Execution

```typescript
import { execute } from "@zao/controller";

const result = await execute({
  task: "Fix the subtraction bug",
  blueprintPackage: "dev-cycle",
  projectDir: "/path/to/project",
  harnessClient?: MockHarnessClient,  // injectable for testing
  autoYes?: boolean,
});
// result.success, result.steps, result.executionDir
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
  status: string;       // "success", "failed", "skipped", "not-run"
  sessionId?: string;   // Harness session id for this step
}
```

## Execution Result Structure

```typescript
interface ExecutionResult {
  success: boolean;
  steps: StepResult[];
  executionDir: string;  // Directory with artifacts
  error?: string;
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
