/**
 * The TTY port confirmations ask through. The CLI's port asks on stderr and reads stdin, and only
 * when both are terminals; tests inject their own.
 */
import { createInterface } from "node:readline/promises";

/** Asks a person a yes/no question; `interactive` is false when nobody can answer. */
export interface TtyPort {
  interactive: boolean;
  /** Shows `text`, asks `question` and resolves true on yes. */
  ask(text: string, question: string): Promise<boolean>;
}

/** The process's own TTY: interactive when stdin and stderr are both terminals. */
export function processTty(): TtyPort {
  return {
    interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
    async ask(text, question) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        process.stderr.write(`${text}\n`);
        const answer = await rl.question(`${question} [y/N] `);
        return /^\s*y(es)?\s*$/i.test(answer);
      } finally {
        rl.close();
      }
    },
  };
}

/** A port no one answers: the source when there is no TTY. */
export const NO_TTY: TtyPort = {
  interactive: false,
  ask: () => Promise.resolve(false),
};
