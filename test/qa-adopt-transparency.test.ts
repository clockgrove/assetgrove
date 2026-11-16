/**
 * `library adopt`'s transparency check (issue #321): a hand edit is held to the alpha rule of the
 * asset's own style and to the transparency of the version it replaces, while a generated
 * candidate is checked as before.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { freeChecks } from "../src/library/adopt.ts";
import { deterministicChecks } from "../src/qa.ts";
import type { Provenance } from "../src/types.ts";

const provenance = { route: "scripted", models: [], parameters: {} } as unknown as Provenance;

/** A 4x4 raster: every pixel opaque red, `alpha` overriding the first `count` pixels. */
function image(count: number, alpha: number): Raster {
  const r = createRaster(4, 4);
  for (let i = 0; i < 16; i++) {
    setPixel(r, i % 4, Math.floor(i / 4), [200, 0, 0, i < count ? alpha : 255]);
  }
  return r;
}

const png = (r: Raster) => encodePng(r);
const transparency = (reasons: { check: string; passed: boolean; reason: string }[]) =>
  reasons.find((r) => r.check === "transparency")!;

test("an asset of a soft-alpha style adopts an edit with partial alpha", async () => {
  const original = png(image(4, 0));
  const edited = png(image(6, 0));
  // Two soft pixels beside four transparent ones: the edge a soft-alpha style keeps.
  const r = image(4, 0);
  setPixel(r, 0, 1, [200, 0, 0, 90]);
  setPixel(r, 1, 1, [200, 0, 0, 170]);
  for (const style of [{ alpha: { mode: "soft" as const } }, undefined]) {
    const reasons = await freeChecks(png(r), provenance, undefined, { style, original });
    const t = transparency(reasons);
    assert.equal(t.passed, true, t.reason);
    assert.match(t.reason, /2 of 16 pixels have partial alpha.*alpha mode soft/);
  }
  assert.equal(transparency(await freeChecks(edited, provenance, undefined, {})).passed, true);
});

test("an asset whose replaced version has no transparent pixel adopts an opaque edit", async () => {
  const original = png(image(0, 255));
  const edited = image(0, 255);
  setPixel(edited, 2, 2, [0, 0, 200, 255]);
  const reasons = await freeChecks(png(edited), provenance, undefined, {
    style: { alpha: { mode: "binary" } },
    original,
  });
  assert.equal(transparency(reasons).passed, true, transparency(reasons).reason);
  // A replaced version that had a transparent pixel still requires one.
  const refused = await freeChecks(png(edited), provenance, undefined, {
    style: { alpha: { mode: "binary" } },
    original: png(image(1, 0)),
  });
  assert.deepEqual(
    { passed: transparency(refused).passed, reason: transparency(refused).reason },
    { passed: false, reason: "no pixel is transparent" },
  );
});

test("a binary-alpha asset refuses an edit with soft pixels, naming the rule and the count", async () => {
  const edited = image(4, 0);
  setPixel(edited, 3, 3, [200, 0, 0, 128]);
  setPixel(edited, 2, 3, [200, 0, 0, 12]);
  setPixel(edited, 1, 3, [200, 0, 0, 254]);
  const reasons = await freeChecks(png(edited), provenance, undefined, {
    style: { alpha: { mode: "binary", threshold: 100 } },
    original: png(image(4, 0)),
  });
  const t = transparency(reasons);
  assert.equal(t.passed, false);
  assert.equal(
    t.reason,
    "3 of 16 pixels have partial alpha; the asset's style allows only alpha 0 or 255 (alpha mode binary)",
  );
});

test("a generated candidate is checked as before: partial alpha and no transparent pixel fail", () => {
  const expected = { frame: { width: 4, height: 4 }, frameCount: 1, palette: [] };
  const soft = image(4, 0);
  setPixel(soft, 3, 3, [200, 0, 0, 128]);
  assert.deepEqual(transparency(deterministicChecks(soft, expected)), {
    check: "transparency",
    passed: false,
    reason: "1 of 16 pixels have partial alpha",
    source: "deterministic",
  });
  assert.equal(
    transparency(deterministicChecks(image(0, 255), expected)).reason,
    "no pixel is transparent",
  );
  // freeChecks without the asset's rule keeps the old check too.
  return freeChecks(png(soft), provenance, undefined).then((reasons) =>
    assert.equal(transparency(reasons).reason, "1 of 16 pixels have partial alpha"),
  );
});
