/**
 * Adopting a person's hand edit (design section 4; issues #251 and #235): the asset's working
 * media, edited outside Assetgrove, becomes its next version. A person confirms it like a pick, over
 * the asset id, the edited file's sha256 and the review record's head. The edit is handed off
 * through `pick`'s hand-off path (src/handoff.ts): every file the profile's presets write, the
 * manifest included, is rendered again from the adopted bytes and read back, the profile's approved
 * validator runs, and only then is the version recorded. The file is marked
 * `compositeWithTrainedAlgorithmicMedia` and its C2PA credentials name the AI-made original as the
 * `parentOf` ingredient; the provenance gets a `human-edit` step.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ApprovalGate } from "../approvals.ts";
import { digestOf } from "../confirm/records.ts";
import type { KindRequest } from "../confirm/index.ts";
import { InputError } from "../errors.ts";
import {
  commitTargetWrite,
  prepareTargetWrite,
  provenanceLayout,
  sameFilePath,
} from "../handoff.ts";
import type {
  CredentialsResult,
  LibraryResult,
  PresetResult,
  ValidatorResult,
} from "../handoff.ts";
import type { PresetRegistry } from "../handoff/presets/index.ts";
import { markableMediaType } from "../handoff/mark-check.ts";
import { decodeImage } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { loadStyleBible } from "../inputs.ts";
import { readRun, RUN_FILE } from "../loop.ts";
import type { RunRecord, StagedCandidate } from "../loop.ts";
import { DIGITAL_SOURCE_TYPES } from "../metadata.ts";
import { readRecordPath, relativeRecordPath } from "../paths.ts";
import { GLB_MEDIA_TYPE, parseGlb } from "../model3d/glb.ts";
import { shapeModelHandoff } from "../model3d/handoff.ts";
import { familyHandoff, IMPORT_FILE, readImport } from "../sheet/import.ts";
import { read as readKtx2 } from "ktx-parse";
import { deterministicChecks } from "../qa.ts";
import { sha256 as sha256Of, sniffMediaType } from "../request.ts";
import { DEFAULT_RUNS } from "../runs/plan.ts";
import { pixelHash } from "../transform/run.ts";
import type { TransformStep } from "../transform/types.ts";
import type {
  AssetSpec,
  ConfirmationRecord,
  Provenance,
  Reason,
  StyleProfile,
  TargetProfile,
} from "../types.ts";
import { resolveStyle } from "../style.ts";
import { loadAsset, locateAsset } from "./actions.ts";
import type { AssetLocation, LoadedAsset } from "./actions.ts";
import { sha256Hex } from "./canonical.ts";
import { parseLfsPointer } from "./lfs.ts";
import { libraryPath } from "./paths.ts";
import { currentVersion, recordHead } from "./review.ts";
import { AssetIdError } from "./write.ts";

/** The asset's working file, edited by hand. */
export interface WorkingFile {
  bytes: Uint8Array;
  sha256: string;
}

/**
 * The working file of an asset; exit 2 when it is a Git LFS pointer, and 2 `version_exists` when
 * it holds the current version's bytes or an older version's.
 */
export async function workingFile(asset: LoadedAsset): Promise<WorkingFile> {
  if (!existsSync(asset.mediaPath)) {
    throw new InputError(`the working media ${asset.mediaPath} is missing`);
  }
  const bytes = new Uint8Array(await readFile(asset.mediaPath));
  if (parseLfsPointer(bytes) !== undefined) {
    throw new InputError(
      `${asset.mediaPath} is a Git LFS pointer; fetch its bytes before adopting it`,
    );
  }
  const sha256 = sha256Hex(bytes);
  const lock = (asset.card.data["lock"] as { sha256?: string } | undefined)?.sha256;
  if (sha256 === lock || sha256 === currentVersion(asset.record)?.sha256) {
    throw new AssetIdError(
      "version_exists",
      `nothing to adopt: ${asset.resource} is unchanged from the card's lock.sha256 (the current version of ${asset.assetId})`,
    );
  }
  const older = asset.record.versions.findIndex((v) => v.sha256 === sha256);
  if (older !== -1) {
    throw new AssetIdError(
      "version_exists",
      `${asset.mediaPath} holds the bytes of version ${older + 1} of ${asset.assetId}; a version cannot be added twice`,
    );
  }
  return { bytes, sha256 };
}

/** The AI-made original: the file whose sha256 is the card's `lock.sha256`; exit 2 otherwise. */
export async function originalFile(asset: LoadedAsset, path: string): Promise<WorkingFile> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch {
    throw new InputError(`cannot read the original ${path}`);
  }
  const sha256 = sha256Hex(bytes);
  const lock = (asset.card.data["lock"] as { sha256?: string } | undefined)?.sha256;
  if (sha256 !== lock) {
    throw new InputError(
      `${path} has sha256 ${sha256}, not the card's lock.sha256 ${lock ?? "(none)"}; give the version that was handed off`,
    );
  }
  return { bytes, sha256 };
}

/** What an adopt request names: the asset, the original and the target, by path. */
export interface AdoptRequestFiles {
  card: string;
  original: string;
  target: string;
}

/**
 * The adopt request: a pick confirmation whose digest covers the asset id, the edited file's
 * sha256, the version it replaces, the original, the review record's head (design section 3.3) and,
 * as pick's does, the run that made the asset and the sha256 of the profile that drives the
 * hand-off, so a stored confirmation stops applying once the record gains a line or the run record
 * changes.
 */
export function adoptRequest(
  asset: LoadedAsset,
  edited: WorkingFile,
  original: WorkingFile,
  files: AdoptRequestFiles,
  source: AdoptSource,
): KindRequest {
  const current = currentVersion(asset.record)!;
  const head = recordHead(asset.record);
  const body = {
    command: "library adopt",
    asset: asset.assetId,
    card: resolve(files.card),
    candidate: edited.sha256,
    version: edited.sha256,
    replaces: current.sha256,
    original: resolve(files.original),
    originalSha256: original.sha256,
    target: resolve(files.target),
    run: source.run,
    runRecord: source.record,
    profile: source.profile.name,
    profileSha256: source.profileSha256,
    head,
  };
  const id = digestOf(body);
  const number = asset.record.versions.length;
  return {
    kind: "pick",
    id,
    summary:
      `adopt the hand-edited ${asset.resource} as version ${number + 1} of ${asset.assetId} (sha256 ${edited.sha256}), replacing version ${number} (sha256 ${current.sha256}); ` +
      `handed off by the profile ${source.profile.name} (sha256 ${source.profileSha256}) of the ${source.kind} ${source.run} (${source.record})`,
    details: {
      asset: asset.assetId,
      card: body.card,
      media: asset.mediaPath,
      sha256: edited.sha256,
      replaces: { version: number, sha256: current.sha256 },
      original: body.original,
      run: source.run,
      runRecord: source.record,
      profile: source.profile.name,
      profileSha256: source.profileSha256,
      lastAnnotation: head.last,
      digest: id,
    },
    body,
    choices: [edited.sha256],
  };
}

/** Rebuilds a pending adopt request from its body (`assetgrove confirm`); undefined when it names none. */
export async function rebuildAdoptRequest(
  body: Record<string, unknown>,
): Promise<KindRequest | undefined> {
  const { card, original, target } = body;
  if (typeof card !== "string" || typeof original !== "string" || typeof target !== "string") {
    return undefined;
  }
  const asset = await loadAsset(locateAsset(card));
  const edited = await workingFile(asset);
  return adoptRequest(
    asset,
    edited,
    await originalFile(asset, original),
    { card, original, target },
    await adoptSource(asset, target, edited.bytes),
  );
}

/** The project directory of an asset: the Git top level of its folder, else undefined. */
export function projectOf(location: AssetLocation): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: location.dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Where a project keeps its sheet imports, as `import` and `generate-sheet` default. */
export const DEFAULT_IMPORTS = ".assetgrove/imports";

/** A run or import id the review record names: one path segment, never `.` or `..`. */
const SAFE_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/** What the hand-off of an adopt renders from: the run or import that made the asset, as `pick` and `write-families` use it. */
export interface AdoptSource {
  /** A staged run (`pick`) or a sheet import (`write-families`). */
  kind: "run" | "import";
  /** The run or import id. */
  run: string;
  /** The candidate id, or the family's name. */
  candidate: string;
  /** The run's or import's record file. */
  record: string;
  profile: TargetProfile;
  /** The sha256 of the profile's canonical JSON, confirmed with the adopt. */
  profileSha256: string;
  spec: AssetSpec;
  bibleVersion: string;
  /** The version's media type and extension, as the run staged it. */
  mediaType: string;
  extension: string;
  /** The candidate's output fields, which the templates read as `output.*`. */
  fields: Record<string, unknown>;
  sidecars?: Array<{
    name: string;
    bytes: Uint8Array;
    mediaType: string;
    field: string;
    extra?: Record<string, unknown>;
  }>;
  /** The candidate's provenance, used when no provenance is found where the layout puts it. */
  provenance?: Provenance;
}

/**
 * The run that made the asset: the newest version with a run id, read from the project's runs
 * directory `<target>/.assetgrove/runs/<run>` or, for a family `write-families` handed off, its
 * import `<target>/.assetgrove/imports/<run>`. `edited` is the strip a family's fields are measured
 * from. Exit 2 when the id is not one path segment, when neither record is there, or when the run
 * lacks the version's candidate.
 */
export async function adoptSource(
  asset: LoadedAsset,
  targetDir: string,
  edited: Uint8Array,
): Promise<AdoptSource> {
  const made = [...asset.record.versions]
    .reverse()
    .find((v) => v.run !== undefined && v.run !== "");
  if (made === undefined) {
    throw new InputError(
      `${asset.reviewPath} names no run that made ${asset.assetId}; adopt renders the hand-off again from it`,
    );
  }
  const id = made.run!;
  if (!SAFE_SEGMENT.test(id)) {
    throw new InputError(
      `${asset.reviewPath} names the run "${id}" for ${asset.assetId}, which is not one path segment; adopt reads only a run or import of the project`,
    );
  }
  const target = resolve(targetDir);
  const runDir = join(target, DEFAULT_RUNS, id);
  const importDir = join(target, DEFAULT_IMPORTS, id);
  if (existsSync(join(importDir, IMPORT_FILE)) && !existsSync(join(runDir, RUN_FILE))) {
    return importSource(asset, target, importDir, id, made.candidate ?? "", edited);
  }
  let run: RunRecord;
  try {
    run = await readRun(runDir);
  } catch {
    throw new InputError(
      `the run ${id} that made ${asset.assetId} is in neither ${runDir} nor ${importDir}; adopt renders the hand-off (its manifest and preset files) again from it`,
    );
  }
  const candidate: StagedCandidate | undefined = run.candidates.find(
    (c) => c.id === made.candidate,
  );
  if (candidate === undefined) {
    throw new InputError(
      `the run ${id} in ${runDir} has no candidate "${made.candidate ?? ""}", which made version ${asset.record.versions.indexOf(made) + 1} of ${asset.assetId}; adopt renders the hand-off again from it`,
    );
  }
  const sidecars: NonNullable<AdoptSource["sidecars"]> = [];
  for (const staged of candidate.sidecars ?? []) {
    const bytes = new Uint8Array(
      await readFile(join(runDir, readRecordPath(staged.file, "staged file"))),
    );
    if (sha256Of(bytes) !== staged.sha256) {
      throw new InputError(`staged file ${staged.file} changed since it was staged`);
    }
    sidecars.push({
      name: staged.name,
      bytes,
      mediaType: staged.mediaType,
      field: staged.field,
      ...(staged.extra !== undefined && { extra: staged.extra }),
    });
  }
  const extension = asset.resource.includes(".") ? asset.resource.split(".").pop()! : "";
  return {
    kind: "run",
    run: id,
    candidate: candidate.id,
    record: join(runDir, RUN_FILE),
    profile: run.profile,
    profileSha256: digestOf(run.profile),
    spec: run.spec,
    bibleVersion: run.bibleVersion,
    mediaType:
      candidate.mediaType ?? markableMediaType(asset.resource) ?? "application/octet-stream",
    extension: candidate.extension ?? extension,
    fields: candidate.fields ?? {},
    ...(sidecars.length > 0 && { sidecars }),
    ...(candidate.provenance !== undefined && { provenance: candidate.provenance }),
  };
}

/** A family `write-families` handed off from an import: its spec and fields measured from `edited`. */
async function importSource(
  asset: LoadedAsset,
  target: string,
  importDir: string,
  id: string,
  family: string,
  edited: Uint8Array,
): Promise<AdoptSource> {
  const record = await readImport(importDir);
  if (family === "") {
    throw new InputError(`${asset.reviewPath} names no family of the import ${id}`);
  }
  const raster = rasterOf(edited);
  if (raster === undefined) {
    throw new InputError(`the edited ${asset.resource} is not a PNG strip of family ${family}`);
  }
  const count = Math.max(1, Math.floor(raster.width / record.frame.width));
  const preliminary = familyHandoff(record, family, raster, count, 0);
  const source: AdoptSource = {
    kind: "import",
    run: id,
    candidate: family,
    record: join(importDir, IMPORT_FILE),
    profile: record.profile,
    profileSha256: digestOf(record.profile),
    spec: preliminary.spec,
    bibleVersion: record.bibleVersion,
    mediaType: "image/png",
    extension: "png",
    fields: preliminary.fields,
  };
  // The registration jitter is the family's as written; a hand edit does not register it again.
  const provenance = await currentProvenance(asset, source, target).catch(() => undefined);
  const jitter = provenance?.parameters?.["jitterPx"];
  if (typeof jitter === "number") source.fields = { ...source.fields, jitterPx: jitter };
  return source;
}

/** Whether `bytes` are a file of `mediaType`, read by its own signature or parser. */
export function isMediaType(bytes: Uint8Array, mediaType: string): boolean {
  switch (mediaType) {
    case "image/png":
    case "image/jpeg":
    case "image/webp":
    case "audio/wav":
      return sniffMediaType(bytes) === mediaType;
    case GLB_MEDIA_TYPE:
      try {
        parseGlb(bytes);
        return true;
      } catch {
        return false;
      }
    case "model/gltf+json":
      try {
        const json = JSON.parse(Buffer.from(bytes).toString("utf8")) as { asset?: unknown };
        return json !== null && typeof json === "object" && typeof json.asset === "object";
      } catch {
        return false;
      }
    case "image/ktx2":
      try {
        readKtx2(bytes);
        return true;
      } catch {
        return false;
      }
    default:
      return true;
  }
}

/** Exit 2 when the edited bytes are not the version's media type, so the hand-off can mark them. */
export function requireMediaType(asset: LoadedAsset, edited: WorkingFile, source: AdoptSource) {
  if (!isMediaType(edited.bytes, source.mediaType)) {
    throw new InputError(
      `the edited ${asset.resource} is not ${source.mediaType}, the media type of ${asset.assetId}'s version; save the edit in the same format`,
    );
  }
}

/** Provenance: generator and route are strings. */
function isProvenance(value: unknown): value is Provenance {
  const record = value as Partial<Provenance> | null;
  return (
    record !== null &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    typeof record.route === "string" &&
    Array.isArray(record.models)
  );
}

/** The first provenance record in `value`, searched a few levels down (a manifest may embed it). */
export function findProvenance(value: unknown, depth = 0): Provenance | undefined {
  if (isProvenance(value)) return value;
  if (value === null || typeof value !== "object" || depth > 4) return undefined;
  for (const child of Object.values(value)) {
    const found = findProvenance(child, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The asset's current provenance: the record its card's `provenance` source names (a file of its
 * own, or a manifest in the library that embeds it), else the one where the profile's layout puts
 * it for this asset, inside the library root or not, else the candidate's from the run. A
 * `human-edit` step made on the current version, left by an adopt that never recorded its version,
 * is dropped with the steps after it.
 */
export async function currentProvenance(
  asset: LoadedAsset,
  source: AdoptSource,
  targetDir: string,
): Promise<Provenance> {
  const sources = (asset.card.data["sources"] ?? []) as { id?: string; resource?: string }[];
  const named = sources.find((s) => s.id === "provenance");
  let found: Provenance | undefined;
  if (typeof named?.resource === "string") {
    const path = libraryPath(asset.config.root, asset.dir, named.resource, asset.cardPath);
    found = await provenanceIn(path);
    if (found === undefined) throw new InputError(`${path} holds no provenance record`);
  } else {
    const target = resolve(targetDir);
    const rel = provenanceLayout(
      {
        profile: source.profile,
        spec: source.spec,
        bibleVersion: source.bibleVersion,
        output: {
          bytes: new Uint8Array(),
          mediaType: source.mediaType,
          extension: source.extension,
          fields: source.fields,
        },
        provenance: source.provenance ?? ({} as Provenance),
        run: { runId: "", candidateId: "", pickedAt: "" },
        targetDir: target,
      },
      relativeRecordPath(target, mediaIn(target, asset.mediaPath)),
    );
    if (rel !== undefined && existsSync(join(target, rel))) {
      found = await provenanceIn(join(target, rel));
    }
    found ??= source.provenance;
  }
  if (found === undefined) {
    throw new InputError(`no provenance of ${asset.assetId} to add the human-edit step to`);
  }
  return withoutUnrecordedEdit(found, currentVersion(asset.record)?.sha256);
}

/** The asset's media as a path under the target, through the target's own spelling when they differ. */
function mediaIn(target: string, mediaPath: string): string {
  const rel = relative(target, resolve(mediaPath));
  if (!rel.startsWith("..")) return resolve(mediaPath);
  try {
    return join(target, relative(realpathSync.native(target), realpathSync.native(mediaPath)));
  } catch {
    return resolve(mediaPath);
  }
}

/** The provenance record in a JSON file (its own, or a manifest that embeds it). */
async function provenanceIn(path: string): Promise<Provenance | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new InputError(`${path}: provenance is not readable JSON (${(error as Error).message})`);
  }
  return findProvenance(value);
}

/**
 * The provenance without what an adopt that recorded no version left in it: a `human-edit` step
 * made on the current version (an adopt that is recorded makes its own version current) and every
 * step and command after it.
 */
export function withoutUnrecordedEdit(
  provenance: Provenance,
  current: string | undefined,
): Provenance {
  const steps = provenance.steps ?? [];
  const at = steps.findIndex(
    (step) =>
      step.op === "human-edit" &&
      (step.params as Record<string, unknown> | undefined)?.["original"] === current,
  );
  if (at === -1) return provenance;
  const recorded = (steps[at]!.params as Record<string, unknown> | undefined)?.["commands"];
  const commands = typeof recorded === "number" ? recorded : undefined;
  return {
    ...provenance,
    steps: steps.slice(0, at),
    ...(commands !== undefined &&
      provenance.commands !== undefined && { commands: provenance.commands.slice(0, commands) }),
  };
}

/**
 * Whether a provenance record describes an adopted edit that no version records: it carries a
 * `human-edit` step made on the current version (`library check`, `provenance_unrecorded`).
 */
export function describesUnrecordedEdit(value: unknown, current: string | undefined): boolean {
  const provenance = findProvenance(value);
  return provenance !== undefined && withoutUnrecordedEdit(provenance, current) !== provenance;
}

/** A PNG or JPEG decoded; undefined for other media. */
export function rasterOf(bytes: Uint8Array): Raster | undefined {
  const type = sniffMediaType(bytes);
  if (type !== "image/png" && type !== "image/jpeg") return undefined;
  try {
    return decodeImage(bytes);
  } catch {
    return undefined;
  }
}

/**
 * The free QA checks of an edited raster (src/qa.ts): transparency, the frame count of the
 * provenance's `frame` and `frameCount` (else one frame of the whole image) and, with a bible, its
 * palette. Media that is not a raster gets no checks. With `asset`, the transparency check follows
 * the asset: partial alpha fails only when its style's alpha mode is binary (default soft), and a
 * transparent pixel is required only when `original` (the version replaced) has one.
 */
export async function freeChecks(
  bytes: Uint8Array,
  provenance: Provenance,
  biblePath: string | undefined,
  asset?: { style?: StyleProfile; original?: Uint8Array },
): Promise<Reason[]> {
  const raster = rasterOf(bytes);
  if (raster === undefined) return [];
  let transparencyRule: { alpha: "binary" | "soft"; requireTransparentPixel: boolean } | undefined;
  if (asset !== undefined) {
    const before = asset.original === undefined ? undefined : rasterOf(asset.original);
    let hasTransparent = false;
    if (before !== undefined) {
      for (let i = 3; i < before.data.length; i += 4) {
        if (before.data[i] === 0) {
          hasTransparent = true;
          break;
        }
      }
    }
    transparencyRule = {
      alpha: resolveStyle({ ...(asset.style?.alpha && { alpha: asset.style.alpha }) }).alpha.mode,
      requireTransparentPixel: hasTransparent,
    };
  }
  const parameters = provenance.parameters ?? {};
  const frame = parameters["frame"] as { width?: unknown; height?: unknown } | undefined;
  const frameCount = parameters["frameCount"];
  const framed =
    typeof frame?.width === "number" &&
    typeof frame.height === "number" &&
    typeof frameCount === "number";
  const palette =
    biblePath === undefined ? undefined : (await loadStyleBible(biblePath)).value.palette;
  const reasons = deterministicChecks(raster, {
    frame: framed
      ? { width: frame.width as number, height: frame.height as number }
      : { width: raster.width, height: raster.height },
    frameCount: framed ? frameCount : 1,
    palette: palette ?? [],
    ...transparencyRule,
  });
  return palette === undefined ? reasons.filter((r) => r.check !== "palette") : reasons;
}

export interface AdoptOptions {
  asset: LoadedAsset;
  targetDir: string;
  edited: WorkingFile;
  original: WorkingFile;
  /** What the hand-off renders from; the run that made the asset when absent (`adoptSource`). */
  source?: AdoptSource;
  /** How the profile's validator is approved, and the settings (signer, state directory). */
  gate: ApprovalGate;
  registry?: PresetRegistry;
  /** The person's confirmation of the adopt, recorded on the version and in the provenance. */
  confirmation?: ConfirmationRecord;
  /**
   * Run under the library write lock before the first write: the request is rebuilt from the
   * files as they are then and must be the one confirmed (exit 2 `plan_changed`).
   */
  underLock?: () => Promise<void>;
  now?: () => Date;
}

export interface AdoptResult {
  assetId: string;
  /** The new version's number, absent when the validator rejected the adopt. */
  version?: number;
  /** The adopted file's sha256 as written (marked and signed). */
  sha256: string;
  /** The hand-edited file's sha256 as the person confirmed it. */
  editedSha256: string;
  digitalSourceType: string;
  /** Every file written, relative to the target. */
  files: string[];
  handoff: PresetResult[];
  library?: LibraryResult;
  contentCredentials?: CredentialsResult;
  validator?: ValidatorResult;
  /** A rejected adopt: each file that could not be put back, with the reason. */
  notRestored?: string[];
}

/**
 * Hands off the edited file as the asset's next version through `pick`'s hand-off path. A
 * validator that is not approved exits 8 before any write; a failed read-back throws a
 * HandoffCheckError (exit 6) and a rejecting validator returns `validator.accepted: false`, both
 * with no version recorded.
 */
export async function adoptHandEdit(options: AdoptOptions): Promise<AdoptResult> {
  const { asset, edited, original } = options;
  const targetDir = resolve(options.targetDir);
  const source = options.source ?? (await adoptSource(asset, targetDir, edited.bytes));
  requireMediaType(asset, edited, source);
  const base = await currentProvenance(asset, source, targetDir);
  const now = options.now ?? (() => new Date());
  const at = now().toISOString();
  const composite = DIGITAL_SOURCE_TYPES.composite;
  const pixels = (bytes: Uint8Array) => {
    const raster = rasterOf(bytes);
    return raster === undefined ? [] : [pixelHash(raster)];
  };
  const humanEdit: TransformStep = {
    op: "human-edit",
    params: {
      adoptedAt: at,
      original: original.sha256,
      edited: edited.sha256,
      // The commands recorded before this edit; an adopt that records no version left the rest.
      commands: base.commands?.length ?? 0,
    },
    engine: { name: "human", version: "1" },
    inputs: pixels(original.bytes),
    outputs: pixels(edited.bytes),
  };
  const provenance: Provenance = {
    ...base,
    digitalSourceType: composite,
    steps: [...(base.steps ?? []), humanEdit],
    ...(options.confirmation && { confirmation: options.confirmation }),
  };
  // A 3D output takes the shape its target declares, as at pick (assetgrove#137).
  const shaped =
    source.mediaType === GLB_MEDIA_TYPE && source.profile.model3d !== undefined
      ? shapeModelHandoff(source.profile, {
          bytes: edited.bytes,
          fields: source.fields,
          sidecars: source.sidecars ?? [],
        })
      : { bytes: edited.bytes, fields: source.fields, sidecars: source.sidecars ?? [] };
  const prepared = await prepareTargetWrite({
    profile: source.profile,
    spec: source.spec,
    bibleVersion: source.bibleVersion,
    output: {
      bytes: shaped.bytes,
      mediaType: source.mediaType,
      extension: source.extension,
      fields: shaped.fields,
      ...(shaped.sidecars.length > 0 && { sidecars: shaped.sidecars }),
    },
    provenance,
    // A hand edit comes from no run or candidate.
    run: { runId: "", candidateId: "", pickedAt: at },
    targetDir,
    gate: options.gate,
    ...(options.registry && { registry: options.registry }),
    ...(options.confirmation && { confirmation: options.confirmation }),
    replaces: currentVersion(asset.record)!.sha256,
    adopt: {
      original: original.bytes,
      ...(options.underLock && { underLock: options.underLock }),
    },
    now,
  });
  if (!sameFilePath(prepared.mediaPath, asset.mediaPath)) {
    throw new InputError(
      `the profile of the ${source.kind} that made ${asset.assetId} now writes its media to ${prepared.mediaPath}, not ${asset.mediaPath}; adopt hands the edit off to the file it was made at`,
    );
  }
  const written = await commitTargetWrite(prepared);
  return {
    assetId: asset.assetId,
    ...(written.library && { version: written.library.version }),
    sha256: sha256Hex(prepared.mediaBytes),
    editedSha256: edited.sha256,
    digitalSourceType: composite,
    files: [...written.files, ...(written.library?.files ?? [])],
    handoff: written.handoff,
    ...(written.library && { library: written.library }),
    ...(written.contentCredentials && { contentCredentials: written.contentCredentials }),
    ...(written.validator && { validator: written.validator }),
    ...(written.notRestored && { notRestored: written.notRestored }),
  };
}
