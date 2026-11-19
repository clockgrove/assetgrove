import { canCarryMark, markableMediaType, markProblems } from "./handoff/mark-check.ts";
import {
  canCarryCredentials,
  credentialed,
  credentialProblem,
  DEVELOPMENT_SIGNER_WARNING,
  resolveSigner,
} from "./credentials.ts";
import type { ContentSigner, SignerRecord } from "./credentials.ts";
import { requireLfsMedia } from "./gitlfs.ts";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { DigitalSourceType } from "./metadata.ts";
import {
  combineDigitalSourceTypes,
  embedDigitalSourceType,
  readDigitalSourceType,
  metadataStep,
  requireDeclared,
} from "./metadata.ts";
import { decodeImage } from "./image/raster.ts";
import { pixelHash } from "./transform/run.ts";
import { InputError } from "./errors.ts";
import { commandIdentity, defaultGate, requireApproval, resolveProgram } from "./approvals.ts";
import type { ApprovalGate, CommandStep } from "./approvals.ts";
import { requireLicensable } from "./license.ts";
import { bindingOf, callsSha256 } from "./provenance-binding.ts";
import { keyFreeEnv, redact } from "./redact.ts";
import { presetToolRunner } from "./extension/tools.ts";
import type { ToolRunner, ToolStep } from "./extension/tools.ts";
import { GLB_MEDIA_TYPE } from "./model3d/glb.ts";
import { shapeModelHandoff } from "./model3d/handoff.ts";
import { readRun, writeRun } from "./loop.ts";
import type { StagedCandidate } from "./loop.ts";
import type { CandidateSummary } from "./library/summary.ts";
import {
  checkSpecValues,
  checkKindLayoutPaths,
  layoutFor,
  checkWrites,
  embedsProvenance,
  inGitDir,
  readRecordPath,
  relativeRecordPath,
} from "./paths.ts";
import { sha256 } from "./request.ts";
import { isInside } from "./settings.ts";
import { renderString, setPath } from "./template.ts";
import { acquireLibraryLock } from "./runs/lock.ts";
import {
  assetgroveVersion,
  commitLibraryWrite,
  libraryWritePaths,
  prepareLibraryWrite,
  recheckLibraryWrite,
  writeAtomic,
} from "./library/write.ts";
import type { CandidateReview, LibraryPlan } from "./library/write.ts";
import { WriteJournal } from "./library/undo.ts";
import type { VersionStatus } from "./library/review.ts";
import { HandoffCheckError, resolveHandoff } from "./handoff/presets/index.ts";
import type {
  FamiliesContext,
  HandedOffFamily,
  PresetContext,
  PresetRegistry,
  ResolvedPreset,
  TargetRead,
} from "./handoff/presets/index.ts";
import { CORE_REGISTRY } from "./extensions/registry.ts";
import { framesOf } from "./frames.ts";
import type { HandoffProblem, PresetFile } from "./handoff/presets/index.ts";
import type { AssetSpec, ConfirmationRecord, Provenance, TargetProfile } from "./types.ts";

const run = promisify(execFile);

export interface PickOptions {
  runDir: string;
  candidateId: string;
  /** The target repository (or directory) the pick is written into. */
  targetDir: string;
  now?: () => Date;
  /** How the profile's validator is approved; the developer settings with no prompt when absent. */
  gate?: ApprovalGate;
  /** The presets the profile's `handoff` list chooses among; core's when absent. */
  registry?: PresetRegistry;
  /** The person's confirmation of this pick (design section 7), copied into its provenance. */
  confirmation?: ConfirmationRecord;
  /** The version the confirmed pick replaces (sha256), or null for a first pick (TargetWrite.replaces). */
  replaces?: string | null;
  /** Refuse, before writing, media Git does not send to LFS (TargetWrite.requireLfs). */
  requireLfs?: boolean;
}

export interface PickResult {
  candidate: StagedCandidate;
  mediaPath: string;
  manifestPath: string;
  provenancePath?: string;
  /** Each hand-off preset that ran, with the files it wrote. */
  handoff?: PresetResult[];
  /** The C2PA content credentials signed into the images, and which certificate signed. */
  contentCredentials?: CredentialsResult;
  /** The card, review record, indexes and log the pick wrote. */
  library?: LibraryResult;
  validator?: ValidatorResult;
}

/** One hand-off preset that ran: its name and the files it wrote, relative to the target. */
export interface PresetResult {
  preset: string;
  files: string[];
  /** Each tool run the preset made through its context's `run`, approved, in order; absent when none. */
  tools?: ToolStep[];
}

/** What the target's validator said, and the approved command step that ran it. */
export interface ValidatorResult {
  accepted: boolean;
  command: string[];
  output: string;
  /** The command's hash and approval method (design section 8). */
  approval: CommandStep;
}

function inside(root: string, path: string): string {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new InputError(`profile layout path "${path}" leaves the target directory`);
  }
  return full;
}

/** The real path of `path`, or of its nearest existing ancestor joined with the rest. */
function realOf(path: string): string {
  if (existsSync(path)) return realpathSync.native(path);
  const parent = dirname(path);
  return parent === path ? path : join(realOf(parent), basename(path));
}

/**
 * Whether two paths reach one file: compared as real paths, so a link, a short (8.3) name or a
 * case-insensitive file system's other spelling of the same file is the same file.
 */
export function sameFilePath(a: string, b: string): boolean {
  const [x, y] = [realOf(resolve(a)), realOf(resolve(b))];
  return x === y || (process.platform !== "linux" && x.toLowerCase() === y.toLowerCase());
}

/** What every hand-off write is checked against. */
interface TargetGuard {
  targetDir: string;
  /** The target's real path. */
  realTarget: string;
  /** The real paths of the settings and state directories. */
  protectedDirs: string[];
  /** The real paths of the files the validator's argv names, which its approval hashes. */
  commandFiles: string[];
}

/**
 * The guard of a target. Refuses a target that is, holds or lies in the settings or state
 * directory: a hand-off never writes the developer's settings, approvals or confirmations.
 */
function targetGuard(
  targetDir: string,
  settings: { configDir: string; stateDir: string },
  validator: readonly string[] | undefined,
): TargetGuard {
  const realTarget = realOf(targetDir);
  const protectedDirs = [settings.configDir, settings.stateDir].map((dir) => realOf(resolve(dir)));
  for (const dir of protectedDirs) {
    if (isInside(dir, realTarget) || isInside(realTarget, dir)) {
      throw new InputError(
        `the target ${targetDir} holds or lies in the Assetgrove settings or state directory ${dir}`,
      );
    }
  }
  const commandFiles = (validator ?? [])
    .filter((arg) => arg !== "" && !arg.includes("{{"))
    .map((arg) => realOf(resolve(targetDir, arg)));
  return { targetDir, realTarget, protectedDirs, commandFiles };
}

/**
 * The absolute path of a hand-off write, checked on its real path: inside the target (a link in the
 * target cannot send it elsewhere), outside the settings and state directories, in no `.git`
 * directory, and not a file the validator's command names.
 */
function targetPath(guard: TargetGuard, rel: string): string {
  const full = inside(guard.targetDir, rel);
  if (inGitDir(rel)) throw new InputError(`profile layout path "${rel}" writes into .git`);
  const real = realOf(full);
  if (real === guard.realTarget || !isInside(real, guard.realTarget)) {
    throw new InputError(`profile layout path "${rel}" leaves the target directory through a link`);
  }
  if (guard.protectedDirs.some((dir) => isInside(real, dir))) {
    throw new InputError(`profile layout path "${rel}" reaches the Assetgrove settings or state`);
  }
  if (guard.commandFiles.some((file) => isInside(real, file) && isInside(file, real))) {
    throw new InputError(
      `profile layout path "${rel}" overwrites a file the validator command names`,
    );
  }
  return full;
}

/**
 * What a preset's `write` reads the target through: a path the target-path rule refuses is refused
 * (exit 2); a file that is missing or cannot be read is undefined.
 */
function targetRead(guard: TargetGuard): TargetRead {
  return async (rel) => {
    let path: string;
    try {
      path = targetPath(guard, rel);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new InputError(`a preset may not read "${rel}": ${why}`, { cause: error });
    }
    return readFile(path).then(
      (bytes) => new Uint8Array(bytes),
      () => undefined,
    );
  };
}

/** Refuses two writes that reach one file, through a link or a case-insensitive file system. */
function sameFile(paths: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const key = realOf(path).toLowerCase();
    const other = seen.get(key);
    if (other !== undefined)
      throw new InputError(`two writes reach one file: ${other} and ${path}`);
    seen.set(key, path);
  }
}

/**
 * Refuses, before the first of several hand-offs into one target writes anything, any two of their
 * writes that name or reach one file, so no hand-off replaces another's file.
 */
export function checkPreparedWrites(prepared: readonly PreparedTargetWrite[]): void {
  checkWrites(prepared.flatMap((p) => p.rels));
  sameFile(
    prepared.flatMap((p) => [...p.writes.map(([path]) => path), ...libraryFiles(p.library)]),
  );
}

/** The asset's own library files, which no hand-off write may also name. */
function libraryFiles(plan: LibraryPlan): string[] {
  return [plan.cardPath, plan.reviewPath];
}

/** What a hand-off writes: one media file with its fields and provenance. */
export interface TargetWrite {
  /**
   * Before anything is written, ask Git (`check-attr filter`) whether the media and its image
   * sidecars go to LFS: outside a work tree exit 2 `git_required`, else `lfs_required`.
   */
  requireLfs?: boolean;
  profile: TargetProfile;
  spec: AssetSpec;
  bibleVersion: string;
  output: {
    bytes: Uint8Array;
    mediaType: string;
    extension: string;
    fields: Record<string, unknown>;
    /** Files written beside the media; each is exposed to the templates as `output.<field>`. */
    sidecars?: Array<{
      name: string;
      bytes: Uint8Array;
      mediaType: string;
      field: string;
      extra?: Record<string, unknown>;
    }>;
  };
  provenance: Provenance;
  /** Values the templates read as `{{run.*}}`. */
  run: Record<string, unknown>;
  targetDir: string;
  /** How the profile's validator is approved; the developer settings with no prompt when absent. */
  gate?: ApprovalGate;
  /** The presets the profile's `handoff` list chooses among; core's when absent. */
  registry?: PresetRegistry;
  /** The person's confirmation of the hand-off, recorded with the version in the review record. */
  confirmation?: ConfirmationRecord;
  /** The candidate's review record, whose annotations are carried into the asset's. */
  candidateReview?: CandidateReview;
  /**
   * The asset's version this hand-off confirmed replacing: its sha256, or null when it confirmed
   * a first pick. Another current version exits 2 `version_changed` before any write.
   */
  replaces?: string | null;
  /** The picked candidate's model-written summary; never set for an adopt. */
  summary?: CandidateSummary;
  /** The candidate answers a change request: the version it was made on and the requests' ids. */
  answers?: { version: string; answers: string[] };
  /** The clock the library's version and log line are stamped with. */
  now?: () => Date;
  /**
   * A person's hand edit adopted as the next version (`library adopt`): the media's C2PA claim
   * records the edit of `original` (the AI-made version, a `parentOf` ingredient), the version is
   * appended with the annotation action `adopt`, and the validator runs before the library, so a
   * rejection records no version.
   */
  adopt?: {
    original: Uint8Array;
    /** Run under the library write lock before the first write; it throws to stop the adopt. */
    underLock?: () => Promise<void>;
  };
}

/** What a hand-off wrote into the library (docs/library.md). */
export interface LibraryResult {
  assetId: string;
  /** The current version's position in the stack. */
  version: number;
  sha256: string;
  state: VersionStatus;
  /** Whether this hand-off appended the version; false when completing an earlier one. */
  appended: boolean;
  /** Every library file this hand-off changed, relative to the target, in write order. */
  files: string[];
  /**
   * Cards and review records that do not parse, relative to the target; their assets' rows in
   * `index.md` and `log.md` were kept as those files had them. Absent when there are none.
   */
  unreadable?: { file: string; code: "card_invalid" | "review_invalid" | "index_invalid" }[];
}

/** The C2PA content credentials a hand-off signed into its images (docs/disclosure.md, "Content credentials"). */
export interface CredentialsResult extends SignerRecord {
  /** Each image carrying them, relative to the target. */
  files: string[];
  /** Present when the local development certificate signed: no C2PA trust list holds it. */
  warning?: string;
}

export { DEVELOPMENT_SIGNER_WARNING } from "./credentials.ts";

export interface TargetWriteResult {
  mediaPath: string;
  manifestPath: string;
  provenancePath?: string;
  /** Every written file, relative to the target directory. */
  files: string[];
  /** Each hand-off preset of the profile's `handoff` list, in order, with the files it wrote. */
  handoff: PresetResult[];
  /** The C2PA content credentials signed into the images, and which certificate signed. */
  contentCredentials?: CredentialsResult;
  /** The card, review record, indexes and log the hand-off wrote. */
  library?: LibraryResult;
  validator?: ValidatorResult;
  /**
   * An adopt the validator rejected: each file that could not be put back, with the reason. Absent
   * when every file was.
   */
  notRestored?: string[];
}

/**
 * The failure that stopped an adopt, with each file that could not be put back named in its
 * message and listed as `notRestored`; the error itself when every file was put back.
 */
async function undone(journal: WriteJournal, error: unknown): Promise<unknown> {
  const failed = await journal.restore();
  if (failed.length === 0) return error;
  const note = `; these files could not be put back: ${failed.join(", ")}`;
  const stopped = error instanceof Error ? error : new Error(String(error));
  stopped.message += note;
  (stopped as Error & { notRestored?: string[] }).notRestored = failed;
  return stopped;
}

/** A hand-off checked and rendered, with nothing written yet (see `prepareTargetWrite`). */
export interface PreparedTargetWrite {
  /** Every path the hand-off writes, relative to the target. */
  rels: string[];
  write: TargetWrite;
  targetDir: string;
  gate: ApprovalGate;
  guard: TargetGuard;
  presets: ResolvedPreset[];
  presetContext: PresetContext;
  presetFiles: PresetFile[][];
  /**
   * The context of each `scope: "families"` preset this hand-off ran, by the preset's index; such a
   * preset runs on one hand-off per asset (the last of `prepareTargetWrites`), so on the others it
   * is absent and the preset wrote nothing here.
   */
  familyContexts: Array<FamiliesContext | undefined>;
  /** The tool runner the preset at each index is handed: its own pack's tools only. */
  runnerOf: (i: number) => ToolRunner;
  /** Each preset's approved tool runs, by the preset's index. */
  toolSteps: ToolStep[][];
  /** Signs an image a preset writes, when the hand-off signs; records it in `credentials`. */
  signImage?: (rel: string, bytes: Uint8Array, mediaType: string) => Promise<Uint8Array>;
  mediaRel: string;
  manifestRel: string;
  mediaPath: string;
  manifestPath: string;
  provenancePath?: string;
  writes: Array<[string, Uint8Array | string]>;
  validatorStep?: CommandStep;
  /** The library write, checked. */
  library: LibraryPlan;
  /** The media bytes and provenance as written. */
  mediaBytes: Uint8Array;
  provenance: Provenance;
  provenanceBytes?: string;
  /** Where each sidecar is written, relative to the target. */
  sidecarRels: string[];
  /**
   * The images carrying C2PA content credentials, relative to the target, and their signer; present
   * whenever the hand-off signs, its `rels` empty when no image was signed.
   */
  credentials?: { signer: SignerRecord; rels: string[] };
  /** The sha256 of the media before its credentials were signed in, when they were. */
  contentSha256?: string;
}

/**
 * Writes one output into the target through the profile's hand-off presets (design section 14;
 * src/handoff/presets): first every preset's options are validated (exit 2), then the media,
 * sidecars and provenance are written with each preset's files (the `manifest` preset renders the
 * profile's template with the review field set to the profile's pending value), then each preset
 * checks what it wrote. A failed check throws a HandoffCheckError (exit 6 `handoff_check_failed`)
 * and the validator does not run. Then runs the target's validator, when the profile declares one;
 * the validator must be approved (src/approvals.ts) before anything is written, no write replaces a
 * file its command names, and its approval is checked again on the written target before it runs.
 * The provenance records its hash and approval method. Every write is checked on its real path
 * before the first one: it stays in the target, outside the settings and state directories and
 * any `.git` directory. Assetgrove never writes any review value other than pending. Refuses with
 * a LicenseError, before writing, an output whose provider grant the target cannot declare
 * (src/license.ts); `{{profile.license}}` renders the licence the output is declared under.
 */
export async function writeToTarget(write: TargetWrite): Promise<TargetWriteResult> {
  return commitTargetWrite(await prepareTargetWrite(write));
}

/** What the profile's layout and templates read as `spec`, `profile`, `bible`, `output`, `provenance` and `run`. */
function layoutContext(
  write: TargetWrite,
  provenance: Provenance,
  output: Pick<TargetWrite["output"], "bytes" | "mediaType" | "extension" | "fields">,
): Record<string, unknown> {
  const { profile, spec } = write;
  return {
    spec: { ...spec.fields, ...spec },
    profile: {
      ...profile.values,
      name: profile.name,
      // The licence this output is declared under, so a template never relabels it.
      license: provenance.license,
      ...(profile.style !== undefined && { style: profile.style }),
    },
    bible: { version: write.bibleVersion },
    output: {
      ...output.fields,
      mediaType: output.mediaType,
      extension: output.extension,
      sha256: sha256(output.bytes),
    },
    provenance,
    run: write.run,
  };
}

/** The provenance file of its own a hand-off writes, relative to the target; undefined when the manifest embeds it. */
function ownProvenanceRel(
  profile: TargetProfile,
  context: Record<string, unknown>,
  mediaRel: string,
): string | undefined {
  return profile.layout.provenance !== undefined
    ? renderString(profile.layout.provenance, context)
    : embedsProvenance(profile.manifest)
      ? undefined
      : `${mediaRel}.provenance.json`;
}

/**
 * Where a hand-off of `write` whose media is at `mediaRel` (relative to the target) keeps the
 * provenance, relative to the target: its own file, else the manifest that embeds it. Rendered as
 * `prepareTargetWrite` renders it; undefined when the layout cannot be rendered from `write`.
 */
export function provenanceLayout(write: TargetWrite, mediaRel: string): string | undefined {
  try {
    const context = layoutContext(write, write.provenance, write.output);
    return (
      ownProvenanceRel(write.profile, context, mediaRel) ??
      renderString(layoutFor(write.profile, write.spec.kind).manifest, context)
    );
  } catch {
    return undefined;
  }
}

/** Everything `writeToTarget` checks and renders before its first write; writes nothing. */
export async function prepareTargetWrite(write: TargetWrite): Promise<PreparedTargetWrite> {
  return (await prepareTargetWrites([write]))[0] as PreparedTargetWrite;
}

/**
 * Prepares several hand-offs into one target (each as `prepareTargetWrite`), then runs each
 * `scope: "families"` preset once per asset, over every family handed off for it so far: the
 * library's, with these hand-offs' families in place of their own. Its files go with the last of
 * that asset's hand-offs. Refuses, before anything is written, any two writes that reach one file.
 */
export async function prepareTargetWrites(
  writes: readonly TargetWrite[],
): Promise<PreparedTargetWrite[]> {
  const prepared: PreparedTargetWrite[] = [];
  for (const write of writes) prepared.push(await prepareOne(write));
  await runFamilyPresets(prepared);
  if (prepared.length > 1) checkPreparedWrites(prepared);
  return prepared;
}

/** The hand-offs of each asset, by target and spec `assetId`, in order. */
function byAsset(prepared: readonly PreparedTargetWrite[]): PreparedTargetWrite[][] {
  const groups = new Map<string, PreparedTargetWrite[]>();
  for (const p of prepared) {
    const key = JSON.stringify([p.targetDir, p.write.spec.assetId]);
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.values()];
}

/**
 * Every family handed off for the asset of `group` so far: each library card that records an
 * `animationFamily` and whose id is `<the spec's assetId>-<that family>` (the id a hand-off of that
 * asset and family gives it; the library holds one card per id), with a locked version; the
 * group's own families in place of theirs, sorted by name.
 */
async function handedOffFamilies(
  group: readonly PreparedTargetWrite[],
): Promise<HandedOffFamily[]> {
  const last = group.at(-1) as PreparedTargetWrite;
  const { spec } = last.write;
  const families = new Map<string, HandedOffFamily>();
  for (const card of last.library.cards) {
    const name = card.animationFamily;
    if (name === undefined || card.id !== `${spec.assetId}-${name}`) continue;
    if (card.sha256 === undefined || card.resource === undefined) continue;
    const file = join(card.dir, card.resource);
    const content = await readFile(file).catch(() => undefined);
    families.set(name, {
      name,
      id: card.id,
      media: relativeRecordPath(last.targetDir, file),
      sha256: card.sha256,
      ...(content !== undefined && { content }),
    });
  }
  for (const p of group) {
    const name = p.write.spec.animationFamily as string;
    families.set(name, {
      name,
      id: p.library.assetId,
      media: relativeRecordPath(p.targetDir, p.mediaPath),
      sha256: sha256(p.mediaBytes),
      content: p.mediaBytes,
    });
  }
  return [...families.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Runs each `scope: "families"` preset once per asset, on the last of its hand-offs, and adds its
 * files to that hand-off's writes, checked as every other write is. A hand-off whose spec names no
 * animation family is invalid input for such a preset.
 */
async function runFamilyPresets(prepared: readonly PreparedTargetWrite[]): Promise<void> {
  for (const group of byAsset(prepared)) {
    const last = group.at(-1) as PreparedTargetWrite;
    for (const [i, { preset, options }] of last.presets.entries()) {
      if (preset.scope !== "families") continue;
      for (const p of group) {
        if (p.write.spec.animationFamily === undefined) {
          throw new InputError(
            `the preset "${preset.name}" writes every family of an asset, and the spec of "${p.write.spec.assetId}" names no animationFamily`,
          );
        }
      }
      const ctx: FamiliesContext = {
        profile: last.write.profile,
        assetId: last.write.spec.assetId,
        families: await handedOffFamilies(group),
        run: last.runnerOf(i),
      };
      const ran = last.toolSteps[i]?.length ?? 0;
      const files = await preset.write(ctx, options, targetRead(last.guard));
      const steps = last.toolSteps[i]?.slice(ran) ?? [];
      if (steps.length > 0) await recordFamilyToolSteps(last, steps);
      // An image a preset writes is signed like the media.
      for (const [j, file] of files.entries()) {
        if (last.signImage === undefined || typeof file.content === "string") continue;
        const type = markableMediaType(file.path);
        if (type === undefined || !canCarryCredentials(type)) continue;
        files[j] = { ...file, content: await last.signImage(file.path, file.content, type) };
      }
      const at = 1 + last.presetFiles.slice(0, i).flat().length;
      last.presetFiles[i] = files;
      last.familyContexts[i] = ctx;
      last.rels.splice(at, 0, ...files.map((file) => file.path));
      checkWrites(last.rels);
      last.writes.splice(
        at,
        0,
        ...files.map((file): [string, Uint8Array | string] => [
          targetPath(last.guard, file.path),
          file.content,
        ]),
      );
      sameFile([...last.writes.map(([path]) => path), ...libraryFiles(last.library)]);
    }
  }
}

/** A provenance record as its own file holds it. */
const provenanceText = (provenance: Provenance) => `${JSON.stringify(provenance, null, 2)}\n`;

/**
 * The tool runs that made a hand-off's files join its record's commands, beside the validator's,
 * and the record is bound again to the media's bytes.
 */
function recordToolSteps(provenance: Provenance, steps: ToolStep[], media: Uint8Array): void {
  provenance.commands = [...(provenance.commands ?? []), ...steps];
  provenance.binding = bindingOf(provenance, media);
}

/**
 * A families preset's tool runs, recorded on the hand-off its files go with: the record's commands
 * and binding, its own provenance file, and every preset of it that ran no tool rendered again from
 * the record, to the same paths.
 */
async function recordFamilyToolSteps(p: PreparedTargetWrite, steps: ToolStep[]): Promise<void> {
  recordToolSteps(p.provenance, steps, p.mediaBytes);
  const replace = (path: string, content: Uint8Array | string) => {
    const entry = p.writes.find(([at]) => at === path);
    if (entry) entry[1] = content;
  };
  if (p.provenancePath !== undefined) {
    p.provenanceBytes = provenanceText(p.provenance);
    replace(p.provenancePath, p.provenanceBytes);
  }
  const read = targetRead(p.guard);
  for (const [i, { preset, options }] of p.presets.entries()) {
    if (preset.scope === "families" || (p.toolSteps[i]?.length ?? 0) > 0) continue;
    const files = await preset.write({ ...p.presetContext, run: p.runnerOf(i) }, options, read);
    const before = (p.presetFiles[i] ?? []).map((file) => file.path);
    if (JSON.stringify(files.map((file) => file.path)) !== JSON.stringify(before)) {
      throw new InputError(
        `the preset "${preset.name}" wrote other files when rendered again with the record's tool runs`,
      );
    }
    for (const [j, file] of files.entries()) {
      const type = markableMediaType(file.path);
      if (p.signImage === undefined || typeof file.content === "string") continue;
      if (type === undefined || !canCarryCredentials(type)) continue;
      files[j] = { ...file, content: await p.signImage(file.path, file.content, type) };
    }
    p.presetFiles[i] = files;
    for (const file of files) replace(targetPath(p.guard, file.path), file.content);
  }
}

/** One hand-off checked and rendered, its `scope: "families"` presets not yet run. */
async function prepareOne(write: TargetWrite): Promise<PreparedTargetWrite> {
  const { profile, spec } = write;
  // First: every spec value the layout and manifest name is set (a run staged before stage
  // checked this reaches here with a spec that lacks one).
  checkSpecValues(profile, spec);
  // Then: the profile's hand-off presets and their options.
  const presets = resolveHandoff(profile, write.registry);
  // Before anything is written: the output must be declarable under a licence the target takes.
  const licensed = requireLicensable(profile, write.provenance, write.registry?.operations);
  if (write.provenance.digitalSourceType === "undeclared") requireDeclared("undeclared");
  const known = [
    write.provenance.digitalSourceType,
    readDigitalSourceType(write.output.bytes, write.output.mediaType),
  ].filter((value) => value !== undefined);
  const digitalSourceType = known.length ? combineDigitalSourceTypes(known) : "undeclared";
  requireDeclared(digitalSourceType);
  // The mark carries the sha256 of the record's calls: evidence outside the provenance file that
  // it is the record of these bytes (src/provenance-binding.ts).
  const marks = callsSha256(write.provenance);
  const output = {
    ...write.output,
    bytes: embedDigitalSourceType(write.output.bytes, write.output.mediaType, digitalSourceType, {
      models: write.provenance.models,
      callsSha256: marks,
    }),
  };
  // A sidecar in a format that can carry the mark is marked like the media.
  const sidecars = (write.output.sidecars ?? []).map((sidecar) => {
    if (sidecar.name === "" || /[\\/]/.test(sidecar.name) || sidecar.name.includes("..")) {
      throw new InputError(`sidecar name "${sidecar.name}" must be a bare file name`);
    }
    const type = markableMediaType(sidecar.name);
    return type === undefined
      ? { ...sidecar }
      : {
          ...sidecar,
          bytes: embedDigitalSourceType(sidecar.bytes, type, digitalSourceType, {
            models: write.provenance.models,
            callsSha256: marks,
          }),
        };
  });
  // A binding the record came with describes other bytes; this hand-off binds it again below.
  // "Made outside Assetgrove" means no call, so it is read from the final calls: a step that added
  // a call to outside media (look-dev, fix-frame) leaves it behind.
  // modelMadeOutsideAssetgrove stays: a call a later step added says nothing of the source's grant.
  const { binding: _stale, madeOutsideAssetgrove: _outside, ...unbound } = licensed;
  void _stale;
  void _outside;
  const provenance: Provenance = {
    ...unbound,
    digitalSourceType,
    ...(_outside === true && unbound.calls.length === 0 && { madeOutsideAssetgrove: true }),
  };
  const last = provenance.steps?.at(-1);
  if (
    last?.op !== "embed-digital-source-type" ||
    last.params["digitalSourceType"] !== digitalSourceType
  ) {
    const hashes = ["image/png", "image/jpeg"].includes(output.mediaType)
      ? [pixelHash(decodeImage(output.bytes))]
      : [];
    provenance.steps = [...(provenance.steps ?? []), metadataStep(digitalSourceType, hashes)];
  }
  const targetDir = resolve(write.targetDir);
  const gate = write.gate ?? defaultGate();
  const guard = targetGuard(targetDir, gate.settings, profile.validator?.command);
  // Every PNG, JPEG and WebP is signed with C2PA content credentials beside the IPTC mark.
  const signs =
    canCarryCredentials(output.mediaType) ||
    sidecars.some((sidecar) => canCarryCredentials(markableMediaType(sidecar.name) ?? ""));
  const signer = signs ? await resolveSigner(gate.settings) : undefined;
  if (signer) provenance.contentCredentials = signer.record;
  // Before anything is written: the validator a profile names runs only with an approval.
  let validatorStep: CommandStep | undefined;
  if (profile.validator) {
    const template = profile.validator.command;
    if (!template[0]) throw new InputError("the profile's validator command is empty");
    resolveProgram(template[0], targetDir);
    const identity = commandIdentity("validator", template, targetDir);
    validatorStep = await requireApproval(identity, gate);
    provenance.commands = [...(provenance.commands ?? []), validatorStep];
  }
  const context = layoutContext(write, provenance, output);
  const layout = layoutFor(profile, spec.kind);
  checkKindLayoutPaths(
    profile,
    spec.kind,
    (template) => renderString(template, context),
    targetDir,
  );
  const signed: string[] = [];
  const sign = signer && credentialSigner(signer, guard, digitalSourceType, provenance.models);
  let contentSha256: string | undefined;
  if (sign && canCarryCredentials(output.mediaType)) {
    contentSha256 = sha256(output.bytes);
    // The path is rendered first to find the file already there, then again with the signed bytes.
    const rel = renderString(layout.media, context);
    output.bytes = await sign(rel, output.bytes, output.mediaType, write.adopt?.original);
    (context["output"] as Record<string, unknown>)["sha256"] = sha256(output.bytes);
  }
  const mediaRel = renderString(layout.media, context);
  if (sign && canCarryCredentials(output.mediaType)) signed.push(mediaRel);
  const manifestRel = renderString(layout.manifest, context);
  const provenanceRel = ownProvenanceRel(profile, context, mediaRel);
  (context["output"] as Record<string, unknown>)["path"] = mediaRel;
  const sidecarRels: string[] = [];
  for (const sidecar of sidecars) {
    if (sidecar.name === "" || /[\\/]/.test(sidecar.name) || sidecar.name.includes("..")) {
      throw new InputError(`sidecar name "${sidecar.name}" must be a bare file name`);
    }
    const rel = posix.join(posix.dirname(mediaRel.replaceAll("\\", "/")), sidecar.name);
    const type = markableMediaType(sidecar.name);
    if (sign && type !== undefined && canCarryCredentials(type)) {
      sidecar.bytes = await sign(rel, sidecar.bytes, type);
      signed.push(rel);
    }
    setPath(context["output"] as Record<string, unknown>, sidecar.field, {
      ...sidecar.extra,
      path: rel,
      sha256: sha256(sidecar.bytes),
    });
    sidecarRels.push(rel);
  }
  if (provenanceRel !== undefined) context["provenancePath"] = provenanceRel;
  // Last, once the media's bytes are final (marked and signed): the record is bound to them, so
  // the manifest, the provenance file and the template context carry the binding.
  provenance.binding = bindingOf(provenance, output.bytes);

  const kinds = write.registry?.kinds ?? CORE_REGISTRY.kinds;
  const frames = framesOf(spec.kind, { kinds });
  const presetContext: PreparedTargetWrite["presetContext"] = {
    profile,
    context,
    manifestRel,
    ...(frames !== undefined && { frames }),
  };
  // A preset reads the target as it is before this hand-off writes, and runs only its own pack's
  // tools, in scratch, under the approval rules, with the game project as the approval's project.
  const read = targetRead(guard);
  const toolSteps: ToolStep[][] = presets.map(() => []);
  const runnerOf = (i: number): ToolRunner =>
    presetToolRunner(presets[i]?.preset.name ?? "", {
      tools: write.registry?.tools,
      gate,
      projectDir: targetDir,
      onStep: (step) => toolSteps[i]?.push(step),
    });
  const presetFiles: PresetFile[][] = [];
  for (const [i, { preset, options }] of presets.entries()) {
    presetFiles.push(
      preset.scope === "families"
        ? []
        : await preset.write({ ...presetContext, run: runnerOf(i) }, options, read),
    );
  }
  // A tool that made files is in the record: its steps join the commands, the record is bound
  // again, and every preset that ran no tool (the manifest) is rendered again from it.
  if (toolSteps.some((steps) => steps.length > 0)) {
    recordToolSteps(provenance, toolSteps.flat(), output.bytes);
    for (const [i, { preset, options }] of presets.entries()) {
      if (preset.scope === "families" || (toolSteps[i]?.length ?? 0) > 0) continue;
      presetFiles[i] = await preset.write({ ...presetContext, run: runnerOf(i) }, options, read);
    }
  }
  // An image a preset writes is signed like the media.
  const signImage =
    sign &&
    (async (rel: string, bytes: Uint8Array, type: string) => {
      const signedBytes = await sign(rel, bytes, type);
      if (!signed.includes(rel)) signed.push(rel);
      return signedBytes;
    });
  for (const files of presetFiles) {
    for (const [i, file] of files.entries()) {
      const type = markableMediaType(file.path);
      if (!signImage || type === undefined || !canCarryCredentials(type)) continue;
      if (typeof file.content === "string") continue;
      files[i] = { ...file, content: await signImage(file.path, file.content, type) };
    }
  }

  // Before anything is written: no two writes name one file or differ only by case, and Windows
  // can hold every segment.
  const rels = [
    mediaRel,
    ...presetFiles.flat().map((file) => file.path),
    ...sidecarRels,
    ...(provenanceRel === undefined ? [] : [provenanceRel]),
  ];
  checkWrites(rels);
  const mediaPath = targetPath(guard, mediaRel);
  const manifestPath = targetPath(guard, manifestRel);
  const provenancePath = provenanceRel === undefined ? undefined : targetPath(guard, provenanceRel);
  const writes: Array<[string, Uint8Array | string]> = [
    [mediaPath, output.bytes],
    ...presetFiles
      .flat()
      .map((file): [string, Uint8Array | string] => [targetPath(guard, file.path), file.content]),
  ];
  sidecars.forEach((sidecar, i) => {
    writes.push([targetPath(guard, sidecarRels[i] as string), sidecar.bytes]);
  });
  const provenanceBytes = provenancePath ? provenanceText(provenance) : undefined;
  if (provenancePath && provenanceBytes !== undefined)
    writes.push([provenancePath, provenanceBytes]);
  // Before anything is written: the asset id is free and the library's own files are readable.
  if (write.requireLfs) {
    requireLfsMedia([
      mediaPath,
      ...(write.output.sidecars ?? [])
        .map((sidecar, i) => [sidecar, sidecarRels[i] as string] as const)
        .filter(
          ([sidecar]) =>
            !sidecar.mediaType.startsWith("text/") &&
            sidecar.mediaType !== "application/json" &&
            !sidecar.mediaType.endsWith("+json"),
        )
        .map(([, rel]) => targetPath(guard, rel)),
    ]);
  }
  const library = await prepareLibraryWrite({
    profile,
    spec,
    targetDir,
    mediaPath,
    manifestPath,
    ...(provenancePath !== undefined && { provenancePath }),
    mediaBytes: output.bytes,
    ...(contentSha256 !== undefined && { contentSha256 }),
    ...(write.replaces !== undefined && { replaces: write.replaces }),
    ...(write.answers && { answers: write.answers }),
  });
  sameFile([...writes.map(([path]) => path), ...libraryFiles(library)]);
  return {
    rels,
    write,
    targetDir,
    gate,
    guard,
    presets,
    presetContext,
    presetFiles,
    familyContexts: presets.map(() => undefined),
    runnerOf,
    toolSteps,
    ...(signImage && { signImage }),
    mediaRel,
    manifestRel,
    mediaPath,
    manifestPath,
    ...(provenancePath !== undefined && { provenancePath }),
    writes,
    ...(validatorStep !== undefined && { validatorStep }),
    library,
    mediaBytes: output.bytes,
    provenance,
    ...(provenanceBytes !== undefined && { provenanceBytes }),
    sidecarRels,
    // A families preset run later may sign more images into the same list.
    ...(signer && { credentials: { signer: signer.record, rels: signed } }),
    ...(contentSha256 !== undefined && { contentSha256 }),
  };
}

/**
 * Signs one image for a hand-off: the file already at `rel` is kept when its manifest holds for
 * these bytes and this signer, so re-running an unchanged hand-off leaves its bytes as they were.
 */
function credentialSigner(
  signer: ContentSigner,
  guard: TargetGuard,
  digitalSourceType: DigitalSourceType,
  models: readonly string[],
): (
  rel: string,
  bytes: Uint8Array,
  mediaType: string,
  original?: Uint8Array,
) => Promise<Uint8Array> {
  return async (rel, bytes, mediaType, original) => {
    const path = targetPath(guard, rel);
    const existing = await readFile(path).then(
      (data) => new Uint8Array(data),
      () => undefined,
    );
    const title = posix.basename(rel.replaceAll("\\", "/"));
    // An adopted hand edit records the edit of its original, a `parentOf` ingredient.
    const claim = {
      digitalSourceType,
      models,
      title,
      ...(original !== undefined && { original: { bytes: original, mediaType, title } }),
    };
    return credentialed(bytes, mediaType, claim, signer, assetgroveVersion(), existing);
  };
}

/**
 * Writes a prepared hand-off under the library write lock, each file through a temporary file
 * renamed over it: the media, its files and provenance, then each preset's check, then the library
 * (review record, card, indexes, log); then runs the approved validator. An adopt reads every file
 * before its first write (a file it cannot read stops it there), writes through symbolic links,
 * runs its validator before the library, and when any step fails, the validator rejects or the
 * library write fails, puts back every file it wrote (see `WriteJournal`).
 */
export async function commitTargetWrite(prepared: PreparedTargetWrite): Promise<TargetWriteResult> {
  const lock = acquireLibraryLock(prepared.library.config.root, prepared.gate.settings.stateDir);
  try {
    return await commitLocked(prepared);
  } finally {
    lock.release();
  }
}

async function commitLocked(prepared: PreparedTargetWrite): Promise<TargetWriteResult> {
  const { writes } = prepared;
  // Another writer may have committed since this was prepared: check again before any write.
  await recheckLibraryWrite(prepared.library);
  await prepared.write.adopt?.underLock?.();
  if (prepared.write.adopt === undefined) {
    for (const [path, content] of writes) await writeAtomic(path, content);
    return await commitWritten(prepared);
  }
  // An adopt that fails puts back every file it wrote, so no file describes an unrecorded version.
  // Every file is read before the first write: one that cannot be read stops the adopt here.
  const journal = new WriteJournal();
  for (const [path] of writes) await journal.snapshot(path);
  for (const path of libraryWritePaths(prepared.library)) await journal.snapshot(path);
  let result: TargetWriteResult;
  try {
    for (const [path, content] of writes) await journal.write(path, content);
    result = await commitWritten(prepared, journal);
  } catch (error) {
    throw await undone(journal, error);
  }
  if (result.validator?.accepted === false) {
    const failed = await journal.restore();
    if (failed.length > 0) result.notRestored = failed;
  }
  return result;
}

/**
 * Everything after a hand-off's files are written: the read-back, the validator and the library.
 * An adopt (given its `journal`) runs the validator before the library and stops at a rejection.
 */
async function commitWritten(
  prepared: PreparedTargetWrite,
  journal?: WriteJournal,
): Promise<TargetWriteResult> {
  const { targetDir, guard, presets, presetContext, presetFiles, writes } = prepared;
  const result: TargetWriteResult = {
    mediaPath: prepared.mediaPath,
    manifestPath: prepared.manifestPath,
    ...(prepared.provenancePath !== undefined && { provenancePath: prepared.provenancePath }),
    files: writes.map(([path]) => relativeRecordPath(targetDir, path)),
    handoff: presets.map(({ preset }, i) => ({
      preset: preset.name,
      files: (presetFiles[i] ?? []).map((file) =>
        relativeRecordPath(targetDir, inside(targetDir, file.path)),
      ),
    })),
  };
  if (prepared.credentials && prepared.credentials.rels.length > 0) {
    const { signer, rels } = prepared.credentials;
    result.contentCredentials = {
      ...signer,
      files: rels.map((rel) => relativeRecordPath(targetDir, inside(targetDir, rel))),
      ...(signer.development && { warning: DEVELOPMENT_SIGNER_WARNING }),
    };
  }

  // Each preset checks what it wrote; a failed check stops the hand-off before the validator.
  const read = (rel: string) =>
    readFile(targetPath(guard, rel)).then(
      (bytes) => new Uint8Array(bytes),
      () => undefined,
    );
  const problems: HandoffProblem[] = [];
  const { write } = prepared;
  for (const [i, { preset, options }] of presets.entries()) {
    const files = presetFiles[i] ?? [];
    // A families preset that ran on another hand-off of this asset is checked there; this
    // hand-off's media is still read back for its mark below.
    const families = prepared.familyContexts[i];
    const found =
      preset.scope !== "families"
        ? await preset.check({ ...presetContext, run: prepared.runnerOf(i) }, options, files, read)
        : families === undefined
          ? []
          : await preset.check(families, options, files, read);
    problems.push(...found.map((problem) => ({ preset: preset.name, problem })));
    // The mark is read back from the media and from every file this preset wrote that can carry it.
    const expected = {
      digitalSourceType: prepared.provenance.digitalSourceType ?? "undeclared",
      models: prepared.provenance.models,
    };
    const marked: Array<[string, string]> = [];
    if (canCarryMark(write.output.mediaType))
      marked.push([prepared.mediaRel, write.output.mediaType]);
    for (const file of presetFiles[i] ?? []) {
      const type = markableMediaType(file.path);
      if (type !== undefined) marked.push([file.path, type]);
    }
    for (const [path, type] of marked) {
      const adopted = write.adopt !== undefined && path === prepared.mediaRel;
      problems.push(
        ...(await fileProblems(
          path,
          await read(path),
          type,
          { ...expected, adopted },
          preset.name,
        )),
      );
    }
  }
  // Sidecars are read back whatever the presets are.
  for (const rel of prepared.sidecarRels) {
    const type = markableMediaType(rel);
    if (type === undefined) continue;
    const expected = {
      digitalSourceType: prepared.provenance.digitalSourceType ?? "undeclared",
      models: prepared.provenance.models,
    };
    problems.push(...(await fileProblems(rel, await read(rel), type, expected, "sidecar")));
  }
  // Each preset's tool runs, its checks' included, once every check has run.
  for (const [i, entry] of result.handoff.entries()) {
    const steps = prepared.toolSteps[i] ?? [];
    if (steps.length > 0) entry.tools = [...steps];
  }
  if (problems.length > 0) throw new HandoffCheckError(problems);
  // An adopt's validator runs before the library, so a rejection records no version.
  if (write.adopt !== undefined) {
    const validator = await runValidator(prepared);
    if (validator !== undefined) result.validator = validator;
    if (validator?.accepted === false) return result;
  }
  // Every preset check passed: the version goes into the library.
  const library = await commitLibraryWrite(
    prepared.library,
    {
      mediaBytes: prepared.mediaBytes,
      provenance: prepared.provenance,
      ...(prepared.provenanceBytes !== undefined && { provenanceBytes: prepared.provenanceBytes }),
      ...(prepared.contentSha256 !== undefined && { contentSha256: prepared.contentSha256 }),
      spec: write.spec,
      run: String(write.run["runId"] ?? ""),
      candidate: String(write.run["candidateId"] ?? ""),
      ...(write.confirmation && { confirmation: write.confirmation }),
      ...(write.answers && { answers: write.answers.answers }),
      ...(write.candidateReview && { candidateReview: write.candidateReview }),
      ...(write.summary !== undefined && write.adopt === undefined && { summary: write.summary }),
      ...(write.adopt !== undefined && {
        action: "adopt" as const,
        digitalSourceType: prepared.provenance.digitalSourceType,
      }),
      now: (write.now ?? (() => new Date()))(),
      assetgrove: assetgroveVersion(),
    },
    journal,
  );
  result.library = {
    ...library,
    files: library.files.map((path) => relativeRecordPath(targetDir, path)),
    ...(library.unreadable && {
      unreadable: library.unreadable.map((u) => ({
        ...u,
        file: relativeRecordPath(targetDir, u.file),
      })),
    }),
  };
  if (write.adopt === undefined) {
    const validator = await runValidator(prepared);
    if (validator !== undefined) result.validator = validator;
  }
  return result;
}

/** Runs the profile's approved validator on the written target, when it declares one. */
async function runValidator(prepared: PreparedTargetWrite): Promise<ValidatorResult | undefined> {
  const { targetDir } = prepared;
  const { profile } = prepared.write;
  if (profile.validator && prepared.validatorStep) {
    // The approval must hold for the command as the written target now has it.
    const identity = commandIdentity("validator", profile.validator.command, targetDir);
    const approval =
      identity.hash === prepared.validatorStep.hash
        ? prepared.validatorStep
        : await requireApproval(identity, prepared.gate);
    const vars = { manifest: prepared.manifestRel, media: prepared.mediaRel };
    const command = profile.validator.command.map((part) => renderString(part, vars));
    const [file, ...args] = command;
    if (!file) throw new InputError("the profile's validator command is empty");
    const program = resolveProgram(file, targetDir);
    // The validator runs without any key variable, and its output is redacted before it is kept.
    try {
      const { stdout, stderr } = await run(program, args, { cwd: targetDir, env: keyFreeEnv() });
      const output = redact(`${stdout}${stderr}`.trim());
      return { accepted: true, command, output, approval };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message: string };
      const out = redact(`${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message);
      return { accepted: false, command, output: out, approval };
    }
  }
  return undefined;
}

/**
 * The problems of one written file's marks: its IPTC mark, and for a PNG, JPEG or WebP its C2PA
 * content credentials, read back and validated. Each problem names the file.
 */
async function fileProblems(
  path: string,
  bytes: Uint8Array | undefined,
  type: string,
  expected: { digitalSourceType: DigitalSourceType; models: readonly string[]; adopted?: boolean },
  preset: string,
): Promise<HandoffProblem[]> {
  const problems: HandoffProblem[] = markProblems(path, bytes, type, expected).map(
    ({ code, message }) => ({
      preset,
      problem: message,
      file: path,
      code,
    }),
  );
  if (bytes !== undefined && canCarryCredentials(type)) {
    const found = await credentialProblem(path, bytes, type, {
      digitalSourceType: expected.digitalSourceType,
      models: expected.models,
      ...(expected.adopted === true && { adopted: true }),
    });
    if (found) problems.push({ preset, file: path, ...found });
  }
  return problems;
}

/**
 * Writes the author's pick into the target (see `writeToTarget`) and records the pick in the run.
 */
export async function pick(options: PickOptions): Promise<PickResult> {
  const record = await readRun(options.runDir);
  const candidate = record.candidates.find((c) => c.id === options.candidateId);
  if (!candidate) {
    const ids = record.candidates.map((c) => c.id).join(", ") || "none";
    throw new InputError(
      `"${options.candidateId}" is not a QA-passing candidate of run ${record.runId} (passing: ${ids})`,
    );
  }
  const bytes = new Uint8Array(
    await readFile(join(options.runDir, readRecordPath(candidate.file, "staged file"))),
  );
  if (sha256(bytes) !== candidate.sha256) {
    throw new InputError(`staged file ${candidate.file} changed since it was staged`);
  }
  const sidecars = [];
  for (const staged of candidate.sidecars ?? []) {
    const sidecarBytes = new Uint8Array(
      await readFile(join(options.runDir, readRecordPath(staged.file, "staged file"))),
    );
    if (sha256(sidecarBytes) !== staged.sha256) {
      throw new InputError(`staged file ${staged.file} changed since it was staged`);
    }
    sidecars.push({
      name: staged.name,
      bytes: sidecarBytes,
      mediaType: staged.mediaType,
      field: staged.field,
      ...(staged.extra !== undefined && { extra: staged.extra }),
    });
  }
  // A 3D output takes the shape its target declares: clip fields, side images (assetgrove#137).
  const shaped =
    candidate.mediaType === GLB_MEDIA_TYPE && record.profile.model3d !== undefined
      ? shapeModelHandoff(record.profile, { bytes, fields: candidate.fields, sidecars })
      : { bytes, fields: candidate.fields, sidecars };
  const now = options.now ?? (() => new Date());
  const targetDir = resolve(options.targetDir);
  const written = await writeToTarget({
    profile: record.profile,
    spec: record.spec,
    bibleVersion: record.bibleVersion,
    output: {
      bytes: shaped.bytes,
      mediaType: candidate.mediaType,
      extension: candidate.extension,
      fields: shaped.fields,
      ...(shaped.sidecars.length > 0 && { sidecars: shaped.sidecars }),
    },
    provenance: options.confirmation
      ? { ...candidate.provenance, confirmation: options.confirmation }
      : candidate.provenance,
    run: { runId: record.runId, candidateId: candidate.id, pickedAt: now().toISOString() },
    targetDir,
    ...(options.gate && { gate: options.gate }),
    ...(options.registry && { registry: options.registry }),
    ...(options.confirmation && { confirmation: options.confirmation }),
    ...(options.replaces !== undefined && { replaces: options.replaces }),
    ...(options.requireLfs && { requireLfs: true }),
    ...(record.changeRequest && {
      answers: { version: record.changeRequest.version, answers: record.changeRequest.answers },
    }),
    ...(candidate.summary !== undefined && { summary: candidate.summary }),
    candidateReview: {
      path: join(options.runDir, "reviews", `${candidate.id}.review.json`),
      root: resolve(options.runDir),
    },
    now,
  });
  const { files, ...rest } = written;
  record.picked = {
    candidateId: candidate.id,
    at: now().toISOString(),
    target: targetDir,
    files,
  };
  await writeRun(options.runDir, record);
  return { candidate, ...rest };
}
