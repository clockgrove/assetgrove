import { InputError } from "../errors.ts";
import { isPaid } from "./context.ts";
import { commands } from "./registry.ts";
import { runCommand, toolInputSchema, validateArgs } from "./runner.ts";
import type { CommandSpec } from "./types.ts";
import { defineCommand } from "./types.ts";

interface EstimateArgs {
  command: string;
  args?: Record<string, unknown>;
  workItem?: string;
  providerScript?: string;
}

/** The paid command an estimate names; a free or unknown command is invalid input. */
function paidCommand(name: string): CommandSpec {
  const spec = commands.find((c) => c.name === name || (c.tool !== null && c.tool === name));
  if (spec === undefined) throw new InputError(`unknown command "${name}"`);
  if (!isPaid(spec) || spec.plan === undefined)
    throw new InputError(`${spec.name} spends nothing, so it has no estimate`);
  return spec;
}

export const estimateCommand = defineCommand<EstimateArgs>({
  name: "estimate",
  tool: "estimate",
  summary: "run a paid command's free plan step and return what its --dry-run prints",
  details: `Runs the plan step of a paid command with its arguments (--args, a JSON object of the
command's tool arguments) and returns the same document as that command's --dry-run: its jobs,
forecast, cap, whether it is paid, input hashes, request digest and run directory, under that
command's name. Makes no
provider call, adds no ledger entry and writes nothing.`,
  input: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "the paid command to estimate",
        placeholder: "<command>",
      },
      args: {
        type: "object",
        description: "the command's arguments, as its tool takes them",
        placeholder: "<json>",
      },
      workItem: {
        type: "string",
        description: "the work item the spend ledger counts against",
        placeholder: "<label>",
      },
      providerScript: {
        type: "string",
        description: "answer every model call from this module instead of a provider",
        placeholder: "<module>",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  positionals: [{ name: "command" }],
  effect: { readOnly: true, spends: "never", writes: "none" },
  async run(args, ctx) {
    const spec = paidCommand(args.command);
    const given = args.args ?? {};
    if (typeof given !== "object" || Array.isArray(given))
      throw new InputError("--args must be a JSON object");
    // The arguments are the command's tool arguments: no CLI-only option such as --dry-run.
    await validateArgs({ ...spec, input: toolInputSchema(spec) }, given);
    const workItem = args.workItem ?? ctx.workItem;
    const providerScript = args.providerScript ?? ctx.providerScript;
    const properties = spec.input.properties;
    // The document is that command's --dry-run document, its name included (design section 5).
    const outcome = await runCommand(
      spec,
      {
        ...(providerScript !== undefined && "providerScript" in properties && { providerScript }),
        ...(workItem !== undefined && "workItem" in properties && { workItem }),
        ...given,
        dryRun: true,
      },
      ctx,
    );
    return { ...outcome, command: spec.name };
  },
});
