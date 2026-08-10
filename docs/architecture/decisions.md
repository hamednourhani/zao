# Architecture Decisions

zao follows the [Architecture Decision Record](https://adr.github.io/) (ADR) format for all significant design choices. The full ADR files live in the development environment repository (`mo-development-env/docs/architecture/decisions/`).

## ADR Index

| ADR | Title | Summary |
|-----|-------|---------|
| ADR-001 | File-based state machine | All session state is stored as JSON files. No databases, no in-memory state. |
| ADR-002 | Append-only event log | `events.jsonl` is append-only. Events are never modified after writing. |
| ADR-003 | Schema-first contracts | Every artifact validates against a Zod schema before writing. |
| ADR-004 | Atomic writes | All file writes use temp-file-then-rename for crash safety. |
| ADR-005 | Session immutability | Completed sessions are immutable. Branching creates a new peer — the original is never modified. |
| ADR-006 | Platform monorepo | All zao packages live in a single monorepo with clear boundaries. |
| ADR-007 | Two-plane architecture | Control plane (execution) and advisory plane (analysis) are separate concerns. |
| ADR-008 | Controller-harness interface | Controller orchestrates flows; harness executes single jobs. |
| ADR-009 | LLM client registry | LLM provider credentials and configuration are managed by llm-clients, not the harness. |
| ADR-010 | Advisory plane emits blueprints | Crunch researches and emits blueprints; the controller executes them. |

## Governance

All changes to zao must comply with the governance rules in `docs/architecture/governance.md` (in the development environment repo). Key rules:

- **Fail-closed**: Invalid artifacts are rejected, not written.
- **No silent discards**: Lossy operations (compaction, truncation) require HITL approval.
- **Schema-first**: New artifacts need a Zod schema before any code that produces or consumes them.
- **ADR required for new patterns**: New design patterns need an ADR before implementation.
