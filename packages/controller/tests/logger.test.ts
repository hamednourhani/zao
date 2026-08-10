/**
 * Logger unit tests — verifies leveled output to stderr.
 *
 * @module logger.test
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { logger, __internalInitLogger, __internalResetLoggerForTest } from "../src/logger.ts";

// ── Helpers ─────────────────────────────────────────────────────────

let stderrOutput: string[] = [];
let originalStderr: typeof process.stderr.write;

function captureStderr(): void {
  stderrOutput = [];
  originalStderr = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    stderrOutput.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
}

function restoreStderr(): void {
  process.stderr.write = originalStderr;
}

function getStderrLines(): string[] {
  return stderrOutput.join("").trim().split("\n").filter(Boolean);
}

beforeEach(() => {
  __internalResetLoggerForTest();
});

afterEach(() => {
  __internalResetLoggerForTest();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("controller logger", () => {
  test("logger.error outputs to stderr at default level (info)", () => {
    __internalInitLogger("info", false);
    captureStderr();
    logger.error("test error message");
    restoreStderr();

    const lines = getStderrLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[ERROR]");
    expect(lines[0]).toContain("test error message");
  });

  test("logger.warn outputs to stderr at default level (info)", () => {
    __internalInitLogger("info", false);
    captureStderr();
    logger.warn("test warning");
    restoreStderr();

    const lines = getStderrLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[WARN]");
    expect(lines[0]).toContain("test warning");
  });

  test("logger.info outputs to stderr at default level (info)", () => {
    __internalInitLogger("info", false);
    captureStderr();
    logger.info("test info");
    restoreStderr();

    const lines = getStderrLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[INFO]");
    expect(lines[0]).toContain("test info");
  });

  test("logger.debug is suppressed at default level (info)", () => {
    __internalInitLogger("info", false);
    captureStderr();
    logger.debug("test debug");
    restoreStderr();

    const lines = getStderrLines();
    expect(lines).toHaveLength(0);
  });

  test("logger.debug outputs when level is debug", () => {
    __internalInitLogger("debug", false);
    captureStderr();
    logger.debug("test debug");
    restoreStderr();

    const lines = getStderrLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[DEBUG]");
  });

  test("--quiet (level=error) suppresses warnings and info", () => {
    __internalInitLogger("error", false);
    captureStderr();
    logger.error("error msg");
    logger.warn("warn msg");
    logger.info("info msg");
    logger.debug("debug msg");
    restoreStderr();

    const lines = getStderrLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("error msg");
  });

  test("--verbose (level=debug) shows all levels", () => {
    __internalInitLogger("debug", false);
    captureStderr();
    logger.error("e");
    logger.warn("w");
    logger.info("i");
    logger.debug("d");
    restoreStderr();

    const lines = getStderrLines();
    expect(lines).toHaveLength(4);
  });

  test("logger accepts additional args for formatting", () => {
    __internalInitLogger("info", false);
    captureStderr();
    logger.info("value is", 42, "and", "done");
    restoreStderr();

    const lines = getStderrLines();
    expect(lines[0]).toContain("42");
    expect(lines[0]).toContain("done");
  });

  test("__internalInitLogger throws if called twice", () => {
    __internalInitLogger("info", false);
    expect(() => __internalInitLogger("debug", false)).toThrow(
      "Logger already initialized",
    );
  });

  test("logger is silent when not initialized (safe default)", () => {
    // No init call — logger should silently drop messages
    captureStderr();
    logger.error("should not appear");
    logger.warn("should not appear");
    restoreStderr();

    const lines = getStderrLines();
    expect(lines).toHaveLength(0);
  });

  test("__internalResetLoggerForTest allows re-initialization", () => {
    __internalInitLogger("info", false);
    __internalResetLoggerForTest();
    // Should not throw after reset
    expect(() => __internalInitLogger("debug", false)).not.toThrow();
  });
});
