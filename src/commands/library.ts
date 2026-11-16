/**
 * `library check`, `library rebuild`, `library stats`, `library drift` and `library adopt` (design
 * sections 1.4 and 4): the library's records against their projections, reports computed from the
 * cards, and a person's hand edit handed off as a new version.
 */
import { join, resolve } from "node:path";
import { EXIT, InputError } from "../errors.ts";
import { BIBLE_PATH, PROFILE_PATH } from "../init.ts";
import { loadProfile } from "../inputs.ts";
import { loadAsset, locateAsset } from "../library/actions.ts";
import { targetVersion } from "../library/review.ts";
import {
  adoptHandEdit,
  adoptRequest,
  adoptSource,
  requireMediaType,
  currentProvenance,
  freeChecks,
  originalFile,
  projectOf,
  workingFile,
} from "../library/adopt.ts";
import { libraryConfig, scanCards } from "../library/write.ts";
import {
  bibleVersionOf,
  libraryDrift,
  libraryStats,
  readLibrary,
  rebuildLibrary,
} from "../library/maintain.ts";
import type { LibraryState } from "../library/maintain.ts";
import { acquireLibraryLock } from "../runs/lock.ts";
import { refusal } from "./result.ts";
import { annotationFields, headlessRefusal, personConfirms, requireSameRequest } from "./review.ts";
import { defineCommand } from "./types.ts";
import type { JsonSchemaObject, Outcome } from "./types.ts";

interface LibraryArgs {
  target?: string;
  profile?: string;
  bible?: string;
}

const TARGET = {
  type: "string",
  description: "the target directory holding the library",
  default: ".",
} as const;
const PROFILE = {
  type: "string",
  description: "the target profile (default <target>/.assetgrove/profile.json)",
  placeholder: "<profile.json>",
} as const;

function input(bible: boolean): JsonSchemaObject {
  return {
    type: "object",
    properties: {
      target: TARGET,
      profile: PROFILE,
      ...(bible && {
        bible: {
          type: "string" as const,
          description:
            "the style bible whose version marks stale cards (default <target>/.assetgrove/art-direction/BIBLE.md)",
          placeholder: "<bible>",
        },
      }),
    },
    additionalProperties: false,
  };
}

async function open(args: LibraryArgs) {
  const targetDir = resolve(args.target ?? ".");
  const profilePath = resolve(args.profile ?? join(targetDir, PROFILE_PATH));
  let profile;
  try {
    profile = (await loadProfile(profilePath)).value;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(`cannot read the target profile ${profilePath}`, { cause: error });
  }
  return { targetDir, profile };
}

function checkOutcome(state: LibraryState, extra: Record<string, unknown> = {}): Outcome {
  const { problems, needsRebuild } = state;
  const fields = { library: state.config.rootRel || ".", problems, needsRebuild, ...extra };
  const human = [
    problems.length === 0
      ? "library check passed"
      : `library check found ${problems.length} problem(s)`,
    ...problems.map((p) => `  ${p.file}: ${p.code}`),
    ...(needsRebuild.length > 0
      ? [
          `needs rebuild (layout only): ${needsRebuild.join(", ")}`,
          "run: assetgrove library rebuild",
        ]
      : []),
  ].join("\n");
  if (problems.length === 0) return { exitCode: 0, fields, human };
  return {
    exitCode: EXIT.library_check_failed,
    fields,
    human,
    error: {
      code: "library_check_failed",
      message: `library check found ${problems.length} problem(s): ${problems.map((p) => `${p.file} ${p.code}`).join("; ")}`,
      problems,
    },
  };
}

export const libraryCheckCommand = defineCommand<LibraryArgs>({
  name: "library check",
  tool: "library_check",
  summary: "check the library's records against its cards, indexes, logs and media",
  details: `Checks that every pick has a card and a review record, that each card's machine fields match
the records, and that media is mapped to Git LFS. Indexes, logs and review records are compared after
normalising order and duplicate headings, so a legitimate union merge passes; a file that differs
only in layout is listed under needsRebuild, not as a problem. Exits 6 library_check_failed with
error.problems [{file, code}]. Read-only.`,
  input: input(false),
  effect: { readOnly: true, spends: "never", writes: "none" },
  async run(args) {
    const { targetDir, profile } = await open(args);
    return checkOutcome(await readLibrary(profile, targetDir));
  },
});

export const libraryRebuildCommand = defineCommand<LibraryArgs>({
  name: "library rebuild",
  tool: "library_rebuild",
  summary: "rewrite every card machine field, index, log and review record from the records",
  details: `Rewrites machine fields, indexes, logs and the canonical layout of review records from the
records, under the library write lock. The root log keeps its style bible lines. A second run changes
nothing. Problems the records cannot fix (a missing card, media not in LFS) are still reported, exit 6.`,
  input: input(false),
  effect: { readOnly: false, spends: "never", writes: "target" },
  async run(args, ctx) {
    const { targetDir, profile } = await open(args);
    const lock = acquireLibraryLock(targetDir, ctx.settings.stateDir);
    try {
      const state = await readLibrary(profile, targetDir);
      const rebuilt = await rebuildLibrary(state);
      const after = await readLibrary(profile, targetDir);
      const outcome = checkOutcome(after, { rebuilt });
      outcome.human = [
        `rebuilt ${rebuilt.length} file(s)`,
        ...rebuilt.map((f) => `  ${f}`),
        outcome.human,
      ].join("\n");
      return outcome;
    } finally {
      lock.release();
    }
  },
});

export const libraryStatsCommand = defineCommand<LibraryArgs>({
  name: "library stats",
  tool: "library_stats",
  summary: "count assets by kind and state, and change requests approved within two versions",
  details: `Reports counts by kind and state, and the share of change requests approved within two new
versions (a request counts when one of the next two versions after the one it targets is approved).
Read-only.`,
  input: input(false),
  effect: { readOnly: true, spends: "never", writes: "none" },
  async run(args) {
    const { targetDir, profile } = await open(args);
    const stats = libraryStats(await readLibrary(profile, targetDir));
    const { total, approvedWithinTwoVersions: ok, share } = stats.changeRequests;
    const human = [
      `${stats.assets} asset(s)`,
      `by kind: ${
        Object.entries(stats.byKind)
          .map(([k, n]) => `${k} ${n}`)
          .join(", ") || "none"
      }`,
      `by state: ${
        Object.entries(stats.byState)
          .map(([k, n]) => `${k} ${n}`)
          .join(", ") || "none"
      }`,
      `change requests approved within two versions: ${ok} of ${total}${share === null ? "" : ` (${(share * 100).toFixed(0)}%)`}`,
    ].join("\n");
    return { exitCode: 0, fields: { ...stats }, human };
  },
});

export const libraryDriftCommand = defineCommand<LibraryArgs>({
  name: "library drift",
  tool: "library_drift",
  summary: "list stale assets (older bible) and modified ones (file differs from the lock)",
  details: `Computes from each card, storing nothing: stale when the card's bible is older than the style
bible's version, modified when the file's sha256, or a Git LFS pointer's oid, differs from lock.sha256.
Read-only.`,
  input: input(true),
  effect: { readOnly: true, spends: "never", writes: "none" },
  async run(args) {
    const { targetDir, profile } = await open(args);
    const biblePath = resolve(args.bible ?? join(targetDir, BIBLE_PATH));
    const bible = bibleVersionOf(biblePath);
    if (args.bible !== undefined && bible === undefined) {
      throw new InputError(`${args.bible}: a style bible with a version could not be read.`);
    }
    const drift = await libraryDrift(await readLibrary(profile, targetDir), bible);
    const human = [
      `style bible version: ${drift.bibleVersion ?? "unknown"}`,
      `stale: ${drift.stale.length}`,
      ...drift.stale.map((s) => `  ${s.asset}: ${s.reason}`),
      `modified: ${drift.modified.length}`,
      ...drift.modified.map((m) => `  ${m.asset}: ${m.reason}`),
    ].join("\n");
    return { exitCode: 0, fields: { ...drift }, human };
  },
});

interface AdoptArgs {
  address?: string;
  asset?: string;
  original?: string;
  target?: string;
  profile?: string;
  bible?: string;
}

/** The card of the asset an adopt names: its address, or its id in the library of the target's profile. */
async function adoptCard(args: AdoptArgs): Promise<string> {
  if ((args.address === undefined) === (args.asset === undefined)) {
    throw new InputError("give the asset's card, media or review record, or --asset <id>");
  }
  if (args.address !== undefined) return args.address;
  const { targetDir, profile } = await open(args);
  const config = libraryConfig(profile, targetDir);
  const found = scanCards(config.root).find((card) => card.id === args.asset);
  if (!found) throw new InputError(`no asset "${args.asset}" with a card in ${config.root}`);
  return join(found.dir, `${found.id}.md`);
}

export const libraryAdoptCommand = defineCommand<AdoptArgs>({
  name: "library adopt",
  tool: "library_adopt",
  summary: "hand off a person's edit of an asset as its next version, with a person's confirmation",
  details: `For a picked asset whose working file a person edited, so it differs from the card's
lock.sha256 (design section 4). Name the asset by its card, media or review record, or by --asset <id>
in the library of --target's profile. --original is the AI-made version the card locks (its sha256 must
equal lock.sha256). The free QA checks run again on the edited file (transparency, the frame count its
provenance records, and the palette of --bible when given); a failure exits 5 qa_found_nothing. A person
then confirms like a pick: a record at <configDir>/confirmations/<hex>.json for its digest, an MCP
client's form, the TTY, or exit 8 confirmation_required and \`assetgrove confirm <hex>\`; the digest
covers the asset id, the file's sha256, the version it replaces, the original, the run that made the
asset, its profile's sha256 and the review record's head, so it asks again once the record or the run
changes. Under headless settings it exits 8 confirmation_required and writes nothing. The edit is then
handed off as pick hands off, from the run that made the asset (<target>/.assetgrove/runs/<run>, or
the import <target>/.assetgrove/imports/<run> of a family write-families handed off; the target is
--target, else the Git top level of the asset's folder), in the version's media type: the file is marked compositeWithTrainedAlgorithmicMedia and signed with C2PA
credentials that name the original as a parentOf ingredient, its provenance gets a human-edit step and
the confirmation, every file the profile's hand-off presets write (the manifest included, review
pending) is rendered again and read back, and the profile's validator runs under pick's rules (an
unapproved one exits 8 before any write). A file it would write that it cannot read (a hand-off file, the
review record, the card, an index.md or log.md) stops it before the first write. A
failed write, read-back (exit 6 handoff_check_failed) or library write, or a rejecting validator
(exit 6 validator_rejected), records no version and puts back every file it wrote, through
symbolic links, and remakes a link that pointed at nothing where it wrote a file; a file it could not put back is named in the error. Otherwise the version is appended
with its confirmation, source type and an adopt annotation, and the card, its lock, the indexes and
log.md are rewritten. An unchanged file, a Git LFS pointer, edited bytes of another media type, a
run id that is not one path segment, a missing run or a run without the version's candidate exits 2;
bytes of an older version exit 2 version_exists.`,
  input: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "the asset's card, media or review record (or give --asset)",
        placeholder: "<address>",
      },
      asset: { type: "string", description: "the asset id", placeholder: "<id>" },
      original: {
        type: "string",
        description: "the AI-made version that was handed off",
        placeholder: "<file>",
      },
      target: {
        type: "string",
        description:
          "the target directory (default: the Git top level of the asset's folder, or . with --asset)",
        placeholder: "<target directory>",
      },
      profile: PROFILE,
      bible: {
        type: "string",
        description: "the style bible whose palette the palette check uses",
        placeholder: "<bible.json>",
      },
    },
    required: ["original"],
    additionalProperties: false,
  },
  positionals: [{ name: "address" }],
  effect: { readOnly: false, spends: "never", writes: "target" },
  confirm: "pick",
  async run(args, ctx) {
    if (args.original === undefined) throw new InputError("missing required option --original");
    const cardPath = await adoptCard(args);
    const location = locateAsset(cardPath);
    const targetDir = resolve(
      args.target ?? (args.asset !== undefined ? "." : (projectOf(location) ?? ".")),
    );
    const files = { card: cardPath, original: resolve(args.original), target: targetDir };
    const before = await loadAsset(location);
    const edited = await workingFile(before);
    const original = await originalFile(before, files.original);
    // The run or import that made the asset drives the hand-off; its profile is confirmed with it.
    const source = await adoptSource(before, targetDir, edited.bytes);
    const request = adoptRequest(before, edited, original, files, source);
    // Headless settings never adopt: refused before any check reads or writes more.
    if (ctx.settings.mode === "headless") {
      return headlessRefusal(request, { asset: before.assetId, sha256: edited.sha256 }, "adopt");
    }
    requireMediaType(before, edited, source);
    const qa = await freeChecks(
      edited.bytes,
      await currentProvenance(before, source, targetDir),
      args.bible,
      { style: source.profile.style, original: original.bytes },
    );
    const failed = qa.filter((r) => !r.passed);
    if (failed.length > 0) {
      return refusal(
        "qa_found_nothing",
        `the edited ${before.resource} fails the free QA checks: ${failed.map((r) => `${r.check}: ${r.reason}`).join("; ")}`,
        { asset: before.assetId, sha256: edited.sha256, qa },
        failed.map((r) => `QA ${r.check}: ${r.reason}`).join("\n"),
      );
    }
    const confirmation = await personConfirms(request, ctx);
    const gate = { settings: ctx.settings, ...(ctx.prompt && { prompt: ctx.prompt }) };
    const result = await adoptHandEdit({
      asset: before,
      targetDir,
      edited,
      original,
      source,
      gate,
      ...(ctx.extensions && { registry: ctx.extensions }),
      confirmation,
      // Under the lock: the record, the file and the original are still what the person confirmed.
      async underLock() {
        const now = await loadAsset(location);
        const file = await workingFile(now);
        requireSameRequest(
          request,
          adoptRequest(
            now,
            file,
            await originalFile(now, files.original),
            files,
            await adoptSource(now, targetDir, file.bytes),
          ),
        );
      },
    });
    const record = result.library
      ? (await loadAsset(location)).record.annotations.findLast(
          (a) => a["ag:action"] === "adopt" && targetVersion(a) === result.sha256,
        )
      : undefined;
    const fields = {
      ...result,
      qa,
      ...(record && { annotation: annotationFields(record) }),
      confirmation,
    };
    const lines = [
      result.version === undefined
        ? `handed off ${before.resource}; no version recorded`
        : `adopted ${before.resource} as version ${result.version} of ${result.assetId} (${confirmation.method})`,
      ...result.files.map((f) => `wrote ${f}`),
    ];
    if (result.contentCredentials) {
      const { subject, warning } = result.contentCredentials;
      lines.push(`C2PA content credentials signed by ${subject}`);
      if (warning) lines.push(`warning: ${warning}`);
    }
    if (result.validator) {
      lines.push(
        `target validator ${result.validator.accepted ? "accepted" : "REJECTED"} the adopt` +
          (result.validator.output ? `:\n${result.validator.output}` : ""),
      );
    }
    const human = lines.join("\n");
    if (result.validator?.accepted === false) {
      return refusal(
        "validator_rejected",
        "the target's validator rejected the adopt; no version was recorded" +
          (result.notRestored
            ? `; these files could not be put back: ${result.notRestored.join(", ")}`
            : ""),
        fields,
        human,
      );
    }
    return { exitCode: 0, fields, human };
  },
});
