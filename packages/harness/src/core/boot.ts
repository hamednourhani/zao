/**
 * Boot module — one-time initialization for harness singletons.
 *
 * ONLY imported by the harness CLI entry point (packages/harness/src/index.ts).
 * Components MUST NOT import this module — they use the read-only
 * `logger` and `progress` exports from their respective modules.
 *
 * This separation enforces the governance rule that mutable state
 * initialization happens exactly once at startup.
 *
 * @module boot
 */

import type { LogLevel } from "./logger.ts";
import { __internalInitLogger } from "./logger.ts";
import { __internalInitProgress } from "./progress.ts";

let _booted = false;

export interface BootOptions {
  logLevel: LogLevel;
  jsonMode: boolean;
}

/**
 * Initialize all harness singletons. Call ONCE at CLI startup.
 * Throws if called more than once.
 *
 * @param options - Boot configuration.
 */
export function boot(options: BootOptions): void {
  if (_booted) {
    throw new Error(
      "Boot already called. boot() must only be called once at startup.",
    );
  }
  __internalInitLogger(options.logLevel, options.jsonMode);
  __internalInitProgress(options.jsonMode);
  _booted = true;
}
