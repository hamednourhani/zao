# Session Resume

Interrupted sessions can be resumed from their last state. mo preserves all events and works in-progress, so resume continues where you left off.

## Basic Resume

```bash
mo continue <session_id>
```

The resume flow:
1. Resolves the session from `~/.zao/sessions/<session_id>/`
2. Loads the session manifest (task, role, model config)
3. Reads the last N events for context
4. Replays the task with the original configuration
5. Continues appending to the same events.jsonl

## Resume with Auto-Approval

```bash
mo continue <session_id> --yes
```

Auto-approves Tier 2 actions during the resumed session.

## Controlling Resume Context

```bash
# Include last 10 events in context (default: 3)
mo continue <session_id> --recent-events 10

# Include last 100 events
mo continue <session_id> --recent-events 100
```

More events = more context for the LLM, but may trigger earlier compaction.

## What Resume Preserves

| Preserved | Not Preserved |
|-----------|---------------|
| Task description | In-progress LLM call (replayed) |
| Role configuration | Exact tool state (re-initialized) |
| Model configuration | |
| Session manifest | |
| All prior events | |
| Summary (if compacted) | |

## Resume vs Branch

| Feature | Resume | Branch |
|---------|--------|--------|
| Mutates original session | Yes (continues same run) | No (creates new peer) |
| Session ID | Same | New UUIDv7 |
| Events | Continues same file | Copies events to new file |
| Use case | Recover from crash/interruption | Explore alternative direction |

## When to Branch Instead of Resume

- You want to try a different approach without losing the original path
- The session completed but you want to continue from a checkpoint
- You need to replay a session with different parameters

```bash
# Create a branch from the session
mo branch <session_id>

# Branch from a specific checkpoint
mo branch <session_id> --from-checkpoint <checkpoint_id>

# Resume the branch
mo continue <new_branch_id>
```

## Checking Resume Status

```bash
mo session show <session_id>
```

The `resume_count` field shows how many times a session has been resumed. A count of 0 means it's an original run.
