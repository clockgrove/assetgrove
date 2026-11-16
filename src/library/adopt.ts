/**
 * Adopting a person's hand edit into the library (issue #251): the asset's working media, edited
 * outside Assetgrove, becomes its next version carrying C2PA content credentials that record the
 * edit with the AI-made original (the version the card locks) as the `parentOf` ingredient.
 */
import { readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  canCarryCredentials,
  credentialProblem,
  DEVELOPMENT_SIGNER_WARNING,
  resolveSigner,
  signCredentials,
} from "../credentials.ts";
import type { CredentialSettings, SignerRecord } from "../credentials.ts";
import { digestOf } from "../confirm/records.ts";
import type { KindRequest } from "../confirm/index.ts";
import { InputError } from "../errors.ts";
import { HandoffCheckError } from "../handoff/presets/index.ts";
import type { HandoffProblem } from "../handoff/presets/index.ts";
import { markableMediaType, markProblems } from "../handoff/mark-check.ts";
import { decodeImage } from "../image/raster.ts";
import { DIGITAL_SOURCE_TYPES, embedDigitalSourceType, readMarkedModels } from "../metadata.ts";
import { relativeRecordPath } from "../paths.ts";
import { acquireLibraryLock } from "../runs/lock.ts";
import { pixelHash } from "../transform/run.ts";
import type { TransformStep } from "../transform/types.ts";
import type { ConfirmationRecord, Provenance, TargetProfile } from "../types.ts";
import { sha256Hex } from "./canonical.ts";
import { parseCard } from "./card.ts";
import { parseLfsPointer } from "./lfs.ts";
import { libraryPath } from "./paths.ts";
import {
  assetgroveVersion,
  commitLibraryWrite,
  libraryConfig,
  scanCards,
  writeAtomic,
  within,
} from "./write.ts";
import type { LibraryPlan } from "./write.ts";

export interface AdoptOptions {
  profile: TargetProfile;
  targetDir: string;
  assetId: string;
  /** The AI-made version the card locks, as handed off. */
  originalPath: string;
  settings: { stateDir: string; contentCredentials?: CredentialSettings };
  /** The person's confirmation of this adopt (`adoptRequest`), recorded on the new version. */
  confirmation?: ConfirmationRecord;
  now?: () => Date;
}

/** What an adopt write request names: the asset, its working media and the original, by path. */
export interface AdoptRequestFiles {
  target: string;
  asset: string;
  media: string;
  original: string;
}

/**
 * The write request a person confirms before an adopt (design section 7): its body names the
 * asset, the working media and the original by path and by sha256, so a confirmation covers these
 * bytes only, and `assetgrove confirm` rebuilds it from the files and requires the same id.
 */
export async function adoptRequest(files: AdoptRequestFiles): Promise<KindRequest> {
  const hash = async (path: string) => {
    const bytes = await readIfPresent(path);
    if (bytes === undefined) throw new InputError(`cannot read ${path}`);
    return sha256Hex(bytes);
  };
  const body = {
    action: "adopt",
    target: resolve(files.target),
    asset: files.asset,
    media: resolve(files.media),
    original: resolve(files.original),
    mediaSha256: await hash(files.media),
    originalSha256: await hash(files.original),
  };
  const id = digestOf(body);
  return {
    kind: "write",
    id,
    summary: `adopt the hand edit ${body.media} as the next version of ${body.asset}`,
    details: {
      asset: body.asset,
      media: body.media,
      mediaSha256: body.mediaSha256,
      original: body.original,
      originalSha256: body.originalSha256,
      digest: id,
    },
    body,
  };
}

/** The working media of an asset as its card names it, for `adoptRequest`. */
export function adoptMediaPath(profile: TargetProfile, targetDir: string, assetId: string): string {
  const config = libraryConfig(profile, resolve(targetDir));
  const found = scanCards(config.root).find((card) => card.id === assetId);
  if (!found || found.resource === undefined || found.sha256 === undefined) {
    throw new InputError(`no asset "${assetId}" with a card and a locked file in ${config.root}`);
  }
  return join(found.dir, found.resource);
}

export interface AdoptResult {
  assetId: string;
  version: number;
  sha256: string;
  /** Every file written, relative to the target. */
  files: string[];
  contentCredentials: SignerRecord & { warning?: string };
}

/** The first object holding `models` and `route`, searched a few levels down (a manifest may embed it). */
function findProvenance(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value) || depth > 4) {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  if (Array.isArray(object["models"]) && typeof object["route"] === "string") return object;
  for (const child of Object.values(object)) {
    const found = findProvenance(child, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function readIfPresent(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Adopts the working media of an asset as its next version. Exits 2 (InputError) when the asset has
 * no card, the file is unchanged from the card's lock, the format cannot carry credentials, or
 * `originalPath` is not the locked version; a failed read-back throws a HandoffCheckError (exit 6).
 */
export async function adoptHandEdit(options: AdoptOptions): Promise<AdoptResult> {
  const { profile, assetId } = options;
  const targetDir = resolve(options.targetDir);
  const config = libraryConfig(profile, targetDir);
  const found = scanCards(config.root).find((card) => card.id === assetId);
  if (!found || found.resource === undefined || found.sha256 === undefined) {
    throw new InputError(`no asset "${assetId}" with a card and a locked file in ${config.root}`);
  }
  const mediaPath = join(found.dir, found.resource);
  if (!within(config.root, mediaPath)) {
    throw new InputError(`the media ${mediaPath} lies outside the library root ${config.root}`);
  }
  const mediaType = markableMediaType(found.resource);
  if (mediaType === undefined || !canCarryCredentials(mediaType)) {
    throw new InputError(
      `${found.resource} is not a PNG, JPEG or WebP image; it cannot carry C2PA credentials`,
    );
  }
  const edited = await readIfPresent(mediaPath);
  if (edited === undefined) throw new InputError(`the working media ${mediaPath} is missing`);
  if (parseLfsPointer(edited) !== undefined) {
    throw new InputError(`${mediaPath} is a Git LFS pointer; fetch the file before adopting it`);
  }
  if (sha256Hex(edited) === found.sha256) {
    throw new InputError(
      `nothing to adopt: ${found.resource} is unchanged from the card's lock.sha256`,
    );
  }
  const original = await readIfPresent(resolve(options.originalPath));
  if (original === undefined)
    throw new InputError(`cannot read the original ${options.originalPath}`);
  if (sha256Hex(original) !== found.sha256) {
    throw new InputError(
      `${options.originalPath} has sha256 ${sha256Hex(original)}, not the card's lock.sha256 ${found.sha256}; give the version that was handed off`,
    );
  }

  const cardPath = join(found.dir, `${assetId}.md`);
  const card = parseCard(await readFile(cardPath, "utf8"), cardPath).data as {
    kind?: unknown;
    subject?: unknown;
    sources?: unknown;
    bible?: unknown;
    license?: unknown;
    generated?: { by?: unknown; at?: unknown };
  };
  const source = (Array.isArray(card.sources) ? card.sources : []).find(
    (s: unknown) => (s as { id?: unknown } | null)?.id === "provenance",
  ) as { resource?: unknown } | undefined;
  let provenancePath: string | undefined;
  let old: Provenance | undefined;
  if (typeof source?.resource === "string") {
    provenancePath = libraryPath(config.root, found.dir, source.resource, cardPath);
    const document = JSON.parse(await readFile(provenancePath, "utf8")) as Record<string, unknown>;
    old = findProvenance(document) as unknown as Provenance | undefined;
    if (old === undefined) throw new InputError(`${provenancePath} holds no provenance record`);
  } else {
    // A profile whose provenance lies outside the library: the card and the original's mark say it.
    const models = readMarkedModels(original, mediaType)?.split("; ") ?? [];
    old = {
      models,
      route: /via (.+)$/.exec(String(card.generated?.by ?? ""))?.[1] ?? "unknown",
      bibleVersion: String(card.bible ?? "unknown"),
      license: String(card.license ?? "unknown"),
      finishedAt: String(
        card.generated?.at ?? options.now?.().toISOString() ?? new Date().toISOString(),
      ),
    } as unknown as Provenance;
  }
  const ownFile =
    provenancePath !== undefined &&
    basename(provenancePath) === `${found.resource}.provenance.json`;

  const type = DIGITAL_SOURCE_TYPES.composite;
  const marked = embedDigitalSourceType(edited, mediaType, type, { models: old.models });
  const signer = await resolveSigner(options.settings);
  const bytes = await signCredentials(
    marked,
    mediaType,
    {
      digitalSourceType: type,
      models: old.models,
      title: found.resource,
      original: { bytes: original, mediaType, title: found.resource },
    },
    signer,
    assetgroveVersion(),
  );

  const lock = acquireLibraryLock(targetDir, options.settings.stateDir);
  try {
    await writeAtomic(mediaPath, bytes);
    const rel = relativeRecordPath(targetDir, mediaPath);
    // The file as written is read back and checked.
    const back = new Uint8Array(await readFile(mediaPath));
    const expected = { digitalSourceType: type, models: old.models };
    const problems: HandoffProblem[] = markProblems(rel, back, mediaType, expected).map(
      (problem) => ({
        preset: "adopt",
        problem,
        file: rel,
        code: problem.includes(" lacks ") ? "mark_missing" : "mark_invalid",
      }),
    );
    const credentials = await credentialProblem(rel, back, mediaType, {
      ...expected,
      adopted: true,
    });
    if (credentials) problems.push({ preset: "adopt", file: rel, ...credentials });
    if (problems.length > 0) throw new HandoffCheckError(problems);

    let provenanceBytes: string | undefined;
    const written = [mediaPath];
    if (ownFile && provenancePath !== undefined) {
      const hash = pixelHash(decodeImage(bytes));
      const step: TransformStep = {
        op: "adopt-hand-edit",
        params: { digitalSourceType: type, original: found.sha256 },
        engine: { name: "assetgrove-adopt", version: "1" },
        inputs: [pixelHash(decodeImage(original))],
        outputs: [hash],
      };
      const updated = {
        ...old,
        digitalSourceType: type,
        contentCredentials: signer.record,
        steps: [...(old.steps ?? []), step],
      };
      provenanceBytes = `${JSON.stringify(updated, null, 2)}\n`;
      await writeAtomic(provenancePath, provenanceBytes);
      written.push(provenancePath);
    }

    const plan: LibraryPlan = {
      config,
      assetId,
      dir: found.dir,
      mediaPath,
      cardPath,
      reviewPath: join(found.dir, `${assetId}.review.json`),
      ...(ownFile && provenancePath !== undefined && { provenanceSource: provenancePath }),
      cards: scanCards(config.root),
    };
    const library = await commitLibraryWrite(plan, {
      mediaBytes: bytes,
      provenance: old,
      ...(provenanceBytes !== undefined && { provenanceBytes }),
      spec: {
        kind: typeof card.kind === "string" ? card.kind : "unknown",
        assetId,
        ...(typeof card.subject === "string" && { subject: card.subject }),
      },
      // A hand edit comes from no run or candidate.
      run: "",
      candidate: "",
      action: "adopt",
      ...(options.confirmation && { confirmation: options.confirmation }),
      now: (options.now ?? (() => new Date()))(),
      assetgrove: assetgroveVersion(),
    });
    return {
      assetId,
      version: library.version,
      sha256: library.sha256,
      files: [...written, ...library.files].map((path) =>
        relative(targetDir, path).split("\\").join("/"),
      ),
      contentCredentials: {
        ...signer.record,
        ...(signer.record.development && { warning: DEVELOPMENT_SIGNER_WARNING }),
      },
    };
  } finally {
    lock.release();
  }
}
