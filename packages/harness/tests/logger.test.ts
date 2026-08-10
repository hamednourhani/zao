/**
 * Tests for the logger module.
 *
 * Covers:
 * - Level filtering: each level emits only when configured level allows
 * - Stream routing: output goes to stderr only
 * - __internalInitLogger initializes once, throws on second call
 * - Logger is silent before initialization (safe default)
 * - Logger outputs after initialization
 * - Error always outputs regardless of level (unless --quiet)
 * - Default level is "info"
 * - JSON mode does not suppress logger output
 * - Extra args are included in output
 *
 * @module logger.test
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  logger,
  __internalInitLogger,
  __internalResetLoggerForTest,
} from "../src/core/logger.ts";
import type { LogLevel } from "../src/core/logger.ts";

// ── Stderr Capture Helper ──────────────────────────────────────────

type WriteCalls = Array<{ line: string }>;

function captureStderr(fn: () => void): WriteCalls {
  const captured: WriteCalls = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((data: string | Uint8Array) => {
    captured.push({ line: String(data) });
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

/** Initialize logger at a given level for a test block. */
function initLogger(level: LogLevel, jsonMode = false): void {
  __internalResetLoggerForTest();
  __internalInitLogger(level, jsonMode);
}

describe("logger", () => {
  beforeEach(() => {
    // Reset to a known state before each test
    __internalResetLoggerForTest();
  });

  // ── Init-once enforcement ──────────────────────────────────────

  test("__internalInitLogger throws when called twice", () => {
    __internalInitLogger("info", false);
    expect(() => __internalInitLogger("info", false)).toThrow(
      "Logger already initialized",
    );
  });

  test("logger is silent before initialization", () => {
    // No init called — shouldLog returns false
    const calls = captureStderr(() => logger.info("before init"));
    expect(calls.length).toBe(0);
  });

  test("logger outputs after initialization", () => {
    initLogger("info");
    const calls = captureStderr(() => logger.info("after init"));
    expect(calls.length).toBe(1);
    expect(calls[0]!.line).toContain("[INFO]");
    expect(calls[0]!.line).toContain("after init");
  });

  // ── Level Filtering ─────────────────────────────────────────────

  test("error level emits at all default levels", () => {
    initLogger("info");
    const calls = captureStderr(() => logger.error("test error"));
    expect(calls.length).toBe(1);
    expect(calls[0]!.line).toContain("[ERROR]");
  });

  test("warn level emits at info level (default)", () => {
    initLogger("info");
    const calls = captureStderr(() => logger.warn("test warning"));
    expect(calls.length).toBe(1);
    expect(calls[0]!.line).toContain("[WARN]");
  });

  test("info level emits at info level (default)", () => {
    initLogger("info");
    const calls = captureStderr(() => logger.info("test info"));
    expect(calls.length).toBe(1);
    expect(calls[0]!.line).toContain("[INFO]");
  });

  test("debug level is suppressed at info level", () => {
    initLogger("info");
    const calls = captureStderr(() => logger.debug("test debug"));
    expect(calls.length).toBe(0);
  });

  test("debug level emits at debug level", () => {
    initLogger("debug");
    const calls = captureStderr(() => logger.debug("test debug"));
    expect(calls.length).toBe(1);
    expect(calls[0]!.line).toContain("[DEBUG]");
  });

  test("only errors emit at error level (--quiet)", () => {
    initLogger("error");
    const eCalls = captureStderr(() => logger.error("test error"));
    const wCalls = captureStderr(() => logger.warn("test warn"));
    const iCalls = captureStderr(() => logger.info("test info"));
    const dCalls = captureStderr(() => logger.debug("test debug"));

    expect(eCalls.length).toBe(1);
    expect(wCalls.length).toBe(0);
    expect(iCalls.length).toBe(0);
    expect(dCalls.length).toBe(0);
  });

  test("warn and above emit at warn level", () => {
    initLogger("warn");
    const eCalls = captureStderr(() => logger.error("test error"));
    const wCalls = captureStderr(() => logger.warn("test warn"));
    const iCalls = captureStderr(() => logger.info("test info"));

    expect(eCalls.length).toBe(1);
    expect(wCalls.length).toBe(1);
    expect(iCalls.length).toBe(0);
  });

  // ── Stream Routing ──────────────────────────────────────────────

  test("logger writes to stderr, not stdout", () => {
    initLogger("info");
    let stdoutWritten = false;
    const stdoutOriginal = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((_data: string | Uint8Array) => {
      stdoutWritten = true;
      return true;
    }) as typeof process.stdout.write;

    try {
      logger.info("test message");
    } finally {
      process.stdout.write = stdoutOriginal;
    }

    expect(stdoutWritten).toBe(false);
  });

  // ── JSON Mode ───────────────────────────────────────────────────

  test("JSON mode does not suppress logger output", () => {
    initLogger("info", true);
    // Logger should still emit — JSON mode only suppresses progress/HITL
    const calls = captureStderr(() => logger.info("JSON mode test"));
    expect(calls.length).toBe(1);
    expect(calls[0]!.line).toContain("[INFO]");
  });

  // ── Extra args ──────────────────────────────────────────────────

  test("logger includes extra args in output", () => {
    initLogger("info");
    const calls = captureStderr(() => logger.info("test", "arg1", "arg2"));
    expect(calls.length).toBe(1);
    expect(calls[0]!.line).toContain("arg1 arg2");
  });
});
