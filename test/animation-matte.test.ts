import assert from "node:assert/strict";
import test from "node:test";
import {
  clearTransparentColour,
  edgeHaloReasons,
  frameHalo,
  haloShare,
} from "../src/animation/halo.ts";
import {
  buildHolesPrompt,
  checkHoles,
  enclosedAreas,
  holeView,
  BEFORE_AFTER_QUESTION,
  ENCLOSED_QUESTION,
  holeMinPx,
  planHoles,
} from "../src/animation/holes.ts";
import { animationQa } from "../src/animation/qa.ts";
import { thresholdsFor } from "../src/animation/templates.ts";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { createRaster, getPixel, setPixel } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { defaultRoutes } from "../src/routes.ts";
import { resolveStyle } from "../src/style.ts";

const thresholds = thresholdsFor(undefined);

/**
 * A soft-edged disc of fur with a pale blaze in its middle; optionally a hole punched in the blaze
 * and an orange fringe on the faint edge (what unmixing a cool background used to leave).
 */
function disc(options: { hole?: boolean; fringe?: boolean } = {}): Raster {
  const size = 48;
  const r = createRaster(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const cover = Math.max(0, Math.min(1, 16 - d));
      if (cover === 0) continue;
      const blaze = Math.abs(x + 0.5 - c) < 6 && Math.abs(y + 0.5 - c) < 4;
      const colour: [number, number, number] = blaze
        ? [240, 236, 228]
        : cover < 1 && options.fringe
          ? [210, 90, 30]
          : [116, 88, 73];
      setPixel(r, x, y, [...colour, Math.round(cover * 255)]);
    }
  }
  if (options.hole) {
    for (let y = c - 2; y < c + 1; y++)
      for (let x = c - 3; x < c + 2; x++) setPixel(r, x, y, [0, 0, 0, 0]);
  }
  return r;
}

test("a soft edge in the figure's own colours passes edge-halo; an orange fringe fails it", () => {
  const clean = frameHalo(disc());
  assert.ok(clean.edgePixels > 20);
  assert.equal(clean.haloPixels, 0);
  const fringed = frameHalo(disc({ fringe: true }));
  assert.ok(fringed.haloPixels / fringed.edgePixels > 0.5);
  const [ok] = edgeHaloReasons([disc(), disc()], thresholds);
  assert.equal(ok!.passed, true);
  const failed = edgeHaloReasons([disc(), disc({ fringe: true })], thresholds);
  assert.deepEqual(
    failed.map((r) => [r.check, r.passed, r.frames]),
    [["edge-halo", false, [2]]],
  );
  assert.match(failed[0]!.reason, /^frame 2: \d+ of \d+ soft edge pixels/);
});

test("transparent pixels that keep a colour are a note, never an edge-halo failure", () => {
  // A matting tool that keeps the original RGB under alpha 0: thousands of coloured transparent
  // pixels around a clean figure.
  const frame = disc();
  let kept = 0;
  for (let y = 0; y < frame.height; y++)
    for (let x = 0; x < frame.width; x++) {
      const i = (y * frame.width + x) * 4;
      if (frame.data[i + 3] === 0) {
        frame.data.set([230, 240, 238], i);
        kept++;
      }
    }
  const h = frameHalo(frame);
  assert.equal(h.colouredTransparent, kept);
  assert.ok(kept > 1000);
  const reasons = edgeHaloReasons([frame, disc()], thresholds);
  assert.deepEqual(
    reasons.map((r) => [r.check, r.passed, r.frames]),
    [
      ["edge-halo", true, undefined],
      ["transparent-colour", true, [1]],
    ],
  );
  assert.match(
    reasons[1]!.reason,
    new RegExp(`^frame 1: ${kept} fully transparent pixels keep a colour`),
  );
  const cleared = clearTransparentColour(frame);
  assert.equal(frameHalo(cleared).colouredTransparent, 0);
  assert.equal(frame.data[3], 0);
  assert.notEqual(frame.data[0], 0, "the input frame is left as it was");
});

test("the edge-halo share is over soft edge pixels alone", () => {
  // 200 soft edge pixels of which 40 are halo is 20%, under the limit, whatever number of
  // coloured transparent pixels sits beside them (60 used to make it 23% and fail).
  const h = { edgePixels: 200, haloPixels: 40, colouredTransparent: 60 };
  assert.equal(haloShare(h), 0.2);
  assert.equal(haloShare({ edgePixels: 200, haloPixels: 50, colouredTransparent: 0 }), 0.25);
});

test("the deterministic report has an edge-halo check, so a fringed strip fails for it", () => {
  const frames = [disc(), disc({ fringe: true })];
  const report = animationQa(
    { frames, frame: { width: 48, height: 48 }, anchor: { x: 24, y: 47 }, family: "spin" },
    {},
    resolveStyle(undefined),
  );
  const halo = report.reasons.filter((r) => r.check === "edge-halo");
  assert.deepEqual(
    halo.map((r) => [r.passed, r.frames]),
    [[false, [2]]],
  );
});

test("enclosed see-through areas are found; the outside and specks below the minimum are not", () => {
  assert.deepEqual(enclosedAreas(disc(), { threshold: 128, minPx: 3 }).areas, []);
  const { areas, marked } = enclosedAreas(disc({ hole: true }), { threshold: 128, minPx: 3 });
  assert.deepEqual(areas, [{ area: 15, x: 21, y: 22, width: 5, height: 3 }]);
  assert.equal(marked[23 * 48 + 22], 1);
  assert.equal(marked[0], 0);
  assert.deepEqual(enclosedAreas(disc({ hole: true }), { threshold: 128, minPx: 16 }).areas, []);
});

test("the judged view is enlarged, opaque, green outside and magenta in the enclosed areas", () => {
  const frame = disc({ hole: true });
  const { marked } = enclosedAreas(frame, { threshold: 128, minPx: 3 });
  const view = holeView(frame, marked);
  assert.equal(view.width, 384);
  const zoom = view.width / frame.width;
  assert.deepEqual(getPixel(view, 0, 0), [46, 120, 52, 255]);
  assert.deepEqual(getPixel(view, 22 * zoom, 23 * zoom), [255, 0, 255, 255]);
  assert.deepEqual(getPixel(view, 24 * zoom, 30 * zoom), [116, 88, 73, 255]);
});

test("the holes prompts name the frame", () => {
  assert.match(
    buildHolesPrompt({ subject: "a fox", family: "walk", frame: 4, areas: 2 }),
    /frame 4/,
  );
  assert.equal(
    BEFORE_AFTER_QUESTION.instructions,
    "Is any part of the character missing after background removal?",
  );
  assert.equal(BEFORE_AFTER_QUESTION.type, "boolean");
  assert.equal(ENCLOSED_QUESTION.type, "boolean");
});

function caller(probabilities: number[]) {
  const seen: Array<{ prompt: string; images: number; question: string; operation?: string }> = [];
  const provider = new ScriptedProvider({
    image: () => {
      throw new Error("no image calls expected");
    },
    vision: () => {
      throw new Error("holes is a typed decision, not a vision call");
    },
    decide: (request, index) => {
      seen.push({
        prompt: request.prompt,
        images: request.images.length,
        question: request.question.instructions,
        ...(request.operation !== undefined && { operation: request.operation }),
      });
      return {
        answer: { type: "boolean", probability: probabilities[index] ?? 0 },
        costUsd: 0.001,
      };
    },
  });
  const call = new Caller({
    provider,
    providerName: "scripted",
    budget: new Budget(1),
    routes: defaultRoutes,
  });
  return { call, seen };
}

const base = { family: "idle", subject: "a fox", threshold: 128, minShare: 0.001, cutoff: 0.5 };

test("only frames with an enclosed area are judged; a hole fails that frame for holes", async () => {
  const frames = [disc(), disc({ hole: true }), disc({ hole: true })];
  const plan = planHoles(frames, base, defaultRoutes);
  assert.deepEqual([plan.calls, plan.estimatedCostUsd], [2, 2 * defaultRoutes.holes.estimatedCostUsd]);
  const { call, seen } = caller([0.95, 0.1]);
  const { reasons, decisions } = await checkHoles({ ...base, frames, call });
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.operation, "holes");
  assert.match(seen[0]!.prompt, /frame 2 of a "idle" animation/);
  assert.equal(seen[0]!.question, ENCLOSED_QUESTION.instructions);
  assert.equal(seen[0]!.images, 1);
  assert.deepEqual(
    reasons.map((r) => [r.check, r.passed, r.source, r.frames]),
    [
      ["holes", false, "decision", [2]],
      ["holes", true, "decision", [3]],
    ],
  );
  assert.match(
    reasons[0]!.reason,
    /^frame 2: 1 see-through area\(s\) inside the outline, 15 px; a see-through area inside the outline is a hole cut into the character \(probability 0\.95 ≥ cutoff 0\.5\)/,
  );
  assert.deepEqual(
    decisions.map((d) => [d.frame, d.view, d.label, d.probability, d.flagged, d.areas.length]),
    [
      [2, "enclosed", "holes", 0.95, true, 1],
      [3, "enclosed", "none", 0.1, false, 1],
    ],
  );
});

test("a hole answer flags on the answer alone; a person's cutoff applies to the probability", async () => {
  const frames = [disc({ hole: true }), disc({ hole: true })];
  const { call } = caller([0.6, 0.6]);
  const { reasons } = await checkHoles({ ...base, frames: [frames[0]!], call });
  assert.equal(reasons[0]!.passed, false);
  const strict = await checkHoles({ ...base, cutoff: 0.8, frames: [frames[1]!], call });
  assert.equal(strict.reasons[0]!.passed, true);
  assert.match(strict.reasons[0]!.reason, /probability 0\.60 < cutoff 0\.8/);
});

test("a strip without enclosed areas or images before removal makes no call and says what it could not judge", async () => {
  const { call, seen } = caller([]);
  const { reasons, decisions } = await checkHoles({ ...base, frames: [disc(), disc()], call });
  assert.equal(seen.length, 0);
  assert.deepEqual(decisions, []);
  assert.deepEqual(
    reasons.map((r) => [r.check, r.passed, r.source]),
    [["holes", true, "deterministic"]],
  );
  assert.match(reasons[0]!.reason, /a cut that reaches the outline is not judged/);
});

/** A disc with a bite out of its lower edge, open to the outside: never enclosed. */
function bitten(): Raster {
  const r = disc();
  for (let y = 30; y < 48; y++) for (let x = 20; x < 28; x++) setPixel(r, x, y, [0, 0, 0, 0]);
  return r;
}

/** The disc as it was drawn on its sheet: opaque over a pale background. */
function drawn(): Raster {
  const r = createRaster(48, 48);
  const figure = disc();
  for (let p = 0; p < 48 * 48; p++) {
    const a = (figure.data[p * 4 + 3] ?? 0) / 255;
    for (let k = 0; k < 3; k++)
      r.data[p * 4 + k] = Math.round((figure.data[p * 4 + k] ?? 0) * a + 240 * (1 - a));
    r.data[p * 4 + 3] = 255;
  }
  return r;
}

test("with the image before removal, a bite open to the outside is shown and asked about, one decision per frame", async () => {
  const frames = [disc(), bitten()];
  // Never enclosed: the old gate would not have asked and would have passed the strip on pixels.
  assert.deepEqual(enclosedAreas(bitten(), { threshold: 128, minPx: 1 }).areas, []);
  const sources = [
    { before: drawn(), after: disc() },
    { before: drawn(), after: bitten() },
  ];
  assert.equal(planHoles(frames, { ...base, sources }, defaultRoutes).calls, 2);
  const { call, seen } = caller([0.05, 0.9]);
  const { reasons, decisions } = await checkHoles({ ...base, frames, sources, call });
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.question, "Is any part of the character missing after background removal?");
  assert.equal(seen[1]!.images, 2);
  assert.match(seen[1]!.prompt, /before a program removed its background/);
  assert.deepEqual(
    reasons.map((r) => [r.passed, r.source, r.frames]),
    [
      [true, "decision", [1]],
      [false, "decision", [2]],
    ],
  );
  assert.match(
    reasons[1]!.reason,
    /^frame 2, before and after background removal; part of the character is missing after background removal \(probability 0\.90 ≥ cutoff 0\.5\)/,
  );
  assert.deepEqual(
    decisions.map((d) => [d.view, d.label]),
    [
      ["before-after", "none"],
      ["before-after", "holes"],
    ],
  );
});

test("the after view shows the removed parts over magenta", () => {
  const view = holeView(bitten(), new Uint8Array(0), [255, 0, 255]);
  const zoom = view.width / 48;
  assert.deepEqual(getPixel(view, 23 * zoom, 40 * zoom), [255, 0, 255, 255]);
  assert.deepEqual(getPixel(view, 0, 0), [255, 0, 255, 255]);
});

/** A square figure of `side` px in a `size` px frame, with a `hole` px hole in its middle row. */
function square(size: number, side: number, hole: number): Raster {
  const r = createRaster(size, size);
  const o = Math.floor((size - side) / 2);
  for (let y = o; y < o + side; y++)
    for (let x = o; x < o + side; x++) setPixel(r, x, y, [116, 88, 73, 255]);
  const mid = Math.floor(size / 2);
  for (let i = 0; i < hole; i++) setPixel(r, mid + i, mid, [0, 0, 0, 0]);
  return r;
}

test("the smallest judged area is a share of the figure's area, not a fixed pixel count", async () => {
  // A 2 px eye hole in a 32 px frame is judged (the old 3 px minimum skipped it)...
  const small = square(32, 20, 2);
  assert.equal(holeMinPx(small, base), 1);
  assert.equal(planHoles([small], base, defaultRoutes).calls, 1);
  // ...and a 3 px speck of matte noise in a 512 px frame is not (it cost a paid call before).
  const large = square(512, 400, 3);
  assert.equal(holeMinPx(large, base), 160);
  assert.equal(planHoles([large], base, defaultRoutes).calls, 0);
  const { call, seen } = caller([]);
  await checkHoles({ ...base, frames: [large], call });
  assert.equal(seen.length, 0);
});
