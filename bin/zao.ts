#!/usr/bin/env bun
/**
 * zao CLI — unified entry point.
 * Dispatches to controller (run/crunch/analyze) or harness (session/branch).
 */
// Suppress AI SDK compatibility-mode warnings
(globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS = false;

const cmd = process.argv[2] ?? "";

if (cmd === "session" || cmd === "branch") {
  // Delegate to harness CLI (handles session list/show/tree, branch)
  await import("../packages/harness/src/index.ts");
} else {
  // Delegate to controller CLI (handles run/crunch/analyze/--help)
  const { run } = await import("../packages/controller/src/cli.ts");
  await run();
}
