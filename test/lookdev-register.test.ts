import assert from "node:assert/strict";
import { test } from "node:test";
import { createRaster } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import {
  editedBackground,
  figureCrop,
  figureLuminance,
  register,
} from "../src/model3d/lookdev/command.ts";
import { measureBox } from "../src/model3d/lookdev/markings.ts";
import { speckle } from "../src/model3d/render.ts";

const SIZE = 128;
const GREY: [number, number, number] = [216, 216, 216];
const OUTLINE: [number, number, number] = [212, 214, 216];
const COAT: [number, number, number] = [120, 90, 70];

/** A body with a head on top, as a shape test: 1 inside the figure, in unit-free pixel coordinates. */
function inFigure(x: number, y: number): boolean {
  const body = x >= 40 && x < 88 && y >= 44 && y < 108;
  const head = x >= 52 && x < 76 && y >= 20 && y < 44;
  return body || head;
}

function inEdge(x: number, y: number): boolean {
  return (
    inFigure(x, y) &&
    !(inFigure(x - 2, y) && inFigure(x + 2, y) && inFigure(x, y - 2) && inFigure(x, y + 2))
  );
}

/** The render: grey ground, a coat, and an outline within 8 per channel of the ground; the depth mask is the figure. */
function render(): { raster: Raster; mask: Uint8Array } {
  const raster = createRaster(SIZE, SIZE);
  const mask = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const colour = inEdge(x, y) ? OUTLINE : inFigure(x, y) ? COAT : GREY;
      raster.data.set([...colour, 255], (y * SIZE + x) * 4);
      mask[y * SIZE + x] = inFigure(x, y) ? 1 : 0;
    }
  }
  return { raster, mask };
}

/** An edit on a white ground: the figure drawn through `place`, which maps an edit pixel to figure space. */
function edit(
  place: (x: number, y: number) => [number, number],
  colour: [number, number, number] = [70, 50, 40],
  extra?: (x: number, y: number) => boolean,
): Raster {
  const out = createRaster(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [fx, fy] = place(x, y);
      const c: [number, number, number] = inFigure(Math.floor(fx), Math.floor(fy))
        ? colour
        : extra?.(x, y)
          ? [170, 170, 170]
          : [250, 250, 250];
      out.data.set([...c, 255], (y * SIZE + x) * 4);
    }
  }
  return out;
}

const identity = (x: number, y: number): [number, number] => [x, y];

function box(mask: Uint8Array) {
  let x0 = SIZE;
  let y0 = SIZE;
  let x1 = -1;
  let y1 = -1;
  mask.forEach((m, i) => {
    if (!m) return;
    const x = i % SIZE;
    const y = Math.floor(i / SIZE);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  });
  return { x0, y0, x1, y1 };
}

function foregroundOf(image: Raster): Uint8Array {
  const bg = editedBackground(image, undefined, 24, 0);
  return bg.map((b) => (b ? 0 : 1));
}

function iou(a: Uint8Array, b: Uint8Array): number {
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) both++;
    if (a[i] || b[i]) either++;
  }
  return both / either;
}

test("a pale outline is figure by the depth mask: the registered edit lands on the full box", () => {
  const { raster, mask } = render();
  // By colour the outline reads as ground: the colour box is smaller than the mask's box.
  const colourBox = box(
    mask.map((_, i) =>
      Math.abs(raster.data[i * 4]! - 216) + 0 > 24 || raster.data[i * 4]! < 192 ? 1 : 0,
    ),
  );
  assert.ok(colourBox.x1 - colourBox.x0 < box(mask).x1 - box(mask).x0);

  // The edit draws the figure darker, at 0.8 scale, shifted.
  const edited = edit((x, y) => [(x - 64 - 9) / 0.8 + 64, (y - 64 + 6) / 0.8 + 64]);
  const { image, overlap } = register(edited, raster, mask);
  assert.ok(overlap >= 0.95, `overlap ${overlap}`);
  const fg = foregroundOf(image);
  assert.ok(iou(fg, mask) >= 0.95);
  const got = box(fg);
  const want = box(mask);
  for (const k of ["x0", "y0", "x1", "y1"] as const) {
    assert.ok(Math.abs(got[k] - want[k]) <= 2, `${k}: ${got[k]} vs ${want[k]}`);
  }
});

test("a soft ground shadow in the edit does not squeeze the figure", () => {
  const { raster, mask } = render();
  const shadow = (x: number, y: number) => ((x - 64) / 36) ** 2 + ((y - 108) / 5) ** 2 <= 1;
  const edited = edit(identity, [70, 50, 40], shadow);
  const { image, overlap } = register(edited, raster, mask);
  assert.ok(overlap >= 0.9, `overlap ${overlap}`);
  const fg = foregroundOf(image);
  let covered = 0;
  let total = 0;
  mask.forEach((m, i) => {
    if (!m) return;
    total++;
    if (fg[i]) covered++;
  });
  assert.ok(covered / total >= 0.95, `covers ${covered / total}`);
  const outside = fg.reduce((n, f, i) => n + (f && !mask[i] ? 1 : 0), 0);
  assert.ok(outside / total < 0.1, `outside ${outside / total}`);
});

test("an edit that lost half the figure is named by a low overlap", () => {
  const { raster, mask } = render();
  const half = edit((x, y) => (x >= 64 ? [-1, -1] : [x, y]));
  assert.ok(register(half, raster, mask).overlap < 0.9);
  const empty = createRaster(SIZE, SIZE);
  empty.data.fill(250);
  assert.equal(register(empty, raster, mask).overlap, 0);
  assert.equal(register(edit(identity), raster, new Uint8Array(SIZE * SIZE)).overlap, 0);
});

test("luminance, speckle and markings count the pale outline pixels the mask holds", () => {
  const { raster, mask } = render();
  let sum = 0;
  let n = 0;
  mask.forEach((m, i) => {
    if (!m) return;
    sum +=
      0.2126 * raster.data[i * 4]! +
      0.7152 * raster.data[i * 4 + 1]! +
      0.0722 * raster.data[i * 4 + 2]!;
    n++;
  });
  assert.ok(Math.abs(figureLuminance(raster, mask) - sum / n) < 1e-9);

  // An all-pale figure with one dark pixel: the colour of the figure is no part of the test.
  const pale = createRaster(32, 32);
  pale.data.fill(216);
  const palMask = new Uint8Array(32 * 32);
  for (let y = 8; y < 24; y++) {
    for (let x = 8; x < 24; x++) {
      pale.data.set([214, 215, 216, 255], (y * 32 + x) * 4);
      palMask[y * 32 + x] = 1;
    }
  }
  pale.data.set([90, 90, 90, 255], (16 * 32 + 16) * 4);
  assert.equal(speckle(pale, palMask), 1 / 256);

  const crop = figureCrop(raster, mask);
  assert.equal(crop.image.width * crop.image.height, crop.mask.length);
  const outline = measureBox(crop.image, [0, 0, 1, 1], crop.mask);
  assert.equal(outline?.pixels, n);
});

/** The render with a hole the ground shows through (between the legs, seen at three-quarter). */
const hole = (x: number, y: number) => x >= 52 && x < 76 && y >= 72 && y < 104;

function renderWithHole(): { raster: Raster; mask: Uint8Array } {
  const { raster, mask } = render();
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++)
      if (hole(x, y)) {
        mask[y * SIZE + x] = 0;
        raster.data.set([...GREY, 255], (y * SIZE + x) * 4);
      }
  return { raster, mask };
}

test("a gap the figure encloses is scored: a faithful edit overlaps fully", () => {
  const { raster, mask } = renderWithHole();
  const edited = edit(identity);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++)
      if (hole(x, y)) edited.data.set([250, 250, 250, 255], (y * SIZE + x) * 4);
  assert.ok(register(edited, raster, mask).overlap > 0.99);
});

test("an edit that paints the gap between the legs solid is named by a low overlap", () => {
  const { raster, mask } = renderWithHole();
  const overlap = register(edit(identity), raster, mask).overlap;
  assert.ok(overlap < 0.9, `overlap ${overlap}`);
});
