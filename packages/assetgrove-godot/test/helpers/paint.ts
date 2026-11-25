/**
 * The paint test's map. Godot's terrain painting (`set_cells_terrain_connect`) paints a cell's
 * centre: with a corner-16 TileSet whose only upper-centred tile is tile 15, a painted cell becomes
 * all upper, and every corner it touches is upper. So the painted map's corners are upper exactly
 * where a painted cell touches them, and each cell is the tile whose corner bits those give.
 *
 * A neighbour pair is two tiles side by side (horizontal) or one above the other (vertical) whose
 * shared corners agree. It is legal when painting can make it: every upper corner of the pair
 * belongs to a cell that can be all upper, one whose corners inside the pair are all upper. The
 * map holds every legal pair, each in a block of its own on a lower background: the pair's two
 * cells and the ring of cells around them, each painted when its corners inside the pair are all
 * upper.
 */
import { CORNER_BITS } from "../../src/tile-set.ts";

export type Orientation = "horizontal" | "vertical";
/** The cells of a pair's block, as `[x, y]`, and its corner grid's size in corners. */
const BLOCK = 6;
const WINDOW: Record<Orientation, { columns: number; rows: number }> = {
  horizontal: { columns: 3, rows: 2 },
  vertical: { columns: 2, rows: 3 },
};

/** The corner-16 index of a cell whose corners `(x, y)`.. `(x + 1, y + 1)` `upper` says. */
export function tileOf(upper: (x: number, y: number) => boolean, x: number, y: number): number {
  return (
    (upper(x, y) ? CORNER_BITS.nw : 0) |
    (upper(x + 1, y) ? CORNER_BITS.ne : 0) |
    (upper(x, y + 1) ? CORNER_BITS.sw : 0) |
    (upper(x + 1, y + 1) ? CORNER_BITS.se : 0)
  );
}

/** The two tiles of a pair, first the left or upper one. */
export type Pair = [number, number];

const key = (orientation: Orientation, [a, b]: Pair) => `${orientation} ${a} ${b}`;

/**
 * Every legal pair, by enumeration over every pair of tiles: the shared corners agree, and each
 * upper corner of the pair has, among the four cells around it, one whose corners inside the pair
 * are all upper.
 */
export function legalPairs(): Set<string> {
  const pairs = new Set<string>();
  for (const orientation of ["horizontal", "vertical"] as const) {
    const { columns, rows } = WINDOW[orientation];
    for (let a = 0; a < 16; a++)
      for (let b = 0; b < 16; b++) {
        const corners = new Map<string, boolean>();
        const put = (tile: number, ox: number, oy: number) => {
          for (const [corner, bit] of Object.entries(CORNER_BITS)) {
            const x = ox + (corner.endsWith("e") ? 1 : 0);
            const y = oy + (corner.startsWith("s") ? 1 : 0);
            const value = (tile & bit) !== 0;
            const was = corners.get(`${x},${y}`);
            if (was !== undefined && was !== value) return false;
            corners.set(`${x},${y}`, value);
          }
          return true;
        };
        if (
          !put(a, 0, 0) ||
          !put(b, orientation === "horizontal" ? 1 : 0, orientation === "vertical" ? 1 : 0)
        )
          continue;
        const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < columns && y < rows;
        const cellUpper = (cx: number, cy: number) =>
          [
            [cx, cy],
            [cx + 1, cy],
            [cx, cy + 1],
            [cx + 1, cy + 1],
          ].every(([x, y]) => !inside(x!, y!) || corners.get(`${x},${y}`) === true);
        let legal = true;
        for (const [at, value] of corners) {
          if (!value) continue;
          const [x, y] = at.split(",").map(Number) as [number, number];
          if (
            ![
              cellUpper(x - 1, y - 1),
              cellUpper(x, y - 1),
              cellUpper(x - 1, y),
              cellUpper(x, y),
            ].some(Boolean)
          )
            legal = false;
        }
        if (legal) pairs.add(key(orientation, [a, b]));
      }
  }
  return pairs;
}

export interface PaintMap {
  width: number;
  height: number;
  /** The cells Godot paints with the upper terrain, `[x, y]`. */
  painted: Array<[number, number]>;
  /** The tile index each cell must be, row by row. */
  expected: number[][];
}

/** The map: one block per legal pair, 16 blocks to a row, each `BLOCK` cells square. */
export function paintMap(): PaintMap {
  const pairs = [...legalPairs()].map((k) => {
    const [orientation, a, b] = k.split(" ");
    return { orientation: orientation as Orientation, pair: [Number(a), Number(b)] as Pair };
  });
  const width = 16 * BLOCK;
  const height = Math.ceil(pairs.length / 16) * BLOCK;
  const painted: Array<[number, number]> = [];
  pairs.forEach(({ orientation, pair }, n) => {
    const { columns, rows } = WINDOW[orientation];
    // The pair's corner grid sits at corner (2, 2) of its block; its corners' labels:
    const ox = (n % 16) * BLOCK + 2;
    const oy = Math.floor(n / 16) * BLOCK + 2;
    const second = orientation === "horizontal" ? [1, 0] : [0, 1];
    const label = (x: number, y: number): boolean => {
      for (const [tile, tx, ty] of [
        [pair[0], 0, 0],
        [pair[1], second[0]!, second[1]!],
      ] as const)
        for (const [corner, bit] of Object.entries(CORNER_BITS)) {
          const cx = tx + (corner.endsWith("e") ? 1 : 0);
          const cy = ty + (corner.startsWith("s") ? 1 : 0);
          if (cx === x && cy === y) return (tile & bit) !== 0;
        }
      return false;
    };
    // Each cell touching the pair's corners is painted when its corners inside the pair are upper.
    for (let cy = -1; cy < rows; cy++)
      for (let cx = -1; cx < columns; cx++) {
        const inside = [
          [cx, cy],
          [cx + 1, cy],
          [cx, cy + 1],
          [cx + 1, cy + 1],
        ].filter(([x, y]) => x! >= 0 && y! >= 0 && x! < columns && y! < rows);
        if (inside.length > 0 && inside.every(([x, y]) => label(x!, y!)))
          painted.push([ox + cx, oy + cy]);
      }
  });
  const isPainted = new Set(painted.map(([x, y]) => `${x},${y}`));
  const upper = (x: number, y: number) =>
    [
      [x - 1, y - 1],
      [x, y - 1],
      [x - 1, y],
      [x, y],
    ].some(([cx, cy]) => isPainted.has(`${cx},${cy}`));
  const expected = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => tileOf(upper, x, y)),
  );
  return { width, height, painted, expected };
}

/** The legal pairs a map of tile indices holds. */
export function pairsIn(map: number[][]): Set<string> {
  const pairs = new Set<string>();
  for (let y = 0; y < map.length; y++)
    for (let x = 0; x < map[y]!.length; x++) {
      const tile = map[y]![x]!;
      if (x + 1 < map[y]!.length) pairs.add(key("horizontal", [tile, map[y]![x + 1]!]));
      if (y + 1 < map.length) pairs.add(key("vertical", [tile, map[y + 1]![x]!]));
    }
  return pairs;
}
