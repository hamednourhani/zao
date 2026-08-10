# Getting Started with zao

zao is a deterministic, file-based LLM agent orchestration platform. You define workflows as YAML blueprints, zao executes them step-by-step, and every output is saved as schema-validated JSON — crash-safe by design.

## 3 Steps to First Run

### 1. Clone & Install
```bash
git clone https://github.com/hamednourhani/zao.git
cd zao && make install
```

This installs all 7 packages and makes `zao` available globally.

### 2. Add Your API Key
```bash
bun run scripts/setup-config.ts
```
Or create `~/.zao/llm-providers.yaml` manually:
```yaml
llm_providers:
  deepseek:
    api_key: "${DEEPSEEK_API_KEY}"
    models:
      deepseek-chat:
        api_model_id: "deepseek-chat"
```

### 3. Run
```bash
export DEEPSEEK_API_KEY="sk-your-key"
zao run --blueprint dev-cycle --task "Add a test for the login handler" --verbose
```

That's it. zao will plan, implement, test, and review — saving every step to `~/.zao/executions/`.

## Core Concepts

| Concept | What it is |
|---------|------------|
| **Blueprint** | YAML file defining a multi-step workflow (plan → implement → test → review) |
| **Harness** | Execution engine — runs single LLM tasks, manages sessions and state |
| **Controller** | Orchestrator — loads blueprints, dispatches steps, handles the human gate |
| **Session** | A single run stored as JSON files in `~/.zao/executions/` — survives crashes |

## Key Commands

```bash
# Run a blueprint
zao run --blueprint dev-cycle --task "Fix the login bug"
zao run --blueprint code-review --task "Review src/auth.ts"

# Run a flow package
zao run --flow default --task "Refactor the auth module"

# Research a question (advisory plane)
zao crunch "How should we handle rate limiting?"

# Analyze session patterns
zao analyze

# Session management
zao session list                    # List all sessions
zao session show <session_id>       # Inspect a session
zao session tree <session_id>       # View branch tree

# Branching
zao branch <session_id>             # Create a branch from a session

# CLI flags
--verbose, -v     Debug-level logging (see everything)
--quiet, -q       Errors only
--yes, -y         Auto-approve non-destructive actions
--no-sandbox      Disable git worktree isolation
```

## Next Steps

- [Architecture Overview](architecture/overview.md) — two-plane design, how zao works
- [First Run Walkthrough](usage/first-run.md) — detailed step-by-step
- [Custom Blueprints](usage/custom-flows.md) — create your own workflows
- [Session Inspection](usage/session-inspection.md) — browse and resume sessions
- [API Reference](api/harness.md) — package-level documentation
