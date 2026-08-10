/**
 * Leveled logger singleton for mo harness — writes exclusively to stderr
 * to preserve stdout purity for JSON-mode results (TD-020).
 *
 * ## Stream Routing
 *
 * All log output goes to `process.stderr.write()` — never `console.error`
 * or `console.log`. This ensures JSON-mode callers can pipe stdout without
 * filtering log noise.
 *
 * ## Level Filtering
 *
 * | Level | Numeric | Emitted When                  |
 * |-------|---------|-------------------------------|
 * | error | 0       | Always (unless --quiet)       |
 * | warn  | 1       | level >= warn  (default: yes) |
 * | info  | 2       | level >= info  (default: yes) |
 * | debug | 3       | level >= debug (--verbose)    |
 *
 * Default level: `"info"`. At `--quiet` (level=`"error"`), only errors pass.
 *
 * ## Immutable-After-Init
 *
 * The logger is initialized exactly once at CLI startup via `boot.ts`.
 * `__internalInitLogger` throws if called more than once. Components use
 * the read-only `logger` object — they cannot change log level or JSON
 * mode at runtime.
 *
 * @module logger
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_NUMBERS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let _config: { level: LogLevel; jsonMode: boolean } | null = null;

/**
 * Initialize the logger. Call ONCE at startup from boot.ts.
 * NOT exported from the public barrel — components should never call this.
 * Throws if called more than once.
 *
 * @param level - The active log level.
 * @param jsonMode - Whether JSON mode is active.
 */
export function __internalInitLogger(level: LogLevel, jsonMode: boolean): void {
  if (_config !== null) {
    throw new Error(
      "Logger already initialized. __internalInitLogger must only be called once at startup.",
    );
  }
  _config = { level, jsonMode };
}

/**
 * Returns true if messages at the given level should be emitted.
 * Returns false if the logger has not been initialized yet (safe default).
 */
function shouldLog(level: LogLevel): boolean {
  if (!_config) return false; // not initialized yet → silent
  return LEVEL_NUMBERS[level] <= LEVEL_NUMBERS[_config.level];
}

function write(level: LogLevel, prefix: string, msg: string, args: unknown[]): void {
  if (!shouldLog(level)) return;
  const line = `${prefix} ${msg}` + (args.length > 0 ? " " + args.map(String).join(" ") : "");
  process.stderr.write(line + "\n");
}

/**
 * Reset the logger to uninitialized state. FOR TESTS ONLY.
 * Not exported from the public barrel.
 */
export function __internalResetLoggerForTest(): void {
  _config = null;
}

export const logger = {
  error(msg: string, ...args: unknown[]): void {
    write("error", "[ERROR]", msg, args);
  },
  warn(msg: string, ...args: unknown[]): void {
    write("warn", "[WARN]", msg, args);
  },
  info(msg: string, ...args: unknown[]): void {
    write("info", "[INFO]", msg, args);
  },
  debug(msg: string, ...args: unknown[]): void {
    write("debug", "[DEBUG]", msg, args);
  },
};
