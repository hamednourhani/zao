/**
 * Structured CLI Output — JSON envelope emitter and HITL relay for json mode.
 *
 * ## stdout purity guarantee
 *
 * In json mode, stdout carries ONLY a single parseable JSON object.
 * All logs, warnings, drift notes, and config notices go to stderr.
 * This is the zao↔Rey contract: Rey parses stdout.
 *
 * @module output
 */



// ── Types ───────────────────────────────────────────────────────────────

/** Output format (table = human prose, json = machine-readable envelope). */
export type OutputFormat = "table" | "json";

/** Injectable stdin reader for testing. */
export type StdinReader = () => Promise<string | null>;

/** Payload for the pending_interaction envelope. */
export interface PendingInteractionPayload {
  sessionId: string;
  interactionId: string;
  tier: number;
  actionType: string;
  command: string;
  reasons: string[];
  diff: string | null;
  sessionState: {
    currentStep: string;
    stepIndex: number;
    totalSteps: number;
  };
}

// ── Action Type Mapping (H2: HITL relay schema alignment) ─────────────

/** yue run-output schema enum for pending_interaction.action. */
type SchemaActionType = "shell" | "read_file" | "write_file";

/**
 * Maps executor's internal action type vocabulary to the yue
 * run-output schema enum for `pending_interaction.action`.
 *
 * Internal → Schema:
 * - `file_read`  → `read_file`
 * - `file_write` → `write_file`
 * - `shell`      → `shell`
 *
 * Unknown types fall back to `"shell"` (conservative default).
 *
 * @param actionType - The executor's internal action type.
 * @returns The schema-compliant action type.
 */
function mapActionTypeToSchema(actionType: string): SchemaActionType {
  switch (actionType) {
    case "shell":
      return "shell";
    case "file_read":
      return "read_file";
    case "file_write":
      return "write_file";
    default:
      return "shell";
  }
}

/** Reply from stdin for a pending interaction. */
export interface HITLDecision {
  interaction_id: string;
  decision: "approve" | "deny" | "modify";
  modified_command: string | null;
  remember: boolean;
}

/** Result of reading a HITL decision from stdin. */
export type HITLDecisionResult =
  | { ok: true; decision: HITLDecision }
  | { ok: false; error: string };

// ── HITL Relay ──────────────────────────────────────────────────────────

/**
 * Emits a pending_interaction envelope to stdout and blocks
 * on stdin for a single JSON decision line.
 *
 * Implements the HITL relay protocol for json mode.
 *
 * ## H3: Bounded re-emit→re-read loop
 *
 * On invalid input, the envelope is re-emitted and stdin is re-read
 * up to 3 times total. This prevents desync where a second
 * pending_interaction is emitted on stdout but zao has already
 * moved on — leaving an unread decision in Rey's stdin buffer
 * that corrupts the next interaction.
 *
 * After max retries, returns an error (fail-closed).
 *
 * @param payload - The pending interaction details.
 * @param _readStdin - Injectable stdin reader for testing. Defaults to readStdinLine.
 * @returns A resolved decision or error.
 */
export async function readHITLDecisionFromStdin(
  payload: PendingInteractionPayload,
  _readStdin?: StdinReader,
): Promise<HITLDecisionResult> {
  const envelope = {
    schema_version: "0.2.0",
    type: "pending_interaction",
    session_id: payload.sessionId,
    interaction_id: payload.interactionId,
    tier: payload.tier,
    action: mapActionTypeToSchema(payload.actionType),
    command: payload.command,
    reasons: payload.reasons,
    diff: payload.diff,
    session_state: {
      current_step: payload.sessionState.currentStep,
      step_index: payload.sessionState.stepIndex,
      total_steps: payload.sessionState.totalSteps,
    },
  };

  const reader = _readStdin ?? readStdinLine;
  const MAX_RETRIES = 3;

  // Emit pending_interaction envelope to stdout
  process.stdout.write(JSON.stringify(envelope) + "\n");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Read one line from stdin
    const line = await reader();

    if (line === null) {
      return { ok: false, error: "stdin closed — denying by default" };
    }

    // Parse and validate
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (attempt < MAX_RETRIES) {
        // Re-emit envelope and retry
        process.stdout.write(JSON.stringify(envelope) + "\n");
        continue;
      }
      return { ok: false, error: "Invalid decision: not valid JSON" };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (attempt < MAX_RETRIES) {
        process.stdout.write(JSON.stringify(envelope) + "\n");
        continue;
      }
      return { ok: false, error: "Invalid decision: expected a JSON object" };
    }

    const obj = parsed as Record<string, unknown>;

    // Validate interaction_id match
    if (obj["interaction_id"] !== payload.interactionId) {
      if (attempt < MAX_RETRIES) {
        process.stdout.write(JSON.stringify(envelope) + "\n");
        continue;
      }
      return {
        ok: false,
        error: `Invalid decision: interaction_id mismatch`,
      };
    }

    // Validate decision field
    const decisionStr = obj["decision"];
    if (
      typeof decisionStr !== "string" ||
      !["approve", "deny", "modify"].includes(decisionStr)
    ) {
      if (attempt < MAX_RETRIES) {
        process.stdout.write(JSON.stringify(envelope) + "\n");
        continue;
      }
      return {
        ok: false,
        error: "Invalid decision: must be approve, deny, or modify",
      };
    }

    return {
      ok: true,
      decision: {
        interaction_id: obj["interaction_id"] as string,
        decision: decisionStr as "approve" | "deny" | "modify",
        modified_command:
          typeof obj["modified_command"] === "string"
            ? (obj["modified_command"] as string)
            : null,
        remember: obj["remember"] === true,
      },
    };
  }

  // Should never reach here (loop has final returns on each branch),
  // but satisfy TypeScript exhaustive check
  return { ok: false, error: "Max retries exhausted — denying by default" };
}

// ── Internal Helpers ─────────────────────────────────────────────────────

/**
 * Reads a single line from stdin. Returns null on EOF.
 */
async function readStdinLine(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    if (process.stdin.isTTY && typeof (globalThis as unknown as { prompt?: (s: string) => string | null }).prompt === "function") {
      // Bun TTY: use prompt()
      const result = (globalThis as unknown as { prompt: (s: string) => string | null }).prompt("");
      resolve(result ?? null);
      return;
    }

    // Non-TTY: read from stream
    const chunks: string[] = [];
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      const nlIdx = text.indexOf("\n");
      if (nlIdx >= 0) {
        chunks.push(text.slice(0, nlIdx));
        process.stdin.removeListener("data", onData);
        process.stdin.removeListener("end", onEnd);
        process.stdin.pause();
        resolve(chunks.join(""));
        return;
      }
      chunks.push(text);
    };

    const onEnd = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      resolve(chunks.length > 0 ? chunks.join("") : null);
    };

    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.resume();
  });
}


