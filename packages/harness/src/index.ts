/**
 * zao — A deterministic, file-based, single-job harness.
 *
 * Entry point for the CLI. Parses arguments and dispatches to the
 * appropriate command handler. All commands fail-closed: missing or
 * invalid arguments result in an error and usage output, never a guess.
 *
 * ## Single-job identity (TD-029-F)
 *
 * The harness is now a pure single-job executor. Flow/orchestration logic
 * has moved to the controller. `zao run` executes exactly one task with
 * one role per invocation.
 *
 * ## Exit codes (TD-020)
 *
 * | Code | Meaning |
 * |---|---|
 * | 0 | success |
 * | 1 | run failed (LLM error) |
 * | 2 | usage error (bad flags, missing task, unknown command) |
 * | 3 | validation error (unknown session, etc.) |
 *
 * @module index
 */

import { runLoop } from "./core/loop.ts";
import type { RunLoopParams } from "./core/loop.ts";
import { handleSessionList, parseSessionListArgs, handleSessionShow, handleBranch, handleSessionTree } from "./cli/session.ts";
import { resumeSession } from "./core/resume.ts";
import type { ResolvedRoleDefinition } from "./schemas/role-definition.ts";
import { boot } from "./core/boot.ts";
import { logger } from "./core/logger.ts";

// ── Exit Code Constants ───────────────────────────────────────────────

const EXIT_RUN_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_VALIDATION = 3;

// ── Built-in Roles ────────────────────────────────────────────────────

/**
 * Minimal built-in role definitions for the slimmed harness.
 * The harness no longer loads roles from config files — the caller
 * (controller or CLI) provides the role definition directly.
 * These built-in roles provide sensible defaults for CLI users.
 */
const BUILTIN_ROLES: Record<string, ResolvedRoleDefinition> = {
  developer: {
    prompt_template:
      "You are a developer agent. Write production-quality code following " +
      "the project's conventions and patterns. Prioritize readability, " +
      "defensive error handling, and comprehensive type safety.",
    context_budget: 0.65,
    model: "deepseek-chat",
    llm_id: "deepseek:deepseek-chat",
    provenance: "built-in",
    model_provenance: "built-in",
  },
  planner: {
    prompt_template:
      "You are a planning agent. Break down complex tasks into ordered " +
      "steps with clear dependencies. Identify risks, prerequisites, " +
      "and decision points before execution begins.",
    context_budget: 0.70,
    model: "deepseek-chat",
    llm_id: "deepseek:deepseek-chat",
    provenance: "built-in",
    model_provenance: "built-in",
  },
  reviewer: {
    prompt_template:
      "You are a code reviewer. Analyze code for security vulnerabilities, " +
      "correctness issues, and adherence to conventions. Identify edge " +
      "cases, potential bugs, and deviations from established patterns.",
    context_budget: 0.40,
    model: "deepseek-chat",
    llm_id: "deepseek:deepseek-chat",
    provenance: "built-in",
    model_provenance: "built-in",
  },
  architect: {
    prompt_template:
      "You are an architect. Design systems, choose appropriate patterns, " +
      "and define clear interfaces between components. Evaluate tradeoffs " +
      "and document the rationale behind each design decision.",
    context_budget: 0.60,
    model: "deepseek-chat",
    llm_id: "deepseek:deepseek-chat",
    provenance: "built-in",
    model_provenance: "built-in",
  },
};

// ── Usage ──────────────────────────────────────────────────────────────

function printUsage(exitCode: number): never {
  const usage = [
    "Usage: zao <command> [args]",
    "",
    "Commands:",
    "  run [--yes] [--role <name>] <task>           Execute a single task with one role",
    "  continue <session_id> [--yes] [--recent-events N]  Resume an interrupted or failed session",
    "  branch <session_id> [--from-checkpoint <id>]  Create a branched peer session",
    "  session list [--status ...] [--repo ...] [--since ...]  List sessions from the global index",
    "  session show <session_id> [--format json]     Show details for a session (read-only)",
    "  session tree <session_id>                     Show agent and branch trees",
    "",
    "Options:",
    "  --yes, -y              Auto-approve Tier 2 actions (Tier 1 always prompts)",
    "  --role <name>          Role to execute the task as (developer, planner, reviewer, architect)",
    "                         Default: developer",
    "  --verbose, -v          Enable debug-level logging",
    "  --debug                Enable debug-level logging",
    "  --quiet, -q            Suppress all log output except errors",
    "  --recent-events N      Number of recent events to include in resume context (default: 3)",
    "",
    "Session list flags:",
    "  --status <status>      Filter by status (active, complete, failed, interrupted)",
    "  --repo <path>          Filter by repository path",
    "  --since <YYYY-MM-DD>   Show sessions created on or after this date",
    "  --limit <N>            Maximum number of sessions to show",
    "  --format table|json    Output format (default: table)",
    "",
    "Exit codes:",
    "  0   success",
    "  1   run failed",
    "  2   usage error",
    "  3   validation error",
    "",
    "Examples:",
    '  zao run "Implement user authentication"',
    '  zao run --role planner "Plan the API design"',
    '  zao run --yes --role reviewer "Review the auth module"',
    "  zao continue abc123def456",
    "  zao continue abc123def456 --yes",
    "  zao session list",
    '  zao session list --status complete --limit 5',
    '  zao session show abc123def456',
  ].join("\n");

  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(usage + "\n");
  process.exit(exitCode);
}

// ── Argument Parsing ───────────────────────────────────────────────────

function parseArgs(): {
  command: string;
  args: string[];
  autoYes: boolean;
  roleName: string;
  roleExplicit: boolean;
  logLevel: "error" | "warn" | "info" | "debug";
} {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0) {
    printUsage(EXIT_USAGE);
  }

  let autoYes = false;
  // guard:ignore R4-no-hardcoded-roles — built-in defaults for slimmed single-job harness
  let roleName = "developer";
  let roleExplicit = false;
  let logLevel: "error" | "warn" | "info" | "debug" = "info";
  const filtered: string[] = [];

  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i]!;
    if (arg === "--yes" || arg === "-y") {
      autoYes = true;
      i++;
    } else if (arg === "--verbose" || arg === "-v" || arg === "--debug") {
      logLevel = "debug";
      i++;
    } else if (arg === "--quiet" || arg === "-q") {
      logLevel = "error";
      i++;
    } else if (arg === "--role") {
      i++;
      if (i < rawArgs.length) {
        const val = rawArgs[i]!;
        if (BUILTIN_ROLES[val]) {
          roleName = val;
          roleExplicit = true;
        } else {
          process.stderr.write(
            `Error: Unknown role "${val}". Available roles: ${Object.keys(BUILTIN_ROLES).join(", ")}.\n\n`,
          );
          printUsage(EXIT_VALIDATION);
        }
        i++;
      } else {
        process.stderr.write(
          'Error: --role flag requires a role name.\n\n',
        );
        printUsage(EXIT_USAGE);
      }
    } else {
      filtered.push(arg);
      i++;
    }
  }

  if (filtered.length === 0) {
    printUsage(EXIT_USAGE);
  }

  const command = filtered[0]!;
  const args = filtered.slice(1);

  return { command, args, autoYes, roleName, roleExplicit, logLevel };
}

// ── Run Command Handler ────────────────────────────────────────────────

async function handleRun(
  args: string[],
  autoYes: boolean,
  roleName: string,
): Promise<void> {
  if (args.length === 0) {
    process.stderr.write(
      'Error: Missing task description for "run" command.\n' +
        "Provide a task as a single argument, e.g.:\n" +
        '  zao run "Your task here"\n\n'
    );
    printUsage(EXIT_USAGE);
  }

  const task = args.join(" ");

  if (autoYes) {
    logger.info("Auto-approve mode enabled (--yes). Tier 2 actions will be auto-approved.");
  }
  logger.info(`Role: ${roleName}`);
  logger.info(`Running task: ${task}\n`);

  const roleDef = BUILTIN_ROLES[roleName]!;
  const loopParams: RunLoopParams = {
    task,
    autoYes,
    roleName,
    _roleDef: roleDef,
  };

  const result = await runLoop(loopParams);

  if (result.success) {
    logger.info("✓ Task completed successfully.");
    logger.info(`  Session: ${result.sessionDir}`);
    logger.info(`  Artifact: ${result.artifactPath}`);
  } else {
    process.stderr.write(
      `✗ Task failed.\n` +
        `  Session: ${result.sessionDir}\n` +
        `  Error: ${result.error ?? "Unknown error"}\n`
    );
    process.exit(EXIT_RUN_FAILED);
  }
}

// ── Continue Command Handler ────────────────────────────────────────────

async function handleContinue(
  args: string[],
  autoYes: boolean,
  roleExplicit: boolean,
  roleName: string,
): Promise<void> {
  if (args.length === 0) {
    process.stderr.write(
      'Error: Missing session id for "continue" command.\n' +
        "Provide a session id, e.g.:\n" +
        "  zao continue abc123def456\n\n",
    );
    printUsage(EXIT_USAGE);
  }

  // ── Immutability guard: --role is ignored on resume ──────────
  if (roleExplicit) {
    process.stderr.write(
      "Warning: Session config is immutable. " +
        `Replaying original role. --role ${roleName} is ignored.\n\n`,
    );
  }

  const continueSessionId = args[0]!;

  // Extract --recent-events N from remaining args
  let recentEvents = 3;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--recent-events") {
      i++;
      if (i < args.length) {
        const n = parseInt(args[i]!, 10);
        if (!isNaN(n) && n > 0) {
          recentEvents = n;
        }
      }
      break;
    }
  }

  const result = await resumeSession(continueSessionId, {
    yes: autoYes,
    recentEvents,
  });

  if (result.success) {
    logger.info("✓ Session resumed and completed successfully.");
    logger.info(`  Session: ${result.sessionDir}`);
  } else {
    const errorMsg = result.error ?? "Unknown error";
    const exitCode = result.isValidationError ? EXIT_VALIDATION : EXIT_RUN_FAILED;
    process.stderr.write(`✗ Resume failed: ${errorMsg}\n`);
    process.exit(exitCode);
  }
}

// ── Session Command Handlers ────────────────────────────────────────────

async function handleSession(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand) {
    process.stderr.write(
      'Error: "session" requires a subcommand (list, show).\n\n',
    );
    printUsage(EXIT_USAGE);
  }
  if (subcommand === "list") {
    const flags = parseSessionListArgs(args.slice(1));
    await handleSessionList(flags);
  } else if (subcommand === "show") {
    const showArgs = args.slice(1);
    const showSessionId = showArgs[0];
    if (!showSessionId) {
      process.stderr.write(
        'Error: Missing session id for "session show".\n' +
          'Usage: zao session show <id> [--format json]\n\n',
      );
      process.exit(EXIT_USAGE);
    }

    let format: "table" | "json" = "table";
    for (let i = 1; i < showArgs.length; i++) {
      if (showArgs[i] === "--format") {
        i++;
        if (i < showArgs.length && showArgs[i] === "json") {
          format = "json";
        }
        break;
      }
    }

    const showResult = await handleSessionShow({ sessionId: showSessionId, format });
    if (!showResult.success) {
      process.stderr.write(showResult.error + "\n");
      process.exit(showResult.isValidationError ? EXIT_VALIDATION : EXIT_RUN_FAILED);
    }
  } else if (subcommand === "tree") {
    const treeArgs = args.slice(1);
    const treeSessionId = treeArgs[0];
    if (!treeSessionId) {
      process.stderr.write(
        'Error: Missing session id for "session tree".\n' +
          'Usage: zao session tree <id>\n\n',
      );
      process.exit(EXIT_USAGE);
    }
    await handleSessionTree(treeSessionId);
  } else {
    process.stderr.write(
      `Error: Unknown session subcommand "${subcommand}".\n` +
        'Available: list, show\n\n',
    );
    process.exit(EXIT_USAGE);
  }
}

// ── Main Entry Point ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, args, autoYes, roleName, roleExplicit, logLevel } = parseArgs();
  boot({ logLevel, jsonMode: false });
  switch (command) {
    case "run":
      await handleRun(args, autoYes, roleName);
      break;
    case "continue":
      await handleContinue(args, autoYes, roleExplicit, roleName);
      break;
    case "session":
      await handleSession(args);
      break;
    case "branch":
      if (args.length === 0) {
        process.stderr.write(
          'Error: Missing session id for "branch" command.\n' +
            "Usage: zao branch <session_id> [--from-checkpoint <id>]\n\n",
        );
        process.exit(EXIT_USAGE);
      }
      {
        const branchSourceId = args[0]!;
        let branchFromCheckpoint: string | undefined;
        for (let i = 1; i < args.length; i++) {
          if (args[i] === "--from-checkpoint") {
            i++;
            if (i < args.length) {
              branchFromCheckpoint = args[i];
            }
            break;
          }
        }
        await handleBranch({ sourceId: branchSourceId, fromCheckpoint: branchFromCheckpoint });
      }
      break;
    default:
      process.stderr.write(
        `Error: Unknown command "${command}".\n` +
          `Run "zao" without arguments to see available commands.\n\n`
      );
      process.exit(EXIT_USAGE);
  }
}

main();
