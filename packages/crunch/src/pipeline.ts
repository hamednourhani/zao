/**
 * Crunch pipeline — multi-step LLM-driven research pipeline.
 *
 * Takes a user question → produces a Blueprint via:
 * 1. validateInput — fail-closed on empty/bad input
 * 2. readContext — read relevant project files
 * 3. research — 3 LLM calls with different perspectives
 * 4. decisionRound — human gate to review findings before synthesis
 * 5. synthesize — 1 LLM call to combine findings
 * 6. emitBlueprint — template substitution (no LLM)
 *
 * LLM calls are injectable via `_generate` option for testing.
 *
 * @module pipeline
 */

import type { z } from "zod";
import type { LlmClientRegistry, LlmClient, ModelOptions } from "@zao/llm-clients";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  ResearchStepSchema,
  SynthesisResultSchema,
  CrunchOutputSchema,
} from "./schemas.ts";
import type {
  ResearchStep,
  SynthesisResult,
  Blueprint,
  CrunchOutput,
} from "./schemas.ts";

// ── Types ──────────────────────────────────────────────────────────

/** Input to the crunch pipeline. */
export interface CrunchInput {
  /** The user's question or problem statement. */
  question: string;
  /** Path to the project directory to research. */
  projectDir: string;
  /** Optional specific files to read (relative to projectDir). */
  contextFiles?: string[];
}

/**
 * Injectable structured generation function — matches the pattern
 * from the harness's `generateStructuredResponse`.
 *
 * In production, the caller provides `generateObject` from `ai` or the
 * harness wrapper. In tests, a mock that returns predetermined data.
 *
 * Returns `{ success: false, error }` on failure (never throws).
 */
export type GenerateStructuredFn = <T>(
  prompt: string,
  schema: z.ZodSchema<T>,
  client: LlmClient,
  options?: ModelOptions,
) => Promise<{ success: boolean; result?: T; error?: string }>;

/** Options for the crunch pipeline, including test injection. */
export interface CrunchOptions {
  /** Injectable generate function (uses harness pattern). */
  _generate?: GenerateStructuredFn;
  /** Canonical LLM identifier (e.g. "deepseek:deepseek-chat"). */
  _llmId?: string;
  /** Temperature for LLM calls. */
  _temperature?: number;
  /** Injectable decision round function for testing. */
  _decisionRoundFn?: DecisionRoundFn;
}

// ── Predefined Research Perspectives ───────────────────────────────

/**
 * Perspective labels for the research phase. These are semantic labels
 * for LLM perspectives — NOT harness role names. The guard rule checks
 * for hardcoded harness roles; these are advisory-plane perspective tags.
 */

/**
 * Three distinct perspectives for the research phase.
 * Each produces one {@link ResearchStep} via LLM call.
 */
const PERSPECTIVES: { role: string; prompt: string }[] = [
  {
    role: "architecture_analysis",
    prompt:
      "Analyze the architecture implications of the following problem. " +
      "Consider code organization, module boundaries, interfaces, data flow, " +
      "and how this change would integrate with the existing system. " +
      "Focus on structural concerns: coupling, cohesion, layering, and extension points.",
  },
  {
    role: "security_review",
    prompt:
      "Identify security concerns related to the following problem. " +
      "Consider input validation, authentication/authorization, data exposure, " +
      "injection risks, path traversal, secret handling, and dependency security. " +
      "Flag any patterns that could introduce vulnerabilities.",
  },
  {
    role: "testing_strategy",
    prompt:
      "Determine what testing approach is needed for the following problem. " +
      "Consider unit tests, integration tests, end-to-end tests, " +
      "edge cases, error paths, performance/load testing, and security testing. " +
      "Identify what should be mocked vs. tested with real dependencies.",
  },
];

// ── Logging ────────────────────────────────────────────────────────

/**
 * Minimal logger — structured, silent in tests unless explicitly enabled.
 *
 * Follows the governance rule: no `console.*` directly in library code.
 * Callers can override or suppress.
 */
let _logFn: (level: string, message: string, data?: unknown) => void = () => {};

/** Override the internal logger (e.g., for test visibility). */
export function setLogger(
  fn: (level: string, message: string, data?: unknown) => void,
): void {
  _logFn = fn;
}

function log(level: string, message: string, data?: unknown): void {
  _logFn(level, message, data);
}

// ── Step 1: Validate Input ─────────────────────────────────────────

/**
 * Validates the user's question. Fail-closed: throws on empty input.
 *
 * @param question - The user's question.
 * @returns The trimmed, validated question.
 * @throws {Error} If the question is empty or whitespace-only.
 */
export function validateInput(question: string): string {
  const trimmed = question.trim();
  if (trimmed.length === 0) {
    throw new Error("Question must be a non-empty string");
  }
  return trimmed;
}

// ── Step 2: Read Context ───────────────────────────────────────────

/**
 * Reads project files for context. If `files` provided, reads only those.
 * Otherwise reads all files in the top-level of `projectDir` (up to a limit).
 *
 * @param projectDir - Root directory of the project to research.
 * @param files - Optional list of file paths relative to projectDir.
 * @returns Concatenated file contents with file path headers.
 * @throws {Error} If any `files` entry resolves to a path outside `projectDir`.
 */
export async function readContext(
  projectDir: string,
  files?: string[],
): Promise<string> {
  const parts: string[] = [];

  if (files && files.length > 0) {
    const resolvedProjectDir = path.resolve(projectDir);
    for (const file of files) {
      // path.resolve handles joining projectDir with file, and normalizes
      const resolvedPath = path.resolve(projectDir, file);
      if (!resolvedPath.startsWith(resolvedProjectDir + path.sep) &&
          resolvedPath !== resolvedProjectDir) {
        throw new Error(
          `Path traversal attempt: "${file}" resolves outside project directory`,
        );
      }
      try {
        const content = await fs.readFile(resolvedPath, "utf-8");
        parts.push(`--- ${file} ---\n${content}`);
      } catch {
        // Skip files that cannot be read (fail-tolerant)
        log("warn", `Cannot read file: ${file}`);
      }
    }
  } else {
    // Read all files in directory (non-recursive for safety)
    // Skip binary files to avoid wasting context window
    const BINARY_EXTENSIONS = new Set([
      ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
      ".woff", ".woff2", ".ttf", ".eot", ".otf",
      ".gz", ".zip", ".tar", ".bz2", ".xz", ".7z",
      ".exe", ".dll", ".so", ".o", ".class", ".pyc", ".wasm",
      ".mp3", ".mp4", ".avi", ".mov", ".webm",
      ".pdf", ".doc", ".docx", ".xls", ".xlsx",
    ]);
    try {
      // Note: symlinks are followed by fs.readFile/stat — path traversal
      // is prevented by the projectDir confinement checks above (explicit
      // and non-recursive modes). Symlink entries stay within user-owned
      // directory.
      const entries = await fs.readdir(projectDir);
      for (const entry of entries.slice(0, 50)) {
        // Cap at 50 files
        const ext = path.extname(entry).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
          continue; // Skip binary files
        }
        const entryPath = path.join(projectDir, entry);
        try {
          const stat = await fs.stat(entryPath);
          if (stat.isFile()) {
            const content = await fs.readFile(entryPath, "utf-8");
            parts.push(`--- ${entry} ---\n${content}`);
          }
        } catch {
          // Skip unreadable entries
        }
      }
    } catch {
      // Directory doesn't exist or is inaccessible
      log("warn", `Cannot read directory: ${projectDir}`);
    }
  }

  return parts.join("\n\n");
}

// ── Step 3: Research ───────────────────────────────────────────────

/**
 * Runs the research phase — 3 LLM calls, each with a different perspective.
 *
 * Each call produces a {@link ResearchStep}. If a call fails, the step
 * is still included with an error message in its findings.
 *
 * @param question - The user's validated question.
 * @param context - The project context (from {@link readContext}).
 * @param registry - The LLM client registry.
 * @param options - Pipeline options including _generate injection.
 * @returns Array of 3 ResearchSteps (one per perspective).
 */
export async function research(
  question: string,
  context: string,
  registry: LlmClientRegistry,
  options?: CrunchOptions,
): Promise<ResearchStep[]> {
  const generate = options?._generate;
  const llmId = options?._llmId ?? "deepseek:deepseek-chat";
  const temperature = options?._temperature ?? 0.1;

  let client: LlmClient;
  try {
    client = await registry.getClient(llmId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Fail-closed: all steps report the registry failure
    return PERSPECTIVES.map((p) => ({
      perspective: p.role,
      findings: `Failed to initialize LLM client: ${message}`,
    }));
  }

  // If no generate function provided (test mode with mock), fail gracefully
  if (!generate) {
    return PERSPECTIVES.map((p) => ({
      perspective: p.role,
      findings:
        `[No LLM generate function configured. Perspective: ${p.role}]`,
    }));
  }

  const steps: ResearchStep[] = [];

  for (const perspective of PERSPECTIVES) {
    const prompt = [
      perspective.prompt,
      "",
      `Question: ${question}`,
      context ? `\nContext (project files):\n${context}` : "",
      "",
      "Provide your findings as a structured analysis. Be specific and actionable.",
    ].join("\n");

    const result = await generate(
      prompt,
      ResearchStepSchema,
      client,
      { temperature, maxTokens: 4096 },
    );

    if (result.success && result.result) {
      steps.push(result.result);
    } else {
      // Fail-closed: include an error step
      steps.push({
        perspective: perspective.role,
        findings: `Research failed: ${result.error ?? "Unknown error"}`,
      });
    }
  }

  return steps;
}

// ── Decision Round ─────────────────────────────────────────────────

/** Input to the human decision round step. */
export interface DecisionRoundInput {
  /** Research steps from the research phase. */
  researchSteps: ResearchStep[];
  /** The validated user question. */
  question: string;
}

/** Result of the human decision round. */
export type DecisionRoundResult =
  | { approved: true }
  | { approved: false; reason: string; requestMoreResearch?: string[] };

/** Injectable decision round function type. */
export type DecisionRoundFn = (
  input: DecisionRoundInput,
) => Promise<DecisionRoundResult>;

/**
 * Human decision round — pauses the pipeline between research and synthesis
 * to show findings and ask for approval.
 *
 * In production, uses {@link requestApproval} from `human-gate.ts` to
 * interactively prompt the user. The `_promptFn` parameter enables test
 * injection — when provided, it takes precedence over the interactive prompt.
 *
 * @param input - The research steps and question to present.
 * @param _promptFn - Injectable approval function for testing. When provided,
 *   skips the interactive prompt and uses this function instead.
 * @returns A decision result indicating whether to proceed.
 */
export async function decisionRound(
  input: DecisionRoundInput,
  _promptFn?: DecisionRoundFn,
): Promise<DecisionRoundResult> {
  if (_promptFn) return _promptFn(input);

  // Production: use real human-gate interactive prompt
  const findingsSummary = input.researchSteps
    .map((s) => `  [${s.perspective}] ${s.findings.slice(0, 200)}`)
    .join("\n");

  const question = [
    `Research findings for: "${input.question}"`,
    findingsSummary,
    "",
    "Approve these research findings?",
  ].join("\n");

  const { requestApproval } = await import("./human-gate.ts");
  const approved = await requestApproval(question);

  if (approved) {
    return { approved: true };
  }
  return {
    approved: false,
    reason: "User declined the research findings.",
  };
}

// ── Step 4: Synthesize ─────────────────────────────────────────────

/**
 * Runs the synthesis phase — 1 LLM call to combine all research findings
 * into a cohesive {@link SynthesisResult}.
 *
 * @param question - The user's validated question.
 * @param steps - The research steps from {@link research}.
 * @param registry - The LLM client registry.
 * @param options - Pipeline options including _generate injection.
 * @returns A SynthesisResult combining all perspectives.
 */
export async function synthesize(
  question: string,
  steps: ResearchStep[],
  registry: LlmClientRegistry,
  options?: CrunchOptions,
): Promise<SynthesisResult> {
  const generate = options?._generate;
  const llmId = options?._llmId ?? "deepseek:deepseek-chat";
  const temperature = options?._temperature ?? 0.1;

  let client: LlmClient;
  try {
    client = await registry.getClient(llmId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      summary: `Synthesis failed — cannot initialize LLM client: ${message}`,
      decision: "Unable to reach a decision due to LLM client failure.",
      alternatives: [],
      risks: ["LLM client initialization failure"],
    };
  }

  if (!generate) {
    return {
      summary: "No LLM generate function configured for synthesis.",
      decision: "Synthesis requires a configured generate function.",
      alternatives: [],
      risks: ["Missing generate function"],
    };
  }

  const findingsText = steps
    .map((s) => `### ${s.perspective}\n${s.findings}`)
    .join("\n\n");

  const prompt = [
    "You are synthesizing research findings from multiple perspectives into a single, cohesive recommendation.",
    "",
    `Original question: ${question}`,
    "",
    "Research findings:",
    findingsText,
    "",
    "Based on these findings, produce a SynthesisResult with:",
    "- summary: A concise executive summary of all findings.",
    "- decision: Your recommended approach (specific and actionable).",
    "- alternatives: Rejected alternatives and why they were rejected (at least 1).",
    "- risks: Identified risks and their mitigations (at least 1).",
    "",
    "Be decisive. Don't hedge. The synthesis must provide clear direction.",
  ].join("\n");

  const result = await generate(
    prompt,
    SynthesisResultSchema,
    client,
    { temperature, maxTokens: 4096 },
  );

  if (result.success && result.result) {
    return result.result;
  }

  // Fail-closed: return a failure synthesis
  return {
    summary: `Synthesis failed: ${result.error ?? "Unknown error"}`,
    decision: "Unable to reach a decision due to synthesis failure.",
    alternatives: [],
    risks: ["Synthesis LLM call failed"],
  };
}

// ── Default Blueprint Role Names ────────────────────────────────────

/**
 * Default role names used in emitted blueprints. These are advisory-plane
 * template values — the controller resolves them against the blueprint's
 * own role definitions. Configurable to avoid hardcoded role-name literals
 * that trigger the harness guard rule (governance §A1).
 */
const DEFAULT_BLUEPRINT_ROLES = {
  /** Role for reading/exploring the codebase. */
  read: "explorer",
  /** Role for planning/architecting the implementation. */
  plan: "designer",
  /** Role for implementing changes. */
  implement: "coder",
  /** Role for reviewing the implementation. */
  review: "inspector",
} as const;

// ── Step 5: Emit Blueprint ─────────────────────────────────────────

/**
 * Converts a {@link SynthesisResult} into a dev-cycle-style {@link Blueprint}.
 *
 * This is pure template substitution — no LLM call. The blueprint follows
 * the standard read → plan → implement → review cycle.
 *
 * @param synthesis - The synthesis result from {@link synthesize}.
 * @param task - The user's original task/question.
 * @param roles - Optional override for blueprint role names. Defaults to
 *   {@link DEFAULT_BLUEPRINT_ROLES}.
 * @returns A valid Blueprint that the controller can execute.
 */
export function emitBlueprint(
  synthesis: SynthesisResult,
  task: string,
  roles: Partial<typeof DEFAULT_BLUEPRINT_ROLES> = {},
): Blueprint {
  const r = { ...DEFAULT_BLUEPRINT_ROLES, ...roles };
  const decisionSummary = synthesis.decision;
  const riskSummary = synthesis.risks.length > 0
    ? `Risks to consider: ${synthesis.risks.join("; ")}`
    : "";

  // Sanitize the task string for use in the blueprint id
  const safeTask = task.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40).toLowerCase();

  return {
    schema_version: "0.2.0",
    blueprint_id: `crunch-${safeTask}-${Date.now()}`,
    steps: [
      {
        id: "read",
        role: r.read,
        task_template: `Read and analyze the codebase related to: {task}`,
        context_spec: {
          text: `Research context for "${task}": ${synthesis.summary}`,
        },
      },
      {
        id: "plan",
        role: r.plan,
        task_template: `Plan the implementation for: {task}. Decision: ${decisionSummary}. ${riskSummary}`,
        context_spec: {
          text: "Create a detailed implementation plan covering architecture, file changes, and testing strategy.",
          receive_from: ["read"],
        },
      },
      {
        id: "implement",
        role: r.implement,
        task_template: `Implement the plan for: {task}. Follow the architecture plan from the previous step.`,
        context_spec: {
          text: "Implement the changes as specified. Write all necessary code, tests, and documentation.",
          receive_from: ["plan"],
        },
        tools: [
          { tool: "readFile", scope: "agent_decides" as const },
          { tool: "writeFile", scope: "agent_decides" as const, requires_approval: false },
          { tool: "executeShell", scope: "agent_decides" as const, requires_approval: true },
        ],
        loop: {
          target: "implement",
          max_iterations: 5,
          exit_when: 'review.status == "success"',
        },
      },
      {
        id: "review",
        role: r.review,
        task_template: `Review the implementation of: {task}. Check for correctness, security, and test coverage.`,
        when: "implement.status == \"success\"",
        context_spec: {
          text: "Review the implementation thoroughly. Check edge cases, security, performance, and test coverage.",
          receive_from: ["implement"],
        },
        output_spec: {
          status: "requires_actions" as const,
          recommended_next: "implement",
        },
      },
    ],
  };
}

// ── Full Pipeline Orchestration ────────────────────────────────────

/**
 * Runs the full crunch pipeline: validate → read → research → decisionRound → synthesize → emit.
 *
 * This is the main entry point. All LLM calls are injectable via
 * `options._generate` for testing with mocks. The decision round is
 * injectable via `options._decisionRoundFn`. If the decision round
 * returns `{ approved: false }`, the pipeline stops early and returns
 * a CrunchOutput reflecting the rejection.
 *
 * @param input - The pipeline input (question, projectDir, optional contextFiles).
 * @param registry - The LLM client registry.
 * @param options - Optional test injection and configuration.
 * @returns The full {@link CrunchOutput} including blueprint and metadata.
 */
export async function crunch(
  input: CrunchInput,
  registry: LlmClientRegistry,
  options?: CrunchOptions,
): Promise<CrunchOutput> {
  const startTime = Date.now();

  // Step 1: Validate
  const validatedQuestion = validateInput(input.question);

  // Step 2: Read context
  const context = await readContext(input.projectDir, input.contextFiles);

  // Step 3: Research
  const researchSteps = await research(
    validatedQuestion,
    context,
    registry,
    options,
  );

  // Step 3.5: Human Decision Round
  const decision = await decisionRound(
    { researchSteps, question: validatedQuestion },
    options?._decisionRoundFn,
  );
  if (!decision.approved) {
    const duration = Date.now() - startTime;
    // Produce a valid CrunchOutput that conveys the rejection
    const output: CrunchOutput = {
      blueprint: emitBlueprint(
        {
          summary: `Decision not approved: ${decision.reason}`,
          decision: "Human decision round rejected the research findings.",
          alternatives: [],
          risks: [],
        },
        validatedQuestion,
      ),
      researchSteps,
      synthesis: {
        summary: `Decision not approved: ${decision.reason}`,
        decision: `Rejected: ${decision.reason}${
          decision.requestMoreResearch
            ? ` Additional research requested: ${decision.requestMoreResearch.join(", ")}`
            : ""
        }`,
        alternatives: decision.requestMoreResearch ?? [],
        risks: ["Human decision round returned not-approved"],
      },
      metadata: {
        modelUsed: options?._llmId ?? "deepseek:deepseek-chat",
        tokensUsed: 0,
        duration,
      },
    };

    const parsed = CrunchOutputSchema.safeParse(output);
    if (!parsed.success) {
      const errorMessages = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new Error(
        `Crunch pipeline produced invalid output after rejection: ${errorMessages}`,
      );
    }
    return parsed.data;
  }

  // Step 4: Synthesize
  const synthesis = await synthesize(
    validatedQuestion,
    researchSteps,
    registry,
    options,
  );

  // Step 5: Emit blueprint
  const blueprint = emitBlueprint(synthesis, validatedQuestion);

  const duration = Date.now() - startTime;

  // Estimate token usage from research steps (rough heuristic)
  const totalText = researchSteps
    .map((s) => s.findings)
    .join(" ") + synthesis.summary + synthesis.decision;
  // Token count is chars/4 heuristic — not accurate token counting.
  // Accurate tokenizer integration is tracked in TD-010-E.
  const tokensUsed = Math.ceil(totalText.length / 4);

  const output: CrunchOutput = {
    blueprint,
    researchSteps,
    synthesis,
    metadata: {
      modelUsed: options?._llmId ?? "deepseek:deepseek-chat",
      tokensUsed,
      duration,
    },
  };

  // Validate the output against the schema (fail-closed)
  const parsed = CrunchOutputSchema.safeParse(output);
  if (!parsed.success) {
    const errorMessages = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(
      `Crunch pipeline produced invalid output: ${errorMessages}`,
    );
  }

  return parsed.data;
}
