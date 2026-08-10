# First Run Guide

## Prerequisites

- [Bun](https://bun.sh) runtime (v1.2+)
- A DeepSeek API key (or OpenAI, configurable)
- Git (for sandboxed execution)

## Setup

1. **Clone mo:**

```bash
git clone https://github.com/hamednourhani/mo.git
cd mo
```

2. **Install dependencies:**

```bash
bun install
```

3. **Configure your API key:**

```bash
mkdir -p ~/.zao
cat > ~/.zao/llm-providers.yaml << EOF
providers:
  deepseek:
    api_key: "${DEEPSEEK_API_KEY}"
    default_model: deepseek-chat
    models:
      - deepseek-chat
EOF
```

4. **Verify setup:**

```bash
bun run packages/harness/src/index.ts run "Hello, world"
```

## First Command

```bash
# Run the dev-cycle blueprint on mo's own code
bun run packages/controller/src/cli.ts run \
  --flow dev-cycle \
  "Add a comment to the README"
```

## What Happens

1. **Blueprint loading**: The controller loads the `dev-cycle` blueprint (read → plan → implement → review)
2. **Step execution**: Each step is dispatched to the harness, which calls the LLM
3. **Loop**: If the review step finds issues, it loops back to implement (up to 5 iterations)
4. **Artifacts**: Session state is stored in `~/.zao/sessions/<uuid>/`
5. **Result**: Output appears in stdout, with all artifacts available for inspection

## Session Inspection

```bash
# List all sessions
bun run packages/harness/src/index.ts session list

# Show details
bun run packages/harness/src/index.ts session show <session_id>

# Show tree
bun run packages/harness/src/index.ts session tree <session_id>
```

## Next Steps

- [Custom roles](custom-roles.md) — define your own agent roles
- [Custom flows](custom-flows.md) — create your own blueprints
- [Session inspection](session-inspection.md) — debug and analyze runs
- [Session resume](resume.md) — recover from interruptions
