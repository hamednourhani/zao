# blueprint API Reference

Blueprints are declarative flow definitions in YAML. They define the steps, roles, tools, and loop behavior for multi-step workflows.

## Blueprint Structure

```
defaults/blueprints/<name>/
├── blueprint.yaml   # Steps and flow logic
├── package.yaml     # Metadata
└── roles.yaml       # Role definitions
```

## blueprint.yaml Schema

```yaml
schema_version: "0.2.0"
blueprint_id: "dev-cycle"

steps:
  - id: read
    role: developer
    task_template: "Read relevant files for: {task}"
    tools:
      - tool: readFile
        scope: agent_decides

  - id: plan
    role: developer
    task_template: "Plan the implementation of: {task}"
    when: read.status == "success"
    context_spec:
      text: "Use file contents from the read step"
      receive_from: [read]

  - id: implement
    role: developer
    task_template: "Implement: {task}"
    when: plan.status == "success"
    tools:
      - tool: readFile
        scope: agent_decides
      - tool: writeFile
        scope: agent_decides
        requires_approval: false
      - tool: executeShell
        scope: agent_decides
        requires_approval: true
    loop:
      target: implement
      max_iterations: 5
      exit_when: 'review.status == "success"'

  - id: review
    role: developer
    task_template: "Review: {task}"
    when: implement.status == "success"
    output_spec:
      status: requires_actions
      recommended_next: implement
```

## package.yaml Schema

```yaml
schema_version: "0.1.0"
package:
  id: "dev-cycle"
  version: "0.1.0"
  type: blueprint
  name: "dev-cycle"
  description: "Universal development cycle: read → plan → implement → review"
```

## roles.yaml Schema

```yaml
schema_version: "0.3.0"

model_defaults:
  default_llm_id: "deepseek:deepseek-chat"

roles:
  developer:
    prompt_template: "You are a developer agent..."
    context_budget: 0.65
    llm_id: null  # null = use default
```

## Tool Declarations

| Tool | Scope | Requires Approval |
|------|-------|-------------------|
| `readFile` | `agent_decides` | No |
| `writeFile` | `agent_decides` | Configurable |
| `executeShell` | `agent_decides` | Yes (default) |

## Loop Rules

The `loop` field on a step enables iterative execution:

- `target`: Which step to loop back to
- `max_iterations`: Maximum iterations before escalation
- `exit_when`: Condition string that exits the loop (evaluated against step results)

## Built-in Blueprints

| Name | Steps | Loop |
|------|-------|------|
| `dev-cycle` | read → plan → implement → review | implement ↔ review |
| `bug-fix` | reproduce → diagnose → fix → verify | fix ↔ verify |
| `code-review` | read → analyze → report | None |
| `feature-development` | explore → design → implement → test | implement ↔ test |
| `zao-fix` | analyze → plan → fix → verify | fix ↔ verify |
| `zao-read-codebase` | read → summarize | None |
| `dev-review-loop` | implement → review | implement ↔ review |
