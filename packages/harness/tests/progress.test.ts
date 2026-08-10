/**
 * Tests for the progress module.
 *
 * Covers:
 * - start/update/stop cycle doesn't throw
 * - isDisabled returns true when not TTY
 * - isDisabled returns true when jsonMode is true
 * - start() writes ANSI escape codes to stderr
 * - pause/resume cycle works
 * - stop() clears interval and restores cursor
 * - __internalInitProgress sets json mode
 * - progress works after initialization
 *
 * @module progress.test
 */

import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import {
  progress,
  __internalInitProgress,
  __internalResetProgressForTest,
} from "../src/core/progress.ts";
import type { ProgressState } from "../src/core/progress.ts";

// ── Helpers ────────────────────────────────────────────────────────

type WriteCall = string;

function captureStderr(fn: () => void): WriteCall[] {
  const captured: WriteCall[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((data: string | Uint8Array) => {
    captured.push(String(data));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

const testState: ProgressState = {
  step: 1,
  totalSteps: 3,
  role: "developer",
  model: "deepseek-chat",
  sessionId: "01abc123def45678",
  phase: "thinking",
};

// ── TTY Mocking Helpers ────────────────────────────────────────────

function setStderrTTY(isTTY: boolean): void {
  Object.defineProperty(process.stderr, "isTTY", {
    value: isTTY,
    configurable: true,
    writable: true,
  });
}

// ── Session Manager Helpers ────────────────────────────────────────

let savedIsTTY: boolean | undefined;

function saveTTY(): void {
  savedIsTTY = (process.stderr as { isTTY?: boolean }).isTTY;
}

function restoreTTY(): void {
  if (savedIsTTY !== undefined) {
    setStderrTTY(savedIsTTY);
  }
}

describe("progress", () => {
  beforeEach(() => {
    saveTTY();
    __internalResetProgressForTest();
    __internalResetProgressForTest();
    __internalInitProgress(false);
    setStderrTTY(true);
    // Stop any running spinner from previous tests
    progress.stop();
  });

  afterEach(() => {
    restoreTTY();
    // Stop any running spinner from previous tests
    progress.stop();
  });

  // ── Init ────────────────────────────────────────────────────────

  test("__internalInitProgress sets json mode", () => {
    __internalResetProgressForTest();
    __internalInitProgress(true);
    // When json mode is true, isDisabled returns true even on TTY
    const calls = captureStderr(() => {
      progress.start(testState);
    });
    expect(calls.length).toBe(0);
  });

  test("progress works after initialization", () => {
    // Non-JSON mode, TTY enabled — progress should render
    const calls = captureStderr(() => {
      progress.start(testState);
      progress.update({ phase: "delegating" });
      progress.stop();
    });
    // Should have at minimum hide-cursor and show-cursor (start + stop)
    expect(calls.some((c) => c.includes("\x1b[?25l"))).toBe(true);
    expect(calls.some((c) => c.includes("\x1b[?25h"))).toBe(true);
  });

  // ── Non-TTY Guard ───────────────────────────────────────────────

  test("start is no-op when stderr is not a TTY", () => {
    setStderrTTY(false);
    const calls = captureStderr(() => {
      progress.start(testState);
    });
    // No ANSI output should be produced
    expect(calls.length).toBe(0);
  });

  test("update is no-op when stderr is not a TTY", () => {
    setStderrTTY(false);
    progress.start(testState);
    const calls = captureStderr(() => {
      progress.update({ phase: "writing" });
    });
    expect(calls.length).toBe(0);
  });

  test("stop is no-op when stderr is not a TTY", () => {
    setStderrTTY(false);
    progress.start(testState);
    const calls = captureStderr(() => {
      progress.stop();
    });
    expect(calls.length).toBe(0);
  });

  // ── JSON Mode Guard ─────────────────────────────────────────────

  test("start is no-op when jsonMode is true", () => {
    setStderrTTY(true);
    __internalResetProgressForTest();
    __internalInitProgress(true);
    const calls = captureStderr(() => {
      progress.start(testState);
    });
    expect(calls.length).toBe(0);
  });

  // ── Normal Operation ────────────────────────────────────────────

  test("start writes ANSI escape codes to stderr", () => {
    setStderrTTY(true);
    __internalResetProgressForTest();
    __internalInitProgress(false);
    const calls = captureStderr(() => {
      progress.start(testState);
    });
    // Should at minimum have hide-cursor and render line
    expect(calls.some((c) => c.includes("\x1b[?25l"))).toBe(true);
    expect(calls.some((c) => c.includes(testState.role))).toBe(true);
  });

  test("update rewrites the progress line in-place", () => {
    setStderrTTY(true);
    __internalResetProgressForTest();
    __internalInitProgress(false);
    // Start first, then capture update output
    progress.start(testState);
    const calls = captureStderr(() => {
      progress.update({ phase: "writing" });
    });
    // Should contain \r (carriage return) for in-place rewrite
    expect(calls.some((c) => c.includes("\r"))).toBe(true);
    progress.stop();
  });

  test("stop clears progress line and restores cursor", () => {
    setStderrTTY(true);
    __internalResetProgressForTest();
    __internalInitProgress(false);
    progress.start(testState);
    const calls = captureStderr(() => {
      progress.stop();
    });
    // Should clear and show cursor
    expect(calls.some((c) => c.includes("\x1b[2K"))).toBe(true);
    expect(calls.some((c) => c.includes("\x1b[?25h"))).toBe(true);
  });

  // ── start/update/stop Cycle ─────────────────────────────────────

  test("start/update/stop cycle does not throw", () => {
    setStderrTTY(true);
    __internalResetProgressForTest();
    __internalInitProgress(false);
    expect(() => {
      progress.start(testState);
      progress.update({ phase: "delegating" });
      progress.update({ step: 2 });
      progress.stop();
    }).not.toThrow();
  });

  // ── Pause/Resume ────────────────────────────────────────────────

  test("pause writes a newline and stops rendering", () => {
    setStderrTTY(true);
    __internalResetProgressForTest();
    __internalInitProgress(false);
    progress.start(testState);
    const pauseCalls = captureStderr(() => {
      progress.pause();
    });
    // Should write \n to move cursor down
    expect(pauseCalls.some((c) => c.includes("\n"))).toBe(true);

    // After pause, updates should be no-ops
    const updateCalls = captureStderr(() => {
      progress.update({ phase: "waiting" });
    });
    expect(updateCalls.length).toBe(0);
    progress.stop();
  });

  test("resume re-renders the progress line", () => {
    setStderrTTY(true);
    __internalResetProgressForTest();
    __internalInitProgress(false);
    progress.start(testState);
    progress.pause();
    const resumeCalls = captureStderr(() => {
      progress.resume();
    });
    expect(resumeCalls.length).toBeGreaterThan(0);
    expect(resumeCalls.some((c) => c.includes(testState.role))).toBe(true);
    progress.stop();
  });

  // ── State Transitions ───────────────────────────────────────────

  test("update changes the phase", () => {
    setStderrTTY(true);
    __internalResetProgressForTest();
    __internalInitProgress(false);
    progress.start(testState);
    const calls = captureStderr(() => {
      progress.update({ phase: "waiting" });
    });
    expect(calls.some((c) => c.includes("waiting"))).toBe(true);
    progress.stop();
  });

  // ── Multiple stop calls ─────────────────────────────────────────

  test("multiple stop calls do not throw", () => {
    setStderrTTY(true);
    __internalResetProgressForTest();
    __internalInitProgress(false);
    progress.start(testState);
    progress.stop();
    expect(() => progress.stop()).not.toThrow();
  });
});
