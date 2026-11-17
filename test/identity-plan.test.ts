import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import { InputError, ProviderError } from "../src/errors.ts";
import { applyPlan, createPlan } from "../src/planning.ts";
import { IDENTITY_CHECK_OPERATION, defaultRoutes } from "../src/routes.ts";
import type { Routes } from "../src/routes.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import type { DecisionRequest } from "../src/gateway/provider.ts";
import { createRaster, decodeImage, encodePng, setPixel } from "../src/image/raster.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";
import type { TargetProfile } from "../src/types.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const spec = { kind: "still", assetId: "den" };

/** The identity mode a saved plan's operations imply; undefined when it plans no scoring. */
function modeOf(operations: readonly string[]): string | undefined {
  if (operations.includes(IDENTITY_CHECK_OPERATION)) return "enforce";
  if (operations.includes("identity") || operations.includes("identity-cast")) return "shadow";
  return undefined;
}

/** Writes the bible's own identity-eval record, as `identity-eval --record` does, for the default routes' models. */
async function recordThresholds(
  dir: string,
  thresholds: { score: number; cast: number },
  barMet = true,
) {
  const entry = (question: "score" | "cast", model: string, threshold: number) => ({
    question,
    model,
    threshold,
    recordedAt: "2026-01-01T00:00:00.000Z",
    eval: {
      casesFile: "cases.json",
      casesSha256: "0".repeat(64),
      cases: 10,
      scored: 10,
      falseAcceptRate: 0,
      falseRejectRate: 0,
      barMet,
    },
  });
  await writeFile(
    join(dir, "identity-thresholds.json"),
    JSON.stringify({
      format: "assetgrove-identity-thresholds/1",
      entries: [
        entry("score", defaultRoutes["identity"]!.model, thresholds.score),
        entry("cast", defaultRoutes["identity-cast"]!.model, thresholds.cast),
      ],
    }),
  );
}

async function fixture(withLock = true, withRecord = true) {
  const root = await mkdtemp(join(tmpdir(), "identity-plan-"));
  roots.push(root);
  const dir = join(root, ".assetgrove/art-direction");
  await mkdir(dir, { recursive: true });
  await mkdir(join(root, ".assetgrove/prompts"), { recursive: true });
  const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  data.referenceLicense = "NOASSERTION";
  data.world = "Woodland";
  if (withLock) {
    await writeFile(join(dir, "turn.png"), encodePng(createRaster(2, 2)));
    data.identities["den"] = {
      version: "7",
      approved: true,
      turnaround: "turn.png",
      signatureFeatures: ["white muzzle"],
      proportions: "round",
      palette: ["#292433"],
    };
  }
  const biblePath = join(dir, "BIBLE.md");
  if (withRecord) await recordThresholds(dir, { score: 0.68, cast: 0.5 });
  await writeFile(
    biblePath,
    serializeBible(data, "## Do's and Don'ts\nDo preserve identity. Don't add text.\n"),
  );
  await writeFile(
    join(root, ".assetgrove/prompts/default.md"),
    "# Prompt template v1\nCreate original art.\n{{constitution}}\n{{spec}}\n{{brief}}\n{{settings}}\n{{family}}\n",
  );
  return { root, biblePath };
}

/**
 * Candidate n gets the n-th answer, on the 0..4 rubric; a number below 0 makes the call fail. The
 * cast question always answers "den", on-model 0.6.
 */
function scripted(answers: number[], checkFails = false) {
  const image = createRaster(4, 4);
  setPixel(image, 1, 1, [120, 90, 80, 255]);
  return new ScriptedProvider({
    image: () => ({ images: [{ mediaType: "image/png", bytes: encodePng(image) }] }),
    vision: (request) => ({
      // Enforce mode first checks the record against its references (#92); this one agrees.
      text: request.prompt.includes("For each written claim")
        ? checkFails
          ? "not json"
          : JSON.stringify({ consistent: true, conflicts: [] })
        : request.prompt.includes('"onModel": p')
          ? JSON.stringify({ choice: "den", onModel: 0.6, reason: "on-model enough" })
          : JSON.stringify({ styleScore: 1, passed: true, reason: "constitution matches" }),
    }),
    decide: (_request, index) => {
      const score = answers[index] as number;
      if (score < 0) throw new Error("decision model offline");
      return { answer: { type: "score", score }, confidence: 0.8 };
    },
  });
}

async function run(
  answers: number[],
  options: {
    profile?: Partial<TargetProfile>;
    withLock?: boolean;
    withRecord?: boolean;
    identityMode?: string;
    routes?: Routes;
    provider?: ScriptedProvider;
  } = {},
) {
  const f = await fixture(options.withLock ?? true, options.withRecord ?? true);
  const provider = options.provider ?? scripted(answers);
  const specPath = join(f.root, "spec.json");
  const runOptionsPath = join(f.root, "run-options.json");
  const profilePath = join(f.root, "profile.json");
  await writeFile(specPath, JSON.stringify(spec));
  await writeFile(runOptionsPath, JSON.stringify({ candidates: answers.length }));
  await writeFile(profilePath, JSON.stringify(syntheticProfile(options.profile)));
  const plan = await createPlan({
    biblePath: f.biblePath,
    specPath,
    runOptionsPath,
    profilePath,
    ...(options.identityMode && { identityMode: options.identityMode }),
    ...(options.routes && { routes: options.routes }),
  });
  const logs: string[] = [];
  const result = await applyPlan(plan.plan, {
    provider,
    ...(options.routes && { routes: options.routes }),
    outDir: join(f.root, "runs"),
    log: (m) => logs.push(m),
  });
  return { plan, mode: modeOf(plan.plan.operations), provider, logs, ...result };
}

test("shadow mode, the default, scores a below-threshold candidate without filtering it", async () => {
  const { mode, run: record, provider, logs } = await run([0.5, 3.6]);
  assert.equal(mode, "shadow");
  assert.equal(record.candidates.length, 2);
  assert.equal(record.filtered, 0);
  const low = record.candidates[0]!;
  assert.equal((low.fields["identity"] as { passed: boolean }).passed, false);
  assert.equal(low.provenance.identity?.lockVersion, "7");
  const reason = low.reasons.find((r) => r.check === "identity-lock")!;
  assert.equal(reason.shadow, true);
  assert.equal(reason.passed, false);
  const decision = low.provenance.calls.find((c) => c.operation === "identity")!.decision!;
  assert.ok(decision.label && decision.confidence === 0.8 && decision.latencyMs >= 0);
  assert.equal(record.identity?.lockVersion, "7");
  assert.equal(record.identity?.agreement.identityOnlyFailed, 1);
  assert.equal(record.identity?.scores, 2);
  assert.equal(
    provider.calls.filter((c) => c.kind === "decide" && c.request.operation !== "style-verdict")
      .length,
    2,
  );
  assert.ok(logs.some((m) => m.startsWith("identity ")));
});

test("enforce mode filters the below-threshold candidate and says why", async () => {
  const { mode, run: record } = await run([0.5, 3.6], {
    profile: { identity: { mode: "enforce" } },
  });
  assert.equal(mode, "enforce");
  assert.deepEqual(
    record.candidates.map((c) => c.id),
    ["c2"],
  );
  assert.equal(record.filtered, 1);
  assert.equal(record.rejections?.length, 1);
  assert.equal(record.rejections?.[0]?.candidate, 1);
  assert.equal(record.rejections?.[0]?.reasons[0]?.check, "identity-lock");
  assert.match(record.rejections![0]!.reasons[0]!.reason, /lock 7/);
  assert.equal(record.candidates[0]!.reasons.at(-1)?.passed, true);
  assert.equal(record.candidates[0]!.reasons.at(-1)?.shadow, undefined);
});

test("enforce mode checks the record against its references once per run", async () => {
  const { provider } = await run([3.6, 3.6, 3.6], {
    profile: { identity: { mode: "enforce" } },
  });
  const checks = provider.calls.filter(
    (c) => c.kind === "vision" && c.request.prompt.includes("For each written claim"),
  );
  assert.equal(checks.length, 1);
});

test("the plan records the record check's route from the routes it plans with", async () => {
  const checkRoute = {
    ...defaultRoutes[IDENTITY_CHECK_OPERATION]!,
    model: "test/record-checker",
    estimatedCostUsd: 0.05,
  };
  const shadow = await run([3.6]);
  assert.equal(shadow.plan.plan.operations.includes(IDENTITY_CHECK_OPERATION), false);
  const { plan, provider } = await run([3.6], {
    profile: { identity: { mode: "enforce" } },
    routes: { ...defaultRoutes, [IDENTITY_CHECK_OPERATION]: checkRoute },
  });
  assert.ok(plan.plan.operations.includes(IDENTITY_CHECK_OPERATION));
  assert.ok(
    Math.abs(
      plan.forecast.generationUsd -
        shadow.plan.forecast.generationUsd -
        checkRoute.estimatedCostUsd,
    ) < 1e-9,
  );
  const checks = provider.calls.filter(
    (c) => c.kind === "vision" && c.request.prompt.includes("For each written claim"),
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0]!.request.model, "test/record-checker");
});

test("the mode option overrides the profile, and off plans no scoring", async () => {
  const enforced = await run([3.6], { identityMode: "enforce" });
  assert.equal(enforced.mode, "enforce");
  const off = await run([3.6], { identityMode: "off" });
  assert.equal(off.mode, undefined);
  assert.equal(off.run.identity, undefined);
});

test("the cast question with no threshold set plans, scores and records at 0.5", async () => {
  const cast = await run([3.6], {
    profile: { identity: { mode: "enforce", question: "cast" } },
  });
  assert.ok(cast.plan.plan.operations.includes("identity-cast"));
  assert.equal(cast.run.identity?.threshold, 0.5);
  // On-model 0.6 passes at 0.5, where the score question's 0.68 would filter it.
  assert.equal(cast.run.filtered, 0);
  const scored = cast.run.candidates[0]!.provenance.identity!;
  assert.equal(scored.threshold, 0.5);
  assert.equal(scored.passed, true);
  assert.match(scored.reason, /^identity 0\.60 >= threshold 0\.5 /);
  // An explicit threshold wins over the cast default.
  const strict = await run([3.6], {
    profile: { identity: { mode: "enforce", question: "cast", threshold: 0.68 } },
  });
  assert.equal(strict.run.identity?.threshold, 0.68);
  assert.equal(strict.run.filtered, 1);
  // The score question keeps 0.68.
  const score = await run([3.6]);
  assert.equal(score.run.identity?.threshold, 0.68);
});

test("enforce mode refuses a bible with no identity-eval of its own, naming the bible and model", async () => {
  await assert.rejects(
    run([3.6], { profile: { identity: { mode: "enforce" } }, withRecord: false }),
    (error: unknown) =>
      error instanceof InputError &&
      /enforce needs an identity-eval of this bible for this model/.test(error.message) &&
      /BIBLE\.md/.test(error.message) &&
      error.message.includes(defaultRoutes["identity"]!.model) &&
      /identity-eval --record/.test(error.message),
  );
  const shadow = await run([3.6], { withRecord: false });
  assert.equal(shadow.run.identity?.threshold, 0.68);
});

test("enforce mode uses the recorded threshold; the profile's own threshold still wins", async () => {
  const f = await fixture();
  await recordThresholds(join(f.root, ".assetgrove/art-direction"), { score: 0.4, cast: 0.5 });
  const specPath = join(f.root, "spec.json");
  const runOptionsPath = join(f.root, "run-options.json");
  const profilePath = join(f.root, "profile.json");
  await writeFile(specPath, JSON.stringify(spec));
  await writeFile(runOptionsPath, JSON.stringify({ candidates: 1 }));
  const plan = async (identity: object) => {
    await writeFile(profilePath, JSON.stringify(syntheticProfile({ identity })));
    return createPlan({ biblePath: f.biblePath, specPath, runOptionsPath, profilePath });
  };
  const recorded = await applyPlan((await plan({ mode: "enforce" })).plan, {
    provider: scripted([2]),
    outDir: join(f.root, "runs"),
  });
  assert.equal(recorded.run.identity?.threshold, 0.4);
  assert.equal(recorded.run.filtered, 0);
  const explicit = await applyPlan((await plan({ mode: "enforce", threshold: 0.68 })).plan, {
    provider: scripted([2]),
    outDir: join(f.root, "runs2"),
  });
  assert.equal(explicit.run.identity?.threshold, 0.68);
  assert.equal(explicit.run.filtered, 1);
});

test("enforce mode refuses a record whose eval did not meet the bar", async () => {
  const f = await fixture();
  await recordThresholds(
    join(f.root, ".assetgrove/art-direction"),
    { score: 0.99, cast: 0.99 },
    false,
  );
  const specPath = join(f.root, "spec.json");
  await writeFile(specPath, JSON.stringify(spec));
  const profilePath = join(f.root, "profile.json");
  await writeFile(profilePath, JSON.stringify(syntheticProfile({ identity: { mode: "enforce" } })));
  await assert.rejects(
    createPlan({ biblePath: f.biblePath, specPath, profilePath }),
    (error: unknown) => error instanceof InputError && /met the enforce bar/.test(error.message),
  );
});

test("a record changed between plan and apply makes the plan stale", async () => {
  const f = await fixture();
  const dir = join(f.root, ".assetgrove/art-direction");
  const specPath = join(f.root, "spec.json");
  const profilePath = join(f.root, "profile.json");
  await writeFile(specPath, JSON.stringify(spec));
  await writeFile(profilePath, JSON.stringify(syntheticProfile({ identity: { mode: "enforce" } })));
  const { plan } = await createPlan({ biblePath: f.biblePath, specPath, profilePath });
  assert.ok(plan.inputs["identityThresholds"], "the record is a plan input");
  await recordThresholds(dir, { score: 0.4, cast: 0.5 });
  await assert.rejects(
    applyPlan(plan, { provider: scripted([2]), outDir: join(f.root, "runs") }),
    /stale plan: identityThresholds changed since planning/,
  );
});

test("a subject with no lock is not scored and its plan has no identity check", async () => {
  const { plan, provider, run: record } = await run([3.6], { withLock: false });
  assert.equal(modeOf(plan.plan.operations), undefined);
  assert.equal(
    provider.calls.filter((c) => c.kind === "decide" && c.request.operation !== "style-verdict")
      .length,
    0,
  );
  assert.equal(record.candidates.length, 1);
  assert.equal(record.identity, undefined);
  assert.equal(record.candidates[0]!.provenance.identity, undefined);
});

test("the identity forecast is part of the plan's cost", async () => {
  const locked = await run([3.6]);
  const free = await run([3.6], { withLock: false });
  assert.ok(
    Math.abs(
      locked.plan.forecast.generationUsd -
        free.plan.forecast.generationUsd -
        defaultRoutes["identity"]!.estimatedCostUsd,
    ) < 1e-9,
  );
});

test("decision images are upscaled to at least 384 px on the short side", async () => {
  const { provider } = await run([3.6]);
  const request = provider.calls.find(
    (c) => c.kind === "decide" && c.request.operation !== "style-verdict",
  )!.request as DecisionRequest;
  assert.ok(request.images.length >= 2);
  for (const image of request.images) {
    const raster = decodeImage(image.bytes);
    assert.ok(Math.min(raster.width, raster.height) >= 384);
  }
});

test("a failing decision keeps the candidate unscored in enforce mode and in shadow mode", async () => {
  const enforce = await run([-1], { profile: { identity: { mode: "enforce" } } });
  assert.equal(enforce.run.candidates.length, 1);
  assert.equal(enforce.run.filtered, 0);
  const reason = enforce.run.candidates[0]!.reasons.at(-1)!;
  assert.equal(reason.passed, false);
  assert.equal(reason.shadow, true);
  assert.match(reason.reason, /failed: .*offline.*kept unscored/);
  // A failed call is unknown, not an identity failure: it stays out of the shadow agreement.
  const mixed = await run([-1, 3.6]);
  assert.equal(mixed.run.identity?.scores, 1);
  assert.equal(mixed.run.identity?.unscored, 1);
  assert.equal(mixed.run.identity?.agreement.identityOnlyFailed, 0);
  const shadow = await run([-1]);
  assert.equal(shadow.run.candidates.length, 1);
  assert.equal(shadow.run.candidates[0]!.reasons.at(-1)?.passed, false);
  assert.equal(shadow.run.candidates[0]!.reasons.at(-1)?.shadow, true);
});

test("an enforce record check that cannot run stops the run before any image is generated", async () => {
  const provider = scripted([3.6, 3.6], true);
  await assert.rejects(
    run([3.6, 3.6], { profile: { identity: { mode: "enforce" } }, provider }),
    (error: unknown) =>
      error instanceof ProviderError && /identity record check could not run/.test(error.message),
  );
  assert.equal(provider.calls.filter((c) => c.kind === "image").length, 0);
  assert.equal(
    provider.calls.filter((c) => c.kind === "decide" && c.request.operation !== "style-verdict")
      .length,
    0,
  );
});
