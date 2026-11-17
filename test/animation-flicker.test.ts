import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendDecisionLog,
  buildFlickerPrompt,
  checkFlicker,
  flickerPairs,
  flickerQuestion,
  planFlicker,
} from "../src/animation/flicker.ts";
import { Budget, BudgetExceededError } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { flattenFrame } from "../src/animation/preview.ts";
import { createRaster, decodePng, encodePng, setPixel } from "../src/image/raster.ts";
import { MIN_DECISION_EDGE, forDecision } from "../src/identity.ts";
import { defaultRoutes, type Routes } from "../src/routes.ts";

function frames(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const r = createRaster(4, 4);
    setPixel(r, i % 4, 0, [200, 10 * i, 30, 255]);
    return r;
  });
}

function setup(probabilities: number[], cap = 1, routes: Routes = defaultRoutes) {
  const provider = new ScriptedProvider({
    image: () => {
      throw new Error("no image calls expected");
    },
    vision: () => {
      throw new Error("flicker is a typed decision, not a vision call");
    },
    decide: (_request, index) => ({
      answer: { type: "boolean", probability: probabilities[index] ?? 0 },
    }),
  });
  const call = new Caller({
    provider,
    providerName: "scripted",
    budget: new Budget(cap),
    routes,
  });
  return { provider, call };
}

const base = { family: "walk", subject: "a fox", cutoff: 0.5 };

test("pairs are consecutive, plus the seam for a loop of more than two frames", () => {
  assert.deepEqual(flickerPairs(4, false), [
    [1, 2],
    [2, 3],
    [3, 4],
  ]);
  assert.deepEqual(flickerPairs(3, true).at(-1), [3, 1]);
  assert.equal(flickerPairs(2, true).length, 1);
});

test("each pair is one typed Boolean decision on the flicker route, asking whether the identity changes", async () => {
  const { call, provider } = setup([0.1]);
  await checkFlicker({ ...base, frames: frames(2), loop: false, call });
  assert.equal(provider.calls.length, 1);
  const sent = provider.calls[0];
  assert.equal(sent?.kind, "decide");
  assert.ok(sent && sent.kind === "decide");
  assert.equal(sent.request.operation, "flicker");
  assert.deepEqual(sent.request.question, flickerQuestion([1, 2]));
  assert.equal(sent.request.question.type, "boolean");
  assert.equal(
    sent.request.question.instructions,
    "Does the character's identity change between frame 1 and frame 2, setting aside pose and brush texture?",
  );
  assert.equal(call.records[0]?.decision?.question, "boolean");
});

test("a flicker flags the pair and names the frames, with its probability", async () => {
  const { call } = setup([0.9]);
  const { reasons, decisions } = await checkFlicker({
    ...base,
    frames: frames(2),
    loop: false,
    call,
  });
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0]?.passed, false);
  assert.equal(reasons[0]?.source, "decision");
  assert.deepEqual(reasons[0]?.frames, [1, 2]);
  assert.match(
    reasons[0]?.reason ?? "",
    /frame 1 → frame 2: flicker \(probability 0\.90 ≥ cutoff 0\.5\)/,
  );
  assert.equal(decisions[0]?.flagged, true);
});

test("a correct flicker at probability 0.65 flags the pair (the old 0.7 confidence cut hid it)", async () => {
  const { call } = setup([0.65]);
  const { reasons, decisions } = await checkFlicker({
    ...base,
    frames: frames(2),
    loop: false,
    call,
  });
  assert.equal(reasons[0]?.passed, false);
  assert.match(reasons[0]?.reason ?? "", /probability 0\.65/);
  assert.equal(decisions[0]?.label, "flicker");
  assert.equal(decisions[0]?.probability, 0.65);
  assert.equal(decisions[0]?.flagged, true);
});

test("a same answer passes and prints its probability; a person's cutoff applies to the probability", async () => {
  const { call } = setup([0.3, 0.65]);
  const { reasons, decisions } = await checkFlicker({
    ...base,
    cutoff: 0.8,
    frames: frames(3),
    loop: false,
    call,
  });
  assert.deepEqual(
    reasons.map((r) => r.passed),
    [true, true],
  );
  assert.match(
    reasons[0]?.reason ?? "",
    /frame 1 → frame 2: same \(probability 0\.30 < cutoff 0\.8\)/,
  );
  assert.equal(decisions[1]?.label, "flicker");
  assert.equal(decisions[1]?.flagged, false);
});

test("an answer of the wrong type fails the call", async () => {
  const provider = new ScriptedProvider({
    image: () => {
      throw new Error("no image calls expected");
    },
    vision: () => ({ text: "" }),
    decide: () => ({ answer: { type: "score", score: 1 } }),
  });
  const call = new Caller({
    provider,
    providerName: "scripted",
    budget: new Budget(1),
    routes: defaultRoutes,
  });
  await assert.rejects(checkFlicker({ ...base, frames: frames(2), loop: false, call }));
});

test("the decision log has one line per call, with model and probability", async () => {
  const { call } = setup([0.05, 0.8, 0.1]);
  const { decisions } = await checkFlicker({ ...base, frames: frames(3), loop: true, call });
  const dir = await mkdtemp(join(tmpdir(), "flicker-"));
  const path = join(dir, "nested", "flicker.jsonl");
  await appendDecisionLog(path, decisions);
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 3);
  const second = JSON.parse(lines[1] ?? "{}");
  assert.equal(second.model, defaultRoutes.flicker.model);
  assert.equal(second.requestId, "scripted-decide-1");
  assert.equal(second.label, "flicker");
  assert.equal(second.probability, 0.8);
  assert.equal(second.cutoff, 0.5);
});

test("a cap too small refuses before any provider call", async () => {
  const { call, provider } = setup([0.1], 0.0001);
  await assert.rejects(
    checkFlicker({ ...base, frames: frames(2), loop: false, call }),
    BudgetExceededError,
  );
  assert.equal(provider.calls.length, 0);
});

test("a routes override changes the model, and the plan reports it", async () => {
  const routes: Routes = {
    ...defaultRoutes,
    flicker: { ...defaultRoutes.flicker, model: "other/judge", estimatedCostUsd: 0.02 },
  };
  const { call } = setup([0.1], 1, routes);
  await checkFlicker({ ...base, frames: frames(2), loop: false, call });
  assert.equal(call.records[0]?.model, "other/judge");
  const plan = planFlicker(4, true, routes);
  assert.equal(plan.calls, 4);
  assert.equal(plan.model, "other/judge");
  assert.ok(Math.abs(plan.estimatedCostUsd - 0.08) < 1e-9);
});

test("the images sent are the two frames as PNG, flattened over the preview backdrop and enlarged to the decision size", async () => {
  const { call, provider } = setup([0.1]);
  const fs = frames(2);
  await checkFlicker({ ...base, frames: fs, loop: false, call });
  const sent = provider.calls[0]?.request;
  assert.ok(sent && "images" in sent);
  assert.deepEqual(
    sent.images.map((i) => i.bytes),
    fs.map((f) => {
      const bytes = encodePng(flattenFrame(f));
      return forDecision({ role: "", path: "", mediaType: "image/png", bytes, sha256: "" }, "crisp")
        .bytes;
    }),
  );
  // A 4 px frame goes as 384 px (some decision models reject small images, #27), crisp-edged.
  for (const image of sent.images) {
    const r = decodePng(image.bytes);
    assert.deepEqual([r.width, r.height], [MIN_DECISION_EDGE, MIN_DECISION_EDGE]);
  }
  // Opaque everywhere: a transparent pixel (a matte hole) shows the backdrop, not hidden colour.
  for (const image of sent.images) {
    const r = decodePng(image.bytes);
    for (let i = 3; i < r.data.length; i += 4) assert.equal(r.data[i], 255);
  }
  const first = decodePng(sent.images[0]!.bytes);
  // Source pixel (1, 0) is 96 px wide at 384: (100, 0) is the backdrop, (0, 0) the marked pixel.
  assert.deepEqual([...first.data.subarray(100 * 4, 100 * 4 + 4)], [236, 236, 236, 255]);
  assert.deepEqual([...first.data.subarray(95 * 4, 95 * 4 + 4)], [200, 0, 30, 255]);
  assert.match(sent.prompt, /image 1 is frame 1 and image 2 is frame 2/i);
  assert.match(buildFlickerPrompt({ ...base, pair: [3, 1] }), /frame 3/);
  assert.match(buildFlickerPrompt({ ...base, pair: [1, 2] }), /That is texture, not identity/);
});
