import assert from "node:assert/strict";
import { test } from "node:test";
import { createRaster } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { parseGlb } from "../src/model3d/glb.ts";
import {
  closeUpCamera,
  renderView,
  renderViewWithDepth,
  speckle,
  strandCoverage,
  viewCamera,
} from "../src/model3d/render.ts";
import type { FurMaps, PreviewLighting, RenderOptions } from "../src/model3d/render.ts";
import { boundsOf, posedPrimitives } from "../src/model3d/scene.ts";
import { syntheticCharacter } from "./fixtures/glb.ts";

function setup(triangles = 12 * 64) {
  const glb = parseGlb(syntheticCharacter({ triangles }));
  const framing = boundsOf(posedPrimitives(glb))!;
  const base: RenderOptions = { sizePx: 128, yawDeg: 30, framing };
  return { glb, base };
}

function solid(rgba: [number, number, number, number], size = 4): Raster {
  const r = createRaster(size, size);
  for (let i = 0; i < r.data.length; i += 4) r.data.set(rgba, i);
  return r;
}

function furMaps(length: number, extra: Partial<FurMaps> = {}): FurMaps {
  return {
    length: solid([length, 0, 0, 255]),
    direction: solid([128, 0, 128, 255]),
    density: solid([255, 0, 0, 255]),
    maxLengthM: 0.3,
    shells: 8,
    strandsPerUv: 24,
    ...extra,
  };
}

function covered(raster: Raster, background = 0xd8): number {
  let n = 0;
  for (let i = 0; i < raster.data.length; i += 4) {
    if (raster.data[i] !== background || raster.data[i + 1] !== background) n++;
  }
  return n;
}

function maxLuminance(raster: Raster): number {
  let max = 0;
  for (let i = 0; i < raster.data.length; i += 4) {
    max = Math.max(max, raster.data[i]! + raster.data[i + 1]! + raster.data[i + 2]!);
  }
  return max;
}

function differs(a: Raster, b: Raster): boolean {
  return Buffer.compare(a.data, b.data) !== 0;
}

test("fur with zero length changes nothing", () => {
  const { glb, base } = setup();
  assert.deepEqual(renderView(glb, { ...base, fur: furMaps(0) }).data, renderView(glb, base).data);
});

test("fur grows the silhouette and a tint changes its colour", () => {
  const { glb, base } = setup();
  const plain = renderView(glb, base);
  const furry = renderView(glb, { ...base, fur: furMaps(255) });
  assert.ok(covered(furry) > covered(plain));
  const tinted = renderView(glb, {
    ...base,
    fur: furMaps(255, { tint: solid([255, 0, 0, 255]) }),
  });
  assert.ok(differs(furry, tinted));
  // The tint changes colour where the fur is, never where it reaches.
  assert.ok(Math.abs(covered(tinted) - covered(furry)) <= covered(furry) * 0.01);
});

test("the fur preview is soft: no speckle on the body or at the silhouette", () => {
  const glb = parseGlb(syntheticCharacter({ triangles: 12 * 256 }));
  const framing = boundsOf(posedPrimitives(glb))!;
  for (const yawDeg of [0, 30, 90]) {
    const base: RenderOptions = { sizePx: 256, yawDeg, framing };
    const fur = furMaps(255, {
      density: solid([160, 0, 0, 255]),
      maxLengthM: 0.08,
      shells: 16,
      strandsPerUv: 512,
    });
    const bare = renderView(glb, base);
    const furry = renderView(glb, { ...base, fur });
    assert.ok(differs(bare, furry));
    assert.ok(speckle(furry) - speckle(bare) < 0.001, `yaw ${yawDeg}: ${speckle(furry)}`);
  }
});

test("speckle counts isolated pixels and ignores smooth shading", () => {
  const smooth = createRaster(32, 32);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) smooth.data.set([60 + x * 2, 60 + y, 50, 255], (y * 32 + x) * 4);
  assert.equal(speckle(smooth), 0);
  const noisy = createRaster(32, 32);
  noisy.data.set(smooth.data);
  for (let i = 0; i < 32 * 32; i += 7) noisy.data.set([250, 250, 250, 255], i * 4);
  assert.ok(speckle(noisy) > 0.05);
});

test("strand coverage thins toward the tips and scales with density", () => {
  assert.ok(strandCoverage(0.1, 1, 1) > strandCoverage(0.9, 1, 1));
  assert.equal(strandCoverage(1, 1, 1), 0);
  assert.ok(Math.abs(strandCoverage(0.2, 0.5, 1) * 2 - strandCoverage(0.2, 1, 1)) < 1e-12);
});

test("preview lighting is the same for every view and scales with exposure", () => {
  const { glb, base } = setup();
  const lighting: PreviewLighting = {
    ambient: 0.6,
    key: 0.4,
    keyDirection: [-0.4, 0.5, 0.75],
    exposure: 1,
  };
  const mean = (r: Raster) => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < r.data.length; i += 4) {
      if (r.data[i] === 0xd8 && r.data[i + 1] === 0xd8) continue;
      sum += r.data[i]!;
      n++;
    }
    return sum / n;
  };
  const flat = solid([128, 128, 128, 255]);
  const a = renderView(glb, { ...base, baseColor: flat, lighting });
  const brighter = renderView(glb, {
    ...base,
    baseColor: flat,
    lighting: { ...lighting, exposure: 1.2 },
  });
  assert.ok(mean(brighter) > mean(a) * 1.15);
  // The fixed turntable light is darker than neutral preview lighting.
  assert.ok(mean(renderView(glb, { ...base, baseColor: flat })) < mean(a));
});

test("preview lighting rolls pale highlights off instead of clipping them to white", () => {
  const { glb, base } = setup();
  const pale = solid([235, 225, 205, 255]);
  const lighting: PreviewLighting = {
    ambient: 0.6,
    key: 0.4,
    keyDirection: [-0.4, 0.5, 0.75],
    exposure: 1.3,
  };
  const clipped = (r: Raster) => {
    let n = 0;
    for (let i = 0; i < r.data.length; i += 4) if (r.data[i]! >= 254) n++;
    return n;
  };
  const lit = renderView(glb, { ...base, baseColor: pale, lighting });
  assert.equal(clipped(lit), 0, "no pale pixel reaches full white");
});

test("fur is deterministic and writes depth", () => {
  const { glb, base } = setup();
  const options = { ...base, fur: furMaps(255) };
  const a = renderViewWithDepth(glb, options);
  assert.deepEqual(a.raster.data, renderView(glb, options).data);
  assert.ok(a.depth.some(Number.isFinite));
});

test("a glossy material gets a catch-light", () => {
  // A flat box face only reflects the sky when viewed from well above.
  const { glb, base: flat } = setup();
  const base = { ...flat, elevationDeg: 60 };
  const matte = renderView(glb, base);
  const material = glb.json.materials![0]!;
  (material.pbrMetallicRoughness as Record<string, unknown>).roughnessFactor = 1;
  assert.deepEqual(renderView(glb, base).data, matte.data);
  (material.pbrMetallicRoughness as Record<string, unknown>).roughnessFactor = 0.05;
  const glossy = renderView(glb, base);
  assert.ok(maxLuminance(glossy) > maxLuminance(matte));
});

test("closeUpCamera puts the focus at the centre at the requested scale", () => {
  const focus: [number, number, number] = [0.3, 1.2, 0.1];
  const camera = closeUpCamera({
    sizePx: 512,
    yawDeg: 40,
    focus,
    heightM: 1.8,
    screenHeightPx: 1000,
    characterScreenFraction: 0.5,
  });
  const [cx, cy, depth] = camera.project(...focus);
  assert.ok(Math.abs(cx - 256) < 1e-9 && Math.abs(cy - 256) < 1e-9);
  const up = camera.up;
  const [, top] = camera.project(focus[0] + up[0], focus[1] + up[1], focus[2] + up[2]);
  assert.ok(Math.abs((256 - top) * 1.8 - 500) < 1);
  assert.ok(depth > 0);
  const { glb, base } = setup();
  const close = renderView(glb, { ...base, camera });
  assert.ok(covered(close) > 0);
});

test("a baseColor override changes colours but not coverage", () => {
  const { glb, base } = setup();
  const before = renderView(glb, base);
  const after = renderView(glb, { ...base, baseColor: solid([0, 255, 0, 255]) });
  assert.ok(differs(before, after));
  assert.equal(covered(after), covered(before));
});

test("elevationDeg moves the camera, and defaults to 15", () => {
  const { glb, base } = setup();
  const same = viewCamera({ ...base, elevationDeg: 15 });
  const dflt = viewCamera(base);
  assert.deepEqual(same.eye, dflt.eye);
  const high = viewCamera({ ...base, elevationDeg: 60 });
  assert.ok(high.eye[1] > dflt.eye[1]);
  assert.ok(differs(renderView(glb, { ...base, elevationDeg: 60 }), renderView(glb, base)));
  assert.deepEqual(renderView(glb, { ...base, elevationDeg: 15 }).data, renderView(glb, base).data);
});

test("unlit renders pure albedo without specular or fur shadowing", () => {
  const { glb, base } = setup();
  const flat = solid([200, 100, 50, 255]);
  const unlit = renderView(glb, { ...base, baseColor: flat, unlit: true });
  const colours = new Set<string>();
  for (let i = 0; i < unlit.data.length; i += 4) {
    if (unlit.data[i] !== 0xd8) colours.add(`${unlit.data[i]},${unlit.data[i + 1]}`);
  }
  assert.ok(colours.size > 0 && colours.size <= 3);
  // Unlit fur over the surface keeps the albedo: no root shading (its fringe blends into the background).
  const furry = renderView(glb, { ...base, baseColor: flat, unlit: true, fur: furMaps(255) });
  for (let i = 0; i < furry.data.length; i += 4) {
    if (unlit.data[i] === 0xd8) continue;
    assert.ok(Math.abs(furry.data[i]! - unlit.data[i]!) <= 1, `pixel ${i / 4}`);
  }
});

test("background replaces the grey", () => {
  const { glb, base } = setup();
  const out = renderView(glb, { ...base, background: [0, 0, 0] });
  assert.deepEqual([...out.data.subarray(0, 4)], [0, 0, 0, 255]);
  assert.ok(covered(out, 0) > 0);
});

test("an emissive texture adds light to its material, and unlit renders leave it out", async () => {
  const { setEmissive } = await import("../src/model3d/lookdev/edit.ts");
  const { encodePng } = await import("../src/image/raster.ts");
  const { glb, base } = setup();
  glb.json.materials![0]!.name = "glow";
  const plain = renderView(glb, base);
  assert.equal(setEmissive(glb, "missing", encodePng(solid([255, 255, 255, 255])), "x"), -1);
  assert.ok(setEmissive(glb, "glow", encodePng(solid([255, 255, 255, 255])), "glow") >= 0);
  assert.ok(maxLuminance(renderView(glb, base)) > maxLuminance(plain));
  assert.deepEqual(
    renderView(glb, { ...base, unlit: true }).data,
    renderView(parseGlb(syntheticCharacter({ triangles: 12 * 64 })), { ...base, unlit: true }).data,
  );
});

test("catchLight is exact: every eye needs painted texels that pass the close-up's depth test", async () => {
  const { catchLight } = await import("../src/model3d/lookdev/command.ts");
  const { renderViewWithDepth } = await import("../src/model3d/render.ts");
  const { glb, base } = setup();
  const size = 64;
  const camera = viewCamera({ sizePx: size, yawDeg: 0, framing: base.framing });
  const close = renderViewWithDepth(glb, { ...base, sizePx: size, yawDeg: 0 });
  // A world point on the ray through pixel (x, y) at `depth` along the view axis.
  const at = (x: number, y: number, depth: number) => {
    const sx = ((x + 0.5 - size / 2) * depth) / camera.focal;
    const sy = (-(y + 0.5 - size / 2) * depth) / camera.focal;
    return [0, 1, 2].map(
      (k) =>
        camera.eye[k]! + camera.forward[k]! * depth + camera.right[k]! * sx + camera.up[k]! * sy,
    ) as [number, number, number];
  };
  const surface = (x: number, y: number) => {
    const depth = close.depth[y * size + x]!;
    assert.ok(Number.isFinite(depth), `the figure covers pixel ${x},${y}`);
    return depth;
  };
  const d1 = surface(28, 32);
  const d2 = surface(36, 32);
  const radius = (2 * d1) / camera.focal;
  const eyes = [
    { point: at(28, 32, d1), radius },
    { point: at(36, 32, d2), radius },
  ];
  // Texels: 0 and 1 on the visible surface in each eye, 2 on the same ray behind the figure's front.
  const position = new Float32Array([
    ...at(28, 32, d1),
    ...at(36, 32, d2),
    ...at(36, 32, d2 * 1.5),
  ]);
  const texels = {
    size: 2,
    covered: new Uint8Array([1, 1, 1, 0]),
    position,
    normal: new Float32Array(12),
    joint: new Int16Array(4),
  };

  // Both eyes painted where the close-up sees them: found, with no brightness measured (a pale
  // eye or a render with no highlight at all does not matter).
  const both = catchLight(camera, close.depth, texels, eyes, [[0], [1]]);
  assert.equal(both.found, true);
  assert.equal(both.eyes, 2);
  assert.deepEqual(both.perEye, [
    { painted: 1, visible: 1 },
    { painted: 1, visible: 1 },
  ]);

  // An eye with nothing painted fails, whatever the other eye shows.
  const none = catchLight(camera, close.depth, texels, eyes, [[0], []]);
  assert.equal(none.found, false);
  assert.equal(none.eyes, 1);
  assert.deepEqual(none.perEye[1], { painted: 0, visible: 0 });

  // Painted but hidden from the close-up (behind the surface it drew there) fails the depth test.
  const hidden = catchLight(camera, close.depth, texels, eyes, [[0], [2]]);
  assert.equal(hidden.found, false);
  assert.deepEqual(hidden.perEye[1], { painted: 1, visible: 0 });

  // No located eye is no catch-light.
  assert.equal(catchLight(camera, close.depth, texels, [], []).found, false);
});

test("paintCatchLights returns the texels it painted per eye, none for an eye with no texel", async () => {
  const { paintCatchLights } = await import("../src/model3d/lookdev/command.ts");
  // A 16 × 16 patch of surface facing +z across the first eye.
  const size = 16;
  const position = new Float32Array(size * size * 3);
  const normal = new Float32Array(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    position[i * 3] = ((i % size) / (size - 1)) * 0.2 - 0.1;
    position[i * 3 + 1] = (Math.floor(i / size) / (size - 1)) * 0.2 - 0.1;
    normal[i * 3 + 2] = 1;
  }
  const texels = {
    size,
    covered: new Uint8Array(size * size).fill(1),
    position,
    normal,
    joint: new Int16Array(size * size),
  };
  const albedo = solid([0, 0, 0, 255], size);
  const painted = paintCatchLights(
    albedo,
    texels,
    [
      { point: [0, 0, 0], radius: 0.1 },
      { point: [-9, -9, -9], radius: 0.1 },
    ],
    [0, 0, 1],
  );
  assert.equal(painted.length, 2);
  assert.ok(painted[0]!.length > 0, "the eye's texels near its catch-light are painted");
  assert.ok(painted[0]!.every((i) => albedo.data[i * 4]! > 0));
  assert.deepEqual(painted[1], []);
});
