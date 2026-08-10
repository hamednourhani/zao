# @zao/controller

Orchestration layer for the mo platform.

## Role

Per **ADR-006** (Platform Topology), the controller is the owner of:
- **Role resolution** — the single source of truth for agent role definitions
- **Flow execution** — running orchestration flows and managing the execution lifecycle
- **Run lifecycle** — creating, resuming, completing, and failing runs
- **Execution memory model** — `~/.zao/executions/<execution_id>/` (see ADR-008)

## Layout

```
packages/controller/
├── defaults/
│   └── roles.yaml       # Shipped default role definitions (base layer)
├── src/
│   ├── index.ts         # Public entry point
│   ├── execution-store.ts  # Execution memory model
│   └── role-registry.ts    # Role resolution (4-layer config merging)
└── tests/
    ├── execution-store.test.ts
    └── role-registry.test.ts
```

## Execution Memory Model (ADR-008)

Each execution creates a directory under `~/.zao/executions/<execution_id>/` containing:

- `execution.json` — manifest: execution_id, status, created_at, repo_root, task, schema_version
- `index.jsonl` — append-only JSONL, one line per harness session_id in execution order
- `events.jsonl` — controller-level events (execution_created, execution_resumed, execution_completed, execution_failed)

## Role Registry

The controller resolves roles from three config layers (top wins):

1. Explicit path passed to `loadRoleRegistry()`
2. `~/.zao/config/roles.yaml` (or `mo.yaml`)
3. Controller's shipped defaults (`packages/controller/defaults/roles.yaml`)

See ADR-005 for the config layering model.

## Package Dependencies

- `@zao/contracts` — shared JSON schemas for schema validation
- `yaml` — YAML config parsing
- `zod` — runtime schema validation

No runtime dependency on `@zao/harness` — the interface between controller and harness is defined in ADR-008 and implemented in TD-029-E.
