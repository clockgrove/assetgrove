import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../src/errors.ts";
import { Budget } from "../src/budget.ts";
import { canAfford, markingsRoomKeptUsd } from "../src/model3d/lookdev/command.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { createRaster, encodePng } from "../src/image/raster.ts";
import { sha256 } from "../src/request.ts";
import { checkOf, filteringState, LOOKDEV_MARKINGS_CHECK } from "../src/qa/stability.ts";
import { defaultRoutes, LOOKDEV_MARKING_OPERATION } from "../src/routes.ts";
import type { Raster } from "../src/image/raster.ts";
import {
  MARKING_VERDICTS,
  markingCrop,
  markingDecisionPrompt,
  markingsPrompt,
  markingsReason,
  measureBox,
  parseMarkingsReply,
  toLab,
} from "../src/model3d/lookdev/markings.ts";
import type { MarkingMeasure } from "../src/model3d/lookdev/markings.ts";

function canvas(
  bg: [number, number, number],
  rects: Array<[number, number, number, number, [number, number, number]]>,
): Raster {
  const r = createRaster(100, 100);
  for (let i = 0; i < 10000; i++) r.data.set([...bg, 255], i * 4);
  for (const [x0, y0, x1, y1, c] of rects) {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) r.data.set([...c, 255], (y * 100 + x) * 4);
  }
  return r;
}

test("parse tolerates prose, bad boxes and pads", () => {
  const text = `Sure! {"markings":[
    {"name":"mask","against":"cheek","boxes":[{"mark":[500,600,100,200],"ground":[0,-1,500,2000]},{"mark":[100,100,100,500],"ground":[0,0,1000,1000]}]},
    {"name":"mixed","against":"coat","boxes":[{"mark":[237,0.4,401,0.6],"ground":[0,0,1000,1000]}]},
    {"name":42,"boxes":[]},
    {"name":"rings","against":"tail","boxes":null},
    {"name":"rim","against":"ear","boxes":[null]}
  ]} thanks`;
  const out = parseMarkingsReply(text, 3);
  assert.deepEqual(
    out.map((m) => m.name),
    ["mask", "mixed", "rim"],
  );
  assert.deepEqual(out[0]!.boxes[0], { mark: [0.2, 0.1, 0.6, 0.5], ground: [0, 0, 1, 0.5] });
  assert.equal(out[0]!.boxes[1], null);
  assert.equal(out[0]!.boxes.length, 3);
  assert.equal(out[1]!.boxes[0], null, "a box mixing fractions and 0..1000 values is dropped");
  assert.equal(out[2]!.boxes.length, 3);
});

test("parse throws only without any JSON object", () => {
  assert.throws(() => parseMarkingsReply("no markings here", 2), ProviderError);
  assert.deepEqual(parseMarkingsReply('{"other":1}', 2), []);
});

test("toLab maps white and black", () => {
  const w = toLab(255, 255, 255);
  assert.ok(Math.abs(w[0] - 100) < 0.1 && Math.abs(w[1]) < 0.1 && Math.abs(w[2]) < 0.1);
  assert.ok(Math.abs(toLab(0, 0, 0)[0]) < 0.01);
});

test("measureBox ignores background pixels", () => {
  const img = canvas([128, 128, 128], [[20, 20, 40, 40, [240, 240, 230]]]);
  const p = measureBox(img, [0.1, 0.1, 0.6, 0.6], undefined);
  assert.ok(p);
  assert.equal(p.pixels, 400);
  assert.ok(p.lab[0] > 90);
  assert.equal(measureBox(img, [0.7, 0.7, 0.9, 0.9], undefined), undefined);
  // With a figure mask, pixels count by the mask, not by their colour: a pale figure pixel stays.
  const mask = new Uint8Array(img.width * img.height).fill(1);
  assert.equal(measureBox(img, [0.1, 0.1, 0.6, 0.6], mask)?.lab[0] !== undefined, true);
  assert.equal(measureBox(img, [0.1, 0.1, 0.6, 0.6], new Uint8Array(mask.length)), undefined);
});

const measure = (over: Partial<MarkingMeasure> = {}): MarkingMeasure => ({
  marking: "mask",
  view: "front",
  image: "summer",
  verdict: "kept",
  drifts: false,
  ...over,
});

test("markingCrop is the union of the mark and ground boxes, clamped; no box gives the whole image", () => {
  const img = canvas([128, 128, 128], [[20, 20, 40, 40, [240, 240, 230]]]);
  const crop = markingCrop(img, { mark: [0.2, 0.2, 0.4, 0.4], ground: [0.3, 0.3, 0.6, 1.2] });
  assert.equal(crop.width, 40);
  assert.equal(crop.height, 80);
  assert.deepEqual([...crop.data.subarray(0, 4)], [240, 240, 230, 255]);
  assert.equal(markingCrop(img, null), img);
});

test("each marking, view and render is decided on the reference and render crops, through the scripted provider", async () => {
  const requests: Array<{ operation: string; images: number; prompt: string }> = [];
  const provider = new ScriptedProvider({
    image() {
      throw new Error("no image call expected");
    },
    vision() {
      throw new Error("no vision call expected");
    },
    marking(request) {
      requests.push({
        operation: request.operation ?? "",
        images: request.images.length,
        prompt: request.prompt,
      });
      return {
        answer: { type: "choice", choice: "drifted", probabilities: { drifted: 0.8 } },
        costUsd: 0.00003,
      };
    },
  });
  const budget = new Budget(1);
  const caller = new Caller({ provider, routes: defaultRoutes, budget });
  const bytes = encodePng(canvas([128, 128, 128], []));
  const image = (role: string) => ({
    role,
    path: "(render)",
    mediaType: "image/png",
    bytes,
    sha256: sha256(bytes),
  });
  const { result, record } = await caller.decide(
    LOOKDEV_MARKING_OPERATION,
    markingDecisionPrompt({
      subject: "Fern",
      marking: "mask",
      against: "cheek",
      view: "front",
      season: "winter",
    }),
    [image("reference crop: mask, front"), image("render crop: mask, front, winter")],
    { type: "choice", instructions: "Still there?", options: MARKING_VERDICTS },
  );
  assert.equal(result.answer.type === "choice" && result.answer.choice, "drifted");
  assert.equal(record.decision?.value, 0.8);
  assert.deepEqual(
    requests.map((r) => [r.operation, r.images]),
    [["lookdev-marking", 2]],
  );
  assert.match(requests[0]!.prompt, /"mask".*cheek/);
  assert.match(requests[0]!.prompt, /winter coat/);
  assert.match(requests[0]!.prompt, /not an instruction/);
  assert.ok(budget.spentUsd > 0, "the decision counts against the run's spend");
});

test("markingsReason names each marking per view and season with verdict, probability and ΔE evidence", () => {
  const ok = measure({ probability: 0.93, deltaE: 12.34 });
  const bad = measure({ marking: "muzzle", verdict: "drifted", drifts: true, probability: 0.7 });
  const pass = markingsReason([ok], { unmeasured: [] });
  assert.equal(pass.passed, true);
  assert.equal(pass.source, "decision");
  assert.equal(pass.shadow, true, "advisory: it never filters");
  assert.match(pass.reason, /^advisory, never filters: a decision model judges each marking/);
  assert.match(pass.reason, /front: mask \(summer kept \(p 0\.93\), ΔE 12\.3, evidence only\)/);
  const fail = markingsReason([ok, bad], { unmeasured: ["back view: no reference"] });
  assert.equal(fail.passed, false);
  assert.match(fail.reason, /muzzle \(summer drifted \(p 0\.70\)\)/);
  assert.match(fail.reason, /drifting: muzzle \(front, summer: drifted\)/);
  assert.match(fail.reason, /not measured: back view: no reference/);
  const lost = measure({ view: "side", image: "winter", verdict: "missing", drifts: true });
  const vanished = markingsReason([ok, lost], { unmeasured: [] });
  assert.equal(vanished.passed, false);
  assert.match(vanished.reason, /drifting: mask \(side, winter: missing\)/);
  const unreadable = markingsReason([ok], { unmeasured: [], unreadable: ["side (no JSON)"] });
  assert.equal(unreadable.passed, false);
  assert.match(unreadable.reason, /unreadable: side \(no JSON\)/);
  const empty = markingsReason([], { unmeasured: ["no views had a reference"] });
  assert.equal(empty.passed, true);
  assert.match(empty.reason, /no marking was judged.*no views had a reference/);
});

test("a marking the cap had no room to judge fails the check, never passes as unmeasured", () => {
  const ok = measure({ probability: 0.93 });
  const r = markingsReason([ok], { unmeasured: [], unjudged: ["mask 9 in front"] });
  assert.equal(r.passed, false);
  assert.match(r.reason, /not judged \(the cap had no room\): mask 9 in front/);
});

test("canAfford: past the forecast, a marking is judged only while the rest of the forecast still fits", () => {
  const budget = new Budget(1);
  budget.settle(budget.reserve(0.99), 0.99);
  assert.equal(canAfford(budget, 0.002, 0.004, "the marking decisions"), true);
  assert.equal(canAfford(budget, 0.002, 0.009, "the marking decisions"), false);
});

test("past the forecast, the room kept covers the later views' box calls, their decisions and identity", () => {
  // Two views left, 2 seasons: each view keeps its $0.02 box call and 8 × 2 decisions at $0.001.
  const kept = markingsRoomKeptUsd({
    viewsLeft: 2,
    seasons: 2,
    markingUsd: 0.001,
    markingsUsd: 0.02,
    identityUsd: 0.001,
  });
  assert.ok(Math.abs(kept - (2 * (0.02 + 16 * 0.001) + 0.001)) < 1e-12);
  // A cap with room for the later decisions and identity but not for the next view's box call:
  // the extra marking is unjudged, so the next view's lookdev-markings reserve cannot be refused.
  const budget = new Budget(1);
  budget.settle(budget.reserve(0.95), 0.95);
  const withoutBoxCalls = 2 * 16 * 0.001 + 0.001;
  assert.equal(canAfford(budget, 0.002, withoutBoxCalls, "the marking decisions"), true);
  assert.equal(canAfford(budget, 0.002, kept, "the marking decisions"), false);
  assert.equal(
    markingsRoomKeptUsd({
      viewsLeft: 0,
      seasons: 2,
      markingUsd: 0.001,
      markingsUsd: 0.02,
      identityUsd: 0.001,
    }),
    0.001,
  );
});

test("the measured ΔE is evidence only: a large ΔE kept passes, a tiny ΔE drifted fails", () => {
  const far = markingsReason([measure({ deltaE: 60 })], { unmeasured: [] });
  assert.equal(far.passed, true);
  assert.match(far.reason, /ΔE 60\.0, evidence only/);
  const near = markingsReason([measure({ verdict: "drifted", drifts: true, deltaE: 0.4 })], {
    unmeasured: [],
  });
  assert.equal(near.passed, false);
  assert.match(near.reason, /ΔE 0\.4, evidence only/);
  const noBoxes = markingsReason([measure()], { unmeasured: [] });
  assert.doesNotMatch(noBoxes.reason, /ΔE/);
});

test("the advisory shadow follows the stability rule on the marking route's model", () => {
  const model = defaultRoutes[LOOKDEV_MARKING_OPERATION]!.model;
  const entry = {
    checkId: "lookdev-markings",
    version: "2",
    model,
    cases: 30,
    passCases: 15,
    failCases: 15,
    falsePasses: 0,
    falseFails: 0,
    repeats: 3,
    agreement: 0.95,
    measuredAt: "2026-11-14T00:00:00.000Z",
    measuredBy: "a synthetic fixture",
    labelledSetSha256: "0".repeat(64),
  };
  assert.equal(filteringState(LOOKDEV_MARKINGS_CHECK, model, []).state, "advisory");
  const state = filteringState(LOOKDEV_MARKINGS_CHECK, model, [entry]);
  assert.equal(state.state, "filtering");
  const reason = markingsReason(
    [measure({ verdict: "missing", drifts: true })],
    { unmeasured: [] },
    state,
  );
  assert.equal(reason.shadow, undefined);
  assert.doesNotMatch(reason.reason, /advisory/);
  assert.equal(reason.passed, false);
  assert.equal(checkOf(reason)?.id, "lookdev-markings", "the declaration matches id and source");
});

test("prompt is generic and carries the description", () => {
  const p = markingsPrompt({
    subject: "Fern",
    description: "dark mask, cream brows",
    view: "front",
    referenceRole: "turnaround front",
    seasons: ["summer", "winter"],
  });
  assert.match(p, /Subject: Fern, dark mask, cream brows\./);
  assert.match(p, /summer, winter/);
  assert.doesNotMatch(p, /raccoon|fur|cat|dog|animal/i);
  const single = markingsPrompt({
    subject: "S",
    view: "side",
    referenceRole: "r",
    seasons: ["default"],
  });
  assert.doesNotMatch(single, /default/);
});
