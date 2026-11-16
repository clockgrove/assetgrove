import assert from "node:assert/strict";
import { test } from "node:test";
import { createRaster } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { flipHorizontal } from "../src/image/resample.ts";
import { animationQa } from "../src/animation/qa.ts";
import { registrationPin } from "../src/animation/templates.ts";
import { jitterOf, measureFrame, registerFrames } from "../src/sheet/register.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";

const sheet = syntheticSheet();
const crops: Raster[] = sheet.figures.map((f) => {
  const y0 = f.labelBox.y + f.labelBox.height + 2;
  const { x, width } = f.cellBox;
  const height = f.cellBox.y + f.cellBox.height - y0;
  const out = createRaster(width, height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const s = (y0 + j) * sheet.raster.width + x + i;
      const o = (j * width + i) * 4;
      for (let k = 0; k < 3; k++) out.data[o + k] = sheet.raster.data[s * 4 + k] as number;
      out.data[o + 3] = sheet.alpha[s] as number;
    }
  }
  return out;
});
const families = sheet.figures.map((f) => f.family);
const frame = { width: 32, height: 32 };
const anchor = { x: 16, y: 30 };

function spread(areas: number[], names: string[]): number {
  let worst = 0;
  for (const name of new Set(names)) {
    const v = areas.filter((_, i) => names[i] === name).map(Math.sqrt);
    worst = Math.max(worst, Math.max(...v) / Math.min(...v) - 1);
  }
  return worst;
}

test("all figures register within a pixel into the target frame", () => {
  for (const edges of ["antialiased", "crisp"] as const) {
    const reg = registerFrames(crops, { frame, anchor, edges });
    assert.equal(reg.frames.length, 16);
    for (const f of reg.frames) {
      assert.equal(f.image.width, 32);
      assert.equal(f.image.height, 32);
      assert.ok(f.jitterPx <= 1, `${edges} jitter ${f.jitterPx}`);
    }
    assert.ok(reg.jitterPx <= 1);
    assert.ok(
      jitterOf(
        reg.frames.map((f) => f.image),
        anchor,
      ).maxPx <= 1,
    );
  }
});

test("family normalisation evens out the figure size", () => {
  const plain = registerFrames(crops, { frame, anchor, edges: "antialiased" });
  const normal = registerFrames(crops, { frame, anchor, edges: "antialiased", families });
  const areas = (r: typeof plain) => r.frames.map((f) => f.measure.area);
  assert.ok(spread(areas(normal), families) <= 0.05, `${spread(areas(normal), families)}`);
  assert.ok(spread(areas(plain), families) > 0.05);
  assert.deepEqual(
    normal.frames[0]?.transforms.map((t) => t.op),
    ["normalize-scale", "scale", "place"],
  );
});

test("jitterOf catches the drift of unregistered crops", () => {
  const first = sheet.figures[0];
  assert.ok(first);
  const y0 = first.labelBox.y + first.labelBox.height + 2 - first.cellBox.y;
  const naive = jitterOf(crops, { x: 32, y: 58 - y0 });
  assert.ok(naive.maxPx > 1, `${naive.maxPx}`);
  assert.equal(naive.perFrame.length, 16);
});

test("crisp keeps the input's alpha values; antialiased makes soft alpha", () => {
  const input = new Set<number>();
  for (let i = 3; i < crops[0]!.data.length; i += 4) input.add(crops[0]!.data[i] as number);
  const crisp = registerFrames(crops, { frame, anchor, edges: "crisp" }).frames[0]!.image;
  for (let i = 3; i < crisp.data.length; i += 4) {
    assert.ok(input.has(crisp.data[i] as number));
  }
  const soft = registerFrames(crops, { frame, anchor, edges: "antialiased" }).frames[0]!.image;
  let intermediate = 0;
  for (let i = 3; i < soft.data.length; i += 4) {
    const a = soft.data[i] as number;
    if (a > 0 && a < 255) intermediate++;
  }
  assert.ok(intermediate > 0);
});

test("flipHorizontal mirrors and the flipped figure registers", () => {
  const src = crops[0] as Raster;
  const flipped = flipHorizontal(src);
  for (const [x, y] of [
    [0, 5],
    [10, 20],
    [src.width - 1, 30],
  ] as const) {
    const a = (y * src.width + x) * 4;
    const b = (y * src.width + (src.width - 1 - x)) * 4;
    assert.deepEqual(flipped.data.slice(b, b + 4), src.data.slice(a, a + 4));
  }
  const m = measureFrame(src);
  const mf = measureFrame(flipped);
  assert.ok(m && mf);
  assert.ok(Math.abs(m.centerX + mf.centerX - src.width) < 1e-6);
  const reg = registerFrames([flipped], { frame, anchor, edges: "antialiased" });
  assert.ok(reg.jitterPx <= 1);
});

function sniffCrop(headDrop: number): Raster {
  const r = createRaster(64, 40);
  const fill = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) r.data.set([200, 150, 100, 255], (y * 64 + x) * 4);
  };
  fill(12, 12, 10, 14); // body
  fill(12, 26, 3, 6); // rear leg
  fill(19, 26, 3, 6); // front leg: the feet are identical in every crop
  fill(22 + headDrop, 8 + headDrop * 2, 8, 6); // head goes down and forward, above the feet
  return r;
}

const sniffFrame = { width: 64, height: 48 };
const sniffAnchor = { x: 32, y: 44 };

test("a planted sniff keeps its feet on the same columns while the centre of mass moves", () => {
  const figures = [0, 3, 6].map(sniffCrop);
  const reg = registerFrames(figures, {
    frame: sniffFrame,
    anchor: sniffAnchor,
    edges: "crisp",
    scale: 1,
    pins: figures.map(() => registrationPin("sniff")),
  });
  const anchor = sniffAnchor;
  const [first, ...rest] = reg.frames;
  for (const f of rest) {
    assert.ok(Math.abs(f.measure.footX - (anchor.x + 0.5)) <= 0.5);
    assert.ok(
      Math.abs(f.measure.centerX - (first as (typeof reg.frames)[number]).measure.centerX) > 0.5,
    );
    const rowOf = (img: Raster) => {
      const cols: number[] = [];
      for (let x = 0; x < img.width; x++)
        if ((img.data[(anchor.y * img.width + x) * 4 + 3] as number) >= 128) cols.push(x);
      return cols;
    };
    assert.deepEqual(rowOf(f.image), rowOf((first as (typeof reg.frames)[number]).image));
  }
  assert.ok(
    Math.abs((first as (typeof reg.frames)[number]).measure.footX - (anchor.x + 0.5)) <= 0.5,
  );
});

test("a planted sniff registered from a sheet passes animation QA's footprint-drift", () => {
  const figures = [0, 3, 6, 3].map(sniffCrop);
  for (const edges of ["crisp", "antialiased"] as const) {
    const reg = registerFrames(figures, {
      frame: sniffFrame,
      anchor: sniffAnchor,
      edges,
      pins: figures.map(() => registrationPin("sniff")),
    });
    const r = animationQa(
      {
        frames: reg.frames.map((f) => f.image),
        frame: sniffFrame,
        anchor: sniffAnchor,
        family: "sniff",
      },
      {},
      {
        alpha: { mode: edges === "crisp" ? "binary" : "soft", threshold: 128 },
        color: { rule: "full", palette: [] },
        edges,
      },
    );
    const failing = r.reasons.filter(
      (x) => !x.passed && (x.check === "footprint-drift" || x.check === "ground-contact"),
    );
    assert.deepEqual(failing, [], edges);
  }
});

/** A walk crop: the body and head never move; the stance foot steps `step` px. */
function walkCrop(step: number): Raster {
  const r = createRaster(64, 40);
  const fill = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) r.data.set([200, 150, 100, 255], (y * 64 + x) * 4);
  };
  fill(20, 8, 16, 18); // body and head
  fill(26 + step, 26, 4, 8); // stance foot, on the ground
  fill(30 - step, 26, 3, 5); // swinging foot, off the ground
  return r;
}

function bodyLeft(img: Raster, row: number): number {
  for (let x = 0; x < img.width; x++)
    if ((img.data[(row * img.width + x) * 4 + 3] as number) >= 128) return x;
  return -1;
}

test("the pin follows the family's footprint rule: planted families pin the feet, moving ones the centre of mass", () => {
  assert.equal(registrationPin("sniff"), "footprint");
  assert.equal(registrationPin("idle"), "footprint");
  assert.equal(registrationPin("walk"), "center");
  assert.equal(registrationPin("walk-left"), "center");
  // A profile template that plants a family pins its feet, whatever its name.
  assert.equal(
    registrationPin("walk", {
      animation: {
        templates: [
          {
            name: "walk",
            loop: true,
            frames: { min: 2, max: 16 },
            beats: [],
            contact: "all",
            silhouette: { min: 0, max: 0.4 },
            footprint: "planted",
          },
        ],
      },
    }),
    "footprint",
  );
});

test("a walk registered with its family's pin keeps the body still while the stance foot steps", () => {
  const steps = [-8, -4, 0, 4, 8, 4, 0, -4];
  const figures = steps.map(walkCrop);
  for (const edges of ["crisp", "antialiased"] as const) {
    const options = { frame: sniffFrame, anchor: sniffAnchor, edges, scale: 1 };
    const walk = registerFrames(figures, {
      ...options,
      pins: figures.map(() => registrationPin("walk")),
    });
    const lefts = walk.frames.map((f) => bodyLeft(f.image, 20));
    assert.ok(Math.max(...lefts) - Math.min(...lefts) <= 2, `${edges}: body left edges ${lefts}`);
    // Pinning the swinging contacts instead slides the body by the whole stride.
    const feet = registerFrames(figures, { ...options, pins: figures.map(() => "footprint") });
    const slid = feet.frames.map((f) => bodyLeft(f.image, 20));
    assert.ok(Math.max(...slid) - Math.min(...slid) >= 12, `${edges}: footprint-pinned ${slid}`);
  }
});
