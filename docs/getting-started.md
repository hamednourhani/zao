# Getting Started with mo

mo is a deterministic, file-based agent orchestration platform. It executes LLM-powered workflows defined as blueprints.

## Quick Setup

```bash
# 1. Clone and install
git clone https://github.com/hamednourhani/mo.git
cd mo
bun install

# 2. Configure your LLM provider
mkdir -p ~/.zao
echo 'providers:
  deepseek:
    api_key: "${DEEPSEEK_API_KEY}"
    default_model: deepseek-chat
    models: [deepseek-chat]' > ~/.zao/llm-providers.yaml

# 3. Run your first task
bun run packages/harness/src/index.ts run "Hello, world"

# 4. Run a dev-cycle blueprint
bun run packages/controller/src/cli.ts run \
  --flow dev-cycle \
  "Fix the login bug in auth.ts"
```

## Core Concepts

- **Blueprint**: A YAML file that defines a multi-step workflow (read → plan → implement → review)
- **Harness**: The execution engine that runs single LLM tasks
- **Controller**: The orchestrator that loads blueprints and dispatches steps
- **Session**: A single run, stored as JSON files in `~/.zao/sessions/`

## Key Commands

```bash
mo run "Task"                           # Run a single task
mo run --flow dev-cycle "Task"          # Run a blueprint
mo continue <session_id>                # Resume an interrupted session
mo session list                         # List all sessions
mo session show <session_id>            # Inspect a session
mo branch <session_id>                  # Create a branch
```

## Next Steps

- [Architecture Overview](architecture/overview.md) — how mo works
- [First Run](usage/first-run.md) — detailed walkthrough
- [Custom Blueprints](usage/custom-flows.md) — create your own workflows
- [API Reference](api/harness.md) — programmatic usage
