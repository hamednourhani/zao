# harness API Reference

The harness is the single-job LLM execution engine. It manages sessions, token budgets, compaction, and tool execution.

The harness is a **CLI-only tool** — it does not expose a programmatic API for external consumers. For programmatic access, use the controller's `DefaultHarnessClient` (`packages/controller/src/harness-client.ts`) or import directly from the harness source paths (e.g., `import { initSession } from "../harness/src/core/artifacts.ts"`).

## CLI Commands

```bash
zao run [--yes] [--role <name>] <task>
zao continue <session_id> [--yes] [--recent-events N]
zao branch <session_id> [--from-checkpoint <id>]
zao session list [--status ...] [--repo ...] [--since ...] [--limit N]
zao session show <session_id> [--format json]
zao session tree <session_id>
```

## Configuration

The harness reads LLM clients from the `@zao/llm-clients` registry. Provider credentials and model defaults are configured via `~/.zao/llm-providers.yaml` (see [llm-clients API](llm-clients.md)).

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Run failed (LLM error) |
| 2 | Usage error (bad flags, missing task) |
| 3 | Validation error (unknown session) |
