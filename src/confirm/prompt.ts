/**
 * The confirmation port: how Assetgrove asks a person. The CLI's port prompts inline when stdin and
 * stderr are both a TTY; tests inject their own. A port answers yes or no, or names a choice, and
 * never decides alone.
 */
import { createInterface } from "node:readline/promises";

/** The kinds of confirmation a person gives (design section 7). */
export type ConfirmKind = "spend" | "pick" | "write" | "command" | "settings";

/** What a person is asked to confirm (design section 7). */
export interface ConfirmRequest {
  kind: ConfirmKind;
  /** The request's id: a command's hash, or a spend, pick, write or settings request's digest. */
  id: string;
  /** One line naming what is asked. */
  summary: string;
  /** The flat fields the person is shown, in order. */
  details: Record<string, unknown>;
  /**
   * For spend, pick, write and settings: the request body whose sha256 of canonical JSON is `id`, so
   * `assetgrove confirm` can check a pending request names what its id hashes.
   */
  body?: Record<string, unknown>;
  /** For a pick that names no candidate: the ids a person chooses among (`none` declines). */
  choices?: string[];
}

/** What a channel reports about itself for a record: the client, its protocol, the tool mark. */
export interface ChannelFields {
  client?: string;
  protocolVersion?: string;
  toolMarkedRequiresUser: boolean;
}

/** A channel that can ask a person. */
export interface ConfirmPort {
  /** How an accept is recorded: `tty` for an inline prompt, `elicitation` for an MCP form. */
  method: "tty" | "elicitation";
  /** What the channel adds to the record of `request` it answered; absent on the TTY. */
  recordFields?(request: ConfirmRequest): ChannelFields;
  /** True when the person accepts. */
  confirm(request: ConfirmRequest): Promise<boolean>;
  /** The choice a person names among `request.choices`; `none` or undefined declines. */
  choose?(request: ConfirmRequest): Promise<string | undefined>;
  /**
   * For a settings request: the values the person accepted in a form that showed the proposed
   * ones; undefined declines.
   */
  edit?(request: ConfirmRequest): Promise<Record<string, unknown> | undefined>;
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
  const ask = async (question: string): Promise<string> => {
    const rl = createInterface({ input: stdin, output: stderr });
    try {
      return (await rl.question(question)).trim();
    } catch {
      // Ctrl+D, Ctrl+C or closed input: an empty answer, which declines.
      return "";
    } finally {
      rl.close();
    }
  };
  return {
    method: "tty",
    async confirm(request) {
      return /^y(es)?$/i.test(await ask(`${describeRequest(request)}\nApprove? [y/N] `));
    },
    async choose(request) {
      const choices = request.choices ?? [];
      const answer = await ask(
        `${describeRequest(request)}\nChoose one of ${[...choices, "none"].join(", ")}: `,
      );
      return choices.includes(answer) ? answer : undefined;
    },
  };
}
