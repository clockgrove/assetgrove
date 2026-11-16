import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAnimation, animationQa } from "../src/animation/qa.ts";
import { templateFor, templatesFor, thresholdsFor } from "../src/animation/templates.ts";
import { InputError } from "../src/errors.ts";
import { createRaster, setPixel } from "../src/image/raster.ts";
import type { ResolvedStyle } from "../src/style.ts";
import { postprocessFrames } from "../src/postprocess.ts";
import { splitStrip } from "../src/animation/strip.ts";
import { quadrupedWalk, syntheticStrip } from "./fixtures/strip.ts";
import type { StripOptions } from "./fixtures/strip.ts";

const STYLES = ["painterly", "flat", "pixel"] as const;
const style = (s: (typeof STYLES)[number]): ResolvedStyle => ({
  alpha: s === "painterly" ? { mode: "soft", threshold: 128 } : { mode: "binary", threshold: 128 },
  color: { rule: "full", palette: [] },
  edges: s === "painterly" ? "antialiased" : "crisp",
});

function run(opts: StripOptions, family: string, profile: Parameters<typeof animationQa>[1] = {}) {
  const { frames, anchor } = syntheticStrip(opts);
  const frame = { width: frames[0]!.width, height: frames[0]!.height };
  return animationQa({ frames, frame, anchor, family }, profile, style(opts.style));
}

const failed = (r: ReturnType<typeof run>, check: string) =>
  r.reasons.filter((x) => x.check === check && !x.passed);

for (const s of STYLES) {
  test(`a clean ${s} walk passes every check`, () => {
    const r = run({ count: 8, style: s, motion: "walk" }, "walk-right");
    assert.deepEqual(
      r.reasons.filter((x) => !x.passed),
      [],
    );
    assert.equal(r.passed, true);
    assert.equal(r.template, "walk");
    for (const check of [
      "template",
      "beats",
      "ground-contact",
      "footprint-drift",
      "silhouette",
      "loop-seam",
    ]) {
      assert.ok(
        r.reasons.some((x) => x.check === check),
        check,
      );
    }
    assert.equal(r.silhouetteChange.length, 8);
  });
}

test("horizontal drift fails footprint-drift naming the frame and the one before it", () => {
  const r = run({ count: 8, style: "flat", motion: "idle", drift: 2 }, "idle");
  const bad = failed(r, "footprint-drift");
  assert.ok(bad.length > 0);
  assert.match(
    bad[0]!.reason,
    /^frame \d+: footprint centre .* px from frame \d+'s .*, the previous planted frame \(limit /,
  );
  assert.ok(bad.every((x) => x.frames?.length === 1));
  assert.ok(bad.some((x) => x.frames?.[0] === 8));
  assert.deepEqual(failed(r, "ground-contact"), []);
});

test("a floating frame fails ground-contact naming that frame", () => {
  const r = run({ count: 8, style: "pixel", motion: "walk", floatFrame: 3 }, "walk");
  const bad = failed(r, "ground-contact");
  assert.equal(bad.length, 1);
  assert.deepEqual(bad[0]!.frames, [3]);
  assert.match(bad[0]!.reason, /frame 3: baseline at row \d+, \d+ px above the ground line 63/);
});

test("a strip that does not close fails loop-seam naming the seam", () => {
  const r = run({ count: 8, style: "painterly", motion: "walk", seamBreak: true }, "walk");
  const bad = failed(r, "loop-seam");
  assert.equal(bad.length, 1);
  assert.match(bad[0]!.reason, /frame 8 → frame 1/);
  assert.deepEqual(bad[0]!.frames, [8, 1]);
});

test("the loop-seam floor is a profile threshold and the reason names it", () => {
  const opts = { count: 8, style: "painterly", motion: "walk", seamBreak: true } as const;
  const bad = failed(run(opts, "walk"), "loop-seam");
  assert.match(bad[0]!.reason, /floor 0\.02 \(limit /);
  const loose = { animation: { thresholds: { loopSeamFloor: 1 } } };
  assert.deepEqual(failed(run(opts, "walk", loose), "loop-seam"), []);
});

test("walk-like variation fails the silhouette bound of the idle template", () => {
  const r = run({ count: 8, style: "flat", motion: "walk" }, "idle");
  const bad = failed(r, "silhouette");
  assert.ok(bad.length > 0);
  assert.match(bad[0]!.reason, /frame \d+ → frame \d+/);
  assert.equal(
    failed(run({ count: 4, style: "flat", motion: "idle" }, "idle"), "silhouette").length,
    0,
  );
});

test("a hop passes ground-contact under play and fails it under walk", () => {
  const play = run({ count: 5, style: "flat", motion: "hop" }, "play");
  assert.deepEqual(failed(play, "ground-contact"), []);
  const walk = run({ count: 5, style: "flat", motion: "hop" }, "walk");
  assert.ok(failed(walk, "ground-contact").length > 0);
});

test("a profile-added template matches its family, and walk-right matches walk", () => {
  const sleep = {
    name: "sleep",
    loop: true,
    frames: { min: 2, max: 6 },
    beats: [{ name: "curl", at: 0, contact: true }],
    contact: "all",
    silhouette: { min: 0, max: 0.2 },
  } as const;
  const profile = { animation: { templates: [{ ...sleep, beats: [...sleep.beats] }] } };
  const templates = templatesFor(profile);
  assert.equal(templateFor("sleep", templates)?.name, "sleep");
  assert.equal(templateFor("walk-right", templates)?.name, "walk");
  assert.equal(templateFor("fly", templates), undefined);
  const r = run({ count: 4, style: "flat", motion: "idle" }, "sleep", profile);
  assert.equal(r.template, "sleep");
  const none = run({ count: 4, style: "flat", motion: "idle" }, "fly");
  assert.equal(none.template, undefined);
  assert.match(none.reasons[0]!.reason, /no motion template matches family fly/);
  assert.equal(none.reasons[0]!.passed, true);
});

test("a frame count outside the template range fails template", () => {
  const r = run({ count: 3, style: "flat", motion: "walk" }, "walk");
  assert.equal(failed(r, "template").length, 1);
  const beats = failed(r, "beats");
  assert.match(beats[0]?.reason ?? "", /3 frames cannot hold 4 beats/);
});

test("cycle timing outside the template fails timing", () => {
  const { frames, anchor } = syntheticStrip({ count: 8, style: "flat", motion: "walk" });
  const input = { frames, frame: { width: 64, height: 64 }, anchor, family: "walk" };
  const template = templateFor("walk", templatesFor());
  const options = { template, thresholds: thresholdsFor(), threshold: 128 };
  assert.equal(checkAnimation({ ...input, durationMs: 100 }, options).passed, true);
  const slow = checkAnimation({ ...input, durationMs: 500 }, options);
  assert.equal(failed(slow, "timing" as never).length, 1);
});

test("profile thresholds override the defaults", () => {
  const opts: StripOptions = { count: 8, style: "flat", motion: "idle", drift: 2 };
  assert.ok(failed(run(opts, "idle"), "footprint-drift").length > 0);
  const loose = { animation: { thresholds: { footprintDrift: 0.5 } } };
  assert.deepEqual(failed(run(opts, "idle", loose), "footprint-drift"), []);
});

test("templatesFor rejects an invalid template", () => {
  assert.throws(
    () => templatesFor({ animation: { templates: [{ name: "bad" } as never] } }),
    InputError,
  );
});

/**
 * A strip shaped like Bram's real walk (#38): a body over the anchor and two paws, one planted
 * on the ground line and one lifted, the planted paw jumping 40–60 px between frames as the legs
 * alternate. `planted[k]` is the planted paw's left x in frame k + 1.
 */
function pawStrip(planted: number[]) {
  const width = 160;
  const height = 80;
  const anchor = { x: 80, y: 70 };
  const frames = planted.map((px) => {
    const r = createRaster(width, height);
    const paint = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) setPixel(r, x, y, [90, 80, 70, 255]);
    };
    paint(50, 30, 109, 60);
    paint(px, 61, px + 7, 70); // planted paw, on the ground line
    const lifted = px < 80 ? px + 50 : px - 50;
    paint(lifted, 61, lifted + 7, 65); // lifted paw, off the ground
    return r;
  });
  return { frames, frame: { width, height }, anchor };
}

const WALK_PAWS = [30, 90, 45, 100, 30, 90, 45, 100];
const footFails = (r: ReturnType<typeof checkAnimation>) =>
  r.reasons.filter((x) => x.check === "footprint-drift" && !x.passed);

test("footprint drift: a walk whose contacts alternate 40-70 px on the ground line passes", () => {
  const input = { ...pawStrip(WALK_PAWS), family: "walk-right" };
  const profile = {};
  const r = checkAnimation(input, {
    template: templateFor("walk-right", templatesFor(profile)),
    thresholds: thresholdsFor(profile),
    threshold: 128,
  });
  assert.deepEqual(footFails(r), []);
  const reason = r.reasons.find((x) => x.check === "footprint-drift");
  assert.match(reason!.reason, /contacts move/);
  // The same strip under the strict, planted reading fails every frame away from frame 1's paw.
  const strict = checkAnimation(input, {
    template: { ...templateFor("walk", templatesFor())!, footprint: "planted" },
    thresholds: thresholdsFor(),
    threshold: 128,
  });
  assert.equal(footFails(strict).length, 8);
});

test("footprint drift: a walk that slides over the cycle fails each slid frame against its phase", () => {
  const sliding = WALK_PAWS.map((x, i) => (i < 4 ? x : x + 10));
  const r = checkAnimation(
    { ...pawStrip(sliding), family: "walk-left" },
    {
      template: templateFor("walk-left", templatesFor()),
      thresholds: thresholdsFor(),
      threshold: 128,
    },
  );
  const bad = footFails(r);
  assert.deepEqual(
    bad.map((x) => x.frames),
    [[5], [6], [7], [8]],
  );
  assert.match(
    bad[0]!.reason,
    /^frame 5: footprint centre .* is 10 px from frame 1's .*, the same phase one stride earlier \(limit 20% of the 41 px figure = 8\.2 px\)/,
  );
  // One frame that slips is the only frame named.
  const one = [...WALK_PAWS];
  one[6] = 45 + 9;
  const single = footFails(
    checkAnimation(
      { ...pawStrip(one), family: "walk-left" },
      {
        template: templateFor("walk", templatesFor()),
        thresholds: thresholdsFor(),
        threshold: 128,
      },
    ),
  );
  assert.deepEqual(
    single.map((x) => x.frames),
    [[7]],
  );
  assert.match(single[0]!.reason, /^frame 7: .* 9 px from frame 3's/);
});

/**
 * An asymmetric hop like Bram's crouch-hop (#38): the paw crouches at one x early in the cycle
 * and lands at another x late, 9 frames, so the cycle does not split into two like halves.
 */
test("footprint drift: an asymmetric 9-frame hop is held to the loop's mean, frame by frame", () => {
  const profile = {
    animation: {
      templates: [
        {
          name: "crouch-hop",
          loop: true,
          frames: { min: 3, max: 16 },
          beats: [
            { name: "crouch", at: 0, contact: true },
            { name: "land", at: 0.8, contact: true },
          ],
          contact: "none",
          silhouette: { min: 0, max: 1 },
          footprint: "moving",
          footprintDrift: 0.2,
        },
      ],
    },
  } as unknown as Parameters<typeof animationQa>[1];
  const template = templateFor("crouch-hop", templatesFor(profile));
  assert.equal(template?.name, "crouch-hop");
  const opts = { template, thresholds: thresholdsFor(profile), threshold: 128 };
  const hop = [40, 40, 40, 40, 48, 48, 48, 48, 48];
  assert.deepEqual(footFails(checkAnimation({ ...pawStrip(hop), family: "crouch-hop" }, opts)), []);
  // The same layout with 8 frames gets the same verdict: no parity or half split.
  assert.deepEqual(
    footFails(checkAnimation({ ...pawStrip(hop.slice(0, 8)), family: "crouch-hop" }, opts)),
    [],
  );
  // A hop that slides a few px each frame fails on the frames that strayed, each named.
  const slide = [30, 33, 36, 39, 42, 45, 48, 51, 54];
  const bad = footFails(checkAnimation({ ...pawStrip(slide), family: "crouch-hop" }, opts));
  assert.deepEqual(
    bad.map((x) => x.frames),
    [[1], [2], [8], [9]],
  );
  assert.match(
    bad[0]!.reason,
    /^frame 1: .* 12 px from the loop's mean footprint centre .* \(limit 20% of the 41 px figure = 8\.2 px\)/,
  );
  // The strict reading (no template) fails it against frame 1.
  assert.ok(
    footFails(
      checkAnimation({ ...pawStrip(hop), family: "crouch-hop" }, { ...opts, template: undefined }),
    ).length > 0,
  );
});

test("templates: a hyphenated name serves exactly that family and its suffixes", () => {
  const own = (name: string) => ({
    name,
    loop: true,
    frames: { min: 2, max: 9 },
    beats: [],
    contact: "none",
    silhouette: { min: 0, max: 1 },
  });
  const templates = templatesFor({
    animation: { templates: [own("sit-groom"), own("sit")] },
  } as unknown as Parameters<typeof animationQa>[1]);
  assert.equal(templateFor("sit-groom", templates)?.name, "sit-groom");
  assert.equal(templateFor("sit-groom-left", templates)?.name, "sit-groom");
  assert.equal(templateFor("sit-up", templates)?.name, "sit");
  for (const bad of ["-sit", "sit-", "sit--groom", "Sit"]) {
    assert.throws(
      () => templatesFor({ animation: { templates: [own(bad)] } } as never),
      /name must be lowercase words/,
      bad,
    );
  }
  assert.throws(
    () => templatesFor({ animation: { templates: [{ ...own("hop"), strides: 0 }] } } as never),
    /strides must be a whole number/,
  );
});

test("footprint drift: planted families hold each frame to the previous planted one", () => {
  const shuffled = [40, 40, 40, 44, 40, 40];
  for (const family of ["idle", "sit-groom"]) {
    const r = checkAnimation(
      { ...pawStrip(shuffled), family },
      {
        template: templateFor(family, templatesFor()),
        thresholds: thresholdsFor(),
        threshold: 128,
      },
    );
    const bad = footFails(r);
    assert.deepEqual(
      bad.map((x) => x.frames),
      [[4], [5]],
      family,
    );
    assert.match(
      bad[0]!.reason,
      /^frame 4: footprint centre .* 4 px from frame 3's .*, the previous planted frame \(limit 3% of the 41 px figure = 1\.23 px\)/,
    );
    assert.match(bad[1]!.reason, /^frame 5: .* from frame 4's/);
  }
});

test("footprint drift: a target template marks its own family's contacts as moving", () => {
  const hop = [40, 40, 52, 30, 40, 40, 52, 30];
  const profile = {
    animation: {
      templates: [
        {
          name: "crouch",
          loop: true,
          frames: { min: 3, max: 16 },
          beats: [{ name: "crouch", at: 0, contact: true }],
          contact: "all",
          silhouette: { min: 0, max: 1 },
          footprint: "moving",
          strides: 2,
        },
      ],
    },
  } as unknown as Parameters<typeof animationQa>[1];
  const template = templateFor("crouch-hop", templatesFor(profile));
  assert.equal(template?.footprint, "moving");
  const opts = { thresholds: thresholdsFor(profile), threshold: 128 };
  const input = { ...pawStrip(hop), family: "crouch-hop" };
  assert.deepEqual(footFails(checkAnimation(input, { ...opts, template })), []);
  assert.ok(footFails(checkAnimation(input, { ...opts, template: undefined })).length > 0);
  assert.throws(
    () =>
      templatesFor({
        animation: {
          templates: [{ ...(profile!.animation!.templates![0] as object), footprint: "sliding" }],
        },
      } as never),
    /footprint must be "planted" or "moving"/,
  );
});

const quadFails = (input: ReturnType<typeof quadrupedWalk>, profile = {}, gait?: string) =>
  footFails(
    animationQa(
      { ...input, family: "walk-right", ...(gait !== undefined && { gait }) },
      profile,
      style("flat"),
    ),
  );

test("gait: a four-legged walk fails the two-stride rule and passes under gait quadruped", () => {
  const walk = quadrupedWalk(8);
  // No gait declared: today's two-legged rule, which a four-legged walk fails (#45).
  assert.deepEqual(
    quadFails(walk).map((x) => x.frames),
    [[5], [6], [7], [8]],
  );
  // The profile declares the gait: the walk template's quadruped rule applies and it passes.
  const profile = { animation: { gait: "quadruped" } };
  const r = animationQa({ ...walk, family: "walk-right" }, profile, style("flat"));
  assert.deepEqual(footFails(r), []);
  assert.equal(r.gait, "quadruped");
  assert.match(
    r.reasons.find((x) => x.check === "footprint-drift")!.reason,
    /within 11 px of the loop's mean footprint centre .* \(gait quadruped; footprint over the bottom 30% of the figure\)$/,
  );
  // The asset spec's gait wins over the profile's.
  assert.equal(quadFails(walk, profile, "biped").length, 4);
  assert.deepEqual(quadFails(walk, {}, "quadruped"), []);
});

test("gait: a four-legged walk whose legs slide in one frame fails that frame", () => {
  const bad = quadFails(quadrupedWalk(8, { 6: 30 }), {}, "quadruped");
  assert.deepEqual(
    bad.map((x) => x.frames),
    [[6]],
  );
  assert.match(
    bad[0]!.reason,
    /^frame 6: footprint centre .* px from the loop's mean footprint centre .* \(limit 20% of the 55 px figure = 11 px\) \(gait quadruped/,
  );
});

test("gait: a gait the template does not list keeps the template's own rule and says so", () => {
  const bad = quadFails(quadrupedWalk(8), {}, "biped");
  assert.equal(bad.length, 4);
  assert.match(
    bad[0]!.reason,
    /\(the walk template has no rule for gait biped, so its own applies\)$/,
  );
  // A template without gait rules (idle) is unaffected by the gait and does not mention it.
  const idle = animationQa(
    { ...quadrupedWalk(4), family: "idle" },
    { animation: { gait: "quadruped" } },
    style("flat"),
  );
  assert.doesNotMatch(idle.reasons.find((x) => x.check === "footprint-drift")!.reason, /gait/);
  // A gait name that is not a lowercase word is refused before any check runs.
  assert.throws(
    () =>
      animationQa({ ...quadrupedWalk(4), family: "walk", gait: "Four Legs" }, {}, style("flat")),
    (e: unknown) => e instanceof InputError && /invalid gait/.test(e.message),
  );
});

/**
 * A side-view animal at `s` px per unit (frame 64 units tall): a body, a head that bobs, four
 * legs planted on the ground and a long tail out one side, so its centre of mass sits far from
 * its box centre. Each frame is placed by its bounding-box centre on the anchor column, the way
 * postprocessFrames places a frame. `feet[k]` shifts frame k + 1's legs by that many px.
 */
function tailedAnimal(s: number, feet: number[], bob = [0, 1, 2, 1]) {
  const size = 64 * s;
  const anchor = { x: size / 2, y: 63 * s - 1 };
  const frames = feet.map((dx, k) => {
    const r = createRaster(size, size);
    const rect = (x0: number, y0: number, x1: number, y1: number, shift = 0) => {
      for (let y = y0 * s; y < (y1 + 1) * s; y++)
        for (let x = x0 * s + shift; x < (x1 + 1) * s + shift; x++)
          setPixel(r, x, y, [90, 80, 70, 255]);
    };
    // Drawn left-aligned, then moved so the box centre lands on the anchor column.
    rect(1, 38, 14, 39); // the long tail
    rect(15, 36, 36, 50); // body
    rect(37, 32 + (bob[k % bob.length] as number), 42, 40); // head
    rect(17, 51, 19, 62, dx); // legs
    rect(32, 51, 34, 62, dx);
    let left = size;
    let right = -1;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if ((r.data[(y * size + x) * 4 + 3] as number) > 0) {
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
    const out = createRaster(size, size);
    const move = Math.round(anchor.x - (left + right + 1) / 2);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        if ((r.data[i + 3] as number) > 0 && x + move >= 0 && x + move < size)
          setPixel(out, x + move, y, [90, 80, 70, 255]);
      }
    return out;
  });
  return { frames, frame: { width: size, height: size }, anchor };
}

const animalQa = (s: number, feet: number[], family = "sniff") =>
  animationQa({ ...tailedAnimal(s, feet), family }, {}, style("flat"));

test("a long-tailed animal placed by its box centre passes ground-contact and footprint-drift", () => {
  const input = tailedAnimal(1, [0, 0, 0, 0]);
  const r = animalQa(1, [0, 0, 0, 0]);
  assert.deepEqual(failed(r, "ground-contact"), []);
  assert.deepEqual(failed(r, "footprint-drift"), []);
  assert.deepEqual(
    r.reasons.filter((x) => x.check === "anchor-drift"),
    [],
  );
  // The centre of mass is well off the anchor, which is what the removed check used to fail.
  const m = r.measures[0]!;
  assert.ok(Math.abs(m.centerX - (input.anchor.x + 0.5)) > 3, String(m.centerX));
  assert.equal(r.figureHeightPx, 30);
});

test("the bounds are fractions of the figure's height, so a figure's scale does not change the verdict", () => {
  for (const [shift64, shift512, ok] of [
    [0, 0, true],
    [1, 8, false],
  ] as const) {
    const small = animalQa(1, [0, 0, shift64, 0]);
    const large = animalQa(8, [0, 0, shift512, 0]);
    assert.equal(small.figureHeightPx, 30);
    assert.equal(large.figureHeightPx, 240);
    assert.equal(failed(small, "footprint-drift").length === 0, ok);
    assert.equal(failed(large, "footprint-drift").length === 0, ok);
    assert.deepEqual(
      failed(small, "footprint-drift").map((x) => x.frames),
      failed(large, "footprint-drift").map((x) => x.frames),
    );
  }
  // 1 px is a tiny slip on a 512 px figure.
  assert.deepEqual(failed(animalQa(8, [0, 0, 1, 0]), "footprint-drift"), []);
});

test("planted feet that slide a little each frame fail footprint-drift against the previous frame", () => {
  const r = animalQa(8, [0, 10, 20, 30, 40, 50]);
  const bad = failed(r, "footprint-drift");
  assert.deepEqual(
    bad.map((x) => x.frames),
    [[2], [3], [4], [5], [6], [1]],
  );
  assert.match(
    bad[0]!.reason,
    /^frame 2: footprint centre .* 10 px from frame 1's .*, the previous planted frame \(limit 3% of the 240 px figure = 7\.2 px\)/,
  );
  assert.match(bad[1]!.reason, /^frame 3: .* from frame 2's/);
});

test("a long-tailed animal through stage's own placement passes ground-contact and footprint-drift", () => {
  // The source frames go through postprocessFrames, which places each by its box centre on the
  // anchor column and its bottom row on the anchor's row.
  const source = tailedAnimal(2, [0, 0, 0, 0]);
  const frame = { width: 64, height: 64 };
  const anchor = { x: 32, y: 63 };
  const { strip } = postprocessFrames(source.frames, {
    frame,
    frameCount: 4,
    anchor,
    palette: ["#5a5046"],
  });
  const frames = splitStrip(strip, frame);
  const r = animationQa({ frames, frame, anchor, family: "sniff" }, {}, style("pixel"));
  assert.deepEqual(failed(r, "ground-contact"), []);
  assert.deepEqual(failed(r, "footprint-drift"), []);
  const m = r.measures[0]!;
  assert.ok(Math.abs(m.centerX - (anchor.x + 0.5)) > 3, String(m.centerX));
});
