import { processTty } from "../confirm/prompt.ts";
import { pick } from "../handoff.ts";
import { refusal } from "./result.ts";
import { defineCommand } from "./types.ts";

interface PickArgs {
  run: string;
  candidate: string;
  target: string;
}

export const pickCommand = defineCommand<PickArgs>({
  name: "pick",
  tool: "pick",
  summary: "write a chosen candidate and its manifest into the target, review pending",
  details: `Writes the chosen candidate and its manifest into the target with review pending, then runs
the target profile's validator when it declares one. The validator runs only once its command
hash is approved (settings, an approval file, or a yes on this terminal); otherwise pick writes
nothing and exits 8 confirmation_required. A human runs pick; agents never do.`,
  input: {
    type: "object",
    properties: {
      run: { type: "string", description: "the run directory", placeholder: "<run directory>" },
      candidate: { type: "string", description: "the candidate to pick", placeholder: "<id>" },
      target: {
        type: "string",
        description: "the directory to write into",
        placeholder: "<target directory>",
      },
    },
    required: ["run", "candidate", "target"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "never", writes: "target" },
  confirm: "pick",
  async run(args, ctx) {
    const result = await pick({
      runDir: args.run,
      candidateId: args.candidate,
      targetDir: args.target,
      approvals: { settings: ctx.settings, tty: ctx.tty ?? processTty() },
    });
    const lines = [`wrote ${result.mediaPath}`, `wrote ${result.manifestPath}`];
    if (result.provenancePath) lines.push(`wrote ${result.provenancePath}`);
    if (result.validator) {
      lines.push(
        `target validator ${result.validator.accepted ? "accepted" : "REJECTED"} the pick` +
          (result.validator.output ? `:\n${result.validator.output}` : ""),
      );
    }
    const human = lines.join("\n");
    const fields = { ...result };
    if (result.validator?.accepted === false) {
      return refusal(
        "validator_rejected",
        "the target's validator rejected the pick",
        fields,
        human,
      );
    }
    return { exitCode: 0, fields, human };
  },
});
