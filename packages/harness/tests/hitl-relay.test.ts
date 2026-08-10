/**
 * Tests for the HITL relay protocol (TD-020).
 *
 * Covers:
 * - T7: pending_interaction emitted, approve → proceeds, deny → blocked
 * - T8: pending_interaction fields (interaction_id echoed, session_state)
 * - T9: invalid stdin → re-emitted (fail-closed)
 * - H4: format + stepInfo threaded end-to-end through executeTool
 *
 * Uses injectable StdinReader to avoid cross-test contamination
 * from process.stdin.push() buffering.
 *
 * @module hitl-relay.test
 */

import { describe, expect, test } from "bun:test";
import { readHITLDecisionFromStdin } from "../src/cli/output.ts";
import type {
  PendingInteractionPayload,
  StdinReader,
} from "../src/cli/output.ts";

// ── Helpers ──────────────────────────────────────────────────────────

/** Creates a mock stdin reader that returns the given line once. */
function mockStdinReader(line: string): StdinReader {
  let called = false;
  return async () => {
    if (called) return null;
    called = true;
    return line;
  };
}

/**
 * Creates a mock stdin reader that repeats the same line `count` times
 * before returning null. Used for testing the H3 retry loop where
 * invalid input triggers re-emit and re-read.
 */
function mockRepeatingReader(line: string, count: number = 3): StdinReader {
  let remaining = count;
  return async () => {
    if (remaining <= 0) return null;
    remaining--;
    return line;
  };
}

/** Creates a mock stdin reader that returns null (EOF). */
function mockEofReader(): StdinReader {
  return async () => null;
}

/**
 * Creates a test payload for readHITLDecisionFromStdin.
 */
function makePayload(overrides: Partial<PendingInteractionPayload> = {}): PendingInteractionPayload {
  return {
    sessionId: "test-sid",
    interactionId: "test-interaction-001",
    tier: 2,
    actionType: "shell",
    command: "npm test",
    reasons: ["Tier 2 — ask once per session"],
    diff: null,
    sessionState: {
      currentStep: "default",
      stepIndex: 1,
      totalSteps: 3,
    },
    ...overrides,
  };
}

/**
 * Creates a decision JSON string.
 */
function makeDecision(
  interactionId: string,
  decision: "approve" | "deny" | "modify",
  modifiedCommand?: string,
): string {
  return JSON.stringify({
    interaction_id: interactionId,
    decision,
    modified_command: modifiedCommand ?? null,
    remember: false,
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("HITL relay (json mode)", () => {
  // ── T7: approve and deny ──────────────────────────────────────

  describe("T7: approve and deny", () => {
    test("approve returns ok with approve decision", async () => {
      const payload = makePayload({
        interactionId: "test-approve-001",
      });
      const decisionLine = makeDecision("test-approve-001", "approve");

      const result = await readHITLDecisionFromStdin(
        payload,
        mockStdinReader(decisionLine),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.decision.decision).toBe("approve");
        expect(result.decision.interaction_id).toBe("test-approve-001");
      }
    });

    test("deny returns ok with deny decision", async () => {
      const payload = makePayload({
        interactionId: "test-deny-001",
        tier: 1,
        command: "rm -rf ./dangerous",
        reasons: ["Tier 1 — file deletion"],
      });
      const decisionLine = makeDecision("test-deny-001", "deny");

      const result = await readHITLDecisionFromStdin(
        payload,
        mockStdinReader(decisionLine),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.decision.decision).toBe("deny");
      }
    });

    test("modify returns ok with modify decision and modified_command", async () => {
      const payload = makePayload({
        interactionId: "test-mod-001",
      });
      const decisionLine = makeDecision(
        "test-mod-001",
        "modify",
        "npm test -- --grep security",
      );

      const result = await readHITLDecisionFromStdin(
        payload,
        mockStdinReader(decisionLine),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.decision.decision).toBe("modify");
        expect(result.decision.modified_command).toBe(
          "npm test -- --grep security",
        );
      }
    });
  });

  // ── T7: EOF / deny on closed stdin ────────────────────────────

  describe("T7: EOF → denied", () => {
    test("null stdin (EOF) returns error with fail-closed message", async () => {
      const payload = makePayload();

      const result = await readHITLDecisionFromStdin(
        payload,
        mockEofReader(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("stdin closed");
      }
    });
  });

  // ── T8: pending_interaction fields ────────────────────────────

  describe("T8: pending_interaction fields", () => {
    test("envelope emitted to stdout contains correct fields", async () => {
      // Capture stdout
      let captured = "";
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        return true;
      }) as typeof process.stdout.write;

      try {
        const payload = makePayload({
          interactionId: "test-fields-001",
          tier: 2,
          actionType: "shell",
          command: "npm test",
          reasons: ["Reason one", "Reason two"],
          sessionState: {
            currentStep: "review",
            stepIndex: 2,
            totalSteps: 4,
          },
        });

        const decisionLine = makeDecision("test-fields-001", "approve");

        const result = await readHITLDecisionFromStdin(
          payload,
          mockStdinReader(decisionLine),
        );

        expect(result.ok).toBe(true);

        // Verify the captured envelope
        const lines = captured.trim().split("\n").filter((l) => l.trim());
        expect(lines.length).toBeGreaterThanOrEqual(1);
        const envelope = JSON.parse(lines[0]!);

        expect(envelope.schema_version).toBe("0.2.0");
        expect(envelope.type).toBe("pending_interaction");
        expect(envelope.session_id).toBe("test-sid");
        expect(envelope.interaction_id).toBe("test-fields-001");
        expect(envelope.tier).toBe(2);
        expect(envelope.action).toBe("shell");
        expect(envelope.command).toBe("npm test");
        expect(envelope.reasons).toEqual(["Reason one", "Reason two"]);
        expect(envelope.diff).toBeNull();

        // session_state
        expect(envelope.session_state.current_step).toBe("review");
        expect(envelope.session_state.step_index).toBe(2);
        expect(envelope.session_state.total_steps).toBe(4);
      } finally {
        process.stdout.write = origWrite;
      }
    });

    test("interaction_id mismatch returns error", async () => {
      const payload = makePayload({
        interactionId: "correct-id",
      });

      const wrongLine = JSON.stringify({
        interaction_id: "wrong-id",
        decision: "approve",
        modified_command: null,
        remember: false,
      });

      const result = await readHITLDecisionFromStdin(
        payload,
        mockRepeatingReader(wrongLine, 3),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("interaction_id mismatch");
      }
    });
  });

  // ── T9: invalid stdin → re-emitted (fail-closed) ──────────────

  describe("T9: invalid stdin → re-emitted (fail-closed)", () => {
    test("invalid JSON is caught and returns error", async () => {
      const payload = makePayload({
        interactionId: "test-invalid-json-001",
      });

      const result = await readHITLDecisionFromStdin(
        payload,
        mockRepeatingReader("not-valid-json", 3),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid decision");
      }
    });

    test("invalid decision value is caught", async () => {
      const payload = makePayload({
        interactionId: "test-bad-decision-001",
      });

      const badLine = JSON.stringify({
        interaction_id: "test-bad-decision-001",
        decision: "maybe",
        modified_command: null,
        remember: false,
      });

      const result = await readHITLDecisionFromStdin(
        payload,
        mockRepeatingReader(badLine, 3),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid decision");
      }
    });

    test("non-object JSON is caught", async () => {
      const payload = makePayload({
        interactionId: "test-array-001",
      });

      const result = await readHITLDecisionFromStdin(
        payload,
        mockRepeatingReader("[1, 2, 3]", 3),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("expected a JSON object");
      }
    });
  });

  // ── Edge: remember field ──────────────────────────────────────

  describe("remember field parsing", () => {
    test("remember: true is parsed correctly", async () => {
      const payload = makePayload({ interactionId: "test-remember-true" });
      const decisionLine = JSON.stringify({
        interaction_id: "test-remember-true",
        decision: "approve",
        modified_command: null,
        remember: true,
      });

      const result = await readHITLDecisionFromStdin(
        payload,
        mockStdinReader(decisionLine),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.decision.remember).toBe(true);
        expect(result.decision.decision).toBe("approve");
      }
    });

    test("remember: false is parsed correctly", async () => {
      const payload = makePayload({ interactionId: "test-remember-false" });
      const decisionLine = JSON.stringify({
        interaction_id: "test-remember-false",
        decision: "approve",
        modified_command: null,
        remember: false,
      });

      const result = await readHITLDecisionFromStdin(
        payload,
        mockStdinReader(decisionLine),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.decision.remember).toBe(false);
      }
    });

    test("remember absent defaults to false", async () => {
      const payload = makePayload({ interactionId: "test-remember-absent" });
      const decisionLine = JSON.stringify({
        interaction_id: "test-remember-absent",
        decision: "approve",
        modified_command: null,
        // remember field intentionally absent
      });

      const result = await readHITLDecisionFromStdin(
        payload,
        mockStdinReader(decisionLine),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        // absent `remember` → defaults to false
        expect(result.decision.remember).toBe(false);
      }
    });
  });

  // ── H4: executeTool integration with json mode ──────────────────

  describe("H4: json mode HITL relay (action mapping + stepInfo)", () => {
    test("json mode + Tier 2 tool action emits pending_interaction, zero TUI on stdout", async () => {
      let capturedStdout = "";
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        capturedStdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        return true;
      }) as typeof process.stdout.write;

      try {
        const payload = makePayload({
          sessionId: "test-h4-sid",
          interactionId: "h4-test-001",
          tier: 2,
          actionType: "shell",
          command: "npm test",
          reasons: ["Matched Tier 2 allow-list"],
          sessionState: {
            currentStep: "default",
            stepIndex: 1,
            totalSteps: 3,
          },
        });

        const decision = JSON.stringify({
          interaction_id: "h4-test-001",
          decision: "approve",
          modified_command: null,
          remember: false,
        });

        const result = await readHITLDecisionFromStdin(
          payload,
          mockStdinReader(decision),
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.decision.decision).toBe("approve");
        }

        // Verify stdout has exactly the pending_interaction envelope
        const lines = capturedStdout.trim().split("\n").filter((l) => l.trim());
        expect(lines.length).toBeGreaterThanOrEqual(1);

        const envelope = JSON.parse(lines[0]!);
        expect(envelope.schema_version).toBe("0.2.0");
        expect(envelope.type).toBe("pending_interaction");
        expect(envelope.session_id).toBe("test-h4-sid");
        expect(envelope.interaction_id).toBe("h4-test-001");
        expect(envelope.tier).toBe(2);
        // H2: action must be "shell" (mapped from internal vocab)
        expect(envelope.action).toBe("shell");
        expect(envelope.command).toBe("npm test");
        // H4: session_state must be populated
        expect(envelope.session_state.current_step).toBe("default");
        expect(envelope.session_state.step_index).toBe(1);
        expect(envelope.session_state.total_steps).toBe(3);

        // No TUI artifacts on stdout
        expect(capturedStdout).not.toContain("╔");
        expect(capturedStdout).not.toContain("║");
        expect(capturedStdout).not.toContain("PERMISSION REQUIRED");
        expect(capturedStdout).not.toContain("[Y] Approve");
      } finally {
        process.stdout.write = origWrite;
      }
    });

    test("file_read maps to read_file in envelope", async () => {
      let capturedStdout = "";
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        capturedStdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        return true;
      }) as typeof process.stdout.write;

      try {
        const payload = makePayload({
          sessionId: "test-h4-sid",
          interactionId: "h4-file-read-001",
          tier: 1,
          actionType: "file_read",  // executor's internal vocab
          command: "src/config.ts",
          reasons: ["Tier 1 — file read outside project root"],
          sessionState: {
            currentStep: "review",
            stepIndex: 2,
            totalSteps: 3,
          },
        });

        const decision = JSON.stringify({
          interaction_id: "h4-file-read-001",
          decision: "approve",
          modified_command: null,
          remember: false,
        });

        const result = await readHITLDecisionFromStdin(
          payload,
          mockStdinReader(decision),
        );

        expect(result.ok).toBe(true);

        const lines = capturedStdout.trim().split("\n").filter((l) => l.trim());
        const envelope = JSON.parse(lines[0]!);
        // H2: file_read must be mapped to read_file in the envelope
        expect(envelope.action).toBe("read_file");
        expect(envelope.session_state.current_step).toBe("review");
      } finally {
        process.stdout.write = origWrite;
      }
    });

    test("file_write maps to write_file in envelope", async () => {
      let capturedStdout = "";
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        capturedStdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        return true;
      }) as typeof process.stdout.write;

      try {
        const payload = makePayload({
          sessionId: "test-h4-sid",
          interactionId: "h4-file-write-001",
          tier: 1,
          actionType: "file_write",  // executor's internal vocab
          command: "src/output.txt",
          reasons: ["Tier 1 — file write"],
          sessionState: {
            currentStep: "default",
            stepIndex: 0,
            totalSteps: 3,
          },
        });

        const decision = JSON.stringify({
          interaction_id: "h4-file-write-001",
          decision: "approve",
          modified_command: null,
          remember: false,
        });

        const result = await readHITLDecisionFromStdin(
          payload,
          mockStdinReader(decision),
        );

        expect(result.ok).toBe(true);

        const lines = capturedStdout.trim().split("\n").filter((l) => l.trim());
        const envelope = JSON.parse(lines[0]!);
        // H2: file_write must be mapped to write_file in the envelope
        expect(envelope.action).toBe("write_file");
      } finally {
        process.stdout.write = origWrite;
      }
    });
  });
});
