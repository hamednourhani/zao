# Custom Flows (Blueprints)

Blueprints define multi-step workflows. Create a new blueprint by adding a directory under `packages/blueprint/defaults/blueprints/`.

## Blueprint Directory Structure

```
my-blueprint/
├── blueprint.yaml   # Steps, roles, tools, loop rules
├── package.yaml     # Metadata
└── roles.yaml       # Role definitions
```

## Example: A Security Audit Blueprint

### blueprint.yaml

```yaml
schema_version: "0.2.0"
blueprint_id: "security-audit"

steps:
  - id: read
    role: security-auditor
    task_template: "Read the changed files for: {task}"
    tools:
      - tool: readFile
        scope: agent_decides

  - id: scan
    role: security-auditor
    task_template: "Scan for security vulnerabilities: {task}"
    when: read.status == "success"
    context_spec:
      text: "Analyze the files from the read step for security issues"
      receive_from: [read]

  - id: report
    role: security-auditor
    task_template: "Generate a security report for: {task}"
    when: scan.status == "success"
    context_spec:
      text: "Compile findings from the scan into a report"
      receive_from: [scan]
    tools:
      - tool: writeFile
        scope: agent_decides
        requires_approval: true
```

### package.yaml

```yaml
schema_version: "0.1.0"
package:
  id: "security-audit"
  version: "0.2.0"
  type: blueprint
  name: "security-audit"
  description: "Security audit: read → scan → report"
```

### roles.yaml

```yaml
schema_version: "0.3.0"

model_defaults:
  default_llm_id: "deepseek:deepseek-chat"

roles:
  security-auditor:
    prompt_template: "You are a security auditor..."
    context_budget: 0.50
    llm_id: null
```

## Step Reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Step identifier (must be unique within the blueprint) |
| `role` | Yes | Role name (must match a role in `roles.yaml`) |
| `task_template` | Yes | Task description with `{task}` placeholder |
| `when` | No | Guard condition (e.g., `read.status == "success"`) |
| `tools` | No | Tools available to this step |
| `context_spec` | No | Context passed to this step (text, receive_from) |
| `loop` | No | Loop configuration (target, max_iterations, exit_when) |
| `output_spec` | No | Expected output format (used by review steps) |

## Running Custom Blueprints

```bash
# Run by blueprint directory name
bun run packages/controller/src/cli.ts run --flow security-audit "Audit the auth module"
```
