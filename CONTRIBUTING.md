# Contributing to zao

Thanks for your interest in contributing! zao is prototype software — contributions
are welcome but please read this guide first.

## Getting Started

1. Fork the repo and clone it locally
2. Install dependencies: `bun install`
3. Run tests: `make test`
4. Make your changes
5. Run tests again: `make test`
6. Open a pull request

## Development

```bash
# Install
bun install

# Run tests
make test

# TypeScript check
bunx tsc --noEmit

# Lint
make lint

# Build
make build
```

## Code Style

- **Schema-first**: Every artifact must have a Zod schema before any code produces or consumes it
- **Fail-closed**: Invalid outputs must be rejected, never silently accepted
- **Atomic writes**: All file writes must use temp-file-then-rename
- **No console.* in production code**: Use the logger module
- **JSDoc on public functions**: At minimum, one-line summary of what the function does
- **Tests required**: Every new feature needs tests

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Include tests for new behavior
- Update docs if your change affects user-facing behavior
- Ensure `make test` passes before opening

## Reporting Issues

- Use GitHub Issues
- Include: what you did, what you expected, what happened, zao version, OS
- For bugs: include steps to reproduce and any relevant output

## Architecture

Read [docs/architecture/overview.md](docs/architecture/overview.md) to understand
zao's two-plane design and component boundaries.
