import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_REGISTRY, checkExtension } from "../src/extensions/registry.ts";
import {
  checkFrameLayout,
  frameLayoutOf,
  framesOf,
  isStripKind,
  withLayoutParameters,
} from "../src/frames.ts";
import { createRaster, encodePng } from "../src/image/raster.ts";
import type { MediaOutput } from "../src/types.ts";

function png(width: number, height: number, frames: unknown): MediaOutput {
  return {
    mediaType: "image/png",
    extension: "png",
    bytes: encodePng(createRaster(width, height)),
    fields: { frames },
  };
}

test("core's still declares single, sprite-strip strip, and character-3d no frames", () => {
  assert.equal(framesOf("still", CORE_REGISTRY), "single");
  assert.equal(framesOf("sprite-strip", CORE_REGISTRY), "strip");
  assert.equal(framesOf("character-3d", CORE_REGISTRY), undefined);
  assert.equal(framesOf("fx:unknown", CORE_REGISTRY), undefined);
  assert.equal(isStripKind("sprite-strip", CORE_REGISTRY), true);
  assert.equal(isStripKind("still", CORE_REGISTRY), false);
  const traits = { kinds: [{ kind: "fx:strip", frames: "strip" as const }] };
  assert.equal(isStripKind("fx:strip", traits), true);
});

test("a strip output's layout is checked: whole positive count and size, and its image is count frames in one row", () => {
  const layout = checkFrameLayout("fx:strip", png(12, 5, { width: 4, height: 5, count: 3 }));
  assert.deepEqual(layout, { width: 4, height: 5, count: 3 });
  assert.deepEqual(
    checkFrameLayout(
      "fx:strip",
      png(8, 5, { width: 4, height: 5, count: 2, order: "left-to-right", durationMs: 80 }),
    ),
    { width: 4, height: 5, count: 2, order: "left-to-right", durationMs: 80 },
  );
  assert.throws(
    () => checkFrameLayout("fx:strip", png(12, 5, undefined)),
    /fx:strip declares frames "strip" but its output carries no valid frame layout/,
  );
  assert.throws(
    () => checkFrameLayout("fx:strip", png(12, 5, { width: 4, height: 5, count: 0 })),
    /count/,
  );
  assert.throws(
    () => checkFrameLayout("fx:strip", png(12, 5, { width: 4, height: 5, count: 3, order: "up" })),
    /order/,
  );
  assert.throws(
    () => checkFrameLayout("fx:strip", png(12, 5, { width: 4, height: 5, count: 2 })),
    /12×5, not the 2 frames of 4×5 in one row/,
  );
  assert.equal(frameLayoutOf({ frames: { width: 4, height: 5, count: 1.5 } }), undefined);
});

test("a layout's durationMs is any positive number, as sprite-strip copies a profile's frames.durationMs", () => {
  const layout = { width: 4, height: 5, count: 2, durationMs: 83.5 };
  assert.deepEqual(checkFrameLayout("sprite-strip", png(8, 5, layout)), layout);
  assert.deepEqual(frameLayoutOf({ frames: layout }), layout);
  for (const durationMs of [0, -10])
    assert.equal(frameLayoutOf({ frames: { ...layout, durationMs } }), undefined);
});

test("a strip's provenance parameters gain frame and frameCount only when the kind left them out", () => {
  const layout = { width: 4, height: 5, count: 3 };
  assert.deepEqual(withLayoutParameters("fx:strip", { a: 1 }, layout), {
    a: 1,
    frame: { width: 4, height: 5 },
    frameCount: 3,
  });
  const own = { frame: { width: 4, height: 5 }, frameCount: 3, anchor: { x: 1, y: 4 } };
  assert.equal(withLayoutParameters("sprite-strip", own, layout), own);
  assert.throws(
    () =>
      withLayoutParameters("fx:strip", { frame: { width: 4, height: 5 }, frameCount: 2 }, layout),
    /disagree/,
  );
});

test("a kind declaring frames other than single or strip is refused at load", () => {
  const ext = (frames: unknown) => ({
    api: 2,
    name: "fx",
    kinds: [{ kind: "fx:tile", frames, planCandidate: () => [], generate: () => undefined }],
  });
  assert.throws(
    () => checkExtension(ext("grid"), "extensions[0]"),
    /kind fx:tile declares frames "grid"; a kind's frames are "single" or "strip"/,
  );
  assert.doesNotThrow(() => checkExtension(ext("strip"), "extensions[0]"));
  assert.doesNotThrow(() => checkExtension(ext(undefined), "extensions[0]"));
});
