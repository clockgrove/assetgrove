/**
 * The extent of one exact version of a picked asset, and the bounds check of a note's anchor
 * against it (docs/library.md, Anchors). An anchor names part of a version: a frame range of a
 * strip (`ag:frames`), a cell of an atlas (`ag:cell`) or a time range of a track (a `t=` selector).
 * The valid range is measured from the version's own bytes, never assumed: frames and cells from
 * the image size and the frame layout its provenance records, the duration through music-metadata.
 */
import { readFile } from "node:fs/promises";
import { parseBuffer } from "music-metadata";
import { InputError } from "../errors.ts";
import { decodeImage } from "../image/raster.ts";
import type { LoadedAsset } from "./actions.ts";
import { findProvenance } from "./adopt.ts";
import { sha256Hex } from "./canonical.ts";
import { findGitDir, lfsObjectPath, readMedia } from "./lfs.ts";
import { libraryPath } from "./paths.ts";
import { parseTimeFragment } from "./review.ts";
import type { Version } from "./review.ts";

/** A note's anchor on a version, as a review target carries it. */
export interface Anchor {
  frames?: { from: number; to: number };
  cell?: { column: number; row: number };
  /** Seconds, from a Media Fragments `t=` selector. */
  time?: { start: number; end: number };
}

/** What a version holds: its frames and atlas grid when it is an image, its duration when timed. */
export interface VersionExtent {
  /** The version's number in the stack, for messages. */
  version: number;
  image?: { width: number; height: number };
  /** The frame count and grid, when the version's provenance records its frame layout. */
  layout?: { frames: number; columns: number; rows: number };
  /** Seconds, when the bytes are a track music-metadata reads a duration from. */
  duration?: number;
  /** Why the bytes could not be measured, when they could not. */
  unmeasured?: string;
}

/** The version's bytes: the working file when they are the version's, else the local Git LFS store. */
async function versionBytes(asset: LoadedAsset, sha256: string): Promise<Uint8Array | undefined> {
  try {
    const media = await readMedia(asset.mediaPath);
    if (media.kind !== "lfs-pointer" && media.sha256 === sha256) return media.bytes;
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
  }
  const gitDir = findGitDir(asset.dir);
  if (gitDir === undefined) return undefined;
  const bytes = await readFile(lfsObjectPath(gitDir, sha256)).catch(() => undefined);
  return bytes !== undefined && sha256Hex(bytes) === sha256 ? new Uint8Array(bytes) : undefined;
}

/** The frame size and count a provenance's parameters record, at the top or under `postprocess`. */
export function frameLayoutOf(
  parameters: unknown,
): { width: number; height: number; count: number } | undefined {
  if (parameters === null || typeof parameters !== "object") return undefined;
  const top = parameters as Record<string, unknown>;
  const post = (
    top["postprocess"] !== null && typeof top["postprocess"] === "object" ? top["postprocess"] : {}
  ) as Record<string, unknown>;
  const frame = (top["frame"] ?? post["frame"]) as Record<string, unknown> | undefined;
  const count = top["frameCount"] ?? post["frameCount"];
  const width = frame?.["width"];
  const height = frame?.["height"];
  const positive = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;
  if (!positive(width) || !positive(height) || !positive(count)) return undefined;
  return { width, height, count };
}

/** The provenance parameters the card names, which describe the current version. */
async function currentParameters(asset: LoadedAsset): Promise<unknown> {
  const sources = (asset.card.data["sources"] ?? []) as { id?: unknown; resource?: unknown }[];
  const source = sources.find((s) => s.id === "provenance");
  if (typeof source?.resource !== "string") return undefined;
  try {
    const path = libraryPath(asset.config.root, asset.dir, source.resource, asset.cardPath);
    return findProvenance(JSON.parse(await readFile(path, "utf8")))?.parameters;
  } catch {
    return undefined;
  }
}

/** Measures `version` of `asset` from its own bytes. */
export async function versionExtent(asset: LoadedAsset, version: Version): Promise<VersionExtent> {
  const number = asset.record.versions.findIndex((v) => v.sha256 === version.sha256) + 1;
  const extent: VersionExtent = { version: number };
  const bytes = await versionBytes(asset, version.sha256);
  if (bytes === undefined) {
    extent.unmeasured = `the bytes of version ${number} are neither the working file nor in the local Git LFS store`;
    return extent;
  }
  let image: { width: number; height: number } | undefined;
  try {
    const raster = decodeImage(bytes);
    image = { width: raster.width, height: raster.height };
  } catch {
    image = undefined;
  }
  if (image !== undefined) {
    extent.image = image;
    // The card's provenance describes the current version; an older one's layout is not recorded.
    const current = asset.record.versions.at(-1)?.sha256 === version.sha256;
    const layout = current ? frameLayoutOf(await currentParameters(asset)) : undefined;
    if (layout !== undefined) {
      const columns = Math.floor(image.width / layout.width);
      const rows = Math.floor(image.height / layout.height);
      extent.layout = { frames: Math.min(layout.count, columns * rows), columns, rows };
    } else if (current) {
      // An image with no recorded frame layout is one frame and one cell.
      extent.layout = { frames: 1, columns: 1, rows: 1 };
    }
    return extent;
  }
  try {
    const { format } = await parseBuffer(bytes, undefined, { duration: true, skipCovers: true });
    if (typeof format.duration === "number" && Number.isFinite(format.duration)) {
      extent.duration = format.duration;
    }
  } catch {
    // Neither an image nor a track music-metadata reads: no anchor fits it.
  }
  return extent;
}

const seconds = (n: number) => `${Number(n.toFixed(3))}`;

/**
 * Refuses (InputError) an anchor that does not fit the version: each message names the selector,
 * what it asked for and the version's valid range.
 */
export function checkAnchor(anchor: Anchor, extent: VersionExtent, assetId: string): void {
  const of = `version ${extent.version} of ${assetId}`;
  const unmeasured = (selector: string, what: string) =>
    new InputError(
      `${selector} needs ${what}, but ${extent.unmeasured ?? `${of} has none`}; anchor the note without ${selector}`,
    );
  if (anchor.frames !== undefined || anchor.cell !== undefined) {
    const selector = anchor.frames !== undefined ? "ag:frames" : "ag:cell";
    if (extent.layout === undefined) {
      if (extent.unmeasured === undefined && extent.image !== undefined) {
        throw new InputError(
          `${selector} needs the frame layout of ${of}, which only the current version's provenance records; anchor the current version`,
        );
      }
      throw unmeasured(selector, "an image");
    }
    const { frames, columns, rows } = extent.layout;
    if (anchor.frames !== undefined) {
      const { from, to } = anchor.frames;
      if (to >= frames) {
        throw new InputError(
          `ag:frames ${from}-${to} is outside ${of}: valid frames are 0-${frames - 1}`,
        );
      }
    }
    if (anchor.cell !== undefined) {
      const { column, row } = anchor.cell;
      if (column >= columns || row >= rows) {
        throw new InputError(
          `ag:cell ${column},${row} is outside ${of}: valid cells are columns 0-${columns - 1}, rows 0-${rows - 1}`,
        );
      }
    }
  }
  if (anchor.time !== undefined) {
    if (extent.duration === undefined) throw unmeasured("selector t=", "a duration");
    const { start, end } = anchor.time;
    if (end > extent.duration) {
      throw new InputError(
        `selector t=${seconds(start)},${seconds(end)} is outside ${of}: the valid time range is 0-${seconds(extent.duration)} s`,
      );
    }
  }
}

/** The anchor a review target carries, read back from its members. */
export function anchorOf(target: unknown): Anchor | undefined {
  if (target === null || typeof target !== "object") return undefined;
  const t = target as Record<string, unknown>;
  const anchor: Anchor = {};
  const frames = t["ag:frames"] as Anchor["frames"] | undefined;
  if (frames !== undefined) anchor.frames = { from: frames.from, to: frames.to };
  const cell = t["ag:cell"] as Anchor["cell"] | undefined;
  if (cell !== undefined) anchor.cell = { column: cell.column, row: cell.row };
  const selector = t["selector"] as { value?: unknown } | undefined;
  const time = typeof selector?.value === "string" ? parseTimeFragment(selector.value) : undefined;
  if (time !== undefined) anchor.time = time;
  return Object.keys(anchor).length === 0 ? undefined : anchor;
}

/** The target members that store `anchor` (merged into a version target). */
export function anchorMembers(anchor: Anchor): Record<string, unknown> {
  return {
    ...(anchor.frames && { "ag:frames": { from: anchor.frames.from, to: anchor.frames.to } }),
    ...(anchor.cell && { "ag:cell": { column: anchor.cell.column, row: anchor.cell.row } }),
    ...(anchor.time && {
      selector: {
        type: "FragmentSelector",
        conformsTo: "http://www.w3.org/TR/media-frags/",
        value: `t=${anchor.time.start},${anchor.time.end}`,
      },
    }),
  };
}

/** One line naming an anchor, for human output: `frames 2-5, cell 1,0, time 0.5-1.25 s`. */
export function describeAnchor(anchor: Anchor | undefined): string {
  if (anchor === undefined) return "";
  return [
    anchor.frames && `frames ${anchor.frames.from}-${anchor.frames.to}`,
    anchor.cell && `cell ${anchor.cell.column},${anchor.cell.row}`,
    anchor.time && `time ${seconds(anchor.time.start)}-${seconds(anchor.time.end)} s`,
  ]
    .filter(Boolean)
    .join(", ");
}
