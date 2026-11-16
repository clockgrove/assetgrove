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
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ApprovalGate } from "../approvals.ts";
import { digestOf } from "../confirm/records.ts";
import type { KindRequest } from "../confirm/index.ts";
import { InputError } from "../errors.ts";
import { prepareTargetWrite, commitTargetWrite } from "../handoff.ts";
import type {
  CredentialsResult,
  LibraryResult,
  PresetResult,
  ValidatorResult,
} from "../handoff.ts";
import type { PresetRegistry } from "../handoff/presets/index.ts";
import { decodeImage } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { loadStyleBible } from "../inputs.ts";
import { readRun } from "../loop.ts";
import type { RunRecord, StagedCandidate } from "../loop.ts";
import { DIGITAL_SOURCE_TYPES } from "../metadata.ts";
import { readRecordPath } from "../paths.ts";
import { deterministicChecks } from "../qa.ts";
import { sha256 as sha256Of, sniffMediaType } from "../request.ts";
import { DEFAULT_RUNS } from "../runs/plan.ts";
import { pixelHash } from "../transform/run.ts";
import type { TransformStep } from "../transform/types.ts";
import type { AssetSpec, ConfirmationRecord, Provenance, Reason, TargetProfile } from "../types.ts";
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
 * The working file of an asset; exit 2 when it is a Git LFS pointer or the current version, and 2
 * `version_exists` when it holds an older version's bytes.
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
    throw new InputError(
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
 * sha256, the version it replaces, the original and the review record's head (design section 3.3),
 * so a stored confirmation stops applying once the record gains a line.
 */
export function adoptRequest(
  asset: LoadedAsset,
  edited: WorkingFile,
  original: WorkingFile,
  files: AdoptRequestFiles,
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
    head,
  };
  const id = digestOf(body);
  const number = asset.record.versions.length;
  return {
    kind: "pick",
    id,
    summary: `adopt the hand-edited ${asset.resource} as version ${number + 1} of ${asset.assetId} (sha256 ${edited.sha256}), replacing version ${number} (sha256 ${current.sha256})`,
    details: {
      asset: asset.assetId,
      card: body.card,
      media: asset.mediaPath,
      sha256: edited.sha256,
      replaces: { version: number, sha256: current.sha256 },
      original: body.original,
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
  return adoptRequest(asset, await workingFile(asset), await originalFile(asset, original), {
    card,
    original,
    target,
  });
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

/** What the hand-off of an adopt renders from: the run that made the asset, as `pick` uses it. */
export interface AdoptSource {
  profile: TargetProfile;
  spec: AssetSpec;
  bibleVersion: string;
  /** The candidate's output fields, which the templates read as `output.*`. */
  fields: Record<string, unknown>;
  sidecars?: Array<{
    name: string;
    bytes: Uint8Array;
    mediaType: string;
    field: string;
    extra?: Record<string, unknown>;
  }>;
  /** The candidate's provenance, used when the card names no provenance inside the library. */
  provenance?: Provenance;
}

/**
 * The run that made the asset: the newest version with a run id, read from the project's runs
 * directory `<target>/.assetgrove/runs/<run>`. Exit 2 when it is not there.
 */
export async function adoptSource(asset: LoadedAsset, targetDir: string): Promise<AdoptSource> {
  const made = [...asset.record.versions]
    .reverse()
    .find((v) => v.run !== undefined && v.run !== "");
  if (made === undefined) {
    throw new InputError(
      `${asset.reviewPath} names no run that made ${asset.assetId}; adopt renders the hand-off again from it`,
    );
  }
  const runDir = join(resolve(targetDir), DEFAULT_RUNS, made.run!);
  let run: RunRecord;
  try {
    run = await readRun(runDir);
  } catch {
    throw new InputError(
      `the run ${made.run} that made ${asset.assetId} is not in ${runDir}; adopt renders the hand-off (its manifest and preset files) again from it`,
    );
  }
  const candidate: StagedCandidate | undefined = run.candidates.find(
    (c) => c.id === made.candidate,
  );
  const sidecars: NonNullable<AdoptSource["sidecars"]> = [];
  for (const staged of candidate?.sidecars ?? []) {
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
  return {
    profile: run.profile,
    spec: run.spec,
    bibleVersion: run.bibleVersion,
    fields: candidate?.fields ?? {},
    ...(sidecars.length > 0 && { sidecars }),
    ...(candidate && { provenance: candidate.provenance }),
  };
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
function findProvenance(value: unknown, depth = 0): Provenance | undefined {
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
 * own, or a manifest in the library that embeds it), else the candidate's from the run.
 */
export async function currentProvenance(
  asset: LoadedAsset,
  source: AdoptSource,
): Promise<Provenance> {
  const sources = (asset.card.data["sources"] ?? []) as { id?: string; resource?: string }[];
  const named = sources.find((s) => s.id === "provenance");
  if (typeof named?.resource === "string") {
    const path = libraryPath(asset.config.root, asset.dir, named.resource, asset.cardPath);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      throw new InputError(
        `${path}: provenance is not readable JSON (${(error as Error).message})`,
      );
    }
    const found = findProvenance(value);
    if (found === undefined) throw new InputError(`${path} holds no provenance record`);
    return found;
  }
  if (source.provenance === undefined) {
    throw new InputError(`no provenance of ${asset.assetId} to add the human-edit step to`);
  }
  return source.provenance;
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
 * palette. Media that is not a raster gets no checks.
 */
export async function freeChecks(
  bytes: Uint8Array,
  provenance: Provenance,
  biblePath: string | undefined,
): Promise<Reason[]> {
  const raster = rasterOf(bytes);
  if (raster === undefined) return [];
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
  const source = options.source ?? (await adoptSource(asset, targetDir));
  const base = await currentProvenance(asset, source);
  const now = options.now ?? (() => new Date());
  const at = now().toISOString();
  const composite = DIGITAL_SOURCE_TYPES.composite;
  const pixels = (bytes: Uint8Array) => {
    const raster = rasterOf(bytes);
    return raster === undefined ? [] : [pixelHash(raster)];
  };
  const humanEdit: TransformStep = {
    op: "human-edit",
    params: { adoptedAt: at, original: original.sha256, edited: edited.sha256 },
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
  const mediaType = sniffMediaType(edited.bytes);
  const extension = asset.resource.includes(".") ? asset.resource.split(".").pop()! : "";
  const prepared = await prepareTargetWrite({
    profile: source.profile,
    spec: source.spec,
    bibleVersion: source.bibleVersion,
    output: {
      bytes: edited.bytes,
      mediaType,
      extension,
      fields: source.fields,
      ...(source.sidecars && { sidecars: source.sidecars }),
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
  if (prepared.mediaPath !== resolve(asset.mediaPath)) {
    throw new InputError(
      `the profile of run that made ${asset.assetId} now writes its media to ${prepared.mediaPath}, not ${asset.mediaPath}; adopt hands the edit off to the file it was made at`,
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
  };
}
