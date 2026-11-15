/**
 * `library check`, `library rebuild`, `library stats` and `library drift` (design sections 1.4
 * and 4): the library's records against their projections, and reports computed from the cards.
 */
import { join, resolve } from "node:path";
import { EXIT, InputError } from "../errors.ts";
import { BIBLE_PATH, PROFILE_PATH } from "../init.ts";
import { loadProfile } from "../inputs.ts";
import {
  bibleVersionOf,
  libraryDrift,
  libraryStats,
  readLibrary,
  rebuildLibrary,
} from "../library/maintain.ts";
import type { LibraryState } from "../library/maintain.ts";
import { acquireLibraryLock } from "../runs/lock.ts";
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
