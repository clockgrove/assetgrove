/**
 * The confirmation port: how Assetgrove asks a person. The CLI's port prompts inline when stdin and
 * stderr are both a TTY; tests inject their own. A port answers yes or no and never decides alone.
 */
import { createInterface } from "node:readline/promises";

/** What a person is asked to confirm (design section 7); kind `command` for gated commands. */
export interface ConfirmRequest {
  kind: "command";
  /** The request's id: a command's hash. */
  id: string;
  /** One line naming what is asked. */
  summary: string;
  /** The flat fields the person is shown, in order. */
  details: Record<string, unknown>;
}

/** A channel that can ask a person. */
export interface ConfirmPort {
  /** How an accept is recorded: `tty` for an inline prompt. */
  method: "tty";
  /** True when the person accepts. */
  confirm(request: ConfirmRequest): Promise<boolean>;
}

/** The request as the lines a person reads. */
export function describeRequest(request: ConfirmRequest): string {
  const lines = [request.summary];
  for (const [name, value] of Object.entries(request.details)) {
    lines.push(`  ${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  return lines.join("\n");
}

/**
 * The inline prompt of a CLI whose stdin and stderr are both a TTY; undefined otherwise. It reads
 * one answer from stdin and writes the question to stderr, so stdout keeps only the result.
 */
export function ttyPort(
  stdin: NodeJS.ReadStream = process.stdin,
  stderr: NodeJS.WriteStream = process.stderr,
): ConfirmPort | undefined {
  if (!stdin.isTTY || !stderr.isTTY) return undefined;
  return {
    method: "tty",
    async confirm(request) {
      const rl = createInterface({ input: stdin, output: stderr });
      try {
        const answer = await rl.question(`${describeRequest(request)}\nApprove? [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
  };
}
