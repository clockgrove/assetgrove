/**
 * Slicing: finds each figure on a contact sheet, either from a grid (given or detected) or by
 * locating connected components, and keeps labels, specks, neighbours and background out of every
 * figure's mask.
 */
import { InputError } from "../errors.ts";
import type { Raster } from "../image/raster.ts";
import type { Box, Point, Rgb, Size, Transform } from "../types.ts";
import type { BlobKind, SliceOptions, SliceResult, SlicedFigure } from "./types.ts";

interface Component {
  /** Pixel indices in sheet coordinates. */
  pixels: number[];
  box: Box;
}

/** A figure's components, plus the dropped ones near it. */
interface Found {
  parts: Component[];
  removed: number;
}

/** Px around a dropped label, speck or neighbour also kept out of the frame (its soft fringe). */
const EXCLUDE_FRINGE = 2;
/** Ratio between neighbouring areas (largest first) that separates figures from labels. */
const SIZE_DROP = 3;

/** A figure this many times the median figure's area may be touching figures merged into one. */
const MERGED_RATIO = 1.75;
/** A figure at most this fraction of the median figure's area may be part of a figure. */
const SPLIT_RATIO = 0.5;

/**
 * Slicing could not find the figures the sheet must hold: the count differs from the one asked
 * for. `problems` names each cell or figure that explains the difference, and why.
 */
export class SliceError extends InputError {
  readonly found: number;
  readonly expected: number;
  readonly problems: string[];
  /** Where the refused sheet was kept, when it was a generated one. */
  kept?: string;
  /** What the run had spent when the slice was refused, when a model made the sheet. */
  spentUsd?: number;
  constructor(found: number, expected: number, problems: string[]) {
    super(
      `slicing found ${found} figure${found === 1 ? "" : "s"} on the sheet where ${expected} ` +
        `${expected === 1 ? "is" : "are"} asked for: ` +
        (problems.length > 0
          ? problems.join("; ")
          : "no single cell or figure explains the difference"),
    );
    this.name = "SliceError";
    this.found = found;
    this.expected = expected;
    this.problems = problems;
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function medianColour(
  sheet: Raster,
  hasAlpha: boolean,
  indices: Iterable<number>,
): { colour: Rgb; count: number } {
  const channels: number[][] = [[], [], []];
  const all: number[] = [];
  for (const i of indices) {
    all.push(i);
    if (hasAlpha && (sheet.data[i * 4 + 3] as number) < 128) continue;
    for (let k = 0; k < 3; k++) (channels[k] as number[]).push(sheet.data[i * 4 + k] as number);
  }
  const count = (channels[0] as number[]).length;
  const source =
    count > 0 ? channels : [0, 1, 2].map((k) => all.map((i) => sheet.data[i * 4 + k] as number));
  return {
    colour: [
      median(source[0] as number[]),
      median(source[1] as number[]),
      median(source[2] as number[]),
    ],
    count,
  };
}

function boxBorder(sheet: Raster, box: Box): number[] {
  const out: number[] = [];
  for (let x = box.x; x < box.x + box.width; x++) {
    out.push(box.y * sheet.width + x, (box.y + box.height - 1) * sheet.width + x);
  }
  for (let y = box.y + 1; y < box.y + box.height - 1; y++) {
    out.push(y * sheet.width + box.x, y * sheet.width + box.x + box.width - 1);
  }
  return out;
}

function ringAround(sheet: Raster, box: Box, thickness: number): number[] {
  const x0 = Math.max(0, box.x - thickness);
  const y0 = Math.max(0, box.y - thickness);
  const x1 = Math.min(sheet.width, box.x + box.width + thickness);
  const y1 = Math.min(sheet.height, box.y + box.height + thickness);
  const out: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const inside = x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
      if (!inside) out.push(y * sheet.width + x);
    }
  }
  return out;
}

interface Background {
  colour: Rgb;
  /** False when every sampled pixel was transparent: only alpha then separates the figure. */
  usesColour: boolean;
}

function estimate(sheet: Raster, hasAlpha: boolean, indices: number[]): Background {
  const { colour, count } = medianColour(sheet, hasAlpha, indices);
  return { colour, usesColour: count > 0 };
}

function foreground(
  sheet: Raster,
  hasAlpha: boolean,
  bg: Background,
  tolerance: number,
  box: Box,
): Uint8Array {
  const mask = new Uint8Array(box.width * box.height);
  const limit = tolerance * tolerance;
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const i = ((box.y + y) * sheet.width + box.x + x) * 4;
      const d = sheet.data;
      if (hasAlpha && (d[i + 3] as number) < 128) continue;
      if (!bg.usesColour) {
        mask[y * box.width + x] = 1;
        continue;
      }
      const dr = (d[i] as number) - bg.colour[0];
      const dg = (d[i + 1] as number) - bg.colour[1];
      const db = (d[i + 2] as number) - bg.colour[2];
      if (dr * dr + dg * dg + db * db > limit) mask[y * box.width + x] = 1;
    }
  }
  return mask;
}

/** 8-connected components of a mask over `box`; pixel indices and boxes in sheet coordinates. */
function components(mask: Uint8Array, box: Box, sheetWidth: number): Component[] {
  const seen = new Uint8Array(mask.length);
  const out: Component[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    const pixels: number[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    while (stack.length > 0) {
      const p = stack.pop() as number;
      const x = p % box.width;
      const y = (p - x) / box.width;
      pixels.push((box.y + y) * sheetWidth + box.x + x);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= box.width || ny >= box.height) continue;
          const q = ny * box.width + nx;
          if (!mask[q] || seen[q]) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    out.push({
      pixels,
      box: {
        x: box.x + minX,
        y: box.y + minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      },
    });
  }
  return out;
}

function unionBox(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function inside(inner: Box, outer: Box, slack: number): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}

function centre(b: Box): Point {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/**
 * The smallest area that still counts as a figure. Components under `labelFraction` of the largest
 * are labels or specks; among the rest, a drop of SIZE_DROP or more between neighbouring areas
 * separates figures from the labels that are big next to a small figure.
 */
function figureCutoff(components: Component[], labelFraction: number): number {
  const areas = components.map((c) => c.pixels.length).sort((a, b) => b - a);
  const largest = areas[0] ?? 0;
  const candidates = areas.filter((a) => a >= labelFraction * largest);
  let cutoff = candidates[candidates.length - 1] ?? 0;
  let bestRatio = SIZE_DROP;
  for (let i = 0; i + 1 < candidates.length; i++) {
    const ratio = (candidates[i] as number) / (candidates[i + 1] as number);
    if (ratio >= bestRatio) {
      bestRatio = ratio;
      cutoff = candidates[i] as number;
    }
  }
  return cutoff;
}

/** A blob's id: its box on the sheet, `x,y,WxH`. Stable for one sheet and one set of options. */
function blobId(c: Component): string {
  return `${c.box.x},${c.box.y},${c.box.width}x${c.box.height}`;
}

type Verdicts = ReadonlyMap<string, BlobKind>;

/** A component under the cutoff that a `sheet-blob` verdict made a whole figure. */
function isFigure(c: Component, cutoff: number, verdicts: Verdicts): boolean {
  return c.pixels.length >= cutoff || verdicts.get(blobId(c)) === "figure";
}

function nearest(figures: Component[], c: Component): Component | undefined {
  const at = centre(c.box);
  let best: Component | undefined;
  let bestDistance = Infinity;
  for (const f of figures) {
    const fc = centre(f.box);
    const distance = (fc.x - at.x) ** 2 + (fc.y - at.y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = f;
    }
  }
  return best;
}

/**
 * Splits components into figures, their merged detached bits, and dropped ones. A blob's verdict
 * decides it: a figure is one whatever its area, a part joins the nearest figure, a label or speck
 * is dropped. A blob with no verdict keeps the area rule: under the cutoff, it joins the figure
 * whose box holds it, else it is dropped.
 */
function assign(
  all: Component[],
  cutoff: number,
  verdicts: Verdicts,
): { figures: Component[]; merged: Map<Component, Component[]>; dropped: Component[] } {
  const figures = all.filter((c) => isFigure(c, cutoff, verdicts));
  const merged = new Map<Component, Component[]>(figures.map((f) => [f, []]));
  const dropped: Component[] = [];
  for (const c of all) {
    if (isFigure(c, cutoff, verdicts)) continue;
    const verdict = verdicts.get(blobId(c));
    const host =
      verdict === "part"
        ? nearest(figures, c)
        : verdict === undefined
          ? figures.find((f) => inside(c.box, f.box, 2))
          : undefined;
    if (host) (merged.get(host) as Component[]).push(c);
    else dropped.push(c);
  }
  return { figures, merged, dropped };
}

function cluster(values: number[], gap: number): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ids = new Array<number>(values.length).fill(0);
  let current = 0;
  order.forEach(([v, i], k) => {
    if (k > 0 && v - (order[k - 1] as readonly [number, number])[0] > gap) current++;
    ids[i] = current;
  });
  return ids;
}

interface GridSpec {
  columns: number;
  rows: number;
  cell: Size;
  origin: Point;
}

/** How many rows the figures sit in, clustered by their centres' heights as detectGrid does. */
function figureRows(figures: Component[]): number | undefined {
  if (figures.length === 0) return undefined;
  const boxes = figures.map((f) => f.box);
  return (
    Math.max(
      ...cluster(
        boxes.map((b) => centre(b).y),
        0.5 * median(boxes.map((b) => b.height)),
      ),
    ) + 1
  );
}

/**
 * The figure-sized components that are whole figures, not a detached prop or part beside one: at
 * least half the size of a typical large component (the median of the larger half), so neither a
 * prop in every cell nor a few touching figures merged into one move the reference.
 */
function wholeFigures(figures: Component[]): Component[] {
  if (figures.length === 0) return [];
  const sizes = figures.map((f) => f.pixels.length).sort((a, b) => a - b);
  const reference = median(sizes.slice(Math.floor(sizes.length / 2)));
  return figures.filter((f) => f.pixels.length >= 0.45 * reference);
}

/**
 * How a given grid cuts the sheet's figure-sized components: the cells whose box holds the centres
 * of two or more whole figures (so the grid has too few cells), and the share of the figures' area
 * in components a cell edge cuts straight through, crossing at half the component's width or more
 * (so the cells are too short). Figures that touch across an edge at a narrower contact, and the
 * odd figure that hangs into the cell below, leave that share low.
 */
function gridFit(
  sheetWidth: number,
  figures: Component[],
  grid: GridSpec,
): { crowded: string[]; slicedShare: number } {
  const { columns, rows, cell, origin } = grid;
  const crowding = new Map<string, number>();
  for (const f of wholeFigures(figures)) {
    const c = centre(f.box);
    const column = Math.floor((c.x - origin.x) / cell.width);
    const row = Math.floor((c.y - origin.y) / cell.height);
    if (column < 0 || column >= columns || row < 0 || row >= rows) continue;
    const key = `row ${row + 1}, column ${column + 1}`;
    crowding.set(key, (crowding.get(key) ?? 0) + 1);
  }
  const crowded = [...crowding].filter(([, n]) => n > 1).map(([key]) => key);
  let total = 0;
  let sliced = 0;
  for (const f of figures) {
    total += f.pixels.length;
    const at = new Set(f.pixels);
    let cutThrough = false;
    for (let k = 1; k < rows && !cutThrough; k++) {
      const y = origin.y + k * cell.height;
      if (y <= f.box.y || y >= f.box.y + f.box.height) continue;
      const crossing = new Map<number, number>();
      for (let x = f.box.x; x < f.box.x + f.box.width; x++) {
        if (!at.has(y * sheetWidth + x) || !at.has((y - 1) * sheetWidth + x)) continue;
        const column = Math.floor((x - origin.x) / cell.width);
        crossing.set(column, (crossing.get(column) ?? 0) + 1);
      }
      for (const n of crossing.values()) if (n >= 0.5 * f.box.width) cutThrough = true;
    }
    if (cutThrough) sliced += f.pixels.length;
  }
  return { crowded, slicedShare: total > 0 ? sliced / total : 0 };
}

function detectGrid(sheet: Raster, figures: Component[]): GridSpec | undefined {
  if (figures.length < 2) return undefined;
  const boxes = figures.map((f) => f.box);
  const cx = boxes.map((b) => centre(b).x);
  const cy = boxes.map((b) => centre(b).y);
  const columns = Math.max(...cluster(cx, 0.5 * median(boxes.map((b) => b.width)))) + 1;
  const rows = Math.max(...cluster(cy, 0.5 * median(boxes.map((b) => b.height)))) + 1;
  if (columns * rows < 2) return undefined;
  const cell = {
    width: Math.round(sheet.width / columns),
    height: Math.round(sheet.height / rows),
  };
  if (Math.abs(cell.width * columns - sheet.width) > columns) return undefined;
  if (Math.abs(cell.height * rows - sheet.height) > rows) return undefined;
  const taken = new Set<number>();
  for (const b of boxes) {
    const c = centre(b);
    const column = Math.floor(c.x / cell.width);
    const row = Math.floor(c.y / cell.height);
    if (column >= columns || row >= rows || taken.has(row * columns + column)) return undefined;
    taken.add(row * columns + column);
    const slot = { x: column * cell.width, y: row * cell.height, ...cell };
    if (!inside(b, slot, Math.round(0.1 * Math.min(cell.width, cell.height)))) return undefined;
  }
  return { columns, rows, cell, origin: { x: 0, y: 0 } };
}

/**
 * The figure's crop mask: exactly its own components' pixels. Enclosed background (a gap between
 * an arm and the body) stays 0, so the background colour never becomes opaque in a frame.
 */
function cropMask(parts: Component[], crop: Box, sheetWidth: number): Uint8Array {
  const mask = new Uint8Array(crop.width * crop.height);
  for (const part of parts) {
    for (const p of part.pixels) {
      const x = (p % sheetWidth) - crop.x;
      const y = Math.floor(p / sheetWidth) - crop.y;
      mask[y * crop.width + x] = 1;
    }
  }
  return mask;
}

/**
 * Per crop pixel: 1 on foreground that is not the figure's (labels, specks, neighbours) and on its
 * fringe within EXCLUDE_FRINGE px, never on the figure's own mask. Matting zeroes these pixels.
 */
function excludedMask(mask: Uint8Array, fg: Uint8Array, crop: Box): Uint8Array {
  const out = new Uint8Array(mask.length);
  const r = EXCLUDE_FRINGE;
  for (let p = 0; p < mask.length; p++) {
    if (!fg[p] || mask[p]) continue;
    const x = p % crop.width;
    const y = (p - x) / crop.width;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= crop.width || yy >= crop.height) continue;
        const q = yy * crop.width + xx;
        if (!mask[q]) out[q] = 1;
      }
    }
  }
  return out;
}

function clipBox(box: Box, within: Box): Box {
  const x0 = Math.max(box.x, within.x);
  const y0 = Math.max(box.y, within.y);
  const x1 = Math.min(box.x + box.width, within.x + within.width);
  const y1 = Math.min(box.y + box.height, within.y + within.height);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

function build(
  sheet: Raster,
  found: Found,
  limit: Box,
  cellBox: Box,
  padding: number,
  bg: Background,
  hasAlpha: boolean,
  tolerance: number,
  /** The background that other foreground in the crop (labels, specks, neighbours) is found against. */
  segment: Background,
): Omit<SlicedFigure, "id" | "cell"> {
  const extent = unionBox(found.parts.map((p) => p.box));
  const box = clipBox(
    {
      x: extent.x - padding,
      y: extent.y - padding,
      width: extent.width + 2 * padding,
      height: extent.height + 2 * padding,
    },
    limit,
  );
  const crop = {
    width: box.width,
    height: box.height,
    data: new Uint8Array(box.width * box.height * 4),
  };
  for (let y = 0; y < box.height; y++) {
    const from = ((box.y + y) * sheet.width + box.x) * 4;
    crop.data.set(sheet.data.subarray(from, from + box.width * 4), y * box.width * 4);
  }
  const transforms: Transform[] = [
    { op: "crop", box, cell: cellBox },
    { op: "strip-labels", removed: found.removed },
  ];
  const mask = cropMask(found.parts, box, sheet.width);
  const fg = foreground(sheet, hasAlpha, segment, tolerance, box);
  return {
    box,
    crop,
    mask,
    excluded: excludedMask(mask, fg, box),
    background: bg.colour,
    transforms,
  };
}

/** What every slicing mode shares: the sheet, the options and the sheet-wide segmentation. */
interface Context {
  sheet: Raster;
  whole: Box;
  hasAlpha: boolean;
  tolerance: number;
  labelFraction: number;
  padding: number;
  sheetBg: Background;
  sheetComponents: Component[];
  cutoff: number;
  verdicts: Verdicts;
}

/** A sliced sheet, plus why each grid cell without a figure has none. */
interface Sliced extends SliceResult {
  empty: Map<string, string>;
}

const cellKey = (row: number, column: number): string => `${row},${column}`;

function cellBoxOf(grid: GridSpec, row: number, column: number, whole: Box): Box {
  return clipBox(
    {
      x: grid.origin.x + column * grid.cell.width,
      y: grid.origin.y + row * grid.cell.height,
      ...grid.cell,
    },
    whole,
  );
}

/** Why a cell holds no figure, from its largest component (if any) and the figure size. */
function emptyReason(largest: number, cutoff: number, tolerance: number): string {
  if (largest === 0) {
    return `nothing in it differs from the background by more than the colour tolerance (${tolerance})`;
  }
  return `its largest part is ${largest} px, under the ${cutoff} px a figure needs`;
}

/**
 * A grid the caller gave: each cell is segmented on its own, against its own border's colour, so
 * figures that touch across a cell edge come apart. Which parts are figures is decided on these
 * same per-cell parts, never on the sheet-wide ones, whose areas differ.
 */
function sliceGivenGrid(ctx: Context, grid: GridSpec): Sliced {
  const { sheet, whole, hasAlpha, tolerance, padding } = ctx;
  const cells: Array<{
    row: number;
    column: number;
    box: Box;
    bg: Background;
    parts: Component[];
  }> = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      const box = cellBoxOf(grid, row, column, whole);
      if (box.width === 0 || box.height === 0) continue;
      const bg = estimate(sheet, hasAlpha, boxBorder(sheet, box));
      const parts = components(foreground(sheet, hasAlpha, bg, tolerance, box), box, sheet.width);
      cells.push({ row, column, box, bg, parts });
    }
  }
  const cutoff = figureCutoff(
    cells.flatMap((c) => c.parts),
    ctx.labelFraction,
  );
  const figures: SlicedFigure[] = [];
  const empty = new Map<string, string>();
  for (const { row, column, box, bg, parts } of cells) {
    const { figures: big, merged } = assign(parts, cutoff, ctx.verdicts);
    const main = big.sort((a, b) => b.pixels.length - a.pixels.length)[0];
    if (!main) {
      const largest = Math.max(0, ...parts.map((p) => p.pixels.length));
      empty.set(cellKey(row, column), emptyReason(largest, cutoff, tolerance));
      continue;
    }
    // Anything else in the cell that is figure-sized is dropped, as another figure is not ours.
    const own = [main, ...(merged.get(main) as Component[])];
    const removed = parts.length - own.length;
    figures.push({
      id: 0,
      cell: { row, column, box },
      ...build(sheet, { parts: own, removed }, box, box, padding, bg, hasAlpha, tolerance, bg),
    });
  }
  figures.forEach((f, i) => (f.id = i + 1));
  return { mode: "grid", grid, background: ctx.sheetBg.colour, figures, empty };
}

/**
 * A grid detected from the figures: the figures are the sheet-wide components the grid was
 * detected from, so no figure is lost to a second segmentation. The grid gives each its cell and
 * reading order; its crop is not clipped to the cell, so a tail reaching past the cell's edge into
 * the gutter is kept whole, and anything else in the crop is excluded from it.
 */
function sliceDetectedGrid(ctx: Context, grid: GridSpec): Sliced {
  const { sheet, whole, hasAlpha, tolerance, padding, sheetBg, sheetComponents, cutoff } = ctx;
  const cellOf = (b: Box): { row: number; column: number } => {
    const c = centre(b);
    return {
      row: Math.floor((c.y - grid.origin.y) / grid.cell.height),
      column: Math.floor((c.x - grid.origin.x) / grid.cell.width),
    };
  };
  const { figures: big, merged, dropped } = assign(sheetComponents, cutoff, ctx.verdicts);
  const placed = big.map((f) => {
    const { row, column } = cellOf(f.box);
    const removed = dropped.filter((d) => {
      const at = cellOf(d.box);
      return at.row === row && at.column === column;
    }).length;
    return { row, column, parts: [f, ...(merged.get(f) as Component[])], removed };
  });
  placed.sort((a, b) => a.row - b.row || a.column - b.column);
  const figures: SlicedFigure[] = placed.map((p) => {
    const box = cellBoxOf(grid, p.row, p.column, whole);
    const bg = estimate(sheet, hasAlpha, boxBorder(sheet, box));
    return {
      id: 0,
      cell: { row: p.row, column: p.column, box },
      ...build(
        sheet,
        { parts: p.parts, removed: p.removed },
        whole,
        box,
        padding,
        bg,
        hasAlpha,
        tolerance,
        sheetBg,
      ),
    };
  });
  figures.forEach((f, i) => (f.id = i + 1));
  const taken = new Set(placed.map((p) => cellKey(p.row, p.column)));
  const empty = new Map<string, string>();
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      if (taken.has(cellKey(row, column))) continue;
      const inCell = sheetComponents.filter((c) => {
        const at = cellOf(c.box);
        return at.row === row && at.column === column;
      });
      const largest = Math.max(0, ...inCell.map((c) => c.pixels.length));
      empty.set(cellKey(row, column), emptyReason(largest, cutoff, tolerance));
    }
  }
  return { mode: "grid", grid, background: sheetBg.colour, figures, empty };
}

/** No grid: each figure is located on its own and numbered in reading order. */
function sliceComponents(ctx: Context): Sliced {
  const { sheet, whole, hasAlpha, tolerance, padding, sheetComponents, cutoff } = ctx;
  const figures: SlicedFigure[] = [];
  const { figures: big, merged, dropped } = assign(sheetComponents, cutoff, ctx.verdicts);
  const ownership = new Map<Component, number>(big.map((f) => [f, 0]));
  for (const d of dropped) {
    const c = centre(d.box);
    let best: Component | undefined;
    let bestDistance = Infinity;
    for (const f of big) {
      const fc = centre(f.box);
      const distance = (fc.x - c.x) ** 2 + (fc.y - c.y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = f;
      }
    }
    if (best) ownership.set(best, (ownership.get(best) as number) + 1);
  }
  const placed = big.map((f) => {
    const parts = [f, ...(merged.get(f) as Component[])];
    const extent = unionBox(parts.map((p) => p.box));
    const bg = estimate(sheet, hasAlpha, ringAround(sheet, extent, 3));
    return { parts, extent, bg, removed: ownership.get(f) as number };
  });

  // Rows by vertical overlap of boxes; columns by x within a row.
  placed.sort((a, b) => centre(a.extent).y - centre(b.extent).y);
  const rowsOf: Array<{ top: number; bottom: number; members: typeof placed }> = [];
  for (const p of placed) {
    const top = p.extent.y;
    const bottom = p.extent.y + p.extent.height;
    const row = rowsOf.find(
      (r) => Math.min(r.bottom, bottom) - Math.max(r.top, top) >= 0.5 * p.extent.height,
    );
    if (row) {
      row.top = Math.min(row.top, top);
      row.bottom = Math.max(row.bottom, bottom);
      row.members.push(p);
    } else rowsOf.push({ top, bottom, members: [p] });
  }
  rowsOf.sort((a, b) => a.top - b.top);
  rowsOf.forEach((r, rowIndex) => {
    r.members.sort((a, b) => a.extent.x - b.extent.x);
    r.members.forEach((p, column) => {
      const built = build(
        sheet,
        { parts: p.parts, removed: p.removed },
        whole,
        whole,
        padding,
        p.bg,
        hasAlpha,
        tolerance,
        p.bg,
      );
      figures.push({ id: 0, cell: { row: rowIndex, column, box: built.box }, ...built });
    });
  });
  figures.forEach((f, i) => (f.id = i + 1));
  return { mode: "components", background: ctx.sheetBg.colour, figures, empty: new Map() };
}

function where(f: SlicedFigure): string {
  return `figure ${f.id} (row ${f.cell.row + 1}, column ${f.cell.column + 1})`;
}

/**
 * Why the count differs from the one asked for: on a grid, each cell among the first `count` in
 * reading order that holds no figure and why; on any sheet, a figure far above the median figure's
 * area (touching figures merged) when too few were found, or far below it (a figure that came
 * apart, or a large label) when too many were.
 */
function explain(sliced: Sliced, count: number): string[] {
  const problems: string[] = [];
  const { grid, figures } = sliced;
  if (grid && figures.length < count) {
    for (let k = 0; k < Math.min(count, grid.rows * grid.columns); k++) {
      const row = Math.floor(k / grid.columns);
      const column = k % grid.columns;
      const reason = sliced.empty.get(cellKey(row, column));
      if (reason !== undefined) {
        problems.push(`no figure in the cell at row ${row + 1}, column ${column + 1}: ${reason}`);
      }
    }
    if (count > grid.rows * grid.columns) {
      problems.push(
        `the ${grid.columns} × ${grid.rows} grid has only ${grid.rows * grid.columns} cells`,
      );
    }
  }
  const areas = figures.map((f) => f.mask.reduce((sum, v) => sum + v, 0));
  const typical = median(areas);
  figures.forEach((f, i) => {
    const ratio = (areas[i] as number) / typical;
    if (figures.length < count && ratio >= MERGED_RATIO) {
      problems.push(
        `${where(f)} is ${ratio.toFixed(1)}× the median figure's area: touching figures may have merged into it`,
      );
    }
    if (figures.length > count && ratio <= SPLIT_RATIO) {
      problems.push(
        `${where(f)} is ${ratio.toFixed(2)}× the median figure's area: it may be part of a figure that came apart, or a large label`,
      );
    }
  });
  return problems;
}

/** The sheet-wide segmentation every slicing mode starts from. */
function context(sheet: Raster, options: SliceOptions): Context {
  const tolerance = options.tolerance ?? 40;
  const whole: Box = { x: 0, y: 0, width: sheet.width, height: sheet.height };
  const hasAlpha = sheet.data.some((_, i) => i % 4 === 3 && sheet.data[i] !== 255);
  const sheetBg = estimate(sheet, hasAlpha, boxBorder(sheet, whole));
  const sheetComponents = components(
    foreground(sheet, hasAlpha, sheetBg, tolerance, whole),
    whole,
    sheet.width,
  );
  const labelFraction = options.labelFraction ?? 0.04;
  return {
    sheet,
    whole,
    hasAlpha,
    tolerance,
    labelFraction,
    padding: options.padding ?? 4,
    sheetBg,
    sheetComponents,
    cutoff: figureCutoff(sheetComponents, labelFraction),
    verdicts: new Map((options.blobs ?? []).map((b) => [b.id, b.kind])),
  };
}

/** The sheet-wide figures, the judged ones included. */
function sheetFigures(ctx: Context): Component[] {
  return ctx.sheetComponents.filter((c) => isFigure(c, ctx.cutoff, ctx.verdicts));
}

/**
 * The grid a caller gave, its rows and cell height filled in. How tall a cell is: given; else the
 * sheet's height over its rows. The rows are given, or follow from the count alone (count figures
 * in rows of `columns`), or, with neither, are the rows the figures sit in (their centres
 * clustered by height, as detectGrid does) when the figures fill that many rows one per cell and
 * that cut leaves them whole, else square cells when those leave them whole. Whatever the
 * figures' centres say, a cut is judged on the cut itself (gridFit): a count whose cells hold two
 * whole figures, or whose edges cut through most of the figures, is refused; with no count and no
 * cut that holds, the sheet is refused and the count asked for, never cut into half-figures.
 */
function givenGrid(ctx: Context, options: SliceOptions & { grid: object }): GridSpec {
  const { sheet } = ctx;
  const { columns } = options.grid;
  const cellWidth = options.grid.cellWidth ?? Math.floor(sheet.width / columns);
  const origin = options.grid.origin ?? { x: 0, y: 0 };
  const height = sheet.height - origin.y;
  const figures = sheetFigures(ctx);
  const cut = (rows: number): GridSpec => ({
    columns,
    rows,
    cell: { width: cellWidth, height: Math.floor(height / rows) },
    origin,
  });
  if (options.grid.rows !== undefined || options.grid.cellHeight !== undefined) {
    const cellHeight = options.grid.cellHeight ?? Math.floor(height / (options.grid.rows ?? 1));
    return {
      columns,
      rows: options.grid.rows ?? Math.ceil(height / cellHeight),
      cell: { width: cellWidth, height: cellHeight },
      origin,
    };
  }
  if (options.count !== undefined) {
    const rows = Math.max(1, Math.ceil(options.count / columns));
    const grid = cut(rows);
    const fit = gridFit(sheet.width, figures, grid);
    const problems: string[] = [];
    if (fit.crowded.length > 0)
      problems.push(
        `${fit.crowded.length} cell${fit.crowded.length === 1 ? "" : "s"} of ${columns} × ${rows} hold two or more whole figures (${fit.crowded.slice(0, 3).join("; ")}${fit.crowded.length > 3 ? "; …" : ""}), so the sheet holds more than ${options.count}`,
      );
    if (fit.slicedShare > 0.5)
      problems.push(
        `${options.count} figures in rows of ${columns} make cells ${grid.cell.height} px tall, whose edges cut through ${Math.round(fit.slicedShare * 100)}% of the figures' area, so the sheet holds fewer`,
      );
    if (problems.length > 0) {
      const sliced = sliceGivenGrid(ctx, grid);
      throw new SliceError(sliced.figures.length, options.count, problems);
    }
    return grid;
  }
  const clustered = figureRows(wholeFigures(figures));
  const candidates: number[] = [];
  if (clustered !== undefined) {
    const whole = wholeFigures(figures).length;
    if (whole > columns * (clustered - 1) && whole <= columns * clustered)
      candidates.push(clustered);
  }
  candidates.push(Math.max(1, Math.ceil(height / Math.min(cellWidth, height))));
  const chosen = candidates.map(cut).find((g) => {
    const fit = gridFit(sheet.width, figures, g);
    return fit.slicedShare <= 0.5 && fit.crowded.length === 0;
  });
  if (!chosen)
    throw new InputError(
      `a grid of ${columns} columns alone does not say how tall a cell is on this sheet: ` +
        `neither the rows the figures sit in nor square cells hold them one whole figure per cell; ` +
        `give the frame count (--frames) so the rows follow from it`,
    );
  return chosen;
}

/**
 * Slices a sheet into its figures. With `options.count`, a sheet that does not hold exactly that
 * many figures is refused with a SliceError that names the cells or figures behind the
 * difference, so a short or long strip is never returned silently.
 */
export function sliceSheet(sheet: Raster, options: SliceOptions = {}): SliceResult {
  const ctx = context(sheet, options);
  let sliced: Sliced;
  if (options.grid) {
    sliced = sliceGivenGrid(ctx, givenGrid(ctx, { ...options, grid: options.grid }));
  } else {
    const grid = options.components ? undefined : detectGrid(sheet, sheetFigures(ctx));
    sliced = grid ? sliceDetectedGrid(ctx, grid) : sliceComponents(ctx);
  }
  if (options.count !== undefined && sliced.figures.length !== options.count) {
    throw new SliceError(sliced.figures.length, options.count, explain(sliced, options.count));
  }
  return {
    mode: sliced.mode,
    ...(sliced.grid !== undefined && { grid: sliced.grid }),
    background: sliced.background,
    figures: sliced.figures,
  };
}

/**
 * A blob slicing cannot tell by its area: one the `sheet-blob` decision is asked about. Its
 * components are under the figure cutoff and either at or over the label fraction of the largest
 * component (a crouched frame, a small companion, a large label), or outside every figure's box
 * (a tail segment, a dust puff, a thrown prop, a label, a speck). Ambiguous components close to
 * each other are one blob, so the letters of one label are asked about once.
 */
export interface AmbiguousBlob {
  /** The ids (`x,y,WxH`) of the blob's components; a verdict applies to each. */
  ids: string[];
  /** The blob's box on the sheet. */
  box: Box;
  /** Its opaque area in px. */
  area: number;
  /** The crop of the sheet it is shown in: its grid cell, else it and the nearest figure. */
  crop: Box;
  /** The largest figure's area beside it, for the question. */
  figureArea: number;
}

function gapBetween(a: Box, b: Box): number {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.max(dx, dy);
}

/** The parts under `cutoff` that are at least `least` px, or outside every figure's box. */
function ambiguousIn(parts: Component[], cutoff: number, least: number): Component[] {
  const figures = parts.filter((c) => c.pixels.length >= cutoff);
  return parts.filter(
    (c) =>
      c.pixels.length < cutoff &&
      (c.pixels.length >= least || !figures.some((f) => inside(c.box, f.box, 2))),
  );
}

/**
 * The blobs on a sheet that its areas leave ambiguous, largest first, with the crop each is shown
 * in. A clean sheet (every component a figure, or a part inside a figure's box) has none. Slicing
 * an ambiguous blob with no verdict keeps the area rule.
 */
export function ambiguousBlobs(sheet: Raster, options: SliceOptions = {}): AmbiguousBlob[] {
  const ctx = context(sheet, { ...options, blobs: [] });
  let grid: GridSpec | undefined;
  let candidates: Component[];
  let figures: Component[];
  if (options.grid) {
    try {
      grid = givenGrid(ctx, { ...options, grid: options.grid });
    } catch {
      return [];
    }
    const cells: Component[][] = [];
    for (let row = 0; row < grid.rows; row++) {
      for (let column = 0; column < grid.columns; column++) {
        const box = cellBoxOf(grid, row, column, ctx.whole);
        if (box.width === 0 || box.height === 0) continue;
        const bg = estimate(sheet, ctx.hasAlpha, boxBorder(sheet, box));
        cells.push(
          components(foreground(sheet, ctx.hasAlpha, bg, ctx.tolerance, box), box, sheet.width),
        );
      }
    }
    // As sliceGivenGrid decides: one cutoff over every cell's parts, figure boxes per cell.
    const all = cells.flat();
    const cutoff = figureCutoff(all, ctx.labelFraction);
    const least = ctx.labelFraction * Math.max(0, ...all.map((p) => p.pixels.length));
    figures = all.filter((c) => c.pixels.length >= cutoff);
    candidates = cells.flatMap((parts) => ambiguousIn(parts, cutoff, least));
  } else {
    figures = sheetFigures(ctx);
    const largest = Math.max(0, ...ctx.sheetComponents.map((p) => p.pixels.length));
    candidates = ambiguousIn(ctx.sheetComponents, ctx.cutoff, ctx.labelFraction * largest);
    if (!options.components) grid = detectGrid(sheet, figures);
  }
  if (candidates.length === 0) return [];

  // Group close candidates: within 5% of the median figure's height, at least 2 px.
  const gap = Math.max(2, Math.round(0.05 * median(figures.map((f) => f.box.height))));
  const group = candidates.map((_, i) => i);
  const root = (i: number): number => {
    while (group[i] !== i) i = group[i] = group[group[i] as number] as number;
    return i;
  };
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (gapBetween((candidates[i] as Component).box, (candidates[j] as Component).box) <= gap)
        group[root(i)] = root(j);
    }
  }
  const groups = new Map<number, Component[]>();
  candidates.forEach((c, i) => {
    const r = root(i);
    groups.set(r, [...(groups.get(r) ?? []), c]);
  });

  const figureHeight = median(figures.map((f) => f.box.height)) || sheet.height;
  const blobs = [...groups.values()].map((members): AmbiguousBlob => {
    const box = unionBox(members.map((m) => m.box));
    const host = nearest(figures, { pixels: [], box });
    let crop: Box;
    if (grid) {
      const c = centre(box);
      const row = Math.floor((c.y - grid.origin.y) / grid.cell.height);
      const column = Math.floor((c.x - grid.origin.x) / grid.cell.width);
      crop = unionBox([cellBoxOf(grid, row, column, ctx.whole), box]);
    } else {
      const pad = Math.round(0.25 * figureHeight);
      const span = unionBox(host ? [box, host.box] : [box]);
      crop = {
        x: span.x - pad,
        y: span.y - pad,
        width: span.width + 2 * pad,
        height: span.height + 2 * pad,
      };
    }
    crop = clipBox(crop, ctx.whole);
    if (crop.width === 0 || crop.height === 0) crop = box;
    return {
      ids: members.map(blobId),
      box,
      area: members.reduce((sum, m) => sum + m.pixels.length, 0),
      crop,
      figureArea: Math.max(0, ...figures.map((f) => f.pixels.length)),
    };
  });
  return blobs.sort((a, b) => b.area - a.area || a.box.y - b.box.y || a.box.x - b.box.x);
}

/**
 * The whole image as one figure, for matting an image that was not sliced (generated or hand-made).
 * Every pixel farther than `tolerance` from the border's median colour (or, on a transparent
 * border, every pixel at alpha 128 or more) is the figure's: no component is dropped as a label or
 * speck, so small detached parts of an author's image are kept.
 */
export function wholeImageFigure(image: Raster, tolerance = 40): SlicedFigure {
  const whole: Box = { x: 0, y: 0, width: image.width, height: image.height };
  const hasAlpha = image.data.some((_, i) => i % 4 === 3 && image.data[i] !== 255);
  const bg = estimate(image, hasAlpha, boxBorder(image, whole));
  return {
    id: 1,
    cell: { row: 0, column: 0, box: whole },
    box: whole,
    crop: image,
    mask: foreground(image, hasAlpha, bg, tolerance, whole),
    background: bg.colour,
    transforms: [],
  };
}
