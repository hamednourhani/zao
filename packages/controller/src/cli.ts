#!/usr/bin/env bun
// Suppress AI SDK compatibility-mode warnings (noisy, shown on every call)
(globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS = false;
/**
 * Controller CLI — `zao run` / `zao crunch` / `zao analyze` entry point.
 *
 * ## Design
 *
 * Minimal argument parser — no external CLI library. Parses `process.argv`
 * for the subcommand and known flags, then dispatches to the appropriate
 * handler.
 *
 * ## Usage
 *
 * ```bash
 * zao run --flow default --task "Build the thing" --yes
 * zao run --blueprint feature-development --task "Implement login"
 * zao crunch "How do I add rate limiting?"
 * zao analyze --store-root ~/.zao
 * ```
 *
 * @module cli
 */

import { execute } from "./execution-runner.ts";
import type { LoopCloseState } from "./schemas/flow.ts";
import { createInterface } from "node:readline";
import { requestToolApproval, type ToolApprovalRequest, type ToolApprovalResponse } from "./human-gate.ts";
import { __internalInitLogger } from "./logger.ts";
import type { LogLevel } from "./logger.ts";

// ── Argument Parser ───────────────────────────────────────────────────

export interface ParsedArgs {
  /** Subcommand: "run", "crunch", "analyze", or "help". */
  command?: string;
  /** Positional argument for crunch (the user's question). */
  question?: string;
  flow?: string;
  blueprint?: string;
  task?: string;
  yes: boolean;
  noSandbox: boolean;
  projectDir?: string;
  /** For analyze: path to the zao store root. */
  storeRoot?: string;
  format?: "table" | "json";
  help: boolean;
  /** Logger verbosity level. */
  logLevel: LogLevel;
}

/**
 * Parses CLI arguments into a {@link ParsedArgs} record.
 *
 * Unknown flags are ignored; value flags consume the next argument.
 * When `argv` is omitted, parses the real `process.argv` (after the
 * executable + script position). Tests pass an explicit argv array.
 *
 * ## Trust boundary
 *
 * The `--blueprint` and `--flow` values may be absolute paths. This is
 * intentional: a local user choosing the path is trusted. If this CLI
 * is ever exposed via a service, add path-confinement checks here before
 * passing values to the execution runner.
 *
 * @param argv - Optional argument vector (without node/script positions).
 * @returns The parsed arguments.
 */
export function parseArgs(argv?: string[]): ParsedArgs {
  const args = argv ?? process.argv.slice(2);
  const result: ParsedArgs = { yes: false, noSandbox: false, help: false, logLevel: "info" };

  // First non-flag argument is the subcommand
  let commandParsed = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    // If we haven't seen a command yet and this doesn't look like a flag,
    // it's the command (run, crunch, analyze)
    if (!commandParsed && !arg.startsWith("-")) {
      result.command = arg;
      commandParsed = true;
      continue;
    }

    switch (arg) {
      case "--flow":
      case "-f":
        i++;
        if (i < args.length) result.flow = args[i];
        break;

      case "--blueprint":
      case "-b":
        i++;
        if (i < args.length) result.blueprint = args[i];
        break;

      case "--task":
      case "-t":
        i++;
        if (i < args.length) result.task = args[i];
        break;

      case "--yes":
      case "-y":
        result.yes = true;
        break;

      case "--no-sandbox":
        result.noSandbox = true;
        break;

      case "--project-dir":
      case "-d":
        i++;
        if (i < args.length) result.projectDir = args[i];
        break;

      case "--format":
        i++;
        if (i < args.length) {
          const fmt = args[i];
          if (fmt === "json" || fmt === "table") {
            result.format = fmt;
          }
        }
        break;

      case "--store-root":
        i++;
        if (i < args.length) result.storeRoot = args[i];
        break;

      case "--help":
      case "-h":
        result.help = true;
        break;

      case "--verbose":
      case "-v":
        result.logLevel = "debug";
        break;

      case "--quiet":
      case "-q":
        result.logLevel = "error";
        break;

      default:
        // Collect remaining non-flag arguments as the question (for crunch)
        if (!result.question) {
          result.question = arg;
        } else {
          result.question += " " + arg;
        }
        break;
    }
  }

  // Backward compat: if no subcommand was detected but --blueprint or
  // --flow flags are present, default to "run" so old scripts still work.
  if (!result.command && (result.blueprint || result.flow)) {
    result.command = "run";
  }

  return result;
}

// ── Argument Validation ─────────────────────────────────────────────

/**
 * Validates parsed CLI arguments before any mode dispatch.
 *
 * Checks, in order:
 * 1. `--blueprint` and `--flow` are mutually exclusive (HIGH-001).
 * 2. `--task` is required for `--blueprint` mode.
 * 3. At least one mode (`--flow` or `--blueprint`) must be selected.
 *
 * Kept separate from {@link parseArgs} so the CLI can run these checks
 * before `execute()` is dispatched and so tests can assert each failure
 * path without spawning the process.
 *
 * @param parsed - The parsed arguments.
 * @returns An error message, or null when the arguments are valid.
 */
export function validateArgs(parsed: ParsedArgs): string | null {
  const cmd = parsed.command;

  // ── "run" validation ────────────────────────────────────────────
  if (cmd === "run" || !cmd) {
    if (parsed.blueprint && parsed.flow) {
      return "--blueprint and --flow are mutually exclusive.";
    }
    if (parsed.blueprint && !parsed.task) {
      return "--task is required when using --blueprint.";
    }
    if (!parsed.flow && !parsed.blueprint) {
      return "--flow or --blueprint is required.";
    }
    return null;
  }

  // ── "crunch" validation ─────────────────────────────────────────
  if (cmd === "crunch") {
    if (!parsed.question || parsed.question.trim() === "") {
      return "A question is required for zao crunch.";
    }
    return null;
  }

  // ── "analyze" validation ─────────────────────────────────────────
  if (cmd === "analyze") {
    // All arguments are optional — defaults are used
    return null;
  }

  // Unknown command
  return `Unknown command: "${cmd}". Expected "run", "crunch", or "analyze".`;
}

function printHelp(): void {
  const help = [
    "zao — Control and advisory plane for the zao agent platform",
    "",
    "Usage:",
    "  zao run --flow <package-id|path> [--task <task>] [options]",
    "  zao run --blueprint <id|path> --task <task> [options]",
    "  zao crunch <question> [options]",
    "  zao analyze [--store-root <path>] [options]",
    "",
    "Commands:",
    "  run          Execute a flow or blueprint pipeline",
    "  crunch       Research a question and execute the resulting blueprint",
    "  analyze      Analyze session data and print patterns/learnings",
    "",
    "Options (for run):",
    "  --flow, -f <id|path>      Flow package ID (e.g. 'default') or absolute path",
    "  --blueprint, -b <id|path> Blueprint package ID or path (compiled to flow)",
    "  --task, -t <task>         Task description (required for --blueprint; optional for --flow)",
    "",
    "General Options:",
    "  --yes, -y                 Auto-approve Tier 2 actions",
    "  --no-sandbox              Disable git worktree sandboxing",
    "  --project-dir, -d <dir>   Project root directory (default: cwd)",
    "  --format <table|json>     Output format (default: table)",
    "  --verbose, -v             Enable debug-level logging",
    "  --quiet, -q               Suppress all log output except errors",
    "  --help, -h                Show this help message",
    "",
    "Options (for analyze):",
    "  --store-root <path>       Path to zao store root (default: ~/.zao)",
    "",
    "Examples:",
    "  zao run --flow default --task 'Refactor auth module'",
    "  zao run --blueprint feature-development --task 'Implement login'",
    "  zao crunch 'How do I add rate limiting to the API?'",
    "  zao analyze --store-root ~/.zao",
  ].join("\n");
  process.stdout.write(help + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────

/**
 * Human gate prompt when a loop closes (max iterations exceeded).
 *
 * v1 scope: Options 1 (continue) and 2 (stop) are functional.
 * Options 3 (modify) and 5 (ask_reviewer) are stubs — tracked as TD-010-D.
 * Option 4 (show full details) is functional.
 *
 * @see TD-010-D for full human gate implementation
 *
 * Displays a summary of loop iterations and prompts the user
 * to continue (add 2 more iterations) or stop (mark as failed).
 *
 * @param state - Loop close state with iteration summaries.
 * @returns The user's decision ("continue" or "stop").
 */
async function promptLoopClose(state: LoopCloseState): Promise<"continue" | "stop"> {
  process.stdout.write("\n");
  process.stdout.write("═".repeat(60) + "\n");
  process.stdout.write(
    `Loop closed: "${state.loopStepId}" after ${state.totalIterations} iterations\n`,
  );
  process.stdout.write("═".repeat(60) + "\n\n");

  for (const iteration of state.iterations) {
    process.stdout.write(`  Iteration ${iteration.iteration}:\n`);
    for (const sr of iteration.stepResults) {
      const statusIcon = sr.status === "success" ? "[OK]" : sr.status === "failed" ? "[FAIL]" : "[*]";
      process.stdout.write(
        `    ${statusIcon} ${sr.stepId}: ${sr.status}${sr.error ? ` (${sr.error})` : ""}\n`,
      );
    }
    if (iteration.reviewerOutput) {
      const ro = iteration.reviewerOutput;
      process.stdout.write(`    -> reviewer: ${ro.status}`);
      if (ro.findings && ro.findings.length > 0) {
        process.stdout.write(` -- ${ro.findings.join("; ")}`);
      }
      if (ro.recommended_next) {
        process.stdout.write(` (recommended: ${ro.recommended_next})`);
      }
      process.stdout.write("\n");
    }
    process.stdout.write("\n");
  }

  process.stdout.write(
    `Tokens: ${state.tokenUsage.prompt} prompt + ${state.tokenUsage.completion} completion\n\n`,
  );

  process.stdout.write("[HUMAN GATE]\n");
  process.stdout.write("Options:\n");
  process.stdout.write("  [1] Continue (add 2 more iterations)\n");
  process.stdout.write("  [2] Stop (mark as failed)\n");
  process.stdout.write("  [3] Modify (change task or approach)\n");
  process.stdout.write("  [4] Show full details\n");
  process.stdout.write("  [5] Ask reviewer for options\n\n");
  process.stdout.write("Your choice: ");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question("", (input: string) => {
        resolve(input.trim());
      });
    });

    switch (answer) {
      case "1":
        return "continue";
      case "2":
        return "stop";
      case "3":
        // TODO: TD-010-D — real modify implementation
        process.stdout.write(
          "Modify not yet implemented -- stopping execution. " +
            "Edit the blueprint and re-run.\n",
        );
        return "stop";
      case "4":
        // Show full details: dump the raw state as JSON
        process.stdout.write("\n--- Full Details ---\n");
        process.stdout.write(JSON.stringify(state, null, 2) + "\n");
        process.stdout.write("---\n\n");
        // Re-prompt
        return promptLoopClose(state);
      case "5":
        // TODO: TD-010-D — real ask_reviewer implementation
        process.stdout.write(
          "Asking reviewer for options... (v1 placeholder: stopping)\n",
        );
        return "stop";
      default:
        process.stdout.write("Invalid choice. Stopping (fail closed).\n");
        return "stop";
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs();

  // Initialize logger before any command dispatch
  __internalInitLogger(parsed.logLevel, parsed.format === "json");

  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  // ── Dispatch by subcommand ───────────────────────────────────
  const cmd = parsed.command ?? "run"; // default to "run" for backward compat

  switch (cmd) {
    case "crunch":
      return await runCrunchCommand(parsed);
    case "analyze":
      return await runAnalyzeCommand(parsed);
    case "run":
    default:
      return await runRunCommand(parsed);
  }
}

/** Shared HITL callback for tool approval. */
const onToolApproval = async (request: ToolApprovalRequest): Promise<ToolApprovalResponse> => {
  return requestToolApproval(request);
};

async function runRunCommand(parsed: ParsedArgs): Promise<void> {
  // Pre-dispatch validation
  const validationError = validateArgs(parsed);
  if (validationError) {
    process.stderr.write(`Error: ${validationError}\n`);
    process.stderr.write("Run with --help for usage.\n");
    process.exit(3);
  }

  // --blueprint mode (compile blueprint → flow → execute)
  if (parsed.blueprint) {
    try {
      const result = await execute({
        task: parsed.task,
        blueprintPackage: parsed.blueprint,
        autoYes: parsed.yes,
        projectDir: parsed.projectDir,
        format: parsed.format ?? "table",
        sandbox: !parsed.noSandbox,
        onLoopClose: promptLoopClose,
        onToolApproval,
      });

      if (parsed.format === "json") {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        if (result.success) {
          process.stdout.write(`Execution complete: ${result.executionId}\n`);
          process.stdout.write(`Steps: ${result.steps.length}\n`);
          process.stdout.write(
            `Tokens: ${result.tokenUsage.prompt} prompt + ${result.tokenUsage.completion} completion\n`,
          );
        } else {
          process.stdout.write(
            `Execution failed: ${result.error ?? "Unknown error"}\n`,
          );
        }
      }
      // ADR-008 Decision 4: validation=3, runtime=1, system=2.
      if (result.success) {
        process.exit(0);
      } else {
        process.exit(result.isValidationFailure ? 3 : 1);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Fatal error: ${message}\n`);
      process.exit(2);
    }
  }

  // --flow mode (default path)
  try {
    const result = await execute({
      task: parsed.task,
      flowPackage: parsed.flow,
      autoYes: parsed.yes,
      projectDir: parsed.projectDir,
      format: parsed.format ?? "table",
      sandbox: !parsed.noSandbox,
      onLoopClose: promptLoopClose,
      onToolApproval,
    });

    if (parsed.format === "json") {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      if (result.success) {
        process.stdout.write(`Execution complete: ${result.executionId}\n`);
        process.stdout.write(`Steps: ${result.steps.length}\n`);
        process.stdout.write(
          `Tokens: ${result.tokenUsage.prompt} prompt + ${result.tokenUsage.completion} completion\n`,
        );
      } else {
        process.stdout.write(
          `Execution failed: ${result.error ?? "Unknown error"}\n`,
        );
      }
    }

    // ADR-008 Decision 4: validation=3, runtime=1, system=2.
    if (result.success) {
      process.exit(0);
    } else {
      process.exit(result.isValidationFailure ? 3 : 1);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Fatal error: ${message}\n`);
    process.exit(2);
  }
}

async function runCrunchCommand(parsed: ParsedArgs): Promise<void> {
  // Pre-dispatch validation
  const validationError = validateArgs(parsed);
  if (validationError) {
    process.stderr.write(`Error: ${validationError}\n`);
    process.stderr.write("Run with --help for usage.\n");
    process.exit(3);
  }

  try {
    const { runCrunchCLI } = await import("./crunch-cli.ts");
    const result = await runCrunchCLI({
      question: parsed.question!,
      projectDir: parsed.projectDir,
      sandbox: !parsed.noSandbox,
      autoYes: parsed.yes,
      format: parsed.format ?? "table",
    });

    if (parsed.format === "json") {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      if (result.success) {
        process.stdout.write(`Crunch + execute complete: ${result.executionId}\n`);
        process.stdout.write(`Steps: ${result.steps.length}\n`);
        process.stdout.write(
          `Tokens: ${result.tokenUsage.prompt} prompt + ${result.tokenUsage.completion} completion\n`,
        );
      } else {
        process.stdout.write(
          `Crunch failed: ${result.error ?? "Unknown error"}\n`,
        );
      }
    }

    if (result.success) {
      process.exit(0);
    } else {
      process.exit(result.isValidationFailure ? 3 : 1);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Fatal error: ${message}\n`);
    process.exit(2);
  }
}

async function runAnalyzeCommand(parsed: ParsedArgs): Promise<void> {
  // Pre-dispatch validation
  const validationError = validateArgs(parsed);
  if (validationError) {
    process.stderr.write(`Error: ${validationError}\n`);
    process.stderr.write("Run with --help for usage.\n");
    process.exit(3);
  }

  try {
    const { runAnalyzeCLI } = await import("./analyze-cli.ts");
    const _result = await runAnalyzeCLI({
      storeRoot: parsed.storeRoot,
      format: parsed.format ?? "table",
    });
    void _result;

    process.exit(0);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Fatal error: ${message}\n`);
    process.exit(2);
  }
}

// ── Entry point ─────────────────────────────────────────────────────
//
// Guarded so importing this module for tests does not parse the test
// runner's argv or exit the test process.
//
// Exported so the unified CLI wrapper (bin/zao.ts) can call main()
// directly — import.meta.main is false when imported via dynamic import.

export async function run(): Promise<void> {
  await main();
}

if (import.meta.main) {
  await main();
}
