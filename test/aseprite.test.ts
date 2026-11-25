/**
 * Reading Aseprite files (#470): frames are composited from visible normal image layers with layer
 * and cel opacity, indexed and grayscale files decode, and layers the reader cannot honour are
 * refused by name with exit 2.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { InputError } from "../src/errors.ts";
import { getPixel } from "../src/image/raster.ts";
import { readAseprite } from "../src/source/aseprite.ts";
import { asepriteFile, fernAseprite } from "../src/testing/index.ts";

const fernPath = fileURLToPath(new URL("./fixtures/aseprite/fern.aseprite", import.meta.url));

function refusal(bytes: Uint8Array, pattern: RegExp): void {
  assert.throws(
    () => readAseprite(bytes, "x.aseprite"),
    (error: unknown) => error instanceof InputError && pattern.test(error.message),
  );
}

test("the committed fern fixture is what the writer produces, edited or not", () => {
  assert.deepEqual(new Uint8Array(readFileSync(fernPath)), fernAseprite());
  assert.notDeepEqual(fernAseprite({ edited: true }), fernAseprite());
});

test("fern: canvas, frames, durations and tags", () => {
  const doc = readAseprite(new Uint8Array(readFileSync(fernPath)), fernPath);
  assert.equal(doc.width, 32);
  assert.equal(doc.height, 40);
  assert.equal(doc.frames.length, 7);
  assert.deepEqual(doc.durationsMs, [100, 100, 100, 100, 100, 100, 100]);
  assert.deepEqual(doc.tags, [
    { name: "idle", from: 0, to: 3 },
    { name: "walk", from: 4, to: 6 },
  ]);
});

test("fern: layer opacity blends, the hidden layer is not shown", () => {
  const [f0, f1] = readAseprite(fernAseprite(), "fern").frames;
  assert.ok(f0 && f1);
  assert.deepEqual(getPixel(f0, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(getPixel(f0, 15, 4), [200, 120, 60, 255]);
  assert.deepEqual(getPixel(f0, 12, 20), [60, 110, 180, 255]);
  assert.deepEqual(getPixel(f0, 9, 30), [20, 20, 40, 128]);
  assert.deepEqual(getPixel(f0, 12, 26), [40, 65, 110, 255]);
  assert.deepEqual(getPixel(f0, 12, 30), [55, 40, 40, 255]);
  assert.deepEqual(getPixel(f1, 15, 4), [0, 0, 0, 0]);
  assert.deepEqual(getPixel(f1, 15, 14), [200, 120, 60, 255]);
});

test("the edited fern differs in the idle frames only", () => {
  const before = readAseprite(fernAseprite(), "fern").frames;
  const after = readAseprite(fernAseprite({ edited: true }), "fern").frames;
  assert.deepEqual(getPixel(after[0]!, 12, 20), [180, 60, 60, 255]);
  assert.notDeepEqual(after[3]!.data, before[3]!.data);
  assert.deepEqual(after[4]!.data, before[4]!.data);
});

test("cel opacity multiplies layer opacity, and a hidden group hides its children", () => {
  const cel = (layer: number, opacity?: number) => ({
    layer,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    rgba: Uint8Array.from([200, 100, 0, 255]),
    ...(opacity === undefined ? {} : { opacity }),
  });
  const doc = readAseprite(
    asepriteFile({
      width: 1,
      height: 1,
      layers: [
        { name: "a", opacity: 128 },
        { name: "group", type: 1, visible: false },
        { name: "child", childLevel: 1 },
        { name: "ref", reference: true },
      ],
      frames: [{ durationMs: 40, cels: [cel(0, 128), cel(2), cel(3)] }],
    }),
    "x",
  );
  assert.deepEqual(getPixel(doc.frames[0]!, 0, 0), [200, 100, 0, 64]);
  assert.deepEqual(doc.durationsMs, [40]);
});

test("a visible layer over another composites source-over", () => {
  const doc = readAseprite(
    asepriteFile({
      width: 1,
      height: 1,
      layers: [{ name: "low" }, { name: "high" }],
      frames: [
        {
          durationMs: 100,
          cels: [
            { layer: 0, x: 0, y: 0, width: 1, height: 1, rgba: Uint8Array.from([255, 0, 0, 255]) },
            { layer: 1, x: 0, y: 0, width: 1, height: 1, rgba: Uint8Array.from([0, 0, 255, 51]) },
          ],
        },
      ],
    }),
    "x",
  );
  assert.deepEqual(getPixel(doc.frames[0]!, 0, 0), [204, 0, 51, 255]);
});

test("indexed files: the transparent index is clear except on a background layer", () => {
  const palette = [
    [9, 9, 9, 255],
    [255, 0, 0, 255],
  ] as const;
  const file = (background: boolean) =>
    asepriteFile({
      width: 2,
      height: 1,
      colorDepth: 8,
      palette: [...palette],
      layers: [{ name: "l", background }],
      frames: [
        {
          durationMs: 100,
          cels: [{ layer: 0, x: 0, y: 0, width: 2, height: 1, rgba: Uint8Array.from([0, 1]) }],
        },
      ],
    });
  const clear = readAseprite(file(false), "x").frames[0]!;
  assert.deepEqual(
    [getPixel(clear, 0, 0), getPixel(clear, 1, 0)],
    [
      [0, 0, 0, 0],
      [255, 0, 0, 255],
    ],
  );
  const solidBack = readAseprite(file(true), "x").frames[0]!;
  assert.deepEqual(getPixel(solidBack, 0, 0), [9, 9, 9, 255]);
});

test("grayscale files decode value and alpha", () => {
  const doc = readAseprite(
    asepriteFile({
      width: 2,
      height: 1,
      colorDepth: 16,
      layers: [{ name: "l" }],
      frames: [
        {
          durationMs: 100,
          cels: [
            {
              layer: 0,
              x: 0,
              y: 0,
              width: 2,
              height: 1,
              rgba: Uint8Array.from([100, 255, 50, 128]),
            },
          ],
        },
      ],
    }),
    "x",
  );
  const frame = doc.frames[0]!;
  assert.deepEqual(getPixel(frame, 0, 0), [100, 100, 100, 255]);
  assert.deepEqual(getPixel(frame, 1, 0), [50, 50, 50, 128]);
});

test("a visible layer with a blend mode or a tilemap layer is refused by name", () => {
  const frames = [{ durationMs: 100, cels: [] }];
  refusal(
    asepriteFile({ width: 1, height: 1, layers: [{ name: "glow", blendMode: 1 }], frames }),
    /layer "glow".*blend mode 1/,
  );
  refusal(
    asepriteFile({ width: 1, height: 1, layers: [{ name: "map", type: 2 }], frames }),
    /layer "map".*tilemap/,
  );
  const hidden = readAseprite(
    asepriteFile({
      width: 1,
      height: 1,
      layers: [{ name: "glow", blendMode: 1, visible: false }],
      frames,
    }),
    "x",
  );
  assert.equal(hidden.frames.length, 1);
});

test("garbage is refused as an InputError naming the path", () => {
  assert.throws(
    () => readAseprite(Uint8Array.from([1, 2, 3, 4]), "junk.aseprite"),
    (error: unknown) => error instanceof InputError && error.message.includes("junk.aseprite"),
  );
  const truncated = fernAseprite().slice(0, 300);
  assert.throws(() => readAseprite(truncated, "cut.aseprite"), InputError);
});
