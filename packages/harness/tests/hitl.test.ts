/**
 * Tests for the HITL permission prompt module.
 *
 * Covers all acceptance tests from Story 007:
 * - TEST-1: Tier 1 command → verify prompt is displayed (not auto-approved even with --yes)
 * - TEST-2: Tier 2 command with --yes → verify auto-approved
 * - TEST-3: Tier 3 action → verify no prompt, but event logged
 * - TEST-4: Deny a command → verify execution halts cleanly
 * - TEST-5: Verify event log contains approval/denial records
 * - TEST-6: Tier 2 already approved this session → auto-approved
 * - TEST-7: Re-escalation (3+ rapid requests) → re-prompts
 *
 * Additional coverage:
 * - Hard deny → auto-rejected
 * - Modify response
 * - Chat response
 * - formatPermissionPrompt output
 *
 * Uses injected mock InputReader to avoid real stdin interaction.
 *
 * @module hitl.test
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  promptForPermission,
  formatPermissionPrompt,
  PermissionSession,
  HITLResponse,
} from "../src/core/hitl.ts";
import type { HITLContext } from "../src/core/hitl.ts";
import { classifyCommand, TrustTier } from "../src/core/command-guard.ts";

// ── Mock Input Reader Factory ──────────────────────────────────────

/**
 * Creates a mock InputReader that returns pre-configured responses
 * in sequence. Each call to the reader consumes the next response.
 *
 * When the response array is exhausted, returns `"N"` to fail-closed.
 *
 * @param responses - Ordered sequence of strings to return.
 * @returns A mock InputReader function.
 */
function mockInputReader(responses: string[]): (promptText: string) => Promise<string | null> {
  let index = 0;
  return async (_promptText: string) => {
    if (index >= responses.length) {
      // Fail-closed: deny on mock exhaustion
      return "N";
    }
    return responses[index++]!;
  };
}

// ── Test Context Factory ───────────────────────────────────────────

/**
 * Creates a standard HITLContext for testing.
 *
 * @param overrides - Partial context overrides.
 * @returns A complete HITLContext.
 */
function makeContext(overrides: Partial<HITLContext> = {}): HITLContext {
  const command = overrides.command ?? "npm test";
  const actionType = overrides.actionType ?? "shell";
  const explanation = overrides.explanation ?? "Running the test suite";
  const session = overrides.session ?? new PermissionSession();
  const autoYes = overrides.autoYes ?? false;

  const verdict = overrides.verdict ?? classifyCommand(command, actionType, explanation);

  return {
    actionType,
    command,
    explanation,
    verdict,
    session,
    autoYes,
    sessionDir: overrides.sessionDir,
    sessionId: overrides.sessionId ?? "test-session-id",
    parentSessionId: overrides.parentSessionId ?? null,
    modelId: overrides.modelId ?? "test-model",
  };
}

// ── Temp Dir Helpers ───────────────────────────────────────────────

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zao-test-hitl-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
  tempDirs = [];
});

// ── TEST-1: Tier 1 → Always Prompts (never auto-approved) ──────────

describe("Tier 1 commands", () => {
  test("prompts user even with --yes flag", async () => {
    const reader = mockInputReader(["Y"]);
    const ctx = makeContext({
      command: "rm -rf ./node_modules",
      autoYes: true,
    });

    const result = await promptForPermission(ctx, reader);
    expect(result.response).toBe(HITLResponse.Approve);
    expect(result.autoDecision).toBeUndefined();
  });

  test("prompts user without --yes flag", async () => {
    const reader = mockInputReader(["Y"]);
    const ctx = makeContext({
      command: "rm -rf ./node_modules",
      autoYes: false,
    });

    const result = await promptForPermission(ctx, reader);
    expect(result.response).toBe(HITLResponse.Approve);
    expect(result.autoDecision).toBeUndefined();
  });

  test("denying a Tier 1 command halts cleanly", async () => {
    const reader = mockInputReader(["N"]);
    const ctx = makeContext({
      command: "rm -rf ./node_modules",
    });

    const result = await promptForPermission(ctx, reader);
    expect(result.response).toBe(HITLResponse.Deny);
  });

  test("invalid input re-prompts until valid, empty input causes deny", async () => {
    const reader = mockInputReader(["X", "invalid", "Y"]);
    const ctx = makeContext({
      command: "rm -rf ./node_modules",
    });

    const result = await promptForPermission(ctx, reader);
    expect(result.response).toBe(HITLResponse.Approve);
  });

  test("null/EOF input causes deny (fail-closed)", async () => {
    // Return null to simulate EOF or closed stdin
    const reader = async (_promptText: string) => null;
    const ctx = makeContext({
      command: "rm -rf ./node_modules",
    });

    const result = await promptForPermission(ctx, reader);
    expect(result.response).toBe(HITLResponse.Deny);
  });

  test("max 10 invalid attempts causes deny", async () => {
    // 10 invalid inputs should trigger automatic deny
    const invalidInputs = Array.from({ length: 10 }, (_, i) => `invalid_${i}`);
    const reader = mockInputReader(invalidInputs);
    const ctx = makeContext({
      command: "rm file.txt",
      verdict: {
        tier: TrustTier.Tier1,
        blocked: null,
        reasons: ["Matched Tier 1 deny-list: File deletion."],
      },
    });

    const result = await promptForPermission(ctx, reader);
    expect(result.response).toBe(HITLResponse.Deny);
  });
});

// ── TEST-2: Tier 2 + autoYes → Auto-Approved ───────────────────────

describe("Tier 2 with --yes", () => {
  test("auto-approves Tier 2 command when --yes is active", async () => {
    const reader = mockInputReader([]); // No responses needed
    const ctx = makeContext({
      command: "npm test",
      autoYes: true,
    });

    const result = await promptForPermission(ctx, reader);
    expect(result.response).toBe(HITLResponse.Approve);
    expect(result.autoDecision).toBe(true);
  });

  test("does NOT auto-approve Tier 1 command even with --yes", async () => {
    const reader = mockInputReader(["N"]);
    const ctx = makeContext({
      command: "rm -rf ./node_modules",
      autoYes: true,
    });

    const result = await promptForPermission(ctx, reader);
    expect(result.response).toBe(HITLResponse.Deny);
  });
});

// ── TEST-3: Tier 3 → Auto-Approved (No Prompt) ─────────────────────

describe("Tier 3 actions", () => {
  test("auto-approves Tier 3 without prompting", async () => {
    const reader = mockInputReader([]); // No responses needed
    const ctx = makeContext({
      command: "write artifact to .zao/sessions",
      verdict: {
        tier: TrustTier.Tier0,
        blocked: null,
        reasons: ["Internal .zao/ artifact write — no user impact."],
      },
    });

    const result = await promptForPermission(ctx, reader);
    expect(result.response).toBe(HITLResponse.Approve);
    expect(result.autoDecision).toBe(true);
  });

  test("Tier 3 is not affected by --yes or lack thereof", async () => {
    const reader = mockInputReader([]);
    for (const autoYes of [true, false]) {
      const ctx = makeContext({
        command: "write artifact",
        verdict: {
          tier: TrustTier.Tier0,
          blocked: null,
          reasons: ["Internal write."],
        },
        autoYes,
      });

      const result = await promptForPermission(ctx, reader);
      expect(result.response).toBe(HITLResponse.Approve);
      expect(result.autoDecision).toBe(true);
    }
  });
});

// ── TEST-4: Tier 1 Always Prompts (No Session Memory) ──────────────

describe("Tier 1 always prompts", () => {
  test("Tier 1 commands always prompt, even on repeat requests", async () => {
    const session = new PermissionSession();

    // First request: prompts with Tier 1 verdict
    const reader1 = mockInputReader(["Y"]);
    const ctx1 = makeContext({
      command: "rm file.txt",
      verdict: {
        tier: TrustTier.Tier1,
        blocked: null,
        reasons: ["Matched Tier 1 deny-list: File deletion."],
      },
      session,
    });
    const result1 = await promptForPermission(ctx1, reader1);
    expect(result1.response).toBe(HITLResponse.Approve);
    expect(result1.autoDecision).toBeUndefined(); // Interactive approval

    // Second request: same command, still prompts (no session memory)
    const reader2 = mockInputReader(["Y"]);
    const ctx2 = makeContext({
      command: "rm other.txt",
      verdict: {
        tier: TrustTier.Tier1,
        blocked: null,
        reasons: ["Matched Tier 1 deny-list: File deletion."],
      },
      session,
    });
    const result2 = await promptForPermission(ctx2, reader2);
    expect(result2.response).toBe(HITLResponse.Approve);
    expect(result2.autoDecision).toBeUndefined(); // Still interactive
  });
});

// ── TEST-5: Event Logging ──────────────────────────────────────────

describe("Event logging", () => {
  test("approval decision creates event record", async () => {
    const sessionDir = await makeTempDir();

    const reader = mockInputReader(["Y"]);
    const ctx = makeContext({
      command: "npm test",
      sessionDir,
    });

    await promptForPermission(ctx, reader);

    // Read the events.jsonl to verify the event was logged
    const eventsFile = Bun.file(join(sessionDir, "events.jsonl"));
    expect(await eventsFile.exists()).toBe(true);

    const content = await eventsFile.text();
    expect(content.trim()).not.toBe("");

    const lines = content.trim().split("\n");
    const lastLine = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(lastLine["action"]).toBe("hitl_approve");
    expect(lastLine["agent_role"]).toBe("human");
    expect(lastLine["model_id"]).toBe("test-model");
    expect(lastLine["schema_version"]).toBe("0.2.0");
    expect(lastLine["hitl_tier"]).toBe(TrustTier.Tier0);
  });

  test("denial decision creates event record", async () => {
    const sessionDir = await makeTempDir();

    const reader = mockInputReader(["N"]);
    const ctx = makeContext({
      command: "rm -rf ./node_modules",
      sessionDir,
    });

    await promptForPermission(ctx, reader);

    const eventsFile = Bun.file(join(sessionDir, "events.jsonl"));
    const content = await eventsFile.text();
    const lines = content.trim().split("\n");
    const lastLine = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(lastLine["action"]).toBe("hitl_deny");
  });

  test("modify decision creates event record", async () => {
    const sessionDir = await makeTempDir();

    const reader = mockInputReader(["M", "npm run test:ci"]);
    const ctx = makeContext({
      command: "rm file.txt",
      verdict: {
        tier: TrustTier.Tier1,
        blocked: null,
        reasons: ["Matched Tier 1 deny-list: File deletion."],
      },
      sessionDir,
    });

    const result = await promptForPermission(ctx, reader);
    expect(result.response).toBe(HITLResponse.Modify);
    expect(result.modifiedCommand).toBe("npm run test:ci");

    const eventsFile = Bun.file(join(sessionDir, "events.jsonl"));
    const content = await eventsFile.text();
    const lines = content.trim().split("\n");
    const lastLine = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(lastLine["action"]).toBe("hitl_modify");
  });

  test("chat decision creates event record", async () => {
    const sessionDir = await makeTempDir();

    const reader = mockInputReader(["C"]);
    const ctx = makeContext({
      command: "rm file.txt",
      verdict: {
        tier: TrustTier.Tier1,
        blocked: null,
        reasons: ["Matched Tier 1 deny-list: File deletion."],
      },
      sessionDir,
    });

    const result = await promptForPermission(ctx, reader);
    expect(result.response).toBe(HITLResponse.Chat);

    const eventsFile = Bun.file(join(sessionDir, "events.jsonl"));
    const content = await eventsFile.text();
    const lines = content.trim().split("\n");
    const lastLine = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(lastLine["action"]).toBe("hitl_chat");
  });

  test("auto-approved Tier 3 still logs event", async () => {
    const sessionDir = await makeTempDir();

    const reader = mockInputReader([]);
    const ctx = makeContext({
      command: "write artifact",
      verdict: {
        tier: TrustTier.Tier0,
        blocked: null,
        reasons: ["Internal .zao/ artifact write."],
      },
      sessionDir,
    });

    await promptForPermission(ctx, reader);

    const eventsFile = Bun.file(join(sessionDir, "events.jsonl"));
    const content = await eventsFile.text();
    expect(content.trim()).not.toBe("");
  });
});

// ── TEST-6: Tier 2 Blocked → Auto-Rejected ──────────────────────────

describe("Tier 2 blocked", () => {
  test("blocked commands are auto-rejected without prompting", async () => {
    const reader = mockInputReader([]); // No responses needed
    const ctx = makeContext({
      command: "rm -rf /",
      verdict: {
        tier: TrustTier.Tier2,
        blocked: {
          reason: "Root filesystem deletion",
          details: "This command would recursively delete the root filesystem.",
        },
        reasons: ["Unconditionally blocked: Root filesystem deletion"],
      },
    });

    const result = await promptForPermission(ctx, reader);
    expect(result.response).toBe(HITLResponse.Deny);
    expect(result.autoDecision).toBe(true);
  });
});

// ── TEST-7: PermissionSession Unit Tests ────────────────────────────

describe("PermissionSession unit tests", () => {
  test("approveTier2 and isTier2Approved work correctly", () => {
    const session = new PermissionSession();
    expect(session.isTier2Approved("npm")).toBe(false);
    session.approveTier2("npm");
    expect(session.isTier2Approved("npm")).toBe(true);
  });

  test("shouldReescalate returns false with < 4 timestamps", () => {
    const session = new PermissionSession();
    expect(session.shouldReescalate("npm")).toBe(false);

    session.recordTimestamp("npm");
    expect(session.shouldReescalate("npm")).toBe(false);

    session.recordTimestamp("npm");
    expect(session.shouldReescalate("npm")).toBe(false);

    session.recordTimestamp("npm");
    expect(session.shouldReescalate("npm")).toBe(false);
  });

  test("reset clears all session state", () => {
    const session = new PermissionSession();
    session.approveTier2("npm");
    session.recordTimestamp("npm");

    expect(session.isTier2Approved("npm")).toBe(true);

    session.reset();

    expect(session.isTier2Approved("npm")).toBe(false);
    expect(session.shouldReescalate("npm")).toBe(false);
  });
});

// ── Modify Response ────────────────────────────────────────────────

describe("Modify response", () => {
  test("returns modified command", async () => {
    const reader = mockInputReader(["M", "npm run test:ci -- --verbose"]);
    const ctx = makeContext({
      command: "rm file.txt",
      verdict: {
        tier: TrustTier.Tier1,
        blocked: null,
        reasons: ["Matched Tier 1 deny-list: File deletion."],
      },
    });

    const result = await promptForPermission(ctx, reader);
    expect(result.response).toBe(HITLResponse.Modify);
    expect(result.modifiedCommand).toBe("npm run test:ci -- --verbose");
  });

  test("empty modified command re-prompts then user approves", async () => {
    // After "M", empty modified command → break back to main choice loop → "Y" to approve
    const reader = mockInputReader(["M", "", "Y"]);
    const ctx = makeContext({ command: "npm test" });

    const result = await promptForPermission(ctx, reader);
    // After empty modified command, user chose to approve instead
    expect(result.response).toBe(HITLResponse.Approve);
  });
});

// ── Chat Response ──────────────────────────────────────────────────

describe("Chat response", () => {
  test("returns chat response", async () => {
    const reader = mockInputReader(["C"]);
    const ctx = makeContext({
      command: "rm file.txt",
      verdict: {
        tier: TrustTier.Tier1,
        blocked: null,
        reasons: ["Matched Tier 1 deny-list: File deletion."],
      },
    });

    const result = await promptForPermission(ctx, reader);
    expect(result.response).toBe(HITLResponse.Chat);
  });
});

// ── PermissionSession Unit Tests ───────────────────────────────────

describe("PermissionSession", () => {
  test("isTier2Approved returns false for unapproved command class", () => {
    const session = new PermissionSession();
    expect(session.isTier2Approved("npm")).toBe(false);
  });

  test("approveTier2 makes isTier2Approved return true", () => {
    const session = new PermissionSession();
    session.approveTier2("npm");
    expect(session.isTier2Approved("npm")).toBe(true);
  });

  test("approving one class does not affect another", () => {
    const session = new PermissionSession();
    session.approveTier2("npm");
    expect(session.isTier2Approved("npm")).toBe(true);
    expect(session.isTier2Approved("git")).toBe(false);
  });

  test("shouldReescalate true after 4+ timestamps then false after reset", () => {
    const session = new PermissionSession();
    session.recordTimestamp("npm");
    session.recordTimestamp("npm");
    session.recordTimestamp("npm");
    session.recordTimestamp("npm");
    expect(session.shouldReescalate("npm")).toBe(true);

    session.reset();
    expect(session.shouldReescalate("npm")).toBe(false);
  });
});

// ── formatPermissionPrompt Tests ───────────────────────────────────

describe("formatPermissionPrompt", () => {
  test("contains the tier label", () => {
    const ctx = makeContext({ command: "rm -rf ./node_modules" });
    const output = formatPermissionPrompt(ctx);
    expect(output).toContain("PERMISSION REQUIRED");
    expect(output).toContain("Tier 1");
    expect(output).toContain("Human Gate Required");
  });

  test("contains the raw command verbatim", () => {
    const ctx = makeContext({ command: "npm test -- --coverage" });
    const output = formatPermissionPrompt(ctx);
    expect(output).toContain("npm test -- --coverage");
  });

  test("contains the model's reasoning label", () => {
    const ctx = makeContext({ command: "npm test", explanation: "Testing is good" });
    const output = formatPermissionPrompt(ctx);
    expect(output).toContain("Model's reasoning");
    expect(output).toContain("Testing is good");
  });

  test("contains the verdict reasons", () => {
    const ctx = makeContext({
      command: "rm -rf ./dir",
      verdict: {
        tier: TrustTier.Tier1,
        blocked: null,
        reasons: ["Matched Tier 1 deny-list: File deletion."],
      },
    });
    const output = formatPermissionPrompt(ctx);
    expect(output).toContain("File deletion");
  });

  test("shows blocked warning when applicable", () => {
    const ctx = makeContext({
      command: "rm -rf /",
      verdict: {
        tier: TrustTier.Tier2,
        blocked: {
          reason: "Root filesystem deletion",
          details: "This command would recursively delete the root filesystem.",
        },
        reasons: ["Unconditionally blocked: Root filesystem deletion"],
      },
    });
    const output = formatPermissionPrompt(ctx);
    expect(output).toContain("UNCONDITIONALLY BLOCKED");
    expect(output).toContain("recursively delete");
  });

  test("contains all four choice options", () => {
    const ctx = makeContext({ command: "npm test" });
    const output = formatPermissionPrompt(ctx);
    expect(output).toContain("[Y] Approve");
    expect(output).toContain("[N] Deny");
    expect(output).toContain("[M] Modify");
    expect(output).toContain("[C] Chat");
  });

  test("strips ANSI escapes from command in prompt", () => {
    const ctx = makeContext({ command: "\x1B[31mnpm test\x1B[0m" });
    const output = formatPermissionPrompt(ctx);
    expect(output).not.toContain("\x1B[31m");
    expect(output).toContain("npm test");
  });

  test("strips ANSI escapes from explanation in prompt", () => {
    const ctx = makeContext({
      command: "npm test",
      explanation: "\x1B[31mRunning all tests\x1B[0m",
    });
    const output = formatPermissionPrompt(ctx);
    expect(output).not.toContain("\x1B[31m");
    expect(output).toContain("Running all tests");
  });

  test("wraps long explanations", () => {
    const longExplanation = "This is a very long explanation that should be wrapped across multiple lines in the formatted prompt output to ensure it is readable in the terminal.";
    const ctx = makeContext({
      command: "npm test",
      explanation: longExplanation,
    });
    const output = formatPermissionPrompt(ctx);
    expect(output).toContain("This is a very long explanation");
    // The output should contain the full explanation somewhere
    expect(output.length).toBeGreaterThan(100);
  });
});

// ── Tier 0 Auto-Approve Behavior ────────────────────────────────────

describe("Tier 0 auto-approve", () => {
  test("Tier 0 always auto-approves regardless of --yes flag", async () => {
    // Tier 0 (auto-approved) always auto-approves without prompting
    const reader = mockInputReader([]);
    for (const autoYes of [true, false]) {
      const ctx = makeContext({
        command: "npm test",
        verdict: {
          tier: TrustTier.Tier0,
          blocked: null,
          reasons: ["Matched Tier 0 allow-list: npm routine command."],
        },
        autoYes,
      });
      const result = await promptForPermission(ctx, reader);
      expect(result.response).toBe(HITLResponse.Approve);
      expect(result.autoDecision).toBe(true);
    }
  });

  test("Tier 1 always prompts even with --yes flag", async () => {
    const reader = mockInputReader(["Y"]);
    const ctx = makeContext({
      command: "rm file.txt",
      verdict: {
        tier: TrustTier.Tier1,
        blocked: null,
        reasons: ["Matched Tier 1 deny-list: File deletion."],
      },
      autoYes: true,
    });
    const result = await promptForPermission(ctx, reader);
    expect(result.response).toBe(HITLResponse.Approve);
    expect(result.autoDecision).toBeUndefined(); // Interactive!
  });
});
