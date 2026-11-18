/**
 * Godot's exit code does not report an import or load error, so the pack reads its output: any
 * line that is an `ERROR` (Godot's `ERROR:`, `SCRIPT ERROR:` and `USER ERROR:`) fails the run,
 * whatever the exit code.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** The lines of Godot's output that report an error, without colour codes, in order. */
export function errorLines(output: string): string[] {
  return output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:SCRIPT |USER )?ERROR\b/.test(line));
}
