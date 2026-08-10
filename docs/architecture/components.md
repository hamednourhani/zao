# Component Reference

## Control Plane

### harness (`packages/harness/`)

The execution engine — a single-job, file-based LLM agent harness.

**Responsibilities:**
- Execute a single task with one role per invocation
- Manage session lifecycle: create, resume, branch, checkpoint
- Context window management: token budgeting, compaction
- LLM interaction: structured generation, caching, retry
- Human-in-the-loop: approval prompts for irreversible actions
- CLI: `zao run`, `mo continue`, `mo session`, `mo branch`

**Key modules:**
| Module | Purpose |
|--------|---------|
| `loop.ts` | Run loop: build context → call LLM → process tool call → repeat |
| `context.ts` | Build LLM prompt from system prompt + role + task + events |
| `compaction.ts` | Compact conversation history when token budget exceeded |
| `delegation.ts` | Spawn subagent sessions for delegated tasks |
| `branch.ts` | Create peer branch sessions from existing runs |
| `checkpoints.ts` | Automatic checkpoint creation and retention management |
| `session-store.ts` | Global store (`~/.zao/`): index, manifest, session listing |
| `config.ts` | Load `.zao/config.yaml` for non-credential settings |
| `llm.ts` | LLM client integration, structured generation, caching |
| `tool-access.ts` | Tool permission model and access control |
| `hitl.ts` | Human-in-the-loop approval prompts |
| `artifacts.ts` | Atomic file I/O for all session artifacts |

**Boundaries:**
- Does NOT orchestrate multi-step flows (that's the controller)
- Does NOT define blueprints or roles (those come from the caller)
- Does NOT manage LLM provider credentials (that's llm-clients)

---

### controller (`packages/controller/`)

The flow orchestrator — loads blueprints and executes multi-step workflows.

**Responsibilities:**
- Load blueprints from `packages/blueprint/defaults/blueprints/`
- Execute flow steps in sequence with conditional branching
- Handle loops (implement → review → implement → ...)
- Human-in-the-loop gate for tool approvals
- Sandbox execution in git worktrees
- Store execution state and decision logs

**Key modules:**
| Module | Purpose |
|--------|---------|
| `execution-runner.ts` | Step execution engine with loop and retry logic |
| `execution-store.ts` | File-based execution state persistence |
| `execution-loop.ts` | Core execution loop with step orchestration |
| `flow-loader.ts` | Load blueprints and resolve roles |
| `human-gate.ts` | Interactive approval prompts |
| `role-registry.ts` | Load and resolve role definitions |
| `cli.ts` | CLI entry point for `zao run` with blueprint selection |
| `sandbox.ts` | Git worktree isolation for safe execution |

**Boundaries:**
- Does NOT execute LLM calls directly (delegates to harness)
- Does NOT define LLM provider config (uses llm-clients)
- Does NOT implement compaction or context management (harness does)

---

### blueprint (`packages/blueprint/`)

Declarative flow definitions in YAML.

**Structure:**
```
defaults/blueprints/<name>/
├── blueprint.yaml   # Steps, roles, tools, loop rules
├── package.yaml     # Metadata (name, version, description)
└── roles.yaml       # Role prompt templates and model defaults
```

**Built-in blueprints:**
| Blueprint | Description |
|-----------|-------------|
| `dev-cycle` | Universal development cycle: read → plan → implement → review (loop) |
| `bug-fix` | Focused bug fix: reproduce → diagnose → fix → verify |
| `code-review` | Code review: read → analyze → report |
| `feature-development` | Full feature cycle: explore → design → implement → test |
| `mo-fix` | Self-healing: analyze mo codebase → fix |
| `mo-read-codebase` | Codebase exploration: read → summarize |
| `dev-review-loop` | Review-focused: implement → review (loop) |

**Boundaries:**
- Blueprints declare WHAT should happen, not HOW
- The controller interprets blueprints; the harness doesn't know they exist

---

### contracts (`packages/contracts/`)

Shared Zod schemas — the single source of truth for all inter-package contracts.

**Schemas:**
| Schema | Used By |
|--------|---------|
| Blueprint schema | controller, crunch, blueprint |
| Role definition schema | controller, harness |
| Session manifest schema | harness (session-store) |
| Event log entry schema | harness (artifacts) |
| Session index schema | harness (session-store, CLI) |

**Boundaries:**
- Schemas are the API contract between packages
- Breaking schema changes require coordination across consumers

---

### llm-clients (`packages/llm-clients/`)

LLM provider registry and client lifecycle management.

**Responsibilities:**
- Register and resolve LLM providers (DeepSeek, OpenAI, etc.)
- Manage API key configuration (~/.zao/llm-providers.yaml)
- Provide typed client interfaces for structured generation
- Handle provider-specific configuration (rate limits, defaults)

**Boundaries:**
- Does NOT build prompts or manage context (harness does)
- Does NOT execute tool calls (harness does)
- Does NOT know about sessions or blueprints

---

## Advisory Plane

### crunch (`packages/crunch/`)

Multi-perspective LLM research pipeline.

**Pipeline:**
1. **validateInput** — fail-closed on empty input
2. **readContext** — read relevant project files
3. **research** — 3 LLM calls from architecture, security, testing perspectives
4. **decisionRound** — human gate to review findings
5. **synthesize** — LLM call to combine findings into a recommendation
6. **emitBlueprint** — template substitution to produce a dev-cycle blueprint

**Boundaries:**
- Advisory only — does not modify code or session state
- Emits blueprints for the controller to execute
- Research perspectives are configurable

---

### analyzer (`packages/analyzer/`)

Post-execution verification and governance enforcement.

**Responsibilities:**
- Validate execution artifacts against governance rules
- Check for guard violations in event logs
- Verify ADR compliance in generated code
- Flag issues for human review

**Boundaries:**
- Read-only — does not modify artifacts
- Runs after controller/harness execution
