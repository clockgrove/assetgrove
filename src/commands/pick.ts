import { join, resolve } from "node:path";
import { digestOf, requireConfirmation } from "../confirm/index.ts";
import type { KindRequest } from "../confirm/index.ts";
import { readMedia } from "../library/lfs.ts";
import { exactMatches } from "../library/exact.ts";
import type { ExactMatch } from "../library/exact.ts";
import { readRecordPath } from "../paths.ts";
import { InputError } from "../errors.ts";
import { pick } from "../handoff.ts";
import { replacementUsage } from "../handoff/usage.ts";
import type { PresetUsage } from "../handoff/usage.ts";
import type { PresetRegistry, UsageReference } from "../handoff/presets/index.ts";
import { AssetIdError, changeVersionChanged, currentVersion } from "../library/write.ts";
import { readRun } from "../loop.ts";
import { refusal } from "./result.ts";
import { defineCommand } from "./types.ts";

/** What the replacement preview's usage scan needs: the presets, and the directories it never reads. */
export interface UsageInput {
  registry?: PresetRegistry;
  stateDir: string;
  configDir: string;
}

interface PickArgs {
  run: string;
  candidate?: string;
  target: string;
  duplicate?: "existing-version" | "keep-separate" | "exit";
  existingVersion?: string;
}

/**
 * The pick request (design section 7): its digest covers the run, its candidates' hashes, the
 * target and the named candidate (null when the person chooses), and it shows the run, its contact
 * sheet and the digest. A pick into an asset that already has a version names that version's
 * sha256 in the body, so in the digest (design section 3.2), and warns when the working file
 * differs from the card's `lock.sha256`, since replacing it discards an outside change. It also
 * lists each preset's known usage of the replaced asset (`details.usage`), outside the digest.
 */
export async function pickRequest(
  args: PickArgs,
  usageInput?: UsageInput,
): Promise<KindRequest> {
  if (
    args.duplicate !== undefined &&
    !["existing-version", "keep-separate", "exit"].includes(args.duplicate)
  )
    throw new InputError("--duplicate must be existing-version, keep-separate or exit");
  const runDir = resolve(args.run);
  const run = await readRun(runDir);
  const ids = run.candidates.map((c) => c.id);
  if (args.candidate !== undefined && !ids.includes(args.candidate))
    throw new InputError(
      `"${args.candidate}" is not a QA-passing candidate of run ${run.runId} (passing: ${ids.join(", ") || "none"})`,
    );
  const current = await currentVersion(run.profile, run.spec, resolve(args.target));
  const change = run.changeRequest;
  // Re-running an interrupted pick completes it: when the current version is this run's own
  // candidate (the one named, or any when none is), the pick already appended it.
  const picked =
    current.run === run.runId &&
    (args.candidate === undefined || current.candidate === args.candidate);
  if (change !== undefined && current.sha256 !== change.version && !picked) {
    throw changeVersionChanged(
      current.assetId,
      current.version ?? 0,
      current.sha256,
      change.version,
    );
  }
  const candidates = run.candidates.filter(
    (c) => args.candidate === undefined || c.id === args.candidate,
  );
  // Only bytes that still match the run's record are compared. A changed staged file is refused
  // by pick at write time, and a changed run shows as a new request digest (plan_changed).
  const verified = new Set<string>();
  for (const candidate of candidates) {
    const media = await readMedia(join(runDir, readRecordPath(candidate.file, "staged file")));
    if (media.kind !== "lfs-pointer" && media.sha256 === candidate.sha256)
      verified.add(candidate.id);
  }
  const hashes = candidates.filter((c) => verified.has(c.id)).map((c) => c.sha256);
  const matches = (await exactMatches(run.profile, resolve(args.target), hashes)).filter(
    (m) => m.assetId !== current.assetId || m.sha256 !== current.sha256,
  );
  const duplicates = candidates.flatMap((c) =>
    !verified.has(c.id) || (current.run === run.runId && current.candidate === c.id)
      ? []
      : matches
          .filter((m) => m.sha256 === c.sha256 || m.contentSha256 === c.sha256)
          .map((m) => ({ candidate: c.id, ...m })),
  );
  if (args.existingVersion !== undefined && args.duplicate !== "existing-version")
    throw new InputError("--existing-version requires --duplicate existing-version");
  if (
    args.duplicate !== undefined &&
    duplicates.length === 0 &&
    !(picked && args.candidate !== undefined && args.duplicate !== "existing-version")
  )
    throw new InputError("this candidate has no exact duplicate decision to make");
  if (args.duplicate !== undefined && args.candidate === undefined)
    throw new InputError("name --candidate when selecting a duplicate outcome");
  const olderOwnVersion = duplicates.find((m) => m.assetId === current.assetId);
  if (args.duplicate === "keep-separate" && olderOwnVersion !== undefined)
    throw new AssetIdError(
      "version_exists",
      `these bytes are already version ${olderOwnVersion.version} of asset "${current.assetId}"; select existing-version or exit instead`,
    );
  const selected =
    args.duplicate === "existing-version"
      ? duplicates.find((m) => `${m.assetId}@${m.version}` === args.existingVersion)
      : undefined;
  if (args.duplicate === "existing-version" && selected === undefined)
    throw new InputError("choose a reported match with --existing-version <assetId>@<version>");
  const body = {
    command: "pick",
    run: runDir,
    runId: run.runId,
    inputs: { candidates: digestOf(run.candidates.map((c) => ({ id: c.id, sha256: c.sha256 }))) },
    target: resolve(args.target),
    candidate: args.candidate ?? null,
    ...(duplicates.length > 0 && { duplicates, duplicate: args.duplicate ?? null }),
    ...(selected !== undefined && { existingVersion: args.existingVersion }),
    ...(current.sha256 !== undefined && { replaces: current.sha256 }),
  };
  const id = digestOf(body);
  const usage =
    current.sha256 !== undefined &&
    current.media !== undefined &&
    usageInput?.registry !== undefined
      ? await replacementUsage({
          profile: run.profile,
          assetId: current.assetId,
          media: current.media,
          targetDir: resolve(args.target),
          registry: usageInput.registry,
          stateDir: usageInput.stateDir,
          configDir: usageInput.configDir,
        })
      : [];
  const replacing =
    current.sha256 === undefined
      ? ""
      : `, replacing version ${current.version} of ${current.assetId} (sha256 ${current.sha256})` +
        usage.map(usageSummary).join("");
  const outsideChange = current.outsideChange
    ? `the working file of ${current.assetId} differs from its card's lock.sha256: replacing it discards an outside change`
    : undefined;
  // Media another tool marked as model-made, brought in with a record of no calls: the person sees
  // that no licence grant was checked for it before confirming (docs/decisions.md).
  const unchecked = run.candidates
    .filter((c) => args.candidate === undefined || c.id === args.candidate)
    .filter((c) => c.provenance?.modelMadeOutsideAssetgrove !== undefined)
    .map((c) => c.id);
  const licence =
    unchecked.length === 0
      ? undefined
      : `${args.candidate === undefined ? `candidate${unchecked.length === 1 ? "" : "s"} ${unchecked.join(", ")}: ` : ""}` +
        "the media is marked as model-made by another tool, and Assetgrove checked no licence grant for it";
  const warning =
    [outsideChange, licence].filter((w) => w !== undefined).join(". Warning: ") || undefined;
  return {
    kind: "pick",
    id,
    summary:
      (args.candidate === undefined
        ? `pick a candidate of run ${run.runId} into ${body.target}`
        : `pick candidate ${args.candidate} of run ${run.runId} into ${body.target}`) +
      replacing +
      (duplicates.length === 0
        ? ""
        : `; exact matches: ${duplicates.map((m) => `${m.candidate}: ${m.assetId} version ${m.version}`).join(", ")}; outcome ${args.duplicate ?? "decision-required"}`) +
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
      ...(usage.length > 0 && { usage }),
      ...(outsideChange !== undefined && { outsideChange: true }),
      ...(unchecked.length > 0 && { licenceGrantUnchecked: unchecked }),
      ...(warning !== undefined && { warning }),
      ...(change !== undefined && { answers: change.answers }),
      ...(duplicates.length > 0 && {
        duplicates,
        outcome: args.duplicate ?? "decision-required",
        outcomes: ["existing-version", "keep-separate", "exit"],
      }),
      ...(selected !== undefined && { existingVersion: selected }),
      digest: id,
    },
    body,
    choices: ids,
  };
}

function referenceText(ref: UsageReference): string {
  const where = [ref.line === undefined ? ref.file : `${ref.file}:${ref.line}`, ref.path, ref.uid]
    .filter((part) => part !== undefined)
    .join(" ");
  const locations = ref.locations.length > 0 ? ` (${ref.locations.join(", ")})` : "";
  const reason = ref.reason === undefined ? "" : ` (${ref.reason})`;
  if (ref.status === "resolved") return `${where}${locations}`;
  return `${ref.status === "unresolved" ? "UNRESOLVED" : "UNREADABLE"} ${where}${locations}${reason}`;
}

/** One preset's usage as a summary clause: the known references, then the unresolved and unreadable. */
function usageSummary({ preset, report, error }: PresetUsage): string {
  if (report === undefined) return `; usage unknown (${preset}): ${error ?? "no report"}`;
  if (report.references.length === 0) return `; no known usage (${preset})`;
  const known = report.references.filter((r) => r.status === "resolved");
  const rest = report.references.filter((r) => r.status !== "resolved");
  const head =
    known.length > 0 ? `; known usage (${preset}): ${known.map(referenceText).join(", ")}` : "";
  return `${head}${rest.map((r) => `; ${referenceText(r)}`).join("")}`;
}

export const pickCommand = defineCommand<PickArgs>({
  name: "pick",
  tool: "pick",
  summary: "write a chosen candidate and its manifest into the target, review pending",
  details: `A person confirms the pick (design section 7): headless settings record it unattended and
must name --candidate (exit 2 without one); otherwise a record at <configDir>/confirmations/<hex>.json
for the pick's digest, an MCP client's form, the TTY (which asks for the candidate when none is named), or exit 8
confirmation_required and \`assetgrove confirm <hex>\`. The record goes into the pick's provenance.
Before writing, exact whole-byte matches to other cards or older versions are reported with their
asset and version. Select --candidate and --duplicate existing-version with --existing-version
<assetId>@<version> to return that reference without writing, --duplicate keep-separate to admit
separately, or --duplicate exit to leave unchanged. The first two require a person even in headless
mode, bound to the candidate, outcome and complete match set. Declining writes no library data.
Intake provides the same read-only check for an incoming file. Repeated picks of this run complete normally.
A candidate marked as model-made by another tool, with a record of no calls, is named in the
confirmation: Assetgrove checked no licence grant for it.
Then writes the chosen candidate and its manifest into the target with review pending, and the
library under one lock (docs/library.md): the version into <assetId>.review.json with the candidate's
annotations, the card <assetId>.md, index.md from the library root down and a log.md line (unless
library.log is false). A reserved asset id exits 2 asset_id_reserved and one carded at another path
exits 2 asset_conflict, before any write. A pick into an asset that has a version names that
version's sha256 in its form and digest and warns when the working file differs from the card's
lock.sha256; if the current version is another by the time it writes, it exits 2 version_changed,
and media identical to an older version exits 2 version_exists, both before any write. A target outside a Git work tree exits 2 git_required, and media that Git's check-attr filter does not map to lfs exits 2 lfs_required (run init), both before any write. A candidate of a
request_change run appends its version with answers naming the requests; one made on another version
than the current one exits 2 version_changed. Re-running an interrupted pick completes it. Then runs
the target profile's validator when it declares one. The validator runs only with an approval tied
to its exact command (settings.commands.approved or <configDir>/approvals/<hash>.json); otherwise
pick asks in an MCP client's form or on a TTY, or exits 8 confirmation_required before writing, and \`assetgrove confirm <hash>\`
approves it. A human runs pick; agents never do.`,
  input: {
    type: "object",
    properties: {
      duplicate: {
        type: "string",
        description: "exact duplicate outcome: existing-version, keep-separate or exit",
      },
      existingVersion: {
        type: "string",
        description: "the matching assetId@version for --duplicate existing-version",
        placeholder: "<assetId>@<version>",
      },
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
    const request = await pickRequest(args, {
      ...(ctx.extensions && { registry: ctx.extensions }),
      stateDir: ctx.settings.stateDir,
      configDir: ctx.settings.configDir,
    });
    const duplicates = request.details["duplicates"] as
      (ExactMatch & { candidate: string })[] | undefined;
    if (duplicates !== undefined && args.duplicate === undefined)
      return refusal(
        "invalid_input",
        "exact bytes already tracked: name --candidate and choose --duplicate existing-version, keep-separate or exit",
        {
          duplicates,
          outcome: "decision-required",
          outcomes: ["existing-version", "keep-separate", "exit"],
        },
        request.summary,
      );
    if (args.duplicate === "exit")
      return {
        exitCode: 0,
        fields: { outcome: "exit", duplicates },
        human: "exited without changing the library",
      };
    const confirmation = await requireConfirmation(
      request,
      {
        settings: ctx.settings,
        ...(ctx.prompt && { prompt: ctx.prompt }),
      },
      { person: duplicates !== undefined },
    );
    const recheck = await pickRequest(args).then(
      (rebuilt) => rebuilt.id,
      () => undefined,
    );
    if (recheck !== request.id)
      return refusal(
        "plan_changed",
        "the candidate or matching library versions changed; pick again",
        {},
        "",
      );
    if (args.duplicate === "existing-version")
      return {
        exitCode: 0,
        fields: {
          outcome: "existing-version",
          existingVersion: request.details["existingVersion"],
          duplicates,
          confirmation,
        },
        human: `selected existing version ${args.existingVersion}; library unchanged`,
      };
    const result = await pick({
      runDir: args.run,
      candidateId: confirmation.choice ?? args.candidate ?? "",
      targetDir: args.target,
      gate: { settings: ctx.settings, ...(ctx.prompt && { prompt: ctx.prompt }) },
      ...(ctx.extensions && { registry: ctx.extensions }),
      confirmation,
      requireLfs: true,
      replaces: typeof request.body["replaces"] === "string" ? request.body["replaces"] : null,
    });
    const lines = [`wrote ${result.mediaPath}`, `wrote ${result.manifestPath}`];
    if (result.provenancePath) lines.push(`wrote ${result.provenancePath}`);
    if (result.library) {
      const { assetId, version, state, files } = result.library;
      lines.push(`library: ${assetId} version ${version} (${state})`);
      for (const file of files) lines.push(`wrote ${file}`);
      for (const { file, code } of result.library.unreadable ?? []) {
        lines.push(
          code === "index_invalid"
            ? `warning: ${file} does not parse (${code}) and holds the rows of a card that does not parse either; it was left as it was until both are fixed and library rebuild runs`
            : `warning: ${file} does not parse (${code}); its rows in its folder's index.md and log.md were kept as they were until it is fixed and library rebuild runs`,
        );
      }
    }
    if (result.contentCredentials) {
      const { subject, files, warning } = result.contentCredentials;
      lines.push(`C2PA content credentials on ${files.join(", ")}, signed by ${subject}`);
      if (warning) lines.push(`warning: ${warning}`);
    }
    if (result.validator) {
      lines.push(
        `target validator ${result.validator.accepted ? "accepted" : "REJECTED"} the pick` +
          (result.validator.output ? `:\n${result.validator.output}` : ""),
      );
    }
    for (const f of result.ruleFindings ?? [])
      if (f.status === "failed" && f.severity === "warning")
        lines.push(`warning: project rule ${f.rule}: ${f.asset} (${f.evidence})`);
    for (const { preset, warnings } of result.handoff ?? [])
      for (const warning of warnings ?? []) lines.push(`warning: ${preset}: ${warning}`);
    const human = lines.join("\n");
    // The candidate by its id and file only: its provenance and QA reasons hold the bible's text,
    // which a tool result carries only under sharedText (design section 10).
    const { id, file, mediaType, extension, sha256 } = result.candidate;
    const fields = {
      ...result,
      candidate: { id, file, mediaType, extension, sha256 },
      confirmation,
      ...((duplicates !== undefined || args.duplicate === "keep-separate") && {
        outcome: "keep-separate",
        ...(duplicates !== undefined && { duplicates }),
      }),
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
