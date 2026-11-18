/**
 * Godot's exit code does not report an import or load error, so the pack reads its output: any
 * line that is an `ERROR` of any type (Godot's `ERROR:`, and an upper-case type before it such as
 * `SCRIPT ERROR:`, `USER ERROR:` or `SHADER ERROR:`) fails the run, whatever the exit code.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** The lines of Godot's output that report an error, without colour codes, in order. */
export function errorLines(output: string): string[] {
  return output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[A-Z]+ )*ERROR\b/.test(line));
}
