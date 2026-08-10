# Custom Roles

Roles define the agent's identity, prompt template, and context budget. You can create custom roles by editing the blueprint's `roles.yaml`.

## Role Definition

```yaml
# roles.yaml
schema_version: "0.3.0"

model_defaults:
  default_llm_id: "deepseek:deepseek-chat"

roles:
  security-auditor:
    prompt_template: |
      You are a security auditor. Review code for:
      - OWASP Top 10 vulnerabilities
      - Input validation issues
      - Authentication/authorization gaps
      - Secret exposure
      - Path traversal risks
      
      Be thorough. Flag anything suspicious, even if you're not sure.
      Return findings with severity: CRITICAL, HIGH, MEDIUM, LOW.
    context_budget: 0.50
    llm_id: null  # Use default
```

## Role Fields

| Field | Required | Description |
|-------|----------|-------------|
| `prompt_template` | Yes | The system prompt for the LLM. Injected at the start of every context. |
| `context_budget` | Yes | Fraction of the context window reserved for this role (0–1). Compaction triggers when exceeded. |
| `llm_id` | No | Override the model for this role. `null` = use the blueprint default. |

## Context Budget Tips

- **0.50**: For review/audit roles — less context needed, stricter compaction
- **0.65**: For development roles — balanced
- **0.80**: For planning roles — needs full context

## Using Custom Roles in Blueprints

Reference your custom role in `blueprint.yaml`:

```yaml
steps:
  - id: security-check
    role: security-auditor
    task_template: "Audit the changes for: {task}"
    tools:
      - tool: readFile
        scope: agent_decides
```

## Role Resolution

Roles are resolved by name:
1. Blueprint's own `roles.yaml` — checked first
2. Controller's role registry — fallback for built-in roles
3. Harness built-in roles (developer, planner, reviewer, architect) — used when no role is specified via `--role`

If a role is not found in any source, the step fails with a validation error.
