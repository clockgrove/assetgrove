import assert from "node:assert/strict";
import { test } from "node:test";
import { createRaster, getPixel, setPixel } from "../src/image/raster.ts";
import {
  CORE_METHODS,
  deriveNormals,
  extractScalarMap,
  temporalChecks,
  temporalPairs,
  validateMaterialMap,
} from "../src/material/core.ts";
import type { MaterialGrid } from "../src/material/core.ts";
import type { Raster } from "../src/image/raster.ts";

function fill(grid: MaterialGrid, value: (x: number, y: number) => number): Raster {
  const raster = createRaster(grid.width * grid.count, grid.height);
  for (let y = 0; y < raster.height; y++)
    for (let x = 0; x < raster.width; x++) {
      const v = value(x, y);
      setPixel(raster, x, y, [v, v, v, 255]);
    }
  return raster;
}

test("declared extraction preserves exact analytic heights and versioned normal geometry", () => {
  const grid = { width: 3, height: 3, count: 1 };
  const albedo = fill(grid, () => 100),
    painted = fill(grid, (x, y) => 40 + x * 40 + y * 20);
  const height = extractScalarMap(albedo, painted, grid);
  assert.deepEqual(getPixel(height, 1, 1), [100, 100, 100, 255]);
  const normal = deriveNormals(height, grid);
  const nx = -40 / 255,
    ny = 20 / 255,
    length = Math.hypot(nx, ny, 1);
  assert.deepEqual(getPixel(normal, 1, 1), [
    Math.round((nx / length + 1) * 127.5),
    Math.round((ny / length + 1) * 127.5),
    Math.round((1 / length + 1) * 127.5),
    255,
  ]);
  assert.ok(validateMaterialMap(albedo, normal, grid, "normal").every((c) => c.passed));
  assert.deepEqual(CORE_METHODS.normals, { method: "height-gradient", version: "1" });
  assert.deepEqual(CORE_METHODS.extraction, { method: "mask-extraction", version: "1" });
});

test("flat geometry is exact and normal gradients do not bleed across frame cells", () => {
  const grid = { width: 2, height: 2, count: 2 },
    height = fill(grid, (x) => (x < 2 ? 0 : 255));
  const normal = deriveNormals(height, grid);
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 4; x++) assert.deepEqual(getPixel(normal, x, y), [128, 128, 255, 255]);
});

test("alignment, scalar encoding, range and normal orientation fail closed", () => {
  const grid = { width: 2, height: 2, count: 1 },
    albedo = fill(grid, () => 100),
    map = fill(grid, () => 200);
  assert.ok(
    validateMaterialMap(albedo, map, grid, "height", { range: [0, 0.5] }).some((c) => !c.passed),
  );
  setPixel(map, 0, 0, [100, 50, 50, 255]);
  assert.ok(
    validateMaterialMap(albedo, map, grid, "height").some(
      (c) => c.check === "material-scalar" && !c.passed,
    ),
  );
  setPixel(map, 0, 0, [128, 128, 0, 255]);
  assert.ok(
    validateMaterialMap(albedo, map, grid, "normal").some(
      (c) => c.check === "material-normal" && !c.passed,
    ),
  );
  setPixel(map, 0, 0, [0, 0, 0, 0]);
  assert.ok(
    validateMaterialMap(albedo, map, grid, "height").some(
      (c) => c.check === "material-alignment" && !c.passed,
    ),
  );
  assert.throws(() => deriveNormals({ ...map, data: new Uint8Array(1) }, grid), /frame grid/);
  assert.throws(() => deriveNormals(map, { ...grid, count: 0 }), /frame grid/);
  assert.throws(() => extractScalarMap(albedo, map, grid, { range: [1, 0] }), /range/);
  assert.throws(() => extractScalarMap(albedo, map, grid, { range: [0, 0.1] }), /outside/);
});

test("emission is limited to extraction masks for spec-named windows and lanterns", () => {
  const grid = { width: 2, height: 1, count: 1 },
    albedo = fill(grid, () => 100),
    emissive = fill(grid, () => 0),
    mask = fill(grid, () => 0);
  setPixel(emissive, 0, 0, [255, 255, 255, 255]);
  setPixel(mask, 0, 0, [255, 255, 255, 255]);
  const options = { namedLightSources: ["lantern"], emissiveSources: [{ name: "lantern", mask }] };
  assert.ok(
    validateMaterialMap(albedo, emissive, grid, "emissive", options).every((c) => c.passed),
  );
  assert.throws(
    () =>
      validateMaterialMap(albedo, emissive, grid, "emissive", {
        ...options,
        namedLightSources: ["window"],
      }),
    /not named/,
  );
  setPixel(emissive, 1, 0, [255, 255, 255, 255]);
  assert.ok(
    validateMaterialMap(albedo, emissive, grid, "emissive", options).some(
      (c) => c.check === "material-emissive" && !c.passed,
    ),
  );
  assert.ok(validateMaterialMap(albedo, emissive, grid, "emissive").some((c) => !c.passed));
});

test("flicker uses per-frame maximum residual, flags localized changes and checks loop seam", () => {
  const grid = { width: 8, height: 8, count: 3 },
    albedo = fill(grid, () => 100),
    map = fill(grid, () => 100);
  assert.ok(temporalChecks(albedo, map, grid, 0).every((c) => c.passed));
  setPixel(map, 0, 0, [255, 255, 255, 255]);
  const checks = temporalChecks(albedo, map, grid, 0.1);
  assert.equal(checks.length, 3);
  assert.equal(checks[0]?.passed, false);
  assert.match(checks[0]?.reason ?? "", /frame 0/);
  assert.equal(checks[1]?.passed, false);
  assert.equal(checks[2]?.passed, true);
  assert.throws(() => temporalChecks(albedo, map, grid, NaN), /bound/);
});

test("translated pose preserves map temporal stability through alpha centroid registration", () => {
  const grid = { width: 4, height: 2, count: 2 },
    albedo = createRaster(8, 2),
    map = createRaster(8, 2);
  for (let frame = 0; frame < 2; frame++)
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) {
        setPixel(albedo, frame * 4 + x + frame, y, [100, 100, 100, 255]);
        setPixel(map, frame * 4 + x + frame, y, [x * 100, x * 100, x * 100, 255]);
      }
  assert.ok(temporalChecks(albedo, map, grid, 0).every((c) => c.passed));
});

test("positive scalar ranges ignore transparent background and empty geometry fails closed", () => {
  const grid = { width: 2, height: 1, count: 1 };
  const albedo = createRaster(2, 1),
    painted = createRaster(2, 1);
  setPixel(albedo, 0, 0, [100, 100, 100, 255]);
  setPixel(painted, 0, 0, [100, 100, 100, 255]);
  const extracted = extractScalarMap(albedo, painted, grid, { range: [0.2, 0.8] });
  assert.deepEqual(getPixel(extracted, 1, 0), [0, 0, 0, 0]);
  assert.ok(
    validateMaterialMap(albedo, extracted, grid, "height", { range: [0.2, 0.8] }).every(
      (c) => c.passed,
    ),
  );
  const empty = createRaster(2, 1);
  assert.ok(
    validateMaterialMap(empty, empty, grid, "height").some(
      (c) => c.check === "material-frame-coverage" && !c.passed,
    ),
  );
  const animationGrid = { width: 1, height: 1, count: 2 };
  assert.ok(
    temporalChecks(empty, empty, animationGrid, 1).every(
      (c) => !c.passed && c.reason.includes("unmeasured"),
    ),
  );
});

test("albedo brightness changes cannot hide map flicker: with no unchanged albedo the pixel rule clears nothing", () => {
  const grid = { width: 1, height: 1, count: 2 };
  const albedo = fill(grid, (x) => x * 255),
    map = fill(grid, (x) => x * 255);
  const checks = temporalChecks(albedo, map, grid, 0);
  assert.deepEqual(
    checks.map(({ passed, reason }) => ({ passed, reason })),
    [0, 1].map((frame) => ({
      passed: false,
      reason: `frame ${frame}: no pose-corresponding pixel has unchanged albedo (1 pose-corresponding pixels); the map cannot be compared by pixels`,
    })),
  );
  assert.deepEqual(
    temporalPairs(albedo, map, grid, 0).map((p) => p.state),
    ["no-unchanged", "no-unchanged"],
  );
});

test("map flicker is compared only where the shifted albedo is unchanged: a swinging leg over the torso is not a change", () => {
  // A walk-like pair: the torso holds still; the leg hangs below it in frame 0 and swings up in
  // front of it in frame 1. After the centroid shift, leg pixels land where the torso was: their
  // map differs (leg against torso), but so does their albedo.
  const grid = { width: 8, height: 8, count: 2 };
  const albedo = createRaster(16, 8),
    map = createRaster(16, 8);
  for (let frame = 0; frame < 2; frame++)
    for (let y = 0; y < 5; y++)
      for (let x = 2; x < 6; x++) {
        setPixel(albedo, frame * 8 + x, y, [100, 100, 100, 255]);
        setPixel(map, frame * 8 + x, y, [60, 60, 60, 255]);
      }
  const leg = (frame: number, x: number, y: number) => {
    setPixel(albedo, frame * 8 + x, y, [30, 30, 30, 255]);
    setPixel(map, frame * 8 + x, y, [250, 250, 250, 255]);
  };
  for (let y = 5; y < 8; y++) leg(0, 2, y);
  for (const [x, y] of [
    [3, 3],
    [4, 3],
    [3, 4],
    [4, 4],
  ] as const)
    leg(1, x, y);
  // Old rule: the leg pixel shifted onto the torso compared map 250 against 60 and failed.
  const pairs = temporalPairs(albedo, map, grid, 0.03);
  assert.ok(pairs.every((p) => p.corresponding > p.samples));
  assert.deepEqual(
    pairs.map((p) => p.state),
    ["within", "within"],
  );
  assert.ok(temporalChecks(albedo, map, grid, 0.03).every((c) => c.passed));
  // A map that changes on the still torso is still over the bound.
  setPixel(map, 8 + 3, 1, [200, 200, 200, 255]);
  assert.deepEqual(
    temporalPairs(albedo, map, grid, 0.03).map((p) => p.state),
    ["over", "over"],
  );
});
