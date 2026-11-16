import assert from "node:assert/strict";
import { test } from "node:test";
import { createRaster } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { SliceError, sliceSheet } from "../src/sheet/slice.ts";
import type { SliceResult } from "../src/sheet/types.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import type { SyntheticSheet } from "./fixtures/sheet.ts";

function checkOrder(result: SliceResult, sheet: SyntheticSheet): void {
  assert.equal(result.figures.length, sheet.figures.length);
  result.figures.forEach((figure, i) => {
    const truth = sheet.figures[i];
    assert.ok(truth);
    assert.equal(figure.id, truth.id);
    assert.equal(figure.cell.row, truth.row);
    assert.equal(figure.cell.column, truth.column);
    // The figure sits where the fixture drew it: its box lies within the truth slot.
    const cx = figure.box.x + figure.box.width / 2;
    const cy = figure.box.y + figure.box.height / 2;
    assert.ok(cx > truth.cellBox.x && cx < truth.cellBox.x + truth.cellBox.width);
    assert.ok(cy > truth.cellBox.y && cy < truth.cellBox.y + truth.cellBox.height);
  });
}

function checkMasks(result: SliceResult, sheet: SyntheticSheet): void {
  const width = sheet.raster.width;
  const height = sheet.raster.height;
  const alphaNear = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && sheet.alpha[ny * width + nx]) {
          return true;
        }
      }
    }
    return false;
  };
  result.figures.forEach((figure, i) => {
    const truth = sheet.figures[i];
    assert.ok(truth);
    assert.equal(figure.mask.length, figure.crop.width * figure.crop.height);
    assert.deepEqual(figure.crop.width, figure.box.width);
    for (let y = 0; y < figure.box.height; y++) {
      for (let x = 0; x < figure.box.width; x++) {
        const sx = figure.box.x + x;
        const sy = figure.box.y + y;
        const masked = figure.mask[y * figure.box.width + x] === 1;
        const label = truth.labelBox;
        const inLabel =
          sx >= label.x &&
          sx < label.x + label.width &&
          sy >= label.y &&
          sy < label.y + label.height;
        if (inLabel) assert.equal(masked, false, `figure ${figure.id} masks a label pixel`);
        if (masked) assert.ok(alphaNear(sx, sy), `figure ${figure.id} masks background`);
      }
    }
    // Nothing of the figure is lost: every solid truth pixel is in the crop and masked. The palest
    // half-covered edge pixels (alpha 128..159) blend to within the colour tolerance of the
    // background, so up to 2% of the figure's solid pixels may miss there; none above that.
    const bx = truth.cellBox;
    let solid = 0;
    let missed = 0;
    for (let y = bx.y; y < bx.y + bx.height; y++) {
      for (let x = bx.x; x < bx.x + bx.width; x++) {
        const alpha = sheet.alpha[y * width + x] ?? 0;
        if (alpha < 128) continue;
        solid++;
        const cx = x - figure.box.x;
        const cy = y - figure.box.y;
        const inCrop = cx >= 0 && cy >= 0 && cx < figure.box.width && cy < figure.box.height;
        assert.ok(inCrop, `figure ${figure.id} extends outside its crop`);
        if (figure.mask[cy * figure.box.width + cx] !== 1) {
          missed++;
          assert.ok(alpha < 160, `figure ${figure.id} lost a solid pixel`);
        }
      }
    }
    assert.ok(missed <= 0.02 * solid, `figure ${figure.id} lost ${missed} of ${solid}`);
  });
}

test("a contiguous grid is detected and sliced in reading order", () => {
  const sheet = syntheticSheet();
  const result = sliceSheet(sheet.raster);
  assert.equal(result.mode, "grid");
  assert.equal(result.grid?.columns, 8);
  assert.equal(result.grid?.rows, 2);
  assert.deepEqual(result.grid?.cell, { width: 64, height: 64 });
  checkOrder(result, sheet);
  checkMasks(result, sheet);
});

test("an explicit grid gives the same slicing", () => {
  const sheet = syntheticSheet();
  const detected = sliceSheet(sheet.raster);
  const explicit = sliceSheet(sheet.raster, { grid: { columns: 8 } });
  assert.equal(explicit.mode, "grid");
  assert.equal(explicit.grid?.rows, 2);
  checkOrder(explicit, sheet);
  checkMasks(explicit, sheet);
  assert.deepEqual(
    explicit.figures.map((f) => [f.box, f.mask]),
    detected.figures.map((f) => [f.box, f.mask]),
  );
});

test("a scattered sheet is sliced by locating each figure", () => {
  const sheet = syntheticSheet({ layout: "scatter" });
  const result = sliceSheet(sheet.raster);
  assert.equal(result.mode, "components");
  assert.equal(result.grid, undefined);
  checkOrder(result, sheet);
  checkMasks(result, sheet);
  for (const figure of result.figures) {
    assert.ok(figure.transforms.some((t) => t.op === "crop"));
    assert.ok(figure.transforms.some((t) => t.op === "strip-labels"));
  }
});

test("components mode can be forced on a grid sheet", () => {
  const sheet = syntheticSheet();
  const result = sliceSheet(sheet.raster, { components: true });
  assert.equal(result.mode, "components");
  checkOrder(result, sheet);
  checkMasks(result, sheet);
});

test("a sheet with a transparent background slices too", () => {
  const sheet = syntheticSheet();
  const raster: Raster = createRaster(sheet.raster.width, sheet.raster.height);
  raster.data.set(sheet.raster.data);
  const width = raster.width;
  for (const figure of sheet.figures) {
    const l = figure.labelBox;
    for (let y = l.y; y < l.y + l.height; y++) {
      for (let x = l.x; x < l.x + l.width; x++) {
        const i = (y * width + x) * 4;
        const d = Math.hypot(
          (raster.data[i] as number) - sheet.background[0],
          (raster.data[i + 1] as number) - sheet.background[1],
          (raster.data[i + 2] as number) - sheet.background[2],
        );
        if (d > 40) raster.data[i + 3] = 255;
        else raster.data[i + 3] = sheet.alpha[y * width + x] ?? 0;
      }
    }
  }
  for (let p = 0; p < width * raster.height; p++) {
    const inLabel = raster.data[p * 4 + 3] === 255 && sheet.alpha[p] === 0;
    if (!inLabel) raster.data[p * 4 + 3] = sheet.alpha[p] ?? 0;
  }
  const result = sliceSheet(raster);
  assert.equal(result.mode, "grid");
  checkOrder(result, sheet);
  checkMasks(result, sheet);
});

/** A flat sheet of hard-edged ellipse figures, each with an optional tail bar to its right. */
function ellipseSheet(
  width: number,
  height: number,
  figures: Array<{ cx: number; cy: number; rx: number; ry: number; tailTo?: number }>,
): Raster {
  const raster = createRaster(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = figures.some(
        (f) =>
          ((x - f.cx) / f.rx) ** 2 + ((y - f.cy) / f.ry) ** 2 <= 1 ||
          (f.tailTo !== undefined && x >= f.cx && x < f.tailTo && Math.abs(y - f.cy) <= 3),
      );
      raster.data.set(inside ? [70, 60, 50, 255] : [230, 228, 226, 255], (y * width + x) * 4);
    }
  }
  return raster;
}

function maskArea(mask: Uint8Array): number {
  return mask.reduce((sum, v) => sum + v, 0);
}

test("a detected grid keeps the smallest figure whose tail reaches past its cell", () => {
  // 3 × 2 cells of 64 px. Figure 1 is the smallest, and its tail ends 3 px into the next cell's
  // gutter, as a painted tail does on a real sheet. Segmenting the cell again cut the tail off at
  // the cell's edge, so the figure came out under the sheet's smallest figure area, the cutoff
  // that sheet-wide segmentation had set from this same figure, and it was dropped without a word.
  type Figure = { cx: number; cy: number; rx: number; ry: number; tailTo?: number };
  const cells = [0, 1, 2, 3, 4, 5].map((k): Figure => ({
    cx: (k % 3) * 64 + 32,
    cy: Math.floor(k / 3) * 64 + 32,
    rx: 20,
    ry: 12,
  }));
  cells[0] = { cx: 40, cy: 32, rx: 16, ry: 10, tailTo: 67 };
  const result = sliceSheet(ellipseSheet(192, 128, cells));
  assert.equal(result.mode, "grid");
  assert.deepEqual(
    result.figures.map((f) => [f.cell.row, f.cell.column]),
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
    ],
  );
  const first = result.figures[0] as SliceResult["figures"][number];
  // The whole tail is in the crop and the mask, past the cell's edge at x = 64.
  assert.ok(first.box.x + first.box.width >= 67);
  const tailTip = (32 - first.box.y) * first.box.width + (66 - first.box.x);
  assert.equal(first.mask[tailTip], 1);
  // Nothing of the neighbour enters it.
  assert.equal(maskArea(first.mask) < maskArea((result.figures[1] as typeof first).mask), true);
});

test("a sheet that does not hold the count asked for is refused, naming the empty cell", () => {
  const sheet = syntheticSheet();
  // Paint out figure 11 (row 2, column 3), leaving its number label.
  const raster = createRaster(sheet.raster.width, sheet.raster.height);
  raster.data.set(sheet.raster.data);
  const gone = sheet.figures[10] as SyntheticSheet["figures"][number];
  for (let y = gone.cellBox.y + 12; y < gone.cellBox.y + gone.cellBox.height; y++) {
    for (let x = gone.cellBox.x; x < gone.cellBox.x + gone.cellBox.width; x++) {
      raster.data.set([...sheet.background, 255], (y * raster.width + x) * 4);
    }
  }
  assert.equal(sliceSheet(sheet.raster, { count: 16 }).figures.length, 16);
  assert.throws(
    () => sliceSheet(raster, { count: 16 }),
    (error: unknown) => {
      assert.ok(error instanceof SliceError);
      assert.equal(error.found, 15);
      assert.equal(error.expected, 16);
      assert.equal(error.problems.length, 1);
      assert.match(error.problems[0] as string, /row 2, column 3: its largest part is \d+ px/);
      assert.match(error.message, /found 15 figures on the sheet where 16 are asked for/);
      return true;
    },
  );
  // Without a count the same sheet still slices, into 15 frames.
  assert.equal(sliceSheet(raster).figures.length, 15);
});

test("touching figures that merged into one are named when too few are found", () => {
  // Five figures in a row, the last two touching: four components, no clean grid.
  const figures = [20, 70, 120, 170, 202].map((cx) => ({ cx, cy: 30, rx: 16, ry: 12 }));
  const raster = ellipseSheet(240, 60, figures);
  assert.throws(
    () => sliceSheet(raster, { components: true, count: 5 }),
    (error: unknown) => {
      assert.ok(error instanceof SliceError);
      assert.equal(error.found, 4);
      assert.deepEqual(error.problems.length, 1);
      assert.match(
        error.problems[0] as string,
        /figure 4 \(row 1, column 4\) is \d\.\d× the median figure's area: touching figures may have merged/,
      );
      return true;
    },
  );
});

/** A sheet of `columns` × `rows` cells of cellW × cellH, each holding one tall figure. */
function tallCellSheet(columns: number, rows: number, cellW: number, cellH: number): Raster {
  const sheet = createRaster(columns * cellW, rows * cellH);
  for (let i = 0; i < sheet.data.length; i += 4) sheet.data.set([250, 250, 250, 255], i);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++)
      for (let y = Math.round(cellH * 0.1); y < Math.round(cellH * 0.9); y++)
        for (let x = Math.round(cellW * 0.3); x < Math.round(cellW * 0.7); x++)
          sheet.data.set(
            [60 + 20 * c, 40, 30 + 40 * r, 255],
            ((r * cellH + y) * sheet.width + c * cellW + x) * 4,
          );
  return sheet;
}

test("an explicit grid of columns alone takes its cell height from the count or the figures' rows", () => {
  // generate-sheet's own layout for 8 frames: 4 columns, 2 rows of cells twice as tall as wide.
  const sheet = tallCellSheet(4, 2, 64, 128);
  for (const options of [{ grid: { columns: 4 }, count: 8 }, { grid: { columns: 4 } }]) {
    const result = sliceSheet(sheet, options);
    assert.equal(result.figures.length, 8, JSON.stringify(options));
    assert.deepEqual(result.grid, {
      columns: 4,
      rows: 2,
      cell: { width: 64, height: 128 },
      origin: { x: 0, y: 0 },
    });
    // Every figure is whole: about 80% of its 128 px cell tall, never cut in half.
    for (const figure of result.figures)
      assert.ok(figure.box.height >= 100, `${figure.box.height}`);
  }
});

/** A sheet of 128 px square cells, a 40 px figure in each listed cell at the given top. */
function boxSheet(
  columns: number,
  rows: number,
  figures: Array<{ row: number; column: number; top: number; height?: number }>,
): Raster {
  const sheet = createRaster(columns * 128, rows * 128);
  for (let i = 0; i < sheet.data.length; i += 4) sheet.data.set([250, 250, 250, 255], i);
  for (const { row, column, top, height = 40 } of figures)
    for (let y = row * 128 + top; y < row * 128 + top + height; y++)
      for (let x = column * 128 + 44; x < column * 128 + 84; x++)
        sheet.data.set([60 + 20 * column, 40, 30 + 80 * row, 255], (y * sheet.width + x) * 4);
  return sheet;
}

const cells = (columns: number, rows: number) =>
  Array.from({ length: columns * rows }, (_, i) => ({
    row: Math.floor(i / columns),
    column: i % columns,
    top: 80,
  }));

const square = (columns: number, rows: number) => ({
  columns,
  rows,
  cell: { width: 128, height: 128 },
  origin: { x: 0, y: 0 },
});

test("an explicit grid of columns alone takes its rows from a count, whatever rows the figures' centres cluster into", () => {
  // A jump: two figures of each row drawn 70 px higher, so the centres cluster into 4 rows.
  const jump = boxSheet(
    4,
    2,
    cells(4, 2).map((c) => ({ ...c, top: c.column % 2 === 1 ? 10 : 80 })),
  );
  // One raised figure in a single row: the centres cluster into 2 rows.
  const raised = boxSheet(
    4,
    1,
    cells(4, 1).map((c) => ({ ...c, top: c.column === 2 ? 10 : 80 })),
  );
  // A figure that reaches down to touch the one below it: 7 sheet-wide components.
  const touching = boxSheet(4, 2, [
    ...cells(4, 2)
      .filter((c) => !(c.row === 0 && c.column === 1))
      .map((c) => ({ ...c, top: 20, height: 96 })),
    { row: 0, column: 1, top: 20, height: 108 + 20 },
  ]);
  for (const [name, sheet, columns, rows] of [
    ["jump", jump, 4, 2],
    ["raised", raised, 4, 1],
    ["touching", touching, 4, 2],
  ] as const) {
    for (const options of [{ grid: { columns }, count: columns * rows }, { grid: { columns } }]) {
      const result = sliceSheet(sheet, options);
      const label = `${name} ${JSON.stringify(options)}`;
      assert.equal(result.figures.length, columns * rows, label);
      // With a count the rows come from it; without one, figures that do not fill their clustered
      // rows one per cell fall back to square cells, never a silent cut into thin rows.
      assert.deepEqual(result.grid, square(columns, rows), label);
      result.figures.forEach((figure, i) => {
        assert.equal(figure.cell.row, Math.floor(i / columns), label);
        assert.equal(figure.cell.column, i % columns, label);
      });
    }
  }
});

test("an explicit grid of columns alone refuses a count the cells do not hold", () => {
  // 8 figures in 4 columns and 2 rows: 4 would drop a row, 12 would cut each figure into slivers.
  const sheet = tallCellSheet(4, 2, 64, 128);
  for (const [count, reason] of [
    [4, /4 cells of 4 × 1 hold two or more whole figures/],
    [12, /make cells 85 px tall, whose edges cut through 100% of the figures' area/],
  ] as const) {
    assert.throws(
      () => sliceSheet(sheet, { grid: { columns: 4 }, count }),
      (error: unknown) =>
        error instanceof SliceError && error.expected === count && reason.test(error.message),
      `count ${count}`,
    );
  }
});

/** A sheet of `width` × `height` on a pale background with the given dark rectangles. */
function rectSheet(
  width: number,
  height: number,
  rects: Array<{ x: number; y: number; w: number; h: number }>,
): Raster {
  const sheet = createRaster(width, height);
  for (let i = 0; i < sheet.data.length; i += 4) sheet.data.set([250, 250, 250, 255], i);
  rects.forEach(({ x, y, w, h }, i) => {
    for (let py = y; py < y + h; py++)
      for (let px = x; px < x + w; px++)
        sheet.data.set([40 + (i % 5) * 10, 40, 60, 255], (py * width + px) * 4);
  });
  return sheet;
}

test("an explicit grid of columns alone keeps a correct count when a cell also holds a piece of a neighbour, a prop or a touching figure", () => {
  // 4 × 2 cells of 128 px. Row 1, column 2's figure hangs 40 px into the cell below without
  // touching the figure there.
  const hanging = rectSheet(
    512,
    256,
    cells(4, 2).map(({ row, column }) =>
      row === 0 && column === 1
        ? { x: column * 128 + 4, y: 68, w: 40, h: 100 }
        : { x: column * 128 + 44, y: row * 128 + (row === 0 ? 20 : 26), w: 40, h: 100 },
    ),
  );
  // Each cell holds a figure and a detached prop of about 0.4 of its area below it.
  const props = rectSheet(
    512,
    256,
    cells(4, 2).flatMap(({ row, column }) => [
      { x: column * 128 + 44, y: row * 128 + 8, w: 40, h: 72 },
      { x: column * 128 + 44, y: row * 128 + 90, w: 40, h: 30 },
    ]),
  );
  // Three of the four columns' figures touch the one below at a 6 px foot.
  const touching = rectSheet(
    512,
    256,
    cells(4, 2).flatMap(({ row, column }) => [
      { x: column * 128 + 44, y: row * 128 + 20, w: 40, h: 96 },
      ...(row === 0 && column < 3 ? [{ x: column * 128 + 60, y: 116, w: 6, h: 32 }] : []),
    ]),
  );
  for (const [name, sheet] of [
    ["hanging", hanging],
    ["props", props],
    ["touching", touching],
  ] as const) {
    for (const options of [{ grid: { columns: 4 }, count: 8 }, { grid: { columns: 4 } }]) {
      const label = `${name} ${JSON.stringify(options)}`;
      const result = sliceSheet(sheet, options);
      assert.equal(result.figures.length, 8, label);
      assert.deepEqual(result.grid, square(4, 2), label);
    }
  }
});

test("an explicit grid of columns alone with no count refuses a sheet no cut holds whole, rather than cutting square half-figures", () => {
  // 4 × 2 cells of 128 × 256, one figure raised so the centres cluster into 3 rows: square cells
  // would cut every figure in two.
  const sheet = rectSheet(
    512,
    512,
    cells(4, 2).map(({ row, column }) => ({
      x: column * 128 + 44,
      y: row * 256 + (row === 0 && column === 2 ? 4 : 120),
      w: 40,
      h: 120,
    })),
  );
  assert.throws(
    () => sliceSheet(sheet, { grid: { columns: 4 } }),
    /does not say how tall a cell is on this sheet.*give the frame count \(--frames\)/,
  );
  const result = sliceSheet(sheet, { grid: { columns: 4 }, count: 8 });
  assert.equal(result.figures.length, 8);
  assert.deepEqual(result.grid?.cell, { width: 128, height: 256 });
});
