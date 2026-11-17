/**
 * The compare sheet (design section 3.5): `<dir>/compare.png`, one numbered row per candidate with
 * the version before, the candidate and a difference map, region outlines drawn on all three.
 * Numbers only: no text from any request input is drawn, so the sheet changes only when an image
 * does. It reuses the raster code of the contact sheet.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { splitStrip } from "./animation/strip.ts";
import { CELL_PX, fill, fit } from "./contact.ts";
import { InputError } from "./errors.ts";
import { drawDigits, textWidth } from "./image/digits.ts";
import { createRaster, decodeImage, encodePng, setPixel } from "./image/raster.ts";
import type { Raster } from "./image/raster.ts";
import { boxRect, maskInside } from "./regions.ts";
import type { Region } from "./regions.ts";
import type { Reason } from "./types.ts";

export const COMPARE_SHEET_FILE = "compare.png";
/**
 * The share of the figure's pixels changed outside the regions above which the advisory reason is
 * added. The figure is every pixel not fully transparent in either image and, when the version
 * before has a one-colour opaque border (a turntable render's backdrop), not within the tolerance
 * of that backdrop colour in both images. So a small figure on a large canvas, transparent or
 * opaque, is measured against itself (#376).
 */
export const OUTSIDE_CHANGE_LIMIT = 0.05;
/** A pixel counts as changed when a channel differs by more than this (of 255). */
export const CHANGE_TOLERANCE = 8;

const PAD = 8;
const DIGIT_SCALE = 3;
const BACKDROP = [236, 236, 236, 255];
const CELL = [248, 248, 248, 255];
const INK = [30, 30, 36, 255];
const OUTLINE = [230, 40, 40, 255];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which part of an asset a compare names. */
export interface ViewSelector {
  /** 1-based frame of a strip. */
  frame?: number;
  /** 1-based view of a 3D asset. */
  view?: number;
  /** A strip's frame width in pixels; its height by default. */
  frameWidth?: number;
}

/** The turntable view renders of a 3D asset: a directory's, or those beside a `.glb`. */
export function turntableViews(address: string): string[] {
  const dir = existsSync(address) && statSync(address).isDirectory() ? address : undefined;
  const folders =
    dir !== undefined
      ? [dir]
      : readdirSync(dirname(address), { withFileTypes: true })
          .filter(
            (e) => e.isDirectory() && e.name.startsWith(`${basename(address, extname(address))}-`),
          )
          .map((e) => join(dirname(address), e.name))
          .sort();
  return folders.flatMap((folder) =>
    readdirSync(folder)
      .filter((f) => f.endsWith(".png") && !f.startsWith("clip-"))
      .sort()
      .map((f) => join(folder, f)),
  );
}

/** The image an address shows: the file, a strip's named frame, or a 3D asset's named view. */
export async function loadView(address: string, select: ViewSelector = {}): Promise<Raster> {
  const is3d = extname(address).toLowerCase() === ".glb" || isDirectory(address);
  if (is3d) {
    const views = turntableViews(address);
    const n = select.view ?? 1;
    const file = views[n - 1];
    if (file === undefined)
      throw new InputError(`${address} has ${views.length} view(s); view ${n} does not exist`);
    return decode(address, await readFile(file));
  }
  const image = decode(address, await readFile(address).catch(unreadable(address)));
  if (select.frame === undefined) return image;
  const width = select.frameWidth ?? image.height;
  if (width <= 0 || image.width % width !== 0)
    throw new InputError(
      `${address} is ${image.width} px wide, not a whole number of ${width} px frames`,
    );
  const frames = splitStrip(image, { width, height: image.height });
  const frame = frames[select.frame - 1];
  if (frame === undefined)
    throw new InputError(
      `${address} has ${frames.length} frame(s); frame ${select.frame} does not exist`,
    );
  return frame;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function unreadable(address: string): () => never {
  return () => {
    throw new InputError(`cannot read ${address}`);
  };
}

function decode(address: string, bytes: Uint8Array): Raster {
  try {
    return decodeImage(bytes);
  } catch (error) {
    throw new InputError(`${address} is not a PNG or JPEG image`, { cause: error });
  }
}

/** `image` at the size of `to`, by nearest neighbour; the same raster when the sizes agree. */
function sizedTo(image: Raster, to: Raster): Raster {
  if (image.width === to.width && image.height === to.height) return image;
  const out = createRaster(to.width, to.height);
  for (let y = 0; y < to.height; y++)
    for (let x = 0; x < to.width; x++) {
      const sx = Math.min(image.width - 1, Math.floor(((x + 0.5) * image.width) / to.width));
      const sy = Math.min(image.height - 1, Math.floor(((y + 0.5) * image.height) / to.height));
      const i = (sy * image.width + sx) * 4;
      out.data.set(image.data.subarray(i, i + 4), (y * to.width + x) * 4);
    }
  return out;
}

/** A loaded region: its pixel rectangle (the box, or the mask's bounds) and its pixel test. */
interface Placed {
  rect: Rect;
  inside: (x: number, y: number) => boolean;
}

async function place(region: Region, width: number, height: number): Promise<Placed> {
  if (region.shape.kind === "box") {
    const rect = boxRect(region.shape, width, height);
    return {
      rect,
      inside: (x, y) =>
        x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height,
    };
  }
  const mask = sizedTo(
    decode(
      region.shape.path,
      await readFile(region.shape.path).catch(unreadable(region.shape.path)),
    ),
    createRaster(width, height),
  );
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (maskInside(mask, x, y)) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
  const rect =
    maxX < 0
      ? { x: 0, y: 0, width: 0, height: 0 }
      : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  return { rect, inside: (x, y) => maskInside(mask, x, y) };
}

/**
 * The regions as one mask at the given size, in the region convention: opaque white inside any
 * region, transparent outside. A mask file of another size is resized by nearest neighbour.
 */
export async function regionMask(
  regions: readonly Region[],
  width: number,
  height: number,
): Promise<Raster> {
  const placed = await Promise.all(regions.map((r) => place(r, width, height)));
  const out = createRaster(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (placed.some((p) => p.inside(x, y)))
        out.data.set([255, 255, 255, 255], (y * width + x) * 4);
  return out;
}

/** What comparing one candidate with the version before gives. */
export interface Comparison {
  before: Raster;
  candidate: Raster;
  /** Grey per-pixel difference, black where the pixels are equal. */
  difference: Raster;
  /** Region rectangles on the before image's pixels. */
  outlines: Rect[];
  /** Whether every pixel is equal. */
  identical: boolean;
  /** The share of all pixels that changed. */
  changed: number;
  /**
   * The share of the figure's pixels that changed outside every region (every change when none
   * are given). A pixel fully transparent in both images is not part of the figure, whatever
   * colour it keeps; nor, when the version before has a one-colour opaque border, is a pixel
   * within the tolerance of that backdrop colour in both images.
   */
  outsideChange: number;
  /** The advisory reason `changed_outside_region`, when regions are given and above the limit. */
  reasons: Reason[];
}

/**
 * Compares a candidate with the version before. A candidate of another size is resized to the
 * before image. `regions` are the ones that name this frame or view (or none).
 */
export async function compareRasters(
  before: Raster,
  candidateImage: Raster,
  regions: readonly Region[] = [],
): Promise<Comparison> {
  const candidate = sizedTo(candidateImage, before);
  const placed = await Promise.all(regions.map((r) => place(r, before.width, before.height)));
  const difference = createRaster(before.width, before.height);
  let different = 0;
  let changed = 0;
  let outside = 0;
  let figure = 0;
  const backdrop = backdropOf(before);
  for (let y = 0; y < before.height; y++)
    for (let x = 0; x < before.width; x++) {
      const i = (y * before.width + x) * 4;
      let max = 0;
      for (let c = 0; c < 4; c++)
        max = Math.max(max, Math.abs((before.data[i + c] ?? 0) - (candidate.data[i + c] ?? 0)));
      const grey = Math.min(255, max * 4);
      difference.data.set([grey, grey, grey, 255], i);
      if (max > 0) different++;
      const shown =
        ((before.data[i + 3] ?? 0) > 0 || (candidate.data[i + 3] ?? 0) > 0) &&
        (!backdrop || !nearBackdrop(before, i, backdrop) || !nearBackdrop(candidate, i, backdrop));
      if (shown) figure++;
      if (max > CHANGE_TOLERANCE) {
        changed++;
        if (shown && !placed.some((p) => p.inside(x, y))) outside++;
      }
    }
  const total = Math.max(1, before.width * before.height);
  const outsideChange = outside / Math.max(1, figure);
  return {
    before,
    candidate,
    difference,
    outlines: placed.map((p) => p.rect).filter((r) => r.width > 0 && r.height > 0),
    identical: different === 0,
    changed: changed / total,
    outsideChange,
    reasons:
      regions.length > 0 && outsideChange > OUTSIDE_CHANGE_LIMIT
        ? [
            {
              check: "changed_outside_region",
              passed: false,
              reason: `${(outsideChange * 100).toFixed(1)}% of the figure's pixels changed outside the regions`,
              source: "deterministic",
              shadow: true,
            },
          ]
        : [],
  };
}

/** The share of border pixels that must sit within the tolerance of the border's median colour. */
const BACKDROP_SHARE = 0.9;

/**
 * The backdrop colour of an image whose border is opaque and one colour (a turntable render's
 * grey): the border's median colour, when at least 90% of the border pixels are opaque and within
 * the change tolerance of it. Otherwise none, and the figure is found by alpha alone.
 */
export function backdropOf(image: Raster): [number, number, number] | undefined {
  const { width, height, data } = image;
  if (width === 0 || height === 0) return undefined;
  const border: number[] = [];
  for (let x = 0; x < width; x++) border.push(x, 0, x, height - 1);
  for (let y = 1; y < height - 1; y++) border.push(0, y, width - 1, y);
  const offsets: number[] = [];
  for (let k = 0; k < border.length; k += 2)
    offsets.push((border[k + 1]! * width + border[k]!) * 4);
  const median = [0, 1, 2].map((c) => {
    const s = offsets.map((o) => data[o + c]!).sort((a, b) => a - b);
    return s[s.length >> 1]!;
  }) as [number, number, number];
  let near = 0;
  for (const o of offsets) if (data[o + 3] === 255 && nearBackdrop(image, o, median)) near++;
  return near >= offsets.length * BACKDROP_SHARE ? median : undefined;
}

function nearBackdrop(image: Raster, i: number, rgb: readonly number[]): boolean {
  for (let c = 0; c < 3; c++)
    if (Math.abs((image.data[i + c] ?? 0) - rgb[c]!) > CHANGE_TOLERANCE) return false;
  return true;
}

function outline(cell: Raster, rect: Rect, scale: number, ox: number, oy: number): void {
  const x0 = ox + Math.floor(rect.x * scale);
  const y0 = oy + Math.floor(rect.y * scale);
  const x1 =
    ox + Math.max(Math.ceil((rect.x + rect.width) * scale) - 1, Math.floor(rect.x * scale));
  const y1 =
    oy + Math.max(Math.ceil((rect.y + rect.height) * scale) - 1, Math.floor(rect.y * scale));
  for (let x = x0; x <= x1; x++) {
    setPixel(cell, x, y0, OUTLINE);
    setPixel(cell, x, y1, OUTLINE);
  }
  for (let y = y0; y <= y1; y++) {
    setPixel(cell, x0, y, OUTLINE);
    setPixel(cell, x1, y, OUTLINE);
  }
}

/** One image fitted into a cell, with the outlines drawn over it. */
function cellOf(image: Raster, outlines: readonly Rect[]): Raster {
  const cell = createRaster(CELL_PX, CELL_PX);
  fill(cell, 0, 0, CELL_PX, CELL_PX, CELL);
  const scaled = fit(image);
  const ox = Math.floor((CELL_PX - scaled.width) / 2);
  const oy = Math.floor((CELL_PX - scaled.height) / 2);
  for (let y = 0; y < scaled.height; y++)
    for (let x = 0; x < scaled.width; x++) {
      const i = (y * scaled.width + x) * 4;
      const a = (scaled.data[i + 3] ?? 0) / 255;
      const j = ((oy + y) * CELL_PX + ox + x) * 4;
      for (let c = 0; c < 3; c++)
        cell.data[j + c] = Math.round(
          (scaled.data[i + c] ?? 0) * a + (cell.data[j + c] ?? 0) * (1 - a),
        );
    }
  const scale = scaled.width / image.width;
  for (const rect of outlines) outline(cell, rect, scale, ox, oy);
  return cell;
}

/** One row of the sheet: the candidate's number and its comparison. */
export interface CompareRow {
  number: number;
  comparison: Comparison;
}

/** Renders the rows: the number, then the version before, the candidate and the difference map. */
export function renderCompare(rows: readonly CompareRow[]): Raster {
  const numberW = Math.max(...rows.map((r) => textWidth(String(r.number), DIGIT_SCALE)), 0);
  const x0 = PAD + numberW + PAD;
  const rowH = CELL_PX + PAD;
  const out = createRaster(x0 + 3 * (CELL_PX + PAD), Math.max(PAD + rows.length * rowH, 1));
  for (let i = 0; i < out.data.length; i += 4) out.data.set(BACKDROP, i);
  rows.forEach((row, index) => {
    const y = PAD + index * rowH;
    drawDigits(
      out,
      String(row.number),
      PAD,
      y + Math.floor((CELL_PX - 5 * DIGIT_SCALE) / 2),
      DIGIT_SCALE,
      INK,
    );
    const c = row.comparison;
    [c.before, c.candidate, c.difference].forEach((image, i) => {
      const cell = cellOf(image, c.outlines);
      for (let cy = 0; cy < CELL_PX; cy++)
        out.data.set(
          cell.data.subarray(cy * CELL_PX * 4, (cy + 1) * CELL_PX * 4),
          ((y + cy) * out.width + x0 + i * (CELL_PX + PAD)) * 4,
        );
    });
  });
  return out;
}

/** Writes `<dir>/compare.png` (or `file`) for the rows; returns its path. */
export async function writeCompareSheet(
  dir: string,
  rows: readonly CompareRow[],
  file: string = COMPARE_SHEET_FILE,
): Promise<string> {
  const path = join(dir, file);
  await writeFile(path, encodePng(renderCompare(rows)));
  return path;
}

/** The numbers a compare reports for one candidate. */
export function comparisonFields(c: Comparison): {
  identical: boolean;
  changed: number;
  outsideChange: number;
  reasons: Reason[];
} {
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    identical: c.identical,
    changed: round(c.changed),
    outsideChange: round(c.outsideChange),
    reasons: c.reasons,
  };
}
