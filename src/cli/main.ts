import { readFileSync } from "node:fs";
import { EXIT, EXIT_MEANING } from "../errors.ts";
import { InputError } from "../errors.ts";
import { commands } from "../commands/registry.ts";
import { createRunContext } from "../commands/context.ts";
import { commandUsage, errorOutcome, parseCommandLine, runCommand } from "../commands/runner.ts";
import { resultDocument } from "../commands/result.ts";
import type { Outcome } from "../commands/types.ts";
import { WORK_ITEM_ENV } from "../spend.ts";

/** The CLI's own help: every registry command with its summary, the options, spend and exits. */
export function mainUsage(): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  const exits = Object.entries(EXIT_MEANING).map(([exit, meaning]) => `${exit} ${meaning}`);
  return [
    "Usage: assetgrove <command> [options]",
    "",
    "Commands:",
    ...commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    "",
    "Options:",
    "  --json       print exactly one JSON document on stdout (logs stay on stderr)",
    "  --help, -h   print usage; with a command, that command's usage",
    "  --version    print the version",
    "",
    "Spend: the developer settings cap every run (caps.runUsd; --cap may only lower it), and every",
    "paid call reserves against the ledger <stateDir>/spend.jsonl: a daily cap (caps.dailyUsd) and,",
    `with --work-item or ${WORK_ITEM_ENV}, a work-item cap (caps.workItemUsd). A call that would`,
    "cross a cap, or a paid provider with no declared limit, is refused with exit 3.",
    "",
    `Exit codes: ${exits.join(", ")}.`,
    "Run `assetgrove <command> --help` for a command's options.",
  ].join("\n");
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

/** Prints an outcome: the result document with --json, else the human text; returns the exit. */
function emit(json: boolean, command: string | null, outcome: Outcome): number {
  if (outcome.error) console.error(outcome.error.message);
  if (json) console.log(JSON.stringify(resultDocument(command, outcome), null, 2));
  else if (outcome.human) console.log(outcome.human);
  return outcome.exitCode;
}

/** Runs one command line and returns its exit code. */
export async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const [first, ...rest] = argv;
  if (first === undefined) {
    console.error(mainUsage());
    return EXIT.invalid_input;
  }
  if (first === "--help" || first === "-h" || first === "help") {
    const usage = mainUsage();
    const fields = { usage, commands: commands.map((c) => c.name) };
    return emit(json, null, { exitCode: 0, fields, human: usage });
  }
  if (first === "--version") {
    console.log(version());
    return 0;
  }
  const spec = commands.find((c) => c.name === first);
  const name = spec?.name ?? null;
  try {
    if (!spec) throw new InputError(`unknown command "${first}"\n${mainUsage()}`);
    const { args, help } = parseCommandLine(spec, rest);
    if (help) {
      const usage = commandUsage(spec);
      return emit(json, name, { exitCode: 0, fields: { usage }, human: usage });
    }
    const ctx = createRunContext({ log: (m) => console.error(m) });
    return emit(json, name, await runCommand(spec, args, ctx));
  } catch (error) {
    return emit(json, name, errorOutcome(error));
  }
}
