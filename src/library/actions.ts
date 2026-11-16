/**
 * A person's actions on a picked asset or a staged candidate (design sections 3.3 and 4): review
 * annotations, approval, a hand edit adopted as a new version and card edits. Each one appends to
 * the review record, the commit point, then rewrites the projections: the card's machine fields
 * from the record, each `index.md` from the library root down and the folder's `log.md`. The
 * library root and game are read from the root `index.md`, so no target profile is needed.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { InputError } from "../errors.ts";
import { readRun } from "../loop.ts";
import { acquireLibraryLock } from "../runs/lock.ts";
import { parseCard, refreshFromReview, writeCard } from "./card.ts";
import type { Card } from "./card.ts";
import { parseIndex } from "./folder.ts";
import {
  annotationId,
  appendAnnotation,
  checkReviewPaths,
  emptyReview,
  parseReview,
  versionNumber,
  versionStatus,
  writeReview,
} from "./review.ts";
import type {
  Annotation,
  AnnotationInput,
  ReviewRecord,
  Version,
  VersionStatus,
} from "./review.ts";
import { libraryPath } from "./paths.ts";
import {
  readOwnCard,
  readOwnReview,
  readText,
  scanCards,
  writeAtomic,
  writeIfChanged,
  writeIndexes,
  writeLogs,
} from "./write.ts";
import type { LibraryConfig } from "./write.ts";

/** A picked asset as its card, review record and media lie in the library. */
export interface AssetLocation {
  config: LibraryConfig;
  assetId: string;
  /** The folder of the card, review record and media. */
  dir: string;
  cardPath: string;
  reviewPath: string;
  mediaPath: string;
  /** The media file name, the card's `resource`. */
  resource: string;
}

/** An asset with its card and record read and checked against the library path rule. */
export interface LoadedAsset extends AssetLocation {
  card: Card;
  record: ReviewRecord;
  title: string;
}

/** The library root above `dir`: the nearest `index.md` with the root's OKF front matter. */
function libraryRootOf(dir: string, address: string): { root: string; game: string } {
  for (let folder = dir; ; folder = dirname(folder)) {
    const path = join(folder, "index.md");
    if (existsSync(path)) {
      const index = parseIndex(readFileSync(path, "utf8"), path);
      if (index.root !== undefined && index.root.game !== "") {
        return { root: folder, game: index.root.game };
      }
    }
    if (dirname(folder) === folder) break;
  }
  throw new InputError(
    `${address} is not in an Assetgrove library: no index.md with the library's front matter (okf_version, type: Asset Library, game) above it`,
  );
}

/** The card id beside `dir` whose `resource` is `file`. */
function cardFor(dir: string, file: string): string | undefined {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || name === "index.md" || name === "log.md") continue;
    try {
      const card = parseCard(readFileSync(join(dir, name), "utf8"), join(dir, name));
      if (card.data["resource"] === file) return name.slice(0, -".md".length);
    } catch {
      // Not a card.
    }
  }
  return undefined;
}

/**
 * Finds an asset from its card (`<assetId>.md`), its review record (`<assetId>.review.json`) or
 * its media file; exit 2 when the path is none of these or lies outside a library.
 */
export function locateAsset(address: string): AssetLocation {
  const path = resolve(address);
  if (!existsSync(path)) throw new InputError(`${address} does not exist`);
  const dir = dirname(path);
  const name = basename(path);
  let assetId: string | undefined;
  if (name.endsWith(".review.json")) assetId = name.slice(0, -".review.json".length);
  else if (name.endsWith(".md")) assetId = name.slice(0, -".md".length);
  else assetId = cardFor(dir, name);
  if (assetId === undefined || assetId === "index" || assetId === "log") {
    throw new InputError(
      `${address} names no picked asset: give its card (<assetId>.md), review record or media file`,
    );
  }
  const { root, game } = libraryRootOf(dir, address);
  const cardPath = join(dir, `${assetId}.md`);
  if (!existsSync(cardPath)) throw new InputError(`${address}: the asset has no card ${cardPath}`);
  const card = parseCard(readFileSync(cardPath, "utf8"), cardPath);
  const resource = String(card.data["resource"]);
  const mediaPath = libraryPath(root, dir, resource, cardPath);
  return {
    config: { root, rootRel: "", game, log: existsSync(join(dir, "log.md")) },
    assetId,
    dir,
    cardPath,
    reviewPath: join(dir, `${assetId}.review.json`),
    mediaPath,
    resource,
  };
}

/** Reads the asset's card and review record; exit 2 when the record holds no version. */
export async function loadAsset(location: AssetLocation): Promise<LoadedAsset> {
  const { config, dir } = location;
  const card = await readOwnCard(location.cardPath, config.root, dir);
  if (card === undefined) throw new InputError(`${location.cardPath} does not exist`);
  const record = await readOwnReview(location.reviewPath, config.root, dir, undefined);
  if (record === undefined || record.versions.length === 0) {
    throw new InputError(`${location.reviewPath}: the asset has no version in its review record`);
  }
  return { ...location, card, record, title: String(card.data["title"]) };
}

/** The version `selector` names: its number in the stack or its sha256 (a prefix of 7 or more hex); the current one when absent. */
export function selectVersion(record: ReviewRecord, selector?: string): Version {
  if (selector === undefined) return record.versions.at(-1)!;
  if (/^\d+$/.test(selector)) {
    const version = record.versions[Number(selector) - 1];
    if (version) return version;
  } else if (/^[0-9a-f]{7,64}$/.test(selector)) {
    const found = record.versions.filter((v) => v.sha256.startsWith(selector));
    if (found.length === 1) return found[0]!;
  }
  throw new InputError(
    `version "${selector}" is not one of the ${record.versions.length} versions of this asset (give its number or sha256)`,
  );
}

/** Runs `fn` holding the library write lock of the library the asset is in. */
export async function withLibraryLock<T>(
  location: AssetLocation,
  stateDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = acquireLibraryLock(location.config.root, stateDir);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/** What writing an asset's record and projections changed. */
export interface AssetWrite {
  version: number;
  sha256: string;
  state: VersionStatus;
  /** Every file written, absolute, in write order. */
  files: string[];
}

/**
 * Writes the review record (the commit point), then the card with its machine fields refreshed from
 * the record, each `index.md` from the library root down, and the folder's `log.md` when the folder
 * keeps one. `card` is the card to refresh (a card edit passes its edited card).
 */
export async function writeAsset(
  asset: LoadedAsset,
  record: ReviewRecord,
  options: { card?: Card; qaAt?: string } = {},
): Promise<AssetWrite> {
  const files: string[] = [];
  if (await writeIfChanged(asset.reviewPath, writeReview(record))) files.push(asset.reviewPath);
  const card = refreshFromReview(options.card ?? asset.card, record, asset.cardPath, {
    ...(options.qaAt !== undefined && { qaAt: options.qaAt }),
  });
  if (await writeIfChanged(asset.cardPath, writeCard(card))) files.push(asset.cardPath);
  const cards = scanCards(asset.config.root);
  files.push(...(await writeIndexes(asset.config, cards)));
  if (asset.config.log) {
    files.push(
      ...(await writeLogs(asset.config, cards, {
        dir: asset.dir,
        assetId: asset.assetId,
        title: String(card.data["title"]),
        record,
        at: new Date().toISOString(),
        before: cards,
      })),
    );
  }
  const current = record.versions.at(-1)!;
  return {
    version: versionNumber(record, current.sha256)!,
    sha256: current.sha256,
    state: versionStatus(record, current.sha256),
    files,
  };
}

/** A staged candidate's review record: `<run>/reviews/<candidate>.review.json`, outside Git. */
export interface CandidateLocation {
  runDir: string;
  runId: string;
  candidate: string;
  /** The candidate's file, relative to the run. */
  file: string;
  sha256: string;
  reviewPath: string;
}

/** Finds a QA-passing candidate of a run; exit 2 when the run has no such candidate. */
export async function locateCandidate(
  runDir: string,
  candidate: string,
): Promise<CandidateLocation> {
  const dir = resolve(runDir);
  const run = await readRun(dir);
  const found = run.candidates.find((c) => c.id === candidate);
  if (!found) {
    const ids = run.candidates.map((c) => c.id).join(", ") || "none";
    throw new InputError(
      `"${candidate}" is not a QA-passing candidate of run ${run.runId} (passing: ${ids})`,
    );
  }
  return {
    runDir: dir,
    runId: run.runId,
    candidate,
    file: found.file,
    sha256: found.sha256,
    reviewPath: join(dir, "reviews", `${candidate}.review.json`),
  };
}

/** The candidate's review record, or an empty one; its paths must stay inside the run. */
export async function readCandidateReview(location: CandidateLocation): Promise<ReviewRecord> {
  const text = await readText(location.reviewPath);
  if (text === undefined) {
    return emptyReview(`asset://runs/${location.runId}/${location.candidate}/review`);
  }
  const record = parseReview(text, location.reviewPath);
  checkReviewPaths(record, location.runDir, dirname(location.reviewPath), location.reviewPath);
  return record;
}

/** Appends an annotation to a candidate's record and writes it; the annotation as stamped. */
export async function annotateCandidate(
  location: CandidateLocation,
  annotation: AnnotationInput,
): Promise<{ record: ReviewRecord; annotation: Annotation }> {
  const record = appendAnnotation(await readCandidateReview(location), annotation);
  await writeAtomic(location.reviewPath, writeReview(record));
  return { record, annotation: newest(record, annotation) };
}

/** The annotation of `record` that `input` became once stamped with its id. */
export function newest(record: ReviewRecord, input: AnnotationInput): Annotation {
  const id = annotationId(input as Record<string, unknown>);
  const found = record.annotations.find((a) => a.id === id);
  if (!found) throw new Error(`annotation ${id} was not appended`);
  return found;
}
