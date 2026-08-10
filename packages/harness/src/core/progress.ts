/**
 * ANSI in-place progress indicator for zao harness.
 *
 * Renders a single status line on stderr with a spinner that advances
 * on each `update()` call or via a background interval.
 *
 * ## Guards
 *
 * The progress line is suppressed (no-op) when:
 * - JSON mode is active (`_jsonMode` is `true`) — stdout purity
 * - stderr is not a TTY (CI, piped output) — no ANSI codes
 *
 * ## Immutable-After-Init
 *
 * The progress module is initialized exactly once at CLI startup via `boot.ts`.
 * `__internalInitProgress` sets the JSON mode flag. Components use the
 * read-only `progress` object — they cannot change mode at runtime.
 *
 * ## ANSI Codes Used
 *
 * - `\x1b[2K` — erase entire line
 * - `\x1b[?25l` — hide cursor
 * - `\x1b[?25h` — show cursor
 * - `\r` — carriage return (cursor to start of line)
 *
 * ## Spinner
 *
 * A 10-frame Braille spinner cycles every 100ms via a background
 * interval. `stop()` clears the interval and restores the cursor.
 *
 * @module progress
 */

export type ProgressPhase = "thinking" | "delegating" | "waiting" | "writing";

export interface ProgressState {
  step: number;
  totalSteps: number;
  role: string;
  model: string;
  sessionId: string;
  phase: ProgressPhase;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let _jsonMode = false;
let _initialized = false;

let currentState: ProgressState | null = null;
let spinnerIndex = 0;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let paused = false;

/**
 * Initialize the progress module. Call ONCE at startup from boot.ts.
 * Setting jsonMode=true disables ANSI rendering (stdout purity).
 * Throws if called more than once.
 *
 * @param jsonMode - Whether JSON mode is active.
 */
export function __internalInitProgress(jsonMode: boolean): void {
  if (_initialized) {
    throw new Error(
      "Progress already initialized. __internalInitProgress must only be called once at startup.",
    );
  }
  _jsonMode = jsonMode;
  _initialized = true;
}

/**
 * Reset the progress module to uninitialized state. FOR TESTS ONLY.
 */
export function __internalResetProgressForTest(): void {
  _jsonMode = false;
  _initialized = false;
  currentState = null;
  spinnerIndex = 0;
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
  paused = false;
}

function isDisabled(): boolean {
  // Disable in JSON mode (stdout purity)
  if (_jsonMode) return true;
  // Disable in non-TTY
  if (!process.stderr.isTTY) return true;
  return false;
}

function render(): void {
  if (!currentState || isDisabled() || paused) return;
  const s = currentState;
  const frame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
  const shortId = s.sessionId.slice(0, 8);
  const line = `${frame} step ${s.step}/${s.totalSteps} ${s.role} — model: ${s.model} — session: ${shortId} — ${s.phase}`;
  // Clear previous line + write new
  process.stderr.write(`\x1b[2K\r${line}`);
}

export const progress = {
  start(state: ProgressState): void {
    if (isDisabled()) return;
    currentState = { ...state };
    paused = false;
    // Hide cursor
    process.stderr.write("\x1b[?25l");
    render();
    // Start spinner cycling
    spinnerTimer = setInterval(() => {
      spinnerIndex++;
      render();
    }, 100);
  },

  update(partial: Partial<ProgressState>): void {
    if (!currentState || isDisabled() || paused) return;
    currentState = { ...currentState, ...partial };
    render();
  },

  /**
   * Pauses the progress indicator. Call this before showing a HITL prompt
   * so the prompt appears below the progress line instead of overwriting it.
   * After the prompt resolves, call {@link resume}.
   */
  pause(): void {
    if (!currentState || isDisabled()) return;
    paused = true;
    // Clear the progress line and write a newline so the HITL prompt
    // appears cleanly on its own line
    process.stderr.write("\x1b[2K\r\n");
  },

  /**
   * Resumes the progress indicator after a HITL prompt.
   * Re-renders the current state.
   */
  resume(): void {
    if (!currentState || isDisabled()) return;
    paused = false;
    // Re-render the progress line (no newline — in-place)
    render();
  },

  stop(): void {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    if (currentState) {
      if (!isDisabled()) {
        // Clear progress line
        process.stderr.write("\x1b[2K\r");
      }
      // Always restore cursor — even if isDisabled() is now true.
      // If start() ran (currentState was set), the cursor was hidden;
      // we must show it regardless of current TTY/quiet state.
      process.stderr.write("\x1b[?25h");
    }
    currentState = null;
    paused = false;
  },
};
