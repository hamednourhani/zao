# First Run Guide

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- A [DeepSeek API key](https://platform.deepseek.com/api_keys)
- Git (for sandboxed execution)

## Setup

### 1. Clone & Install
```bash
git clone https://github.com/hamednourhani/zao.git
cd zao && make install
```

This installs dependencies for all 7 packages and links `zao` as a global command.

### 2. Configure Your API Key
```bash
bun run scripts/setup-config.ts
```

Or manually create `~/.zao/llm-providers.yaml`:
```yaml
llm_providers:
  deepseek:
    api_key: "${DEEPSEEK_API_KEY}"
    models:
      deepseek-chat:
        api_model_id: "deepseek-chat"
```

### 3. Verify
```bash
export DEEPSEEK_API_KEY="sk-your-key"
zao --help
```

## First Command

```bash
# Run a full dev cycle on zao's own code
zao run --blueprint dev-cycle --task "Add a comment to the README" --verbose
```

## What Happens

1. **Blueprint loading**: Controller loads the `dev-cycle` blueprint (plan → implement → test → review)
2. **Step execution**: Each step is dispatched to the harness, which calls DeepSeek
3. **Loop**: If the review step finds issues, it loops back to implement (max 3 iterations)
4. **Artifacts**: Every step is saved to `~/.zao/executions/<session-id>/` as schema-validated JSON
5. **Result**: Summary printed to stdout, full artifacts available for inspection

## Session Inspection

```bash
# List all sessions
zao session list

# Show details
zao session show <session_id>

# View branch tree
zao session tree <session_id>

# Branch from a session
zao branch <session_id>
```

## Troubleshooting

**`zao: command not found`** — run `make install` again, which calls `bun link`.

**`API key not found`** — make sure `DEEPSEEK_API_KEY` is exported or set in `~/.zao/llm-providers.yaml`.

**Sandbox error** — use `--no-sandbox` to skip git worktree isolation (not recommended for production).

## Next Steps

- [Custom Roles](custom-roles.md) — define your own agent roles
- [Custom Blueprints](custom-flows.md) — create your own workflows
- [Session Inspection](session-inspection.md) — debug and analyze runs
- [Session Resume](resume.md) — recover from interruptions
