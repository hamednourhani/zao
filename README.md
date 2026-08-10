# zao

**zao** (造, to manufacture/build/create) is a deterministic, file-based LLM agent
orchestration platform. It defines workflows as YAML blueprints, executes them
through a two-plane architecture (control + advisory), and stores all state as
schema-validated files — no databases, no in-memory state, crash-safe by design.

## Why zao?

Most LLM agent frameworks treat code generation as a conversation. zao treats it
as a production line: each step (plan, implement, test, review) is a station with
a specific role, defined tools, and schema-validated output. Results are written
to disk after every step — your session survives crashes, reboots, and context loss.

Read the full rationale in [docs/architecture/overview.md](docs/architecture/overview.md).

## Quick Install

### Prerequisites
- [Bun](https://bun.sh) >= 1.0
- A DeepSeek API key (or any OpenAI-compatible provider)

### Install
```bash
git clone https://github.com/hamednourhani/zao.git
cd zao && bun install
```

### Configure
Create `~/.zao/llm-providers.yaml`:
```yaml
providers:
  deepseek:
    api_key: "${DEEPSEEK_API_KEY}"
    default_model: deepseek-chat
    models: [deepseek-chat]
```

## Usage

```bash
# Run a blueprint
zao run dev-cycle "Fix the login bug"

# Review code
zao run code-review "src/auth.ts"

# Research a question (advisory plane)
zao crunch "How should we handle rate limiting?"

# Analyze a session
zao analyze <session_id>

# Session management
zao session list                    # List all sessions
zao session show <session_id>       # Show session details
zao session tree <session_id>       # View branch tree

# Branch a session
zao branch <session_id>             # Create branch from session
zao branch <session_id> --from-checkpoint 3  # Branch from checkpoint

# CLI flags
zao run dev-cycle "..." --verbose   # Debug-level logging
zao run dev-cycle "..." --quiet     # Errors only
zao run dev-cycle "..." --yes       # Auto-approve non-destructive actions
```

See [docs/usage/](docs/usage/first-run.md) for detailed guides.

## Built-in Blueprints

| Blueprint | Description |
|-----------|-------------|
| `dev-cycle` | Plan → Implement → Test → Review → Fix loop (up to 3 iterations) |
| `code-review` | Single-step code review |
| `bug-fix` | Bug fix workflow with root-cause analysis |
| `dev-review-loop` | Classic dev-review iteration loop |
| `feature-development` | Full feature implementation workflow |
| `zao-fix` | zao self-repair workflow |
| `zao-read-codebase` | Codebase exploration and analysis |

## Architecture

zao has a **two-plane architecture**:

- **Control plane** (harness, controller, blueprint, contracts, llm-clients): Executes flows and manages sessions.
- **Advisory plane** (crunch, analyzer): Researches problems and verifies outputs.

![Architecture](docs/architecture/overview.md)

## Packages

| Package | Purpose |
|---------|---------|
| [harness](packages/harness/) | Execution engine — sessions, compaction, branching, checkpoints |
| [controller](packages/controller/) | Flow orchestrator — loads blueprints, dispatches steps, human gate |
| [blueprint](packages/blueprint/) | Declarative YAML blueprints for multi-step workflows |
| [contracts](packages/contracts/) | Shared Zod schemas — single source of truth |
| [llm-clients](packages/llm-clients/) | LLM provider registry and client lifecycle |
| [crunch](packages/crunch/) | Multi-perspective LLM research pipeline → emits blueprints |
| [analyzer](packages/analyzer/) | Post-execution verification and guard checking |

## Development

```bash
# Run tests
make test

# Lint
make lint

# Build
make build

# TypeScript check
bunx tsc --noEmit

# Distribution artifacts
make dist-linux    # Linux binary
make dist-macos    # macOS binary
```

## Docs

- [Getting Started](docs/getting-started.md)
- [Architecture Overview](docs/architecture/overview.md)
- [Component Reference](docs/architecture/components.md)
- [Design Decisions (ADRs)](docs/architecture/decisions.md)
- [API Reference](docs/api/harness.md)
- [Usage Guides](docs/usage/first-run.md)
