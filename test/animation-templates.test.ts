import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILTIN_TEMPLATES,
  DEFAULT_THRESHOLDS,
  gaitFor,
  parseTemplate,
  templateFor,
  templatesFor,
  thresholdsFor,
  withGait,
} from "../src/animation/templates.ts";
import { InputError } from "../src/errors.ts";

test("templates: the six built-in families ship as data", () => {
  assert.deepEqual(
    BUILTIN_TEMPLATES.map((t) => t.name),
    ["idle", "walk", "sniff", "eat", "play", "shelter"],
  );
  // Each built-in survives the same validation a target's template goes through.
  for (const t of BUILTIN_TEMPLATES) assert.deepEqual(parseTemplate(t), t);
  const walk = templateFor("walk", BUILTIN_TEMPLATES);
  assert.equal(walk?.loop, true);
  assert.equal(walk?.contact, "all");
});

test("templates: a target adds its own and overrides a built-in without code", () => {
  const sleep = {
    name: "sleep",
    loop: true,
    frames: { min: 2, max: 8 },
    beats: [{ name: "exhale", at: 0, contact: true }],
    contact: "all",
    silhouette: { min: 0, max: 0.1 },
  };
  const slowWalk = { ...BUILTIN_TEMPLATES[1], name: "walk", frames: { min: 8, max: 24 } };
  const templates = templatesFor({
    animation: { templates: [sleep, slowWalk] as never },
  });
  assert.equal(templateFor("sleep", templates)?.frames.max, 8);
  assert.equal(templateFor("walk", templates)?.frames.min, 8);
  assert.equal(templates.length, BUILTIN_TEMPLATES.length + 1);
});

test("templates: a family matches a template by its exact name only, else none", () => {
  assert.equal(templateFor("walk-right", BUILTIN_TEMPLATES), undefined);
  assert.equal(templateFor("walk-left", BUILTIN_TEMPLATES), undefined);
  assert.equal(templateFor("play-dead", BUILTIN_TEMPLATES), undefined);
  assert.equal(templateFor("idle", BUILTIN_TEMPLATES)?.name, "idle");
  assert.equal(templateFor("crouch-hop", BUILTIN_TEMPLATES), undefined);
  assert.equal(templateFor("walker", BUILTIN_TEMPLATES), undefined);
});

test("templates: invalid data is refused with the field named", () => {
  assert.throws(
    () => templatesFor({ animation: { templates: [{ name: "x", loop: "yes" }] as never } }),
    (e: unknown) => e instanceof InputError && /loop/.test(e.message),
  );
  assert.throws(
    () =>
      parseTemplate({
        name: "climb",
        loop: false,
        frames: { min: 4, max: 2 },
        beats: [],
        contact: "none",
        silhouette: { min: 0, max: 1 },
      }),
    /frames.min is above frames.max/,
  );
  assert.throws(
    () =>
      parseTemplate({
        name: "climb",
        loop: false,
        frames: { min: 2, max: 4 },
        beats: [{ name: "grab", at: 1.2 }],
        contact: "none",
        silhouette: { min: 0, max: 1 },
      }),
    /beats\[0\]\.at/,
  );
});

test("thresholds: defaults, profile overrides and refusals", () => {
  assert.deepEqual(thresholdsFor({}), DEFAULT_THRESHOLDS);
  const t = thresholdsFor({
    animation: { thresholds: { footprintDrift: 0.3, flickerCutoff: 0.8 } },
  });
  assert.equal(t.footprintDrift, 0.3);
  assert.equal(t.flickerCutoff, 0.8);
  assert.equal(t.groundTolerance, DEFAULT_THRESHOLDS.groundTolerance);
  assert.throws(() => thresholdsFor({ animation: { thresholds: { bogus: 1 } as never } }), /bogus/);
  assert.throws(
    () => thresholdsFor({ animation: { thresholds: { flickerCutoff: 2 } } }),
    /flickerCutoff/,
  );
  // The decisions flag on their answer alone; the smallest judged hole is a share of the figure.
  assert.deepEqual(
    [
      DEFAULT_THRESHOLDS.flickerCutoff,
      DEFAULT_THRESHOLDS.holeCutoff,
      DEFAULT_THRESHOLDS.holeMinShare,
    ],
    [0.5, 0.5, 0.0001],
  );
  assert.throws(
    () => thresholdsFor({ animation: { thresholds: { holeMinPx: 3 } as never } }),
    /holeMinPx was removed: the smallest judged area is now holeMinShare/,
  );
  assert.throws(
    () => thresholdsFor({ animation: { thresholds: { holeMinShare: 2 } } }),
    /holeMinShare must be within 0\.\.1/,
  );
});

test("gaits: a template's gait rules are data, validated with the field named", () => {
  const walk = templateFor("walk", BUILTIN_TEMPLATES)!;
  assert.deepEqual(walk.gaits?.["quadruped"], {
    strides: 1,
    footprintBand: 0.3,
    footprintDrift: 0.2,
  });
  const hexapod = { footprint: "moving", strides: 3, footprintDrift: 0.04, footprintBand: 0.2 };
  const parsed = parseTemplate({ ...walk, gaits: { ...walk.gaits, hexapod } });
  assert.deepEqual(parsed.gaits?.["hexapod"], hexapod);
  const bad = (gaits: unknown, field: RegExp) =>
    assert.throws(
      () => parseTemplate({ ...walk, gaits }),
      (e: unknown) => e instanceof InputError && field.test(e.message),
    );
  bad({ "Four Legs": {} }, /gaits\.Four Legs: a gait name is lowercase words/);
  bad({ quadruped: { loop: false } }, /gaits\.quadruped may only set .* \(not loop\)/);
  bad({ quadruped: { footprintBand: 0 } }, /gaits\.quadruped\.footprintBand must be a fraction/);
  bad({ quadruped: { strides: 1.5 } }, /gaits\.quadruped\.strides must be a whole number/);
  bad(["quadruped"], /gaits must be an object/);
  assert.throws(() => parseTemplate({ ...walk, footprintBand: 1.5 }), /^.*footprintBand must be/);
});

test("gaits: the spec's gait wins over the profile's; none is never guessed", () => {
  const profile = { animation: { gait: "quadruped" } };
  assert.equal(gaitFor(profile), "quadruped");
  assert.equal(gaitFor(profile, "biped"), "biped");
  assert.equal(gaitFor({}), undefined);
  assert.throws(() => gaitFor({ animation: { gait: 4 as never } }), /invalid gait 4/);
  const walk = templateFor("walk", BUILTIN_TEMPLATES)!;
  const four = withGait(walk, "quadruped");
  assert.equal(four.applied, true);
  assert.equal(four.template.strides, 1);
  assert.equal(four.template.footprintBand, 0.3);
  assert.equal(four.template.footprint, "moving");
  assert.deepEqual(withGait(walk, "biped"), { template: walk, applied: false });
  assert.deepEqual(withGait(walk, undefined), { template: walk, applied: false });
});

test("the pixel-unit keys are refused with the fraction that replaces them", () => {
  for (const [key, text] of [
    [
      "anchorDriftPx",
      /anchorDriftPx was removed: drift is now footprintDrift, a fraction of the figure's height/,
    ],
    [
      "groundTolerancePx",
      /groundTolerancePx was removed: .*groundTolerance, a fraction of the figure's height/,
    ],
    [
      "footprintDriftPx",
      /footprintDriftPx was removed: .*footprintDrift, a fraction of the figure's height/,
    ],
  ] as const) {
    assert.throws(
      () => thresholdsFor({ animation: { thresholds: { [key]: 1 } as never } }),
      (e: unknown) => e instanceof InputError && text.test(e.message),
      key,
    );
  }
  const walk = templateFor("walk", BUILTIN_TEMPLATES)!;
  const { footprintDrift: _kept, ...rest } = walk;
  void _kept;
  const removed =
    /footprintDriftPx was removed: it is now footprintDrift, a fraction of the figure's height/;
  assert.throws(
    () => parseTemplate({ ...rest, footprintDriftPx: 6 }),
    (e: unknown) => e instanceof InputError && removed.test(e.message),
  );
  assert.throws(
    () => parseTemplate({ ...walk, gaits: { quadruped: { footprintDriftPx: 12 } } }),
    (e: unknown) => e instanceof InputError && removed.test(e.message),
  );
  assert.throws(
    () => parseTemplate({ ...walk, footprintDrift: 1.5 }),
    /footprintDrift must be a fraction/,
  );
  assert.throws(
    () => thresholdsFor({ animation: { thresholds: { footprintDrift: 2 } } }),
    /footprintDrift must be within 0\.\.1/,
  );
});
