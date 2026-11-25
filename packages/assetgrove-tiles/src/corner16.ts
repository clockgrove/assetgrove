/**
 * The corner-16 layout: 16 tiles on a fixed 4 × 4 cell table, each tile encoding a label on each of
 * its four corners, `L` (the lower terrain) or `U` (the upper). Tile `i` has corner bits
 * NW = 1, NE = 2, SW = 4, SE = 8 (set for `U`) and sits at column `i % 4`, row `floor(i / 4)`,
 * origin top-left. Pure arithmetic over RGBA bytes, so it needs nothing from core.
 */

export const CORNER16_LAYOUT = "corner-16";
export const COLUMNS = 4;
export const TILE_COUNT = 16;

/** A corner's label: the lower or the upper terrain. */
export type Label = "L" | "U";

export interface Corners {
  nw: Label;
  ne: Label;
  sw: Label;
  se: Label;
}

export type Side = "north" | "south" | "west" | "east";
export const SIDES: readonly Side[] = ["north", "south", "west", "east"];

/** An 8-bit RGBA image, row-major (core's `Raster`). */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Cell {
  index: number;
  column: number;
  row: number;
  corners: Corners;
}

/** The corner labels of tile `index` (0..15). */
export function cornersOf(index: number): Corners {
  const at = (bit: number): Label => ((index & bit) !== 0 ? "U" : "L");
  return { nw: at(1), ne: at(2), sw: at(4), se: at(8) };
}

/** The fixed cell table, in index order. */
export const CORNER16_TABLE: readonly Cell[] = Array.from({ length: TILE_COUNT }, (_, index) => ({
  index,
  column: index % COLUMNS,
  row: Math.floor(index / COLUMNS),
  corners: cornersOf(index),
}));

/** A cell's pixel box in an atlas of `tileSize` tiles. */
export function cellBox(
  index: number,
  tileSize: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: (index % COLUMNS) * tileSize,
    y: Math.floor(index / COLUMNS) * tileSize,
    width: tileSize,
    height: tileSize,
  };
}

/** How a cell is named in a reason: `tile 5 (column 1, row 1)`. */
export function cellName(index: number): string {
  return `tile ${index} (column ${index % COLUMNS}, row ${Math.floor(index / COLUMNS)})`;
}

/** A side's corner-label pair, read along the side: north NW NE, south SW SE, west NW SW, east NE SE. */
export function sidePair(corners: Corners, side: Side): string {
  switch (side) {
    case "north":
      return corners.nw + corners.ne;
    case "south":
      return corners.sw + corners.se;
    case "west":
      return corners.nw + corners.sw;
    case "east":
      return corners.ne + corners.se;
  }
}

/** The outermost 1-px row or column of tile `index` on `side`, as RGBA bytes along the side. */
export function strip(image: Pixels, tileSize: number, index: number, side: Side): Uint8Array {
  const { x, y } = cellBox(index, tileSize);
  const out = new Uint8Array(tileSize * 4);
  for (let i = 0; i < tileSize; i++) {
    const [px, py] =
      side === "north"
        ? [x + i, y]
        : side === "south"
          ? [x + i, y + tileSize - 1]
          : side === "west"
            ? [x, y + i]
            : [x + tileSize - 1, y + i];
    const from = (py * image.width + px) * 4;
    out.set(image.data.subarray(from, from + 4), i * 4);
  }
  return out;
}

/** The atlas side for `tileSize` tiles. */
export const atlasSide = (tileSize: number): number => COLUMNS * tileSize;

/** Whether the image is exactly 4 × 4 tiles of `tileSize`. */
export const isAtlasSize = (image: Pixels, tileSize: number): boolean =>
  image.width === atlasSide(tileSize) && image.height === atlasSide(tileSize);

/** The cells (in index order) with no pixel whose alpha is at least `threshold`. */
export function emptyCells(image: Pixels, tileSize: number, threshold: number): number[] {
  const empty: number[] = [];
  for (const { index } of CORNER16_TABLE) {
    const { x, y } = cellBox(index, tileSize);
    let drawn = false;
    for (let py = y; py < y + tileSize && !drawn; py++)
      for (let px = x; px < x + tileSize; px++)
        if ((image.data[(py * image.width + px) * 4 + 3] ?? 0) >= threshold) {
          drawn = true;
          break;
        }
    if (!drawn) empty.push(index);
  }
  return empty;
}

/** A tile whose strip on `side` differs from its class's strip. */
export interface StripMismatch {
  index: number;
  side: Side;
  /** The side's corner-label pair, which with the side names the class. */
  pair: string;
  /** How many of the strip's pixels differ from the class's strip. */
  pixels: number;
}

/**
 * Within each (side, corner-label pair) class, the tiles whose outermost strip on that side is not
 * the class's strip. The class's strip is the one most of its tiles share (on a tie, the one the
 * lowest index holds), so one wrong strip names its own tile. In index order, then side order.
 */
export function classMismatches(image: Pixels, tileSize: number): StripMismatch[] {
  const mismatches: StripMismatch[] = [];
  for (const side of SIDES) {
    const classes = new Map<string, number[]>();
    for (const { index, corners } of CORNER16_TABLE) {
      const pair = sidePair(corners, side);
      classes.set(pair, [...(classes.get(pair) ?? []), index]);
    }
    for (const [pair, members] of classes) {
      const strips = new Map(members.map((i) => [i, strip(image, tileSize, i, side)]));
      const groups = new Map<string, number[]>();
      for (const [i, bytes] of strips) {
        const key = Buffer.from(bytes).toString("base64");
        groups.set(key, [...(groups.get(key) ?? []), i]);
      }
      // Map order is first-seen, so on a tie the group holding the lowest index comes first.
      const [kept] = [...groups.values()].sort((a, b) => b.length - a.length);
      const reference = strips.get(kept![0]!)!;
      for (const i of members) {
        if (kept!.includes(i)) continue;
        const bytes = strips.get(i)!;
        let pixels = 0;
        for (let p = 0; p < tileSize; p++)
          if (bytes.subarray(p * 4, p * 4 + 4).some((b, c) => b !== reference[p * 4 + c])) pixels++;
        mismatches.push({ index: i, side, pair, pixels });
      }
    }
  }
  return mismatches.sort(
    (a, b) => a.index - b.index || SIDES.indexOf(a.side) - SIDES.indexOf(b.side),
  );
}

/**
 * The template-built set: each tile's four quadrants copied from the lower or the upper terrain
 * texture by its corner labels, split at `floor(tileSize / 2)`. Both textures are `tileSize` square.
 */
export function templateAtlas(lower: Pixels, upper: Pixels): Pixels {
  const tileSize = lower.width;
  if (lower.height !== tileSize || upper.width !== tileSize || upper.height !== tileSize)
    throw new Error(
      `the terrain textures must both be ${tileSize} × ${tileSize}, not ${lower.width} × ${lower.height} and ${upper.width} × ${upper.height}`,
    );
  const side = atlasSide(tileSize);
  const out: Pixels = { width: side, height: side, data: new Uint8Array(side * side * 4) };
  const half = Math.floor(tileSize / 2);
  for (const { index, corners } of CORNER16_TABLE) {
    const { x, y } = cellBox(index, tileSize);
    for (let ty = 0; ty < tileSize; ty++)
      for (let tx = 0; tx < tileSize; tx++) {
        const label =
          ty < half ? (tx < half ? corners.nw : corners.ne) : tx < half ? corners.sw : corners.se;
        const texture = label === "U" ? upper : lower;
        const from = (ty * tileSize + tx) * 4;
        out.data.set(texture.data.subarray(from, from + 4), ((y + ty) * side + x + tx) * 4);
      }
  }
  return out;
}
