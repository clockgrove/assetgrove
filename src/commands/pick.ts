import { join, resolve } from "node:path";
import { digestOf, requireConfirmation } from "../confirm/index.ts";
import type { KindRequest } from "../confirm/index.ts";
import { InputError } from "../errors.ts";
import { pick } from "../handoff.ts";
import { currentVersion } from "../library/write.ts";
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
 * sheet and the digest. A pick into an asset that already has a version names that version's
 * sha256 in the body, so in the digest (design section 3.2), and warns when the working file
 * differs from the card's `lock.sha256`, since replacing it discards an outside change.
 */
export async function pickRequest(args: PickArgs): Promise<KindRequest> {
  const runDir = resolve(args.run);
  const run = await readRun(runDir);
  const ids = run.candidates.map((c) => c.id);
  if (args.candidate !== undefined && !ids.includes(args.candidate))
    throw new InputError(
      `"${args.candidate}" is not a QA-passing candidate of run ${run.runId} (passing: ${ids.join(", ") || "none"})`,
    );
  const current = await currentVersion(run.profile, run.spec, resolve(args.target));
  const body = {
    command: "pick",
    run: runDir,
    runId: run.runId,
    inputs: { candidates: digestOf(run.candidates.map((c) => ({ id: c.id, sha256: c.sha256 }))) },
    target: resolve(args.target),
    candidate: args.candidate ?? null,
    ...(current.sha256 !== undefined && { replaces: current.sha256 }),
  };
  const id = digestOf(body);
  const replacing =
    current.sha256 === undefined
      ? ""
      : `, replacing version ${current.version} of ${current.assetId} (sha256 ${current.sha256})`;
  const warning = current.outsideChange
    ? `the working file of ${current.assetId} differs from its card's lock.sha256: replacing it discards an outside change`
    : undefined;
  return {
    kind: "pick",
    id,
    summary:
      (args.candidate === undefined
        ? `pick a candidate of run ${run.runId} into ${body.target}`
        : `pick candidate ${args.candidate} of run ${run.runId} into ${body.target}`) +
      replacing +
      (warning === undefined ? "" : `. Warning: ${warning}`),
    details: {
      run: runDir,
      contactSheet: run.contactSheet ? join(runDir, run.contactSheet) : null,
      candidates: ids,
      ...(args.candidate !== undefined && { candidate: args.candidate }),
      target: body.target,
      ...(current.sha256 !== undefined && {
        replaces: { assetId: current.assetId, version: current.version, sha256: current.sha256 },
      }),
      ...(warning !== undefined && { outsideChange: true, warning }),
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
Then writes the chosen candidate and its manifest into the target with review pending, and the
library under one lock (docs/library.md): the version into <assetId>.review.json with the candidate's
annotations, the card <assetId>.md, index.md from the library root down and a log.md line (unless
library.log is false). A reserved asset id exits 2 asset_id_reserved and one carded at another path
exits 2 asset_conflict, before any write. A pick into an asset that has a version names that
version's sha256 in its form and digest and warns when the working file differs from the card's
lock.sha256; if the current version is another by the time it writes, it exits 2 version_changed,
and media identical to an older version exits 2 version_exists, both before any write. Re-running an interrupted pick completes it. Then runs
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
    const request = await pickRequest(args);
    const confirmation = await requireConfirmation(request, {
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
      replaces: typeof request.body["replaces"] === "string" ? request.body["replaces"] : null,
    });
    const lines = [`wrote ${result.mediaPath}`, `wrote ${result.manifestPath}`];
    if (result.provenancePath) lines.push(`wrote ${result.provenancePath}`);
    if (result.library) {
      const { assetId, version, state, files } = result.library;
      lines.push(`library: ${assetId} version ${version} (${state})`);
      for (const file of files) lines.push(`wrote ${file}`);
    }
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
