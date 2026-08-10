/**
 * Human-gate — interactive approval prompt for the crunch pipeline.
 *
 * Uses bun's built-in `console` async-iterable to read user input.
 * Works in both TTY (interactive) and non-TTY (piped input) modes.
 *
 * @module human-gate
 */

/**
 * Prompts the user with a yes/no question and returns their decision.
 *
 * Displays the question and waits for a single line of input. Returns
 * `true` if the trimmed input starts with "y" (case-insensitive),
 * `false` for any other response.
 *
 * In interactive mode, the prompt is written to stdout. In non-TTY
 * mode (e.g., piped input, tests), the prompt is written to stderr.
 *
 * @param question - The prompt to display to the user.
 * @returns `true` if the user answers "y" or "yes", `false` otherwise.
 */
export async function requestApproval(question: string): Promise<boolean> {
  const prompt = `${question} [y/N]: `;

  if (process.stdout.isTTY) {
    process.stdout.write(prompt);
  } else {
    process.stderr.write(prompt);
  }

  // In Bun, `console` is an async iterable that yields lines from stdin.
  // This works in both TTY and non-TTY modes.
  for await (const line of console) {
    const answer = line.trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }

  // Should never reach here, but be defensive
  return false;
}
