import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  planAnimationQa,
  runAnimationQa,
  stripTarget,
  TEMPLATE_LOG,
} from "../src/animation/commands.ts";
import type { StripTarget } from "../src/animation/commands.ts";
import { TemplateChooser } from "../src/animation/template-choice.ts";
import { BUILTIN_TEMPLATES, templateFor, templatesFor } from "../src/animation/templates.ts";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { InputError } from "../src/errors.ts";
import type { DecisionRequest } from "../src/gateway/provider.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { encodePng } from "../src/image/raster.ts";
import { defaultRoutes } from "../src/routes.ts";
import type { TargetProfile } from "../src/types.ts";
import { syntheticStrip } from "./fixtures/strip.ts";
import type { StripOptions } from "./fixtures/strip.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const profile: TargetProfile = {
  ...syntheticProfile(),
  style: { alpha: { mode: "binary" }, color: { rule: "full" } },
  frames: { width: 64, height: 64, durationMs: 100 },
};

async function strip(
  name: string,
  opts: Partial<StripOptions>,
  family: string,
  extra: { subject?: string; template?: string } = {},
): Promise<StripTarget> {
  const root = await mkdtemp(join(tmpdir(), "assetgrove-template-choice-"));
  const { strip: raster } = syntheticStrip({ count: 8, style: "flat", motion: "walk", ...opts });
  const path = join(root, `${name}.png`);
  await writeFile(path, encodePng(raster));
  return stripTarget({ path, family, profile, ...extra });
}

interface Setup {
  /** What the motion-template decision answers, with its cost. */
  answer?: (request: DecisionRequest) => string;
  costUsd?: number;
}

function provider({ answer = () => "none", costUsd = 0 }: Setup = {}) {
  const asked: DecisionRequest[] = [];
  const scripted = new ScriptedProvider({
    image: () => {
      throw new Error("no image calls expected");
    },
    vision: () => {
      throw new Error("no vision calls expected");
    },
    // Every identity-flicker decision answers that the identity holds.
    decide: () => ({ answer: { type: "boolean", probability: 0.03 }, costUsd: 0.01 }),
    motionTemplate: (request) => {
      asked.push(request);
      return { answer: { type: "choice", choice: answer(request) }, costUsd };
    },
  });
  return { scripted, asked };
}

const qaRun = async (targets: StripTarget[], setup?: Setup, vision = true) => {
  const { scripted, asked } = provider(setup);
  const out = await mkdtemp(join(tmpdir(), "assetgrove-template-qa-"));
  const run = await runAnimationQa({
    targets,
    outDir: out,
    routes: defaultRoutes,
    capUsd: 5,
    provider: { provider: scripted, name: "scripted" },
    vision,
  });
  return { ...run, scripted, asked, outDir: out };
};

type Reason = { check: string; passed: boolean; reason: string };
const reasonOf = (reasons: Reason[], check: string) => reasons.find((r) => r.check === check)!;
/** The frame pairs the identity-flicker calls compared, as "a>b". */
const flickerCalls = (scripted: ScriptedProvider) =>
  scripted.calls.flatMap((c) => {
    if (c.kind !== "decide" || c.request.operation !== "flicker") return [];
    const m = /Image 1 is frame (\d+) and image 2 is frame (\d+)\b/.exec(c.request.prompt);
    return m ? [`${m[1]}>${m[2]}`] : [];
  });

test("templateFor matches a template's exact name only: no prefix, no suffix", () => {
  assert.equal(templateFor("play-dead", BUILTIN_TEMPLATES), undefined);
  assert.equal(templateFor("walk-left", BUILTIN_TEMPLATES), undefined);
  assert.equal(templateFor("walk", BUILTIN_TEMPLATES)?.name, "walk");
  assert.equal(templateFor("play", BUILTIN_TEMPLATES)?.name, "play");
});

test("a jump with airborne frames, judged none, passes contact and footprint as not applicable", async () => {
  const target = await strip("jump", { motion: "hop", count: 5 }, "jump");
  const { results, asked } = await qaRun([target], undefined, false);
  assert.equal(asked.length, 1);
  const report = results[0]!.report;
  assert.equal(report.template, undefined);
  assert.equal(report.templateSource, "judged");
  for (const check of ["ground-contact", "footprint-drift"]) {
    const r = reasonOf(report.reasons, check);
    assert.equal(r.passed, true, check);
    assert.match(r.reason, /not applicable/, check);
  }
  assert.equal(
    report.reasons.filter((r) => !r.passed && /ground|footprint/.test(r.check)).length,
    0,
  );
});

test("a one-shot death whose last frame differs from the first passes the loop seam, with no seam flicker call", async () => {
  const target = await strip("death", { seamBreak: true }, "death");
  const { results, scripted } = await qaRun([target]);
  const report = results[0]!.report;
  assert.equal(report.templateSource, "judged");
  const seam = reasonOf(report.reasons, "loop-seam");
  assert.equal(seam.passed, true);
  assert.match(seam.reason, /not applicable/);
  assert.equal(report.identityFlicker, "checked");
  assert.deepEqual(
    flickerCalls(scripted),
    [1, 2, 3, 4, 5, 6, 7].map((i) => `${i}>${i + 1}`),
  );
  assert.equal(results[0]!.decisions.length, 7);
});

test("the same death strip declared a looping template is held to its seam and pays the seam call", async () => {
  const target = await strip("death", { seamBreak: true }, "death", { template: "walk" });
  const { results, scripted, asked } = await qaRun([target]);
  assert.equal(asked.length, 0);
  assert.equal(results[0]!.report.templateSource, "declared");
  assert.equal(results[0]!.decisions.length, 8);
  assert.ok(flickerCalls(scripted).includes("8>1"));
});

test("play-dead is decided by the call, not given play by its prefix; the request names every template, the family and the subject", async () => {
  const target = await strip("play-dead", {}, "play-dead", { subject: "a sleepy fox" });
  const { results, asked } = await qaRun(
    [target],
    { answer: () => "idle", costUsd: 0.0005 },
    false,
  );
  assert.equal(asked.length, 1);
  const request = asked[0]!;
  assert.equal(request.operation, "motion-template");
  assert.equal(request.question.type, "choice");
  const options = Object.keys(
    (request.question as unknown as { options: Record<string, string> }).options,
  );
  assert.deepEqual(options, [...BUILTIN_TEMPLATES.map((t) => t.name), "none"]);
  assert.match(request.prompt, /play-dead/);
  assert.match(request.prompt, /a sleepy fox/);
  const report = results[0]!.report;
  assert.equal(report.template, "idle");
  assert.equal(report.templateSource, "judged");

  const none = await qaRun([target], { answer: () => "none" }, false);
  assert.equal(none.results[0]!.report.template, undefined);
});

test("a declared template makes no motion-template call; none declared is not applicable; an unknown one is an input error", async () => {
  const declared = await strip("walk-right", {}, "walk-right", { template: "walk" });
  const one = await qaRun([declared], undefined, false);
  assert.equal(one.asked.length, 0);
  assert.equal(one.results[0]!.report.template, "walk");
  assert.equal(one.results[0]!.report.templateSource, "declared");

  const hop = await strip("jump", { motion: "hop", count: 5 }, "jump", { template: "none" });
  const two = await qaRun([hop], undefined, false);
  assert.equal(two.asked.length, 0);
  assert.equal(two.scripted.calls.length, 0);
  assert.equal(two.results[0]!.report.template, undefined);
  assert.equal(two.results[0]!.report.templateSource, "declared");
  assert.match(reasonOf(two.results[0]!.report.reasons, "ground-contact").reason, /not applicable/);

  const bad = await strip("jump", {}, "jump", { template: "glide" });
  await assert.rejects(
    () => qaRun([bad], undefined, false),
    (e: unknown) => e instanceof InputError && /glide/.test(e.message),
  );
});

test("the decision is made once per family and subject, and counts against the run's spend", async () => {
  const a = await strip("fly-a", {}, "fly", { subject: "a bat" });
  const b = await strip("fly-b", {}, "fly", { subject: "a bat" });
  const c = await strip("fly-c", {}, "fly", { subject: "a moth" });
  const one = await qaRun([a, b], { costUsd: 0.0005 }, false);
  assert.equal(one.asked.length, 1);
  assert.equal(one.spentUsd.toFixed(4), "0.0005");
  const two = await qaRun([a, b, c], { costUsd: 0.0005 }, false);
  assert.equal(two.asked.length, 2);
  assert.equal(two.spentUsd.toFixed(4), "0.0010");
});

test("the plan forecasts one motion-template call per undecided family at the route's price", async () => {
  const fly = await strip("fly", {}, "fly");
  const fly2 = await strip("fly2", {}, "fly");
  const named = await strip("walk", {}, "walk");
  const declared = await strip("jump", {}, "jump", { template: "none" });
  const plan = await planAnimationQa([fly, fly2, named, declared], defaultRoutes, 5, false, true);
  assert.deepEqual(
    plan.perFamily.map((f) => f.templateCalls),
    [1, 0, 0, 0],
  );
  assert.equal(plan.calls, 1);
  assert.equal(plan.estimateUsd, defaultRoutes["motion-template"]!.estimatedCostUsd);
  assert.equal(plan.estimateUsd, 0.001);
});

test("the flicker forecast reads a recorded decision: no seam pair for a family decided as none", async () => {
  const undecided = await strip("fly", {}, "fly");
  const none = { ...(await strip("fly-none", {}, "fly")), judgedTemplate: "none" };
  const walk = { ...(await strip("fly-walk", {}, "fly")), judgedTemplate: "walk" };
  const plan = await planAnimationQa([undecided, none, walk], defaultRoutes, 5, true, false);
  // 8 frames: 7 consecutive pairs, plus the last-to-first pair only while the strip may loop.
  assert.deepEqual(
    plan.perFamily.map((f) => f.flickerCalls),
    [8, 7, 8],
  );
});

test("each motion-template decision is logged with its call to motion-template.jsonl, apart from the flicker log", async () => {
  const jump = await strip("jump", { motion: "walk" }, "jump", { subject: "fox" });
  const run = await qaRun([jump], { answer: () => "none", costUsd: 0.001 }, false);
  assert.equal(run.templateDecisions.length, 1);
  const line = run.templateDecisions[0]!;
  assert.equal(line.family, "jump");
  assert.equal(line.subject, "fox");
  assert.equal(line.template, "none");
  assert.equal(line.model, defaultRoutes["motion-template"]!.model);
  assert.equal(line.requestId, "scripted-motion-template-0");
  assert.equal(line.costUsd, 0.001);
  const logged = (await readFile(join(run.outDir, TEMPLATE_LOG), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.deepEqual(logged, [line]);
  // A --no-vision run writes no flicker log.
  await assert.rejects(access(join(run.outDir, "flicker.jsonl")));
});

test("a scripted provider with no motionTemplate answer refuses the decision instead of answering none", async () => {
  const scripted = new ScriptedProvider({
    image: () => {
      throw new Error("no image calls expected");
    },
    vision: () => ({ text: "" }),
  });
  const call = new Caller({
    provider: scripted,
    providerName: "scripted",
    budget: new Budget(1),
    routes: defaultRoutes,
  });
  await assert.rejects(
    new TemplateChooser(templatesFor(profile), call).choose({ family: "jump", subject: "fox" }),
    /no motionTemplate answer/,
  );
});

test("a chooser with no caller leaves an unnamed family undecided", async () => {
  const chooser = new TemplateChooser(BUILTIN_TEMPLATES);
  assert.equal((await chooser.choose({ family: "swim", subject: "a fish" })).source, "undecided");
  assert.equal((await chooser.choose({ family: "idle", subject: "a fish" })).source, "named");
  const { scripted, asked } = provider({ answer: () => "walk" });
  const call = new Caller({
    provider: scripted,
    providerName: "scripted",
    budget: new Budget(1),
    routes: defaultRoutes,
  });
  const decided = new TemplateChooser(BUILTIN_TEMPLATES, call);
  const choice = await decided.choose({ family: "walk-left", subject: "a fish" });
  assert.equal(choice.template?.name, "walk");
  assert.equal(choice.source, "judged");
  await decided.choose({ family: "walk-left", subject: "a fish" });
  assert.equal(asked.length, 1);
});

test("a profile template named none is rejected", () => {
  assert.throws(
    () =>
      templatesFor({
        animation: {
          templates: [
            {
              name: "none",
              loop: true,
              frames: { min: 2, max: 8 },
              beats: [],
              contact: "all",
              silhouette: { min: 0, max: 1 },
            },
          ],
        },
      } as never),
    (e: unknown) => e instanceof InputError && /"none" is reserved/.test(e.message),
  );
});
