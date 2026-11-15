import { join, resolve } from "node:path";
import { digestOf, requireConfirmation } from "../confirm/index.ts";
import type { KindRequest } from "../confirm/index.ts";
import { InputError } from "../errors.ts";
import { pick } from "../handoff.ts";
import { readRun } from "../loop.ts";
import { refusal } from "./result.ts";
import { defineCommand } from "./types.ts";

interface PickArgs {
  run: string;
  candidate?: string;
  target: string;
}

/**
 * The pick request (design section 7): its digest covers the run, its candidates' hashes, the
 * target and the named candidate (null when the person chooses), and it shows the run, its contact
 * sheet and the digest.
 */
export async function pickRequest(args: PickArgs): Promise<KindRequest> {
  const runDir = resolve(args.run);
  const run = await readRun(runDir);
  const ids = run.candidates.map((c) => c.id);
  if (args.candidate !== undefined && !ids.includes(args.candidate))
    throw new InputError(
      `"${args.candidate}" is not a QA-passing candidate of run ${run.runId} (passing: ${ids.join(", ") || "none"})`,
    );
  const body = {
    command: "pick",
    run: runDir,
    runId: run.runId,
    inputs: { candidates: digestOf(run.candidates.map((c) => ({ id: c.id, sha256: c.sha256 }))) },
    target: resolve(args.target),
    candidate: args.candidate ?? null,
  };
  const id = digestOf(body);
  return {
    kind: "pick",
    id,
    summary:
      args.candidate === undefined
        ? `pick a candidate of run ${run.runId} into ${body.target}`
        : `pick candidate ${args.candidate} of run ${run.runId} into ${body.target}`,
    details: {
      run: runDir,
      contactSheet: run.contactSheet ? join(runDir, run.contactSheet) : null,
      candidates: ids,
      ...(args.candidate !== undefined && { candidate: args.candidate }),
      target: body.target,
      digest: id,
    },
    body,
    choices: ids,
  };
}

export const pickCommand = defineCommand<PickArgs>({
  name: "pick",
  tool: "pick",
  summary: "write a chosen candidate and its manifest into the target, review pending",
  details: `A person confirms the pick (design section 7): headless settings record it unattended and
must name --candidate (exit 2 without one); otherwise a record at <configDir>/confirmations/<hex>.json
for the pick's digest, an MCP client's form, the TTY (which asks for the candidate when none is named), or exit 8
confirmation_required and \`assetgrove confirm <hex>\`. The record goes into the pick's provenance.
Then writes the chosen candidate and its manifest into the target with review pending, and runs
the target profile's validator when it declares one. The validator runs only with an approval tied
to its exact command (settings.commands.approved or <configDir>/approvals/<hash>.json); otherwise
pick asks in an MCP client's form or on a TTY, or exits 8 confirmation_required before writing, and \`assetgrove confirm <hash>\`
approves it. A human runs pick; agents never do.`,
  input: {
    type: "object",
    properties: {
      run: { type: "string", description: "the run directory", placeholder: "<run directory>" },
      candidate: {
        type: "string",
        description: "the candidate to pick; required under headless settings",
        placeholder: "<id>",
      },
      target: {
        type: "string",
        description: "the directory to write into",
        placeholder: "<target directory>",
      },
    },
    required: ["run", "target"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "never", writes: "target" },
  confirm: "pick",
  async run(args, ctx) {
    const confirmation = await requireConfirmation(await pickRequest(args), {
      settings: ctx.settings,
      ...(ctx.prompt && { prompt: ctx.prompt }),
    });
    const result = await pick({
      runDir: args.run,
      candidateId: confirmation.choice ?? args.candidate ?? "",
      targetDir: args.target,
      gate: { settings: ctx.settings, ...(ctx.prompt && { prompt: ctx.prompt }) },
      ...(ctx.extensions && { registry: ctx.extensions }),
      confirmation,
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
    // The candidate by its id and file only: its provenance and QA reasons hold the bible's text,
    // which a tool result carries only under sharedText (design section 10).
    const { id, file, mediaType, extension, sha256 } = result.candidate;
    const fields = {
      ...result,
      candidate: { id, file, mediaType, extension, sha256 },
      confirmation,
    };
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
