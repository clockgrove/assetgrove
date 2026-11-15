import { canCarryMark, markableMediaType, markProblems } from "./handoff/mark-check.ts";
import {
  canCarryCredentials,
  credentialed,
  credentialProblem,
  DEVELOPMENT_SIGNER_WARNING,
  resolveSigner,
} from "./credentials.ts";
import type { ContentSigner, SignerRecord } from "./credentials.ts";
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
import { keyFreeEnv, redact } from "./redact.ts";
import { GLB_MEDIA_TYPE } from "./model3d/glb.ts";
import { shapeModelHandoff } from "./model3d/handoff.ts";
import { readRun, writeRun } from "./loop.ts";
import type { StagedCandidate } from "./loop.ts";
import {
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
  prepareLibraryWrite,
  writeAtomic,
} from "./library/write.ts";
import type { CandidateReview, LibraryPlan } from "./library/write.ts";
import type { VersionStatus } from "./library/review.ts";
import { HandoffCheckError, resolveHandoff } from "./handoff/presets/index.ts";
import type { PresetRegistry, ResolvedPreset } from "./handoff/presets/index.ts";
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
  /** The clock the library's version and log line are stamped with. */
  now?: () => Date;
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
}

/** The C2PA content credentials a hand-off signed into its images (docs/handoff.md). */
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
  presetContext: { profile: TargetProfile; context: Record<string, unknown>; manifestRel: string };
  presetFiles: PresetFile[][];
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
  /** The images carrying C2PA content credentials, relative to the target, and their signer. */
  credentials?: { signer: SignerRecord; rels: string[] };
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

/** Everything `writeToTarget` checks and renders before its first write; writes nothing. */
export async function prepareTargetWrite(write: TargetWrite): Promise<PreparedTargetWrite> {
  const { profile, spec } = write;
  // First: the profile's hand-off presets and their options.
  const presets = resolveHandoff(profile, write.registry);
  // Before anything is written: the output must be declarable under a licence the target takes.
  const licensed = requireLicensable(profile, write.provenance);
  if (write.provenance.digitalSourceType === "undeclared") requireDeclared("undeclared");
  const known = [
    write.provenance.digitalSourceType,
    readDigitalSourceType(write.output.bytes, write.output.mediaType),
  ].filter((value) => value !== undefined);
  const digitalSourceType = known.length ? combineDigitalSourceTypes(known) : "undeclared";
  requireDeclared(digitalSourceType);
  const output = {
    ...write.output,
    bytes: embedDigitalSourceType(write.output.bytes, write.output.mediaType, digitalSourceType, {
      models: write.provenance.models,
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
          }),
        };
  });
  const provenance = { ...licensed, digitalSourceType };
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
  const context: Record<string, unknown> = {
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
  const signed: string[] = [];
  const sign = signer && credentialSigner(signer, guard, digitalSourceType, provenance.models);
  if (sign && canCarryCredentials(output.mediaType)) {
    // The path is rendered first to find the file already there, then again with the signed bytes.
    const rel = renderString(profile.layout.media, context);
    output.bytes = await sign(rel, output.bytes, output.mediaType);
    (context["output"] as Record<string, unknown>)["sha256"] = sha256(output.bytes);
  }
  const mediaRel = renderString(profile.layout.media, context);
  if (sign && canCarryCredentials(output.mediaType)) signed.push(mediaRel);
  const manifestRel = renderString(profile.layout.manifest, context);
  const provenanceRel =
    profile.layout.provenance !== undefined
      ? renderString(profile.layout.provenance, context)
      : embedsProvenance(profile.manifest)
        ? undefined
        : `${mediaRel}.provenance.json`;
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

  const presetContext = { profile, context, manifestRel };
  const presetFiles: PresetFile[][] = presets.map(({ preset, options }) =>
    preset.write(presetContext, options),
  );
  // An image a preset writes is signed like the media.
  for (const files of presetFiles) {
    for (const [i, file] of files.entries()) {
      const type = markableMediaType(file.path);
      if (!sign || type === undefined || !canCarryCredentials(type)) continue;
      if (typeof file.content === "string") continue;
      files[i] = { ...file, content: await sign(file.path, file.content, type) };
      signed.push(file.path);
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
  const provenanceBytes = provenancePath ? `${JSON.stringify(provenance, null, 2)}\n` : undefined;
  if (provenancePath && provenanceBytes !== undefined)
    writes.push([provenancePath, provenanceBytes]);
  // Before anything is written: the asset id is free and the library's own files are readable.
  const library = await prepareLibraryWrite({
    profile,
    spec,
    targetDir,
    mediaPath,
    manifestPath,
    ...(provenancePath !== undefined && { provenancePath }),
    mediaBytes: output.bytes,
    ...(write.replaces !== undefined && { replaces: write.replaces }),
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
    ...(signer && signed.length > 0 && { credentials: { signer: signer.record, rels: signed } }),
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
): (rel: string, bytes: Uint8Array, mediaType: string) => Promise<Uint8Array> {
  return async (rel, bytes, mediaType) => {
    const path = targetPath(guard, rel);
    const existing = await readFile(path).then(
      (data) => new Uint8Array(data),
      () => undefined,
    );
    const claim = { digitalSourceType, models, title: posix.basename(rel.replaceAll("\\", "/")) };
    return credentialed(bytes, mediaType, claim, signer, assetgroveVersion(), existing);
  };
}

/**
 * Writes a prepared hand-off under the library write lock, each file through a temporary file
 * renamed over it: the media, its files and provenance, then each preset's check, then the library
 * (review record, card, indexes, log); then runs the approved validator.
 */
export async function commitTargetWrite(prepared: PreparedTargetWrite): Promise<TargetWriteResult> {
  const lock = acquireLibraryLock(prepared.targetDir, prepared.gate.settings.stateDir);
  try {
    return await commitLocked(prepared);
  } finally {
    lock.release();
  }
}

async function commitLocked(prepared: PreparedTargetWrite): Promise<TargetWriteResult> {
  const { targetDir, guard, presets, presetContext, presetFiles, writes } = prepared;
  const { profile } = prepared.write;
  for (const [path, content] of writes) await writeAtomic(path, content);

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
  if (prepared.credentials) {
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
    const found = await preset.check(presetContext, options, presetFiles[i] ?? [], read);
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
      problems.push(...(await fileProblems(path, await read(path), type, expected, preset.name)));
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
  if (problems.length > 0) throw new HandoffCheckError(problems);
  // Every preset check passed: the version goes into the library.
  const library = await commitLibraryWrite(prepared.library, {
    mediaBytes: prepared.mediaBytes,
    provenance: prepared.provenance,
    ...(prepared.provenanceBytes !== undefined && { provenanceBytes: prepared.provenanceBytes }),
    spec: write.spec,
    run: String(write.run["runId"] ?? ""),
    candidate: String(write.run["candidateId"] ?? ""),
    ...(write.confirmation && { confirmation: write.confirmation }),
    ...(write.candidateReview && { candidateReview: write.candidateReview }),
    now: (write.now ?? (() => new Date()))(),
    assetgrove: assetgroveVersion(),
  });
  result.library = {
    ...library,
    files: library.files.map((path) => relativeRecordPath(targetDir, path)),
  };
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
      result.validator = { accepted: true, command, output, approval };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message: string };
      const out = redact(`${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message);
      result.validator = { accepted: false, command, output: out, approval };
    }
  }
  return result;
}

/**
 * The problems of one written file's marks: its IPTC mark, and for a PNG, JPEG or WebP its C2PA
 * content credentials, read back and validated. Each problem names the file.
 */
async function fileProblems(
  path: string,
  bytes: Uint8Array | undefined,
  type: string,
  expected: { digitalSourceType: DigitalSourceType; models: readonly string[] },
  preset: string,
): Promise<HandoffProblem[]> {
  const problems: HandoffProblem[] = markProblems(path, bytes, type, expected).map((problem) => ({
    preset,
    problem,
    file: path,
    code: problem.includes(" lacks ") ? "mark_missing" : "mark_invalid",
  }));
  if (bytes !== undefined && canCarryCredentials(type)) {
    const found = await credentialProblem(path, bytes, type, expected);
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
