# yue (约)

**The contracts pact between rey, mo, and zhi.**

*yue* (约 — "agreement / pact", as in 契约, "contract") holds every schema that crosses a tool boundary. Language-agnostic **JSON Schema (draft 2020-12)**, fully validated with fixtures, versioned with semver. One source of truth; any language can validate against it.

## The pact

Each tool is **sovereign** — yue is data, not coupling:

- **mo without rey**: the user hand-writes `flow.yaml` / `roles.yaml` per these schemas.
- **rey without mo**: emits a validated package; the human runs it wherever.
- **zhi**: optional guard layer, never a hard dependency.

yue itself depends on nothing at runtime. Consumers pin versions.

## Layout

```
schemas/    one JSON Schema file per artifact type
examples/   valid + invalid fixtures per schema (CI-validated)
```

## Schemas (planned)

| Schema | Owner artifact | Lands with |
|---|---|---|
| `roles.schema.json` | `roles.yaml` — personas, model assignments | ✅ mo TD-012 |
| `flow.schema.json` | `flow.yaml` — orchestration flow | ✅ mo TD-013 |
| `run-output.schema.json` | stdout envelope — mo↔Rey contract | ✅ mo TD-020 |
| `event-envelope.schema.json` | tracing envelope v0.2.0 | mo TD-010-A |
| `session-manifest.schema.json` | `session.json` | mo TD-010-A |
| `orchestration-spec.schema.json` | `orchestration-spec.json` snapshot | mo TD-012 |
| `result.schema.json` | `result.json` (handoff response) | mo TD-014 (extract from Story 002) |
| `handoff-request.schema.json` | delegation request | mo TD-014 |
| `tool-exec-request.schema.json` | tool execution request | mo TD-014 |
| `memory-state.schema.json` | memory state | mo TD-014 |
| `index-line.schema.json` | global + per-parent index lines | mo TD-010-A |

## Consumers

| Tool | Role | Usage |
|---|---|---|
| **mo** | Deterministic execution engine | Validates `flow.yaml`/`roles.yaml` at load; writes sessions per envelope/manifest schemas |
| **rey** | Crunch & design | Validates every emitted orchestration package (fail closed) |
| **zhi** | Guard / safety (formerly schild) | Future consumer |

## Versioning & evolution

- Additive change → **minor**; breaking change → **major**. Consumers pin and migrate deliberately.
- Artifacts carry a `schema_version` field aligned with yue releases (current target: **0.2.0** per mo ADR-005).
- Legacy mo Story 002 schemas port in at 0.1.0 for continuity, migrate to 0.2.0 with mo TD-010-A.

## Status

**Bootstrap.** First schemas land with mo TD-012 (`roles`) and TD-013 (`flow`); extraction of mo's legacy schemas tracked in mo-development-env TD-014. Adoption in rey tracked in rey-development-env TD-001.

## References

- mo-development-env: `backlog/tech-debt/TD-014-external-contracts.md`, `docs/architecture/decisions/005-run-session-correlation.md`
- rey-development-env: `docs/architecture/decisions/001-foundation-decisions.md` (§3 contracts, §4 independence), `backlog/tech-debt/TD-001-contracts-dependency.md`
