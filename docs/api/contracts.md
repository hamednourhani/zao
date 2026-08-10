# contracts (yue) API Reference

The contracts package (codename **yue**, 约 — "agreement/pact") holds every schema that crosses a tool boundary. It is language-agnostic **JSON Schema (draft 2020-12)**, fully validated with fixtures, versioned with semver.

## Layout

```
packages/contracts/
├── schemas/    one JSON Schema file per artifact type
└── examples/   valid + invalid fixtures per schema (CI-validated)
```

## Available Schemas

| Schema | File | Purpose |
|--------|------|---------|
| `roles.schema.json` | `schemas/roles.schema.json` | `roles.yaml` — personas, model assignments |
| `flow.schema.json` | `schemas/flow.schema.json` | `flow.yaml` — orchestration flow |
| `blueprint.schema.json` | `schemas/blueprint.schema.json` | `blueprint.yaml` — blueprint package |
| `blueprint-package.schema.json` | `schemas/blueprint-package.schema.json` | `package.yaml` — blueprint metadata |
| `flow-package.schema.json` | `schemas/flow-package.schema.json` | Compiled flow package |
| `llm-providers.schema.json` | `schemas/llm-providers.schema.json` | `llm-providers.yaml` — provider config |
| `run-output.schema.json` | `schemas/run-output.schema.json` | stdout envelope — harness↔controller contract |
| `execution-result.schema.json` | `schemas/execution-result.schema.json` | Execution result envelope |

## TypeScript Zod Schemas (roles only)

The roles schemas are also available as Zod schemas for TypeScript consumers:

```typescript
import {
  RolesFileSchema,
  RoleDefinitionSchema,
  ModelDefaultsSchema,
} from "@zao/contracts/schemas/roles";
```

> **Note:** Internal Zod schemas for session manifests, event logs, and blueprint definitions live in their respective packages (`harness/src/schemas/`, `blueprint/src/schemas/`), not in `@zao/contracts`. The contracts package is the JSON Schema registry only.

## Consumers

| Tool | Role | Usage |
|------|------|-------|
| **zao** (harness) | Deterministic execution engine | Validates `flow.yaml`/`roles.yaml` at load; writes sessions per envelope/manifest schemas |
| **zao** (controller) | Flow orchestrator | Validates every emitted orchestration package (fail closed) |

## Versioning

Additive change → minor; breaking change → major. Consumers pin and migrate deliberately. Artifacts carry a `schema_version` field aligned with yue releases.
