# Session Inspection

Every zao run creates a session with a unique UUIDv7 identifier. Sessions are stored in `~/.zao/sessions/` and indexed in `~/.zao/index.jsonl`.

## Listing Sessions

```bash
# List all sessions
mo session list

# Filter by status
mo session list --status complete
mo session list --status active
mo session list --status failed

# Filter by date
mo session list --since 2026-08-01

# Limit results
mo session list --limit 10

# JSON output
mo session list --format json
```

## Showing Session Details

```bash
mo session show <session_id>

# JSON output
mo session show <session_id> --format json
```

Output includes:
- Session ID, task, status
- Created/updated timestamps
- Model configuration
- Repository info (root, remote)
- Resume count
- Step execution status (from flow spec)

## Session Tree

```bash
mo session tree <session_id>
```

Shows two trees:

### Agent Tree
The delegation hierarchy — which subagents were spawned and their statuses:
```
├─ developer (abc123...) [complete]
├─ reviewer (def456...) [complete]
├─ developer (ghi789...) [failed]
```

### Branch Tree
The branching lineage — which sessions were branched from which:
```
abc123... [complete]
└─ def456... (branched from abc123...) [active]
   └─ ghi789... (branched from def456...) [active]
```

## Session Directory Structure

```
~/.zao/sessions/<uuidv7>/
├── session.json          # Session manifest (status, task, model, etc.)
├── events.jsonl          # Append-only event log
├── result.json           # Execution result (written on completion)
├── summary.md            # Compaction summary (written when context is compacted)
├── orchestration-spec.json  # Flow specification (from controller)
├── checkpoints/          # Automatic checkpoints
│   └── <uuidv7>/
│       ├── session.json
│       ├── events.jsonl
│       └── summary.md
└── agents/               # Child (subagent) sessions
    ├── index.jsonl       # One line per spawned child
    └── <uuidv7>/
        └── session.json
```

## Global Index

`~/.zao/index.jsonl` is an append-only file with one line per session lifecycle event:
- Creation line: written when session starts (status: "active")
- Completion line: written when session ends (status: "complete", "failed", or "interrupted")

Resolution uses **last-line-wins** semantics — the last line for a session_id determines its final status.
