/**
 * Tests for the @clack/prompts HITL wrapper.
 *
 * Covers:
 * - isClackAvailable returns false when not TTY
 * - showClackPrompt handles the response types correctly (via mocking)
 *
 * @module clack-hitl.test
 */

import { describe, expect, test, afterEach, beforeEach, mock } from "bun:test";
import { isClackAvailable } from "../src/core/clack-hitl.ts";
import type { ClassificationVerdict } from "../src/core/command-guard.ts";
import { TrustTier } from "../src/core/command-guard.ts";

// ── Helpers ───────────────────────────────────────────────────────

let originalStdinTTY: boolean;
let originalStdoutTTY: boolean;

function setTTY(stdinTTY: boolean, stdoutTTY: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value: stdinTTY,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: stdoutTTY,
    configurable: true,
    writable: true,
  });
}

function saveTTY(): void {
  originalStdinTTY = (process.stdin as { isTTY?: boolean }).isTTY ?? false;
  originalStdoutTTY = (process.stdout as { isTTY?: boolean }).isTTY ?? false;
}

function restoreTTY(): void {
  setTTY(originalStdinTTY, originalStdoutTTY);
}

// ── Test Verdict ──────────────────────────────────────────────────

const testVerdict: ClassificationVerdict = {
  tier: TrustTier.Tier1,
  blocked: null,
  reasons: ["File deletion detected", "Command writes outside project root"],
};

describe("isClackAvailable", () => {
  beforeEach(() => saveTTY());
  afterEach(() => restoreTTY());

  test("returns true when both stdin and stdout are TTYs", () => {
    setTTY(true, true);
    expect(isClackAvailable()).toBe(true);
  });

  test("returns false when stdin is not a TTY", () => {
    setTTY(false, true);
    expect(isClackAvailable()).toBe(false);
  });

  test("returns false when stdout is not a TTY", () => {
    setTTY(true, false);
    expect(isClackAvailable()).toBe(false);
  });

  test("returns false when neither stdin nor stdout are TTYs", () => {
    setTTY(false, false);
    expect(isClackAvailable()).toBe(false);
  });
});

describe("showClackPrompt", () => {
  beforeEach(() => saveTTY());
  afterEach(() => restoreTTY());

  test("showClackPrompt is callable with valid args", async () => {
    // Import the function to verify it exists and is callable
    const { showClackPrompt } = await import("../src/core/clack-hitl.ts");

    // Mock @clack/prompts select to return "approve"
    mock.module("@clack/prompts", () => ({
      select: () => Promise.resolve("approve"),
      note: () => {},
      text: () => Promise.resolve("modified command"),
      isCancel: () => false,
      cancel: { isCancel: false },
    }));

    const result = await showClackPrompt(
      "rm -rf /tmp/test",
      "Clean up test files",
      testVerdict,
    );

    expect(result.response).toBe("approve");
  });

  test("showClackPrompt handles cancel as deny", async () => {
    const { showClackPrompt } = await import("../src/core/clack-hitl.ts");

    // Mock @clack/prompts select to return a cancel signal
    mock.module("@clack/prompts", () => ({
      select: () => Promise.resolve("__cancel__" as never),
      note: () => {},
      text: () => Promise.resolve(""),
      isCancel: () => true,
      cancel: { isCancel: true },
    }));

    const result = await showClackPrompt(
      "ls -la",
      "List files",
      testVerdict,
    );

    expect(result.response).toBe("deny");
  });

  test("showClackPrompt handles modify path", async () => {
    const { showClackPrompt } = await import("../src/core/clack-hitl.ts");

    let textCalled = false;

    mock.module("@clack/prompts", () => ({
      select: () => Promise.resolve("modify"),
      note: () => {},
      text: () => {
        textCalled = true;
        return Promise.resolve("ls -la /tmp");
      },
      isCancel: (val: unknown) => val === "__cancel__",
      cancel: { isCancel: true },
    }));

    const result = await showClackPrompt(
      "ls",
      "List files",
      testVerdict,
    );

    expect(textCalled).toBe(true);
    expect(result.response).toBe("modify");
    expect(result.modifiedCommand).toBe("ls -la /tmp");
  });

  test("showClackPrompt handles empty modify as deny", async () => {
    const { showClackPrompt } = await import("../src/core/clack-hitl.ts");

    mock.module("@clack/prompts", () => ({
      select: () => Promise.resolve("modify"),
      note: () => {},
      text: () => Promise.resolve(undefined),
      isCancel: () => true,
      cancel: { isCancel: true },
    }));

    const result = await showClackPrompt(
      "ls",
      "List files",
      testVerdict,
    );

    expect(result.response).toBe("deny");
  });
});
