# Security Policy

zao executes LLM agent workflows locally on your machine. It does NOT run as a
service, expose network ports, or collect telemetry. Security concerns are
primarily about what you allow LLM agents to do during execution.

## Reporting a Vulnerability

If you discover a security vulnerability in zao, please open an issue on
[GitHub](https://github.com/hamednourhani/zao/issues) or email the maintainer.
Please do NOT open a public issue if the vulnerability could be exploited.

## Scope

zao v0.1.0 is prototype software. Security is focused on:
- **Sandbox isolation**: Agent execution runs in isolated git worktrees.
- **Permission model**: All tool executions require human approval (human-in-the-loop).
- **Fail-closed**: Invalid outputs are rejected, not silently accepted.

What is NOT in scope for v0.1.0:
- Network-level attacks (zao has no server component)
- Supply-chain attacks on npm dependencies
- Cryptographic vulnerabilities (zao delegates to git/ssh for auth)

## Supported Versions

Only the latest `main` branch commit is supported. No backport releases.
