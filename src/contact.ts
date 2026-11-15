/**
 * The contact sheet of a run (design section 10): `<run>/contact.png`, one numbered row per staged
 * candidate. A still sits beside its references, a sprite strip shows a row of key frames and a 3D
 * character its turntable frames. Numbers only: no text from any shared file or request input is
 * drawn, so the sheet changes only when an image does. It reuses the raster code of the sheet
 * import (src/sheet/import.ts).
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { splitStrip } from "./animation/strip.ts";
import { drawDigits, textWidth } from "./image/digits.ts";
import { createRaster, decodeImage, encodePng } from "./image/raster.ts";
import type { Raster } from "./image/raster.ts";
import { resampleTo } from "./image/resample.ts";
import { blit } from "./sheet/import.ts";
import type { AssetSpec } from "./types.ts";

export const CONTACT_SHEET_FILE = "contact.png";

/** The edge of the square every image cell fits in, in pixels. */
export const CELL_PX = 96;
/** The most key frames shown for a strip. */
export const MAX_KEY_FRAMES = 6;
const PAD = 8;
const GAP = 16;
const DIGIT_SCALE = 3;

const BACKDROP = [236, 236, 236, 255];
const CELL = [248, 248, 248, 255];
const REFERENCE_CELL = [214, 220, 232, 255];
const INK = [30, 30, 36, 255];

/** One candidate's row: its number, its images (the candidate, key frames or turntable frames). */
export interface ContactRow {
  number: number;
  images: Raster[];
}

export interface ContactCellBox {
  kind: "number" | "image" | "reference";
  /** The row's candidate number (0 for a reference row). */
  number: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContactSheet {
  raster: Raster;
  cells: ContactCellBox[];
}

export function fit(image: Raster): Raster {
  const scale = Math.min(CELL_PX / image.width, CELL_PX / image.height);
  const size = {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  };
  return resampleTo(image, scale, { x: 0, y: 0 }, size, "crisp");
}

export function fill(r: Raster, x: number, y: number, w: number, h: number, rgba: number[]): void {
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++) r.data.set(rgba, (j * r.width + i) * 4);
}

/**
 * Renders the rows with the references repeated beside each: the number, then the row's images,
 * then the references in a tinted cell each. Returns the raster and where every cell is.
 */
export function renderContact(rows: ContactRow[], references: Raster[]): ContactSheet {
  const numberW = Math.max(...rows.map((r) => textWidth(String(r.number), DIGIT_SCALE)), 0);
  const columns = Math.max(0, ...rows.map((r) => r.images.length));
  const imageX = PAD + numberW + PAD;
  const referenceX = imageX + columns * (CELL_PX + PAD) + (references.length > 0 ? GAP : 0);
  const width =
    references.length > 0
      ? referenceX + references.length * (CELL_PX + PAD)
      : imageX + Math.max(columns, 1) * (CELL_PX + PAD);
  const rowH = CELL_PX + PAD;
  const out = createRaster(Math.max(width, 1), Math.max(PAD + rows.length * rowH, 1));
  for (let i = 0; i < out.data.length; i += 4) out.data.set(BACKDROP, i);
  const cells: ContactCellBox[] = [];
  const place = (
    image: Raster,
    kind: "image" | "reference",
    number: number,
    x: number,
    y: number,
  ) => {
    fill(out, x, y, CELL_PX, CELL_PX, kind === "image" ? CELL : REFERENCE_CELL);
    const scaled = fit(image);
    blit(
      out,
      scaled,
      x + Math.floor((CELL_PX - scaled.width) / 2),
      y + Math.floor((CELL_PX - scaled.height) / 2),
    );
    cells.push({ kind, number, x, y, width: CELL_PX, height: CELL_PX });
  };
  rows.forEach((row, index) => {
    const y = PAD + index * rowH;
    const label = String(row.number);
    const labelH = 5 * DIGIT_SCALE;
    drawDigits(out, label, PAD, y + Math.floor((CELL_PX - labelH) / 2), DIGIT_SCALE, INK);
    cells.push({
      kind: "number",
      number: row.number,
      x: PAD,
      y: y + Math.floor((CELL_PX - labelH) / 2),
      width: textWidth(label, DIGIT_SCALE),
      height: labelH,
    });
    row.images.forEach((image, i) =>
      place(image, "image", row.number, imageX + i * (CELL_PX + PAD), y),
    );
    references.forEach((reference, i) =>
      place(reference, "reference", row.number, referenceX + i * (CELL_PX + PAD), y),
    );
  });
  return { raster: out, cells };
}

/** `count` indexes spread evenly over `length` items, first and last included. */
export function keyIndexes(length: number, count = MAX_KEY_FRAMES): number[] {
  if (length <= count) return Array.from({ length }, (_, i) => i);
  return Array.from({ length: count }, (_, i) => Math.round((i * (length - 1)) / (count - 1)));
}

function tryDecode(bytes: Uint8Array): Raster | undefined {
  try {
    return decodeImage(bytes);
  } catch {
    return undefined;
  }
}

/** What a run's contact sheet needs of a staged candidate. */
export interface ContactCandidate {
  id: string;
  file: string;
  mediaType: string;
  fields: Record<string, unknown>;
  artifacts?: string[];
}

/** A candidate's number: the digits of its id (`c3` is 3). */
export function candidateNumber(id: string, fallback: number): number {
  const n = Number.parseInt(id.replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** The images of one staged candidate by its kind. */
async function candidateImages(
  runDir: string,
  spec: AssetSpec,
  candidate: ContactCandidate,
): Promise<Raster[]> {
  if (spec.kind === "character-3d") {
    // Turntable frames are the view renders; the clip frames are not part of the turntable.
    const views = (candidate.artifacts ?? []).filter(
      (a) => a.endsWith(".png") && !(a.split("/").pop() ?? "").startsWith("clip-"),
    );
    const images = await Promise.all(
      views.map(async (a) => tryDecode(new Uint8Array(await readFile(join(runDir, a))))),
    );
    return images.filter((i): i is Raster => i !== undefined);
  }
  if (!candidate.mediaType.startsWith("image/")) return [];
  const image = tryDecode(new Uint8Array(await readFile(join(runDir, candidate.file))));
  if (!image) return [];
  if (spec.kind !== "sprite-strip") return [image];
  const frames = candidate.fields["frames"] as { width?: number; height?: number } | undefined;
  const width = frames?.width ?? spec.frames?.width;
  const height = frames?.height ?? spec.frames?.height ?? image.height;
  if (width === undefined || height !== image.height || image.width % width !== 0) return [image];
  const all = splitStrip(image, { width, height });
  return keyIndexes(all.length).map((i) => all[i] as Raster);
}

/** Writes `<runDir>/contact.png` for rows and references; returns the file name and the layout. */
export async function writeContactRows(
  runDir: string,
  rows: ContactRow[],
  references: Raster[],
): Promise<{ file: string; cells: ContactCellBox[] } | undefined> {
  if (rows.length === 0) return undefined;
  const sheet = renderContact(rows, references);
  await writeFile(join(runDir, CONTACT_SHEET_FILE), encodePng(sheet.raster));
  return { file: CONTACT_SHEET_FILE, cells: sheet.cells };
}

/**
 * Writes the contact sheet of a run's staged candidates: stills beside `references` (image
 * bytes), a row of key frames per strip, turntable frames per 3D character. Returns the file
 * name, or undefined when no candidate has an image to show.
 */
export async function writeContact(
  runDir: string,
  spec: AssetSpec,
  candidates: ContactCandidate[],
  references: Uint8Array[],
): Promise<string | undefined> {
  const rows: ContactRow[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const images = await candidateImages(runDir, spec, candidate);
    if (images.length > 0) rows.push({ number: candidateNumber(candidate.id, index + 1), images });
  }
  const refs = references.map(tryDecode).filter((r): r is Raster => r !== undefined);
  return (await writeContactRows(runDir, rows, refs))?.file;
}
