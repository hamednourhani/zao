# zao

**zao** is a deterministic, file-based LLM agent orchestration platform. It defines workflows as YAML blueprints, executes them through a two-plane architecture (control + advisory), and stores all state as schema-validated files — no databases, no in-memory state, crash-safe by design.

## Quick Install

```bash
git clone https://github.com/hamednourhani/zao.git
cd zao && bun install
```

Add your API key to `~/.zao/llm-providers.yaml`:

```yaml
providers:
  deepseek:
    api_key: "${DEEPSEEK_API_KEY}"
    default_model: deepseek-chat
    models: [deepseek-chat]
```

## First Command

```bash
bun run packages/controller/src/cli.ts run --flow dev-cycle "Fix the bug in auth.ts"
```

## Packages

| Package | Purpose |
|---------|---------|
| [harness](packages/harness/) | Execution engine — single-job LLM runner with sessions, compaction, branching |
| [controller](packages/controller/) | Flow orchestrator — loads blueprints, dispatches steps, handles loops |
| [blueprint](packages/blueprint/) | Flow definitions — declarative YAML blueprints for multi-step workflows |
| [contracts](packages/contracts/) | Shared schemas — single source of truth for all inter-package contracts |
| [llm-clients](packages/llm-clients/) | LLM registry — provider management and client lifecycle |
| [crunch](packages/crunch/) | Research pipeline — multi-perspective LLM analysis that emits blueprints |
| [analyzer](packages/analyzer/) | Verification — post-execution governance and guard checking |

## Docs

- [Getting Started](docs/getting-started.md)
- [Architecture](docs/architecture/overview.md) — two-plane design, component map, flow diagrams
- [Components](docs/architecture/components.md) — package-by-package reference
- [Decisions](docs/architecture/decisions.md) — ADR index
- [API Reference](docs/api/harness.md) — harness, controller, blueprint, contracts, llm-clients
- [Usage](docs/usage/first-run.md) — first run, custom roles, custom flows, session inspection, resume
