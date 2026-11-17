import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runFixFrame, stripTarget } from "../src/animation/commands.ts";
import {
  DEFAULT_FIX_CAP_USD,
  buildFixPrompt,
  fixFrame,
  planFix,
  provenanceProblems,
} from "../src/animation/fix.ts";
import type { FixFrameOptions } from "../src/animation/fix.ts";
import { animationQa } from "../src/animation/qa.ts";
import { postprocessFrames } from "../src/postprocess.ts";
import { joinStrip, splitStrip } from "../src/animation/strip.ts";
import { registrationPin, templateFor, templatesFor } from "../src/animation/templates.ts";
import { Budget, BudgetExceededError } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { InputError } from "../src/errors.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { sha256 } from "../src/request.ts";
import { defaultRoutes } from "../src/routes.ts";
import { measureFrame, registerFrames } from "../src/sheet/register.ts";
import { resolveStyle } from "../src/style.ts";
import { parseRecipe, transformFiles } from "../src/transform/run.ts";
import type { Provenance } from "../src/types.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const frame = { width: 24, height: 32 };
const anchor = { x: 12, y: 30 };

function rect(r: Raster, x0: number, y0: number, w: number, h: number, rgb: number[]): void {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) setPixel(r, x, y, [...rgb, 255]);
}

function makeStrip(count: number): Raster {
  const strip = createRaster(frame.width * count, frame.height);
  for (let i = 0; i < count; i++) {
    rect(strip, i * frame.width + 8, 12 + (i % 2), 8, 18 - (i % 2), [60 + i * 20, 90, 140]);
  }
  return strip;
}

/** A figure at a larger size and off-centre; opaque on a flat light background, or transparent. */
function figureImage(transparent: boolean): Uint8Array {
  const r = createRaster(80, 80);
  if (!transparent) rect(r, 0, 0, 80, 80, [245, 243, 238]);
  rect(r, 10, 20, 24, 50, [200, 60, 50]);
  return encodePng(r);
}

function setup(options: { transparent?: boolean; cap?: number } = {}) {
  const provider = new ScriptedProvider({
    image: () => ({
      images: [{ mediaType: "image/png", bytes: figureImage(!!options.transparent) }],
    }),
    vision: () => ({ text: "" }),
  });
  const call = new Caller({
    provider,
    providerName: "scripted",
    budget: new Budget(options.cap ?? DEFAULT_FIX_CAP_USD),
    routes: defaultRoutes,
  });
  return { provider, call };
}

function base(call: Caller, over: Partial<FixFrameOptions> = {}): FixFrameOptions {
  return {
    strip: makeStrip(4),
    frame,
    anchor,
    family: "walk",
    pin: "center",
    subject: "fox",
    index: 3,
    from: { neighbour: 2 },
    style: resolveStyle(undefined),
    call,
    ...over,
  };
}

test("plans one edit call and builds a prompt with the note", () => {
  const plan = planFix(defaultRoutes);
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.operation, "edit");
  const prompt = buildFixPrompt({
    subject: "fox",
    family: "walk",
    frame: 3,
    count: 4,
    source: "neighbour",
    sourceFrame: 2,
    note: "keep the tail down",
  });
  assert.match(prompt, /frame 3 of 4/);
  assert.match(prompt, /keep the tail down/);
});

for (const transparent of [false, true]) {
  test(`fixes only the target frame (${transparent ? "alpha" : "opaque, matted"})`, async () => {
    const { provider, call } = setup({ transparent });
    const options = base(call);
    const result = await fixFrame(options);
    const before = splitStrip(options.strip, frame);
    const after = splitStrip(result.strip, frame);
    after.forEach((f, i) => {
      if (i !== 2) assert.deepEqual(f.data, before[i]?.data);
    });
    assert.notDeepEqual(after[2]?.data, before[2]?.data);
    const m = measureFrame(result.frame);
    assert.ok(m);
    // Placed where its neighbour (frame 2) is: bottom row and centre of mass on the neighbour's.
    const near = measureFrame(before[1] as Raster);
    assert.ok(near);
    assert.equal(m.baseline, near.baseline);
    assert.ok(Math.abs(m.centerX - near.centerX) <= 1);

    const neighbourPng = encodePng(before[1] as Raster);
    const badPng = encodePng(before[2] as Raster);
    const refs = provider.calls[0]?.request;
    assert.ok(refs && "references" in refs);
    assert.deepEqual(
      refs.references.map((r) => sha256(r.bytes)),
      [sha256(neighbourPng), sha256(badPng)],
    );
    assert.equal(provider.calls.length, 1);
  });
}

test("provenance records the call, the fix and the frame transform", async () => {
  const { call } = setup();
  const prior: Provenance = {
    generator: "sheet",
    route: "r",
    models: ["m"],
    prompt: "p",
    parameters: {},
    requestIds: ["a"],
    referenceHashes: [],
    bibleVersion: "1",
    license: "MIT",
    providerTerms: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.000Z",
    costUsd: 0.3,
    calls: [],
    digitalSourceType: DIGITAL_SOURCE_TYPES.human,
    madeOutsideAssetgrove: true,
    frames: [0, 1, 2, 3].map((index) => ({
      index,
      frame: index + 1,
      cell: { row: 0, column: index, box: { x: 0, y: 0, width: 1, height: 1 } },
      tool: "t",
      sheetSha256: "s",
      transforms: [],
    })),
  };
  const result = await fixFrame(base(call, { provenance: prior }));
  const record = call.records[0];
  assert.ok(record);
  const p = result.provenance;
  assert.equal(p.calls.length, 1);
  // A strip made outside Assetgrove is no longer that once the fix adds a call.
  assert.equal(p.madeOutsideAssetgrove, undefined);
  assert.equal(record.operation, "edit");
  assert.equal(record.model, defaultRoutes.edit.model);
  assert.match(record.route, /edit/);
  assert.equal(record.prompt, result.fix.prompt);
  assert.ok(record.seed !== undefined);
  assert.deepEqual(p.requestIds, ["a", record.requestId]);
  assert.deepEqual(p.models, ["m", record.model]);
  assert.equal(p.costUsd, 0.3 + record.costUsd);
  assert.equal(p.digitalSourceType, DIGITAL_SOURCE_TYPES.composite);
  assert.equal(p.fixes?.length, 1);
  assert.equal(p.fixes?.[0]?.requestId, record.requestId);
  assert.equal(p.fixes?.[0]?.seed, record.seed);
  assert.equal(p.fixes?.[0]?.costUsd, record.costUsd);
  assert.notEqual(result.fix.beforeHash, result.fix.afterHash);
  assert.deepEqual(p.frames?.[2]?.transforms[0], {
    op: "edit-frame",
    from: { neighbour: 2 },
    model: record.model,
    requestId: record.requestId,
  });
  assert.equal(p.frames?.[1]?.transforms.length, 0);
  assert.ok(p.steps?.some((s) => s.op === "register"));
});

test("a key pose is sent first and a minimal provenance is made", async () => {
  const { provider, call } = setup();
  const bytes = encodePng(makeStrip(1));
  const keyPose = {
    role: "key pose (approved)",
    path: "key.png",
    mediaType: "image/png",
    bytes,
    sha256: sha256(bytes),
  };
  const result = await fixFrame(base(call, { from: { keyPose } }));
  const request = provider.calls[0]?.request;
  assert.ok(request && "references" in request);
  assert.deepEqual(request.references[0]?.bytes, bytes);
  assert.deepEqual(result.fix.from, { keyPose: { path: "key.png", sha256: keyPose.sha256 } });
  assert.equal(result.provenance.generator, "frame-fix");
  assert.equal(result.provenance.digitalSourceType, DIGITAL_SOURCE_TYPES.composite);
});

test("invalid index or neighbour refuses before any call", async () => {
  const { provider, call } = setup();
  for (const over of [
    { index: 0 },
    { index: 5 },
    { from: { neighbour: 3 } },
    { from: { neighbour: 9 } },
  ]) {
    await assert.rejects(fixFrame(base(call, over)), InputError);
  }
  assert.equal(provider.calls.length, 0);
});

test("a cap too small refuses before any call", async () => {
  const { provider, call } = setup({ cap: 0.01 });
  await assert.rejects(fixFrame(base(call)), BudgetExceededError);
  assert.equal(provider.calls.length, 0);
});

test("soft and binary styles both work", async () => {
  for (const mode of ["soft", "binary"] as const) {
    const { call } = setup();
    const style = resolveStyle({ alpha: { mode } });
    const result = await fixFrame(base(call, { style }));
    const alphas = new Set<number>();
    for (let i = 3; i < result.frame.data.length; i += 4)
      alphas.add(result.frame.data[i] as number);
    if (mode === "binary") assert.deepEqual([...alphas].sort(), [0, 255]);
    assert.ok(measureFrame(result.frame, 128));
  }
});

/** A 4-frame strip on disk with a target profile of its frame size, for `runFixFrame`. */
async function stripOnDisk() {
  const root = await mkdtemp(join(tmpdir(), "assetgrove-fix-prov-"));
  const path = join(root, "walk.png");
  await writeFile(path, encodePng(makeStrip(4)));
  const target = stripTarget({
    path,
    family: "walk",
    profile: syntheticProfile({ frames: { width: frame.width, height: frame.height } }),
    anchor,
  });
  return { root, path, target };
}

function runOn(
  target: ReturnType<typeof stripTarget>,
  provider: ScriptedProvider,
  out: string,
  provenancePath?: string,
) {
  return runFixFrame({
    target,
    index: 3,
    from: { neighbour: 2 },
    ...(provenancePath !== undefined && { provenancePath }),
    outDir: out,
    routes: defaultRoutes,
    capUsd: DEFAULT_FIX_CAP_USD,
    provider: { provider, name: "scripted" },
  });
}

test("fix-frame on a family no template names records its motion-template decision in the fixed strip's provenance", async () => {
  const { root, target } = await stripOnDisk();
  const provider = new ScriptedProvider({
    image: () => ({ images: [{ mediaType: "image/png", bytes: figureImage(false) }] }),
    vision: () => ({ text: "" }),
    motionTemplate: () => ({ answer: { type: "choice", choice: "walk" }, costUsd: 0.001 }),
  });
  const out = join(root, "out-trot");
  const run = await runOn({ ...target, family: "trot" }, provider, out);
  const written = JSON.parse(await readFile(run.provenancePath, "utf8"));
  assert.deepEqual(
    written.calls.map((c: { operation: string }) => c.operation),
    ["motion-template", "edit"],
  );
  const decision = written.calls[0];
  assert.equal(decision.model, defaultRoutes["motion-template"]!.model);
  assert.ok(written.requestIds.includes(decision.requestId));
  assert.ok(written.models.includes(decision.model));
  assert.equal(written.costUsd, written.calls[0].costUsd + written.calls[1].costUsd);
  assert.equal(run.qa.report.template, "walk");
  assert.equal(run.qa.report.templateSource, "judged");

  // A family named like its template makes no decision, and its record has the edit only.
  const { provider: plain } = setup();
  const named = await runOn(target, plain, join(root, "out-walk"));
  const record = JSON.parse(await readFile(named.provenancePath, "utf8"));
  assert.deepEqual(
    record.calls.map((c: { operation: string }) => c.operation),
    ["edit"],
  );
});

test("a provenance the fix cannot extend refuses before any paid call", async () => {
  const { root, path, target } = await stripOnDisk();
  // A recipe's record for another image, a record with no models, and not a record at all.
  const other = await transformFiles({
    recipe: parseRecipe({ steps: [{ op: "convert", params: { format: "png" } }] }),
    inputs: [path],
    out: join(root, "other", "other.png"),
  });
  const otherRecord = JSON.parse(await readFile(other.provenancePath, "utf8"));
  otherRecord.outputs[0].pixels = "not-this-strip";
  const shapes: Array<[string, unknown]> = [
    ["recipe-for-another-image", otherRecord],
    ["no-models", { generator: "frame-fix", calls: [], costUsd: 0 }],
    ["a-list", [1, 2, 3]],
  ];
  for (const [name, record] of shapes) {
    const provenancePath = join(root, `${name}.provenance.json`);
    await writeFile(provenancePath, JSON.stringify(record));
    const { provider } = setup();
    const out = join(root, `out-${name}`);
    await assert.rejects(runOn(target, provider, out, provenancePath), (error: Error) => {
      assert.ok(error instanceof InputError, String(error));
      assert.match(error.message, /cannot extend the provenance/);
      assert.match(error.message, /write-families/);
      return true;
    });
    assert.equal(provider.calls.length, 0, `${name}: no paid call`);
    await assert.rejects(access(out), `${name}: nothing written`);
  }
});

test("fixFrame itself refuses a provenance it cannot extend before the call", async () => {
  const { provider, call } = setup();
  const transform = { generator: "transform", sources: [], steps: [], outputs: [] };
  await assert.rejects(
    fixFrame(base(call, { provenance: transform as unknown as Provenance })),
    InputError,
  );
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(provenanceProblems(transform), [
    "models is not a list of strings",
    "requestIds is not a list of strings",
    "referenceHashes is not a list of strings",
    "providerTerms is not a list of strings",
    "calls is not a list",
    "costUsd is not a number",
  ]);
});

test("a recipe's transform record for the strip is carried forward with the fix", async () => {
  const { root, path } = await stripOnDisk();
  // `recipe` with one output writes `<out>.provenance.json`, the sidecar fix-frame reads.
  const recipeOut = join(root, "recipe", "walk.png");
  const made = await transformFiles({
    recipe: parseRecipe({ name: "tidy", steps: [{ op: "convert", params: { format: "png" } }] }),
    inputs: [path],
    out: recipeOut,
  });
  const target = stripTarget({
    path: recipeOut,
    family: "walk",
    profile: syntheticProfile({ frames: { width: frame.width, height: frame.height } }),
    anchor,
  });
  const { provider } = setup();
  const run = await runOn(target, provider, join(root, "fixed"));
  assert.equal(provider.calls.length, 1);
  const p = JSON.parse(await readFile(run.provenancePath, "utf8"));
  assert.equal(p.generator, "transform");
  assert.deepEqual(p.parameters.recipe, { name: "tidy" });
  assert.equal(p.parameters.sources[0].sha256, made.record.sources[0]?.sha256);
  assert.deepEqual(p.referenceHashes.slice(0, 1), [made.record.sources[0]?.sha256]);
  assert.deepEqual(
    p.steps.slice(0, made.record.steps.length).map((s: { op: string }) => s.op),
    made.record.steps.map((s) => s.op),
  );
  assert.equal(p.calls.length, 1);
  assert.equal(p.fixes[0].frame, 3);
  assert.equal(p.license, "MIT");
});

/** A side-view sniff crop: the feet never move, the head drops and reaches forward. */
function sniffCrop(headDrop: number): Raster {
  const r = createRaster(64, 40);
  rect(r, 12, 12, 10, 14, [200, 150, 100]); // body
  rect(r, 12, 26, 3, 6, [200, 150, 100]); // rear leg
  rect(r, 19, 26, 3, 6, [200, 150, 100]); // front leg
  rect(r, 22 + headDrop, 8 + headDrop * 2, 8, 6, [200, 150, 100]); // head
  return r;
}

test("a fixed frame of a planted family is registered by its feet, so the strip passes footprint-drift", async () => {
  const sniffFrame = { width: 64, height: 48 };
  const sniffAnchor = { x: 32, y: 44 };
  const style = resolveStyle({ alpha: { mode: "binary" }, edges: "crisp" });
  const pin = registrationPin(templateFor("sniff", templatesFor()));
  assert.equal(pin, "footprint");
  const figures = [0, 3, 6, 3].map(sniffCrop);
  const registered = registerFrames(figures, {
    frame: sniffFrame,
    anchor: sniffAnchor,
    edges: "crisp",
    scale: 1,
    pins: figures.map(() => pin),
  });
  const strip = joinStrip(registered.frames.map((f) => f.image));
  const failures = async (used: "center" | "footprint") => {
    const provider = new ScriptedProvider({
      image: () => ({ images: [{ mediaType: "image/png", bytes: encodePng(sniffCrop(6)) }] }),
      vision: () => ({ text: "" }),
    });
    const call = new Caller({
      provider,
      providerName: "scripted",
      budget: new Budget(DEFAULT_FIX_CAP_USD),
      routes: defaultRoutes,
    });
    const result = await fixFrame({
      ...base(call),
      strip,
      frame: sniffFrame,
      anchor: sniffAnchor,
      family: "sniff",
      pin: used,
      index: 3,
      from: { neighbour: 2 },
      style,
    });
    const report = animationQa(
      {
        frames: splitStrip(result.strip, sniffFrame),
        frame: sniffFrame,
        anchor: sniffAnchor,
        family: "sniff",
      },
      {},
      style,
    );
    return report.reasons
      .filter((r) => !r.passed && (r.check === "footprint-drift" || r.check === "ground-contact"))
      .map((r) => r.check);
  };
  assert.deepEqual(await failures(pin), []);
  // Registered by its centre of mass instead, the repaired frame's feet slide off its neighbours'.
  assert.ok((await failures("center")).includes("footprint-drift"));
});

/**
 * A side-view animal at 2 px per unit on a 128 px canvas, drawn where it falls (not placed): a
 * body, a head that bobs, four planted legs and a long tail out one side, so its centre of mass
 * and its footprint sit far from its box centre.
 */
function tailedAnimal(bob: number): Raster {
  const r = createRaster(128, 128);
  const box = (x0: number, y0: number, x1: number, y1: number) =>
    rect(r, x0 * 2, y0 * 2, (x1 - x0 + 1) * 2, (y1 - y0 + 1) * 2, [90, 80, 70]);
  box(1, 38, 14, 39); // the long tail
  box(15, 36, 36, 50); // body
  box(37, 32 + bob, 42, 40); // head
  box(17, 51, 19, 62); // legs
  box(32, 51, 34, 62);
  return r;
}

test("a fixed frame of a strip stage placed keeps its feet on its neighbours', so the strip passes footprint-drift", async () => {
  // Stage places each frame by its box centre, so the feet of this animal are off the anchor.
  const sniffFrame = { width: 64, height: 64 };
  const sniffAnchor = { x: 32, y: 63 };
  const style = resolveStyle({ alpha: { mode: "binary" }, edges: "crisp" });
  const { strip } = postprocessFrames([0, 1, 2, 1].map(tailedAnimal), {
    frame: sniffFrame,
    frameCount: 4,
    anchor: sniffAnchor,
    palette: ["#5a5046"],
  });
  const qa = (frames: Raster[]) =>
    animationQa(
      { frames, frame: sniffFrame, anchor: sniffAnchor, family: "sniff" },
      {},
      style,
    ).reasons.filter(
      (r) => !r.passed && (r.check === "footprint-drift" || r.check === "ground-contact"),
    );
  assert.deepEqual(qa(splitStrip(strip, sniffFrame)), []);
  const pin = registrationPin(templateFor("sniff", templatesFor()));
  for (const from of [{ neighbour: 2 }, { neighbour: 4 }] as const) {
    const provider = new ScriptedProvider({
      image: () => ({ images: [{ mediaType: "image/png", bytes: encodePng(tailedAnimal(2)) }] }),
      vision: () => ({ text: "" }),
    });
    const call = new Caller({
      provider,
      providerName: "scripted",
      budget: new Budget(DEFAULT_FIX_CAP_USD),
      routes: defaultRoutes,
    });
    const result = await fixFrame({
      ...base(call),
      strip,
      frame: sniffFrame,
      anchor: sniffAnchor,
      family: "sniff",
      pin,
      index: 3,
      from,
      style,
    });
    assert.deepEqual(qa(splitStrip(result.strip, sniffFrame)), [], JSON.stringify(from));
    // The repaired frame's feet are where its neighbour's are, not on the anchor column.
    const fixed = measureFrame(splitStrip(result.strip, sniffFrame)[2]!)!;
    const near = measureFrame(splitStrip(strip, sniffFrame)[from.neighbour - 1]!)!;
    assert.ok(Math.abs(fixed.footX - near.footX) <= 1, `${fixed.footX} vs ${near.footX}`);
    assert.equal(fixed.baseline, near.baseline);
    assert.ok(Math.abs(fixed.footX - (sniffAnchor.x + 0.5)) > 3, String(fixed.footX));
  }
});

/** A side-view hopper crop, 30 px tall: body, head and two legs. */
function hopperCrop(): Raster {
  const r = createRaster(64, 40);
  rect(r, 14, 6, 20, 16, [200, 150, 100]); // body
  rect(r, 34, 4, 8, 8, [200, 150, 100]); // head
  rect(r, 16, 22, 3, 14, [200, 150, 100]); // rear leg
  rect(r, 29, 22, 3, 14, [200, 150, 100]); // front leg
  return r;
}

/** The frame moved up by `px` rows (an airborne beat). */
function lifted(r: Raster, px: number): Raster {
  const out = createRaster(r.width, r.height);
  out.data.set(r.data.subarray(px * r.width * 4));
  return out;
}

test("a landing frame fixed next to an airborne beat stays on the ground line", async () => {
  // A 5-frame `play` strip: frames 3 and 4 are 12 px in the air, frame 5 lands.
  const playFrame = { width: 64, height: 64 };
  const playAnchor = { x: 32, y: 60 };
  const style = resolveStyle({ alpha: { mode: "binary" }, edges: "crisp" });
  const pin = registrationPin(templateFor("play", templatesFor()));
  const figures = [0, 1, 2, 3, 4].map(() => hopperCrop());
  const registered = registerFrames(figures, {
    frame: playFrame,
    anchor: playAnchor,
    edges: "crisp",
    scale: 1,
    pins: figures.map(() => pin),
  }).frames.map((f) => f.image);
  const frames = registered.map((f, i) => (i === 2 || i === 3 ? lifted(f, 12) : f));
  assert.equal(measureFrame(frames[3]!)!.baseline, playAnchor.y - 12);
  const strip = joinStrip(frames);
  const bytes = encodePng(hopperCrop());
  const keyPose = {
    role: "key pose (approved)",
    path: "key.png",
    mediaType: "image/png",
    bytes,
    sha256: sha256(bytes),
  };
  for (const from of [{ neighbour: 4 }, { keyPose }]) {
    const provider = new ScriptedProvider({
      image: () => ({ images: [{ mediaType: "image/png", bytes: encodePng(hopperCrop()) }] }),
      vision: () => ({ text: "" }),
    });
    const call = new Caller({
      provider,
      providerName: "scripted",
      budget: new Budget(DEFAULT_FIX_CAP_USD),
      routes: defaultRoutes,
    });
    const result = await fixFrame({
      ...base(call),
      strip,
      frame: playFrame,
      anchor: playAnchor,
      family: "play",
      pin,
      index: 5,
      from,
      style,
    });
    const out = splitStrip(result.strip, playFrame);
    const label = "neighbour" in from ? "neighbour" : "key pose";
    assert.equal(measureFrame(out[4]!)!.baseline, playAnchor.y, label);
    const failed = animationQa(
      { frames: out, frame: playFrame, anchor: playAnchor, family: "play" },
      {},
      style,
    ).reasons.filter((r) => !r.passed && r.check === "ground-contact");
    assert.deepEqual(failed, [], label);
  }
});
