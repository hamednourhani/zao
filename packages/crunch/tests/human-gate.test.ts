import { describe, test, expect, mock } from "bun:test";
import { requestApproval } from "../src/human-gate.ts";

describe("requestApproval", () => {
  test("returns true for 'y' input", async () => {
    // Mock: simulate user typing "y"
    const originalConsole = globalThis.console;
    const originalStdoutIsTTY = process.stdout.isTTY;

    // Set up mock stdin by providing a generator
    const mockIterator = (async function* () {
      yield "y";
    })();

    Object.defineProperty(globalThis, "console", {
      value: {
        [Symbol.asyncIterator]: () => mockIterator,
      },
      writable: true,
      configurable: true,
    });

    // Suppress stdout write
    const writeMock = mock(() => {});
    Object.defineProperty(process.stdout, "write", {
      value: writeMock,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    const result = await requestApproval("Proceed?");
    expect(result).toBe(true);

    // Restore
    Object.defineProperty(globalThis, "console", {
      value: originalConsole,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY,
      writable: true,
      configurable: true,
    });
  });

  test("returns true for 'yes' input", async () => {
    const originalConsole = globalThis.console;
    const originalStdoutIsTTY = process.stdout.isTTY;

    const mockIterator = (async function* () {
      yield "yes";
    })();

    Object.defineProperty(globalThis, "console", {
      value: {
        [Symbol.asyncIterator]: () => mockIterator,
      },
      writable: true,
      configurable: true,
    });

    const writeMock = mock(() => {});
    Object.defineProperty(process.stdout, "write", {
      value: writeMock,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    const result = await requestApproval("Proceed?");
    expect(result).toBe(true);

    Object.defineProperty(globalThis, "console", {
      value: originalConsole,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY,
      writable: true,
      configurable: true,
    });
  });

  test("returns false for 'n' input", async () => {
    const originalConsole = globalThis.console;
    const originalStdoutIsTTY = process.stdout.isTTY;

    const mockIterator = (async function* () {
      yield "n";
    })();

    Object.defineProperty(globalThis, "console", {
      value: {
        [Symbol.asyncIterator]: () => mockIterator,
      },
      writable: true,
      configurable: true,
    });

    const writeMock = mock(() => {});
    Object.defineProperty(process.stdout, "write", {
      value: writeMock,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    const result = await requestApproval("Proceed?");
    expect(result).toBe(false);

    Object.defineProperty(globalThis, "console", {
      value: originalConsole,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY,
      writable: true,
      configurable: true,
    });
  });

  test("returns false for empty input", async () => {
    const originalConsole = globalThis.console;
    const originalStdoutIsTTY = process.stdout.isTTY;

    const mockIterator = (async function* () {
      yield "";
    })();

    Object.defineProperty(globalThis, "console", {
      value: {
        [Symbol.asyncIterator]: () => mockIterator,
      },
      writable: true,
      configurable: true,
    });

    const writeMock = mock(() => {});
    Object.defineProperty(process.stdout, "write", {
      value: writeMock,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    const result = await requestApproval("Proceed?");
    expect(result).toBe(false);

    Object.defineProperty(globalThis, "console", {
      value: originalConsole,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY,
      writable: true,
      configurable: true,
    });
  });

  test("returns true for 'YES' (uppercase)", async () => {
    const originalConsole = globalThis.console;
    const originalStdoutIsTTY = process.stdout.isTTY;

    const mockIterator = (async function* () {
      yield "YES";
    })();

    Object.defineProperty(globalThis, "console", {
      value: {
        [Symbol.asyncIterator]: () => mockIterator,
      },
      writable: true,
      configurable: true,
    });

    const writeMock = mock(() => {});
    Object.defineProperty(process.stdout, "write", {
      value: writeMock,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    const result = await requestApproval("Proceed?");
    expect(result).toBe(true);

    Object.defineProperty(globalThis, "console", {
      value: originalConsole,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY,
      writable: true,
      configurable: true,
    });
  });

  test("handles non-TTY mode (writes to stderr)", async () => {
    const originalConsole = globalThis.console;
    const originalStdoutIsTTY = process.stdout.isTTY;

    const mockIterator = (async function* () {
      yield "y";
    })();

    Object.defineProperty(globalThis, "console", {
      value: {
        [Symbol.asyncIterator]: () => mockIterator,
      },
      writable: true,
      configurable: true,
    });

    const stderrMock = mock(() => {});
    Object.defineProperty(process.stderr, "write", {
      value: stderrMock,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    const result = await requestApproval("Proceed?");
    expect(result).toBe(true);
    expect(stderrMock).toHaveBeenCalled();

    Object.defineProperty(globalThis, "console", {
      value: originalConsole,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY,
      writable: true,
      configurable: true,
    });
  });
});
