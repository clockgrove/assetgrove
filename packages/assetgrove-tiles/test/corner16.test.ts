/** The corner-16 arithmetic: the cell table, cell boxes, the template atlas and the class vote. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CORNER16_TABLE,
  atlasSide,
  cellBox,
  cellName,
  classMismatches,
  emptyCells,
  strip,
  templateAtlas,
} from "../src/corner16.ts";
import type { Pixels } from "../src/corner16.ts";
import { LOWER, UPPER, templateSet, withPixel } from "./helpers/tiles.ts";
import { flatTexture } from "../src/kind.ts";

const pixel = (image: Pixels, x: number, y: number) => [
  ...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
];

test("the cell table has 16 cells in index order with corner bits NW 1, NE 2, SW 4, SE 8", () => {
  assert.equal(CORNER16_TABLE.length, 16);
  CORNER16_TABLE.forEach((cell, i) => assert.equal(cell.index, i));
  assert.deepEqual(CORNER16_TABLE[0]?.corners, { nw: "L", ne: "L", sw: "L", se: "L" });
  assert.deepEqual(CORNER16_TABLE[5], {
    index: 5,
    column: 1,
    row: 1,
    corners: { nw: "U", ne: "L", sw: "U", se: "L" },
  });
  assert.deepEqual(CORNER16_TABLE[15]?.corners, { nw: "U", ne: "U", sw: "U", se: "U" });
  assert.deepEqual(CORNER16_TABLE[8]?.corners, { nw: "L", ne: "L", sw: "L", se: "U" });
  assert.deepEqual([CORNER16_TABLE[7]?.column, CORNER16_TABLE[7]?.row], [3, 1]);
  assert.deepEqual([CORNER16_TABLE[12]?.column, CORNER16_TABLE[12]?.row], [0, 3]);
});

test("a cell's box and name follow its column and row", () => {
  assert.deepEqual(cellBox(0, 16), { x: 0, y: 0, width: 16, height: 16 });
  assert.deepEqual(cellBox(6, 16), { x: 32, y: 16, width: 16, height: 16 });
  assert.deepEqual(cellBox(15, 8), { x: 24, y: 24, width: 8, height: 8 });
  assert.equal(cellName(5), "tile 5 (column 1, row 1)");
  assert.equal(atlasSide(16), 64);
});

test("the template atlas copies each quadrant from the lower or the upper texture", () => {
  const atlas = templateSet(8);
  assert.equal(atlas.width, 32);
  assert.equal(atlas.height, 32);
  const colour = (index: number, qx: number, qy: number) => {
    const { x, y } = cellBox(index, 8);
    return pixel(atlas, x + qx, y + qy);
  };
  // Tile 5: NW U, NE L, SW U, SE L.
  assert.deepEqual(colour(5, 0, 0), [...UPPER]);
  assert.deepEqual(colour(5, 7, 0), [...LOWER]);
  assert.deepEqual(colour(5, 0, 7), [...UPPER]);
  assert.deepEqual(colour(5, 7, 7), [...LOWER]);
  assert.deepEqual(colour(5, 3, 3), [...UPPER]);
  assert.deepEqual(colour(5, 4, 3), [...LOWER]);
  assert.deepEqual(colour(0, 5, 5), [...LOWER]);
  assert.deepEqual(colour(15, 5, 5), [...UPPER]);
  assert.deepEqual(classMismatches(atlas, 8), []);
});

test("the template atlas refuses textures of different sizes", () => {
  assert.throws(
    () => templateAtlas(flatTexture(8, LOWER), flatTexture(4, UPPER)),
    /must both be 8 × 8, not 8 × 8 and 4 × 4/,
  );
});

test("a middle pixel of one strip is that tile's one mismatch, in one pixel", () => {
  const wrong = withPixel(templateSet(8), 8 + 3, 8, [1, 2, 3, 255]);
  assert.deepEqual(classMismatches(wrong, 8), [{ index: 5, side: "north", pair: "UL", pixels: 1 }]);
});

test("a tied class keeps the strip the lowest index holds", () => {
  // The north strips of tiles 0, 4, 8 and 12 are one class (LL). Tiles 0 and 4 get a different
  // pixel, so two strips each: the group holding tile 0 is kept and 8 and 12 are named.
  let atlas = templateSet(8);
  for (const index of [0, 4]) {
    const { x, y } = cellBox(index, 8);
    atlas = withPixel(atlas, x + 3, y, [9, 9, 9, 255]);
  }
  assert.deepEqual(classMismatches(atlas, 8), [
    { index: 8, side: "north", pair: "LL", pixels: 1 },
    { index: 12, side: "north", pair: "LL", pixels: 1 },
  ]);
});

test("empty cells are those with no pixel at or above the alpha threshold", () => {
  const atlas = templateSet(8);
  const { x, y } = cellBox(9, 8);
  for (let py = y; py < y + 8; py++)
    for (let px = x; px < x + 8; px++) atlas.data[(py * atlas.width + px) * 4 + 3] = 0;
  assert.deepEqual(emptyCells(atlas, 8, 1), [9]);
  assert.deepEqual(emptyCells(templateSet(8), 8, 1), []);
  assert.equal(strip(atlas, 8, 0, "north").length, 32);
});
