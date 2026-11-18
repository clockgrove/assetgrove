/**
 * A kind's `frames` trait drives core's frame features (#417): a fixture pack's `fx:strip` gets
 * what core's `sprite-strip` gets, and its `fx:single` gets what a still gets, each through the
 * function core uses (plan, stage, contact sheet, thumbnails, staleness, the atlas hand-off).
 */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import { InputError } from "../src/errors.ts";
import { CORE_ENTRY, CORE_REGISTRY, ExtensionRegistry } from "../src/extensions/registry.ts";
import type { Extension } from "../src/extension/api.ts";
import { writeContact } from "../src/contact.ts";
import { writeToTarget } from "../src/handoff.ts";
import { createRaster, decodeImage, encodePng, setPixel } from "../src/image/raster.ts";
import { stalenessThumbnail } from "../src/library/stale.ts";
import { planStage, stage } from "../src/loop.ts";
import { planJobs } from "../src/planning.ts";
import type { SavedPlan } from "../src/planning.ts";
import { generationTool } from "../src/mcp.ts";
import { planningContext } from "../src/providers/index.ts";
import { loadSettings } from "../src/settings.ts";
import { defaultRoutes } from "../src/routes.ts";
import { openProject } from "../src/tree/project.ts";
import { readTree } from "../src/tree/read.ts";
import { TreeServer } from "../src/tree/serve.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { stripShape } from "../src/tree/thumbs.ts";
import type { Content } from "../src/tree/read.ts";
import type { Generator, GeneratedCandidate } from "../src/generators/generator.ts";
import type { AssetSpec, Provenance } from "../src/types.ts";
import { stateDir } from "./fixtures/env.ts";
import { GAME, fixtureLibrary } from "./fixtures/library.ts";
import { scriptedProvider, syntheticProfile, syntheticWorld } from "./fixtures/synthetic.ts";

const W = 16;
const H = 8;
const COUNT = 3;

/** Distinct opaque frames side by side, so a key-frame cut differs from the whole image. */
function strip(count: number): Uint8Array {
  const image = createRaster(W * count, H);
  for (let f = 0; f < count; f++)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) setPixel(image, f * W + x, y, [40 + 60 * f, 90, 120, 255]);
  return encodePng(image);
}

let layout: unknown = { width: W, height: H, count: COUNT };
const image: Uint8Array = strip(COUNT);

function fixtureKind(kind: string, frames: "strip" | "single"): Generator {
  return {
    kind,
    frames,
    planCandidate: () => [],
    generate: (): Promise<GeneratedCandidate> =>
      Promise.resolve({
        output: {
          bytes: image,
          mediaType: "image/png",
          extension: "png",
          fields: layout === undefined ? {} : { frames: layout },
        },
        qa: { passed: true, reasons: [] },
        prompt: "a synthetic fx",
        parameters: {},
      }),
  } as unknown as Generator;
}

const extension = {
  api: 2,
  name: "fx",
  kinds: [fixtureKind("fx:strip", "strip"), fixtureKind("fx:single", "single")],
} as unknown as Extension;
const registry = new ExtensionRegistry([
  CORE_ENTRY,
  { extension, info: { package: "fx-pack", version: "1.0.0", entry: "/x/index.js" } },
]);

const temporary: string[] = [];
const scratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-frame-traits-")));
  temporary.push(dir);
  return dir;
};
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

async function planFixture() {
  const root = scratch();
  const dir = join(root, ".assetgrove/art-direction");
  await mkdir(dir, { recursive: true });
  await mkdir(join(root, ".assetgrove/prompts"), { recursive: true });
  const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  data.referenceLicense = "NOASSERTION";
  data.world = "Woodland";
  await writeFile(
    join(dir, "BIBLE.md"),
    serializeBible(
      data,
      "# Rationale\n\n## Do's and Don'ts\nDo keep silhouettes readable. Don't add text.\n",
    ),
  );
  await writeFile(join(root, ".assetgrove/prompts/default.md"), "# Prompt template v1\n{{spec}}\n");
  await writeFile(join(root, "key.png"), encodePng(createRaster(4, 4)));
  return {
    biblePath: join(dir, "BIBLE.md"),
    async plan(spec: object) {
      const specPath = join(root, `spec-${Object.keys(spec).length}-${Math.random()}.json`);
      await writeFile(specPath, JSON.stringify(spec));
      const runOptionsPath = join(root, "run-options.json");
      await writeFile(runOptionsPath, JSON.stringify({ candidates: 1 }));
      return { biblePath: join(dir, "BIBLE.md"), specPath, runOptionsPath };
    },
    root,
  };
}

const stripSpec = (kind: string) => ({
  kind,
  assetId: "den",
  animationFamily: "idle",
  keyPose: "key.png",
  frames: { count: COUNT, width: W, height: H },
});

test("plan: a strip kind plans an edit per frame and needs a key pose, a single kind plans a still", async () => {
  const f = await planFixture();
  const jobsOf = async (spec: object, kinds: ExtensionRegistry | undefined) =>
    (await planJobs({ ...(await f.plan(spec)), ...(kinds && { kinds }) })).jobs;
  const strip = await jobsOf(stripSpec("fx:strip"), registry);
  const core = await jobsOf(stripSpec("sprite-strip"), undefined);
  const edit = strip.find((j) => j.operation === "edit");
  assert.equal(edit?.count, COUNT);
  assert.equal(
    strip.some((j) => j.operation === "still"),
    false,
  );
  assert.deepEqual(
    strip.map((j) => [j.operation, j.count]),
    core.map((j) => [j.operation, j.count]),
  );
  const single = await jobsOf(
    { kind: "fx:single", assetId: "den", animationFamily: "idle" },
    registry,
  );
  assert.equal(single.find((j) => j.operation === "still")?.count, 1);
  assert.equal(
    single.some((j) => j.operation === "edit"),
    false,
  );
  await assert.rejects(
    jobsOf({ kind: "fx:strip", assetId: "den", animationFamily: "idle" }, registry),
    (e: unknown) =>
      e instanceof InputError && /fx:strip requires an approved keyPose/.test(e.message),
  );
  await assert.rejects(
    jobsOf({ kind: "fx:strip", assetId: "den", animationFamily: "idle" }, undefined),
    /no planned generator handles asset kind fx:strip/,
  );
});

test("plan: the plan command's context saves a plan for a strip kind of the loaded pack, an edit per frame", async () => {
  const f = await planFixture();
  const settings = loadSettings();
  const profilePath = join(f.root, "profile.json");
  const profile = syntheticProfile();
  delete profile.validator;
  await writeFile(profilePath, JSON.stringify(profile));
  const save = async (spec: object, extensions: ExtensionRegistry | undefined) => {
    const paths = await f.plan(spec);
    const context = await planningContext(undefined, undefined, {
      settings,
      env: {},
      ...(extensions && { extensions }),
    });
    return await generationTool(
      "plan",
      {
        spec: paths.specPath,
        bible: paths.biblePath,
        profile: profilePath,
        runOptions: paths.runOptionsPath,
        out: join(f.root, `plan-${Math.random()}.json`),
      },
      context,
    );
  };
  const saved = await save(stripSpec("fx:strip"), registry);
  const plan = saved["plan"] as SavedPlan;
  assert.ok(plan.operations.includes("edit"), plan.operations.join(","));
  assert.equal(plan.operations.includes("still"), false);
  const core = (await save(stripSpec("sprite-strip"), undefined))["plan"] as SavedPlan;
  assert.deepEqual(plan.operations, core.operations);
  const forecast = await planJobs({ ...(await f.plan(stripSpec("fx:strip"))), kinds: registry });
  assert.equal(forecast.jobs.find((j) => j.operation === "edit")?.count, COUNT);
  await assert.rejects(
    save(stripSpec("fx:strip"), undefined),
    /no planned generator handles asset kind fx:strip/,
  );
});

async function stageKind(kind: string) {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const spec: AssetSpec = {
    kind,
    assetId: "fx",
    animationFamily: "idle",
    frames: { count: COUNT, width: W, height: H },
  };
  const options = {
    spec,
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile: world.profile,
    routes: defaultRoutes,
    provider: scriptedProvider(),
    providerName: "scripted",
    generators: [...registry.kinds] as Generator[],
    runsDir: world.runsDir,
    candidates: 1,
  };
  planStage(options);
  return stage(options);
}

test("stage: a strip kind's output is checked against its layout, its sheet shows key frames and its provenance records the frames", async () => {
  const strip = await stageKind("fx:strip");
  assert.deepEqual(strip.run.errors, []);
  assert.equal(strip.run.candidates.length, 1);
  assert.deepEqual(strip.run.candidates[0]!.provenance.parameters, {
    frame: { width: W, height: H },
    frameCount: COUNT,
  });
  assert.equal(strip.run.contactSheet, "contact.png");
  const stripSheet = decodeImage(new Uint8Array(await readFile(join(strip.runDir, "contact.png"))));

  const single = await stageKind("fx:single");
  assert.equal(single.run.candidates[0]!.provenance.parameters["frame"], undefined);
  const singleSheet = decodeImage(
    new Uint8Array(await readFile(join(single.runDir, "contact.png"))),
  );
  assert.ok(stripSheet.width > singleSheet.width, "the strip's row is its key frames");

  // writeContact reads the trait: with core's kinds alone, fx:strip is shown whole.
  const candidates = strip.run.candidates;
  const via = async (traits: Parameters<typeof writeContact>[5]) => {
    const dir = scratch();
    writeFileSync(
      join(dir, candidates[0]!.file),
      readFileSync(join(strip.runDir, candidates[0]!.file)),
    );
    await writeContact(dir, strip.run.spec, candidates, [], undefined, traits);
    return decodeImage(new Uint8Array(readFileSync(join(dir, "contact.png"))));
  };
  assert.equal((await via(registry)).width, stripSheet.width);
  assert.ok((await via(CORE_REGISTRY)).width < stripSheet.width);
});

test("stage: a strip candidate with no valid layout, or an image that does not match it, is not staged", async () => {
  for (const [bad, pattern] of [
    [undefined, /fx:strip declares frames "strip" but its output carries no valid frame layout/],
    [{ width: W, height: H, count: 0 }, /frame layout.*count/],
    [{ width: W, height: H, count: COUNT + 1 }, /not the 4 frames of 16×8 in one row/],
  ] as const) {
    layout = bad;
    try {
      const { run } = await stageKind("fx:strip");
      assert.equal(run.candidates.length, 0);
      assert.equal(run.contactSheet, undefined);
      assert.equal(run.errors.length, 1);
      assert.match(run.errors[0]!, pattern);
    } finally {
      layout = { width: W, height: H, count: COUNT };
    }
  }
});

test("thumbnails: stripShape reads the trait, and a run candidate or library asset of a strip kind reads as its key frames", async () => {
  const parameters = { frame: { width: W, height: H }, frameCount: COUNT };
  assert.deepEqual(stripShape("fx:strip", parameters, registry), {
    strip: { width: W, height: H, count: COUNT },
  });
  assert.equal(stripShape("fx:single", parameters, registry), "image");
  assert.equal(stripShape("fx:strip", parameters, CORE_REGISTRY), "image");

  const l = fixtureLibrary();
  temporary.push(l.dir);
  const runDir = join(l.runsDir, "r-00000000000000bb");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "c1.png"), strip(8));
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({
      spec: { kind: "fx:strip", assetId: "x" },
      candidates: [
        {
          id: "c1",
          file: "c1.png",
          mediaType: "image/png",
          reasons: [],
          provenance: { parameters: { frame: { width: W, height: H }, frameCount: 8 } },
        },
      ],
    }),
  );
  const widthOf = async (address: string, traits: ExtensionRegistry) => {
    const open = await openProject(l.dir, stateDir);
    const read = await readTree(open, `asset://${GAME}/${address}`, traits);
    const blob = read.contents.find((c): c is Extract<Content, { blob: string }> => "blob" in c)!;
    return decodeImage(new Uint8Array(Buffer.from(blob.blob, "base64"))).width;
  };
  const whole = await widthOf("runs/r-00000000000000bb/c1", CORE_REGISTRY as never);
  const keyed = await widthOf("runs/r-00000000000000bb/c1", registry);
  assert.equal(whole, 8 * W);
  assert.notEqual(keyed, whole);
  // The MCP resource read (TreeServer) reads the traits it was given, as the mcp command passes them.
  const served = async (traits?: ExtensionRegistry) => {
    const handlers = new Map<string, (request: unknown) => Promise<unknown>>();
    const fake = {
      server: {
        setRequestHandler: (method: string, handler: (request: unknown) => Promise<unknown>) =>
          void handlers.set(method, handler),
      },
    };
    new TreeServer(l.dir, stateDir, undefined, traits).attach(
      fake as unknown as McpServer,
      "modern",
    );
    const uri = `asset://${GAME}/runs/r-00000000000000bb/c1`;
    const read = (await handlers.get("resources/read")!({ params: { uri } })) as {
      contents: Content[];
    };
    const blob = read.contents.find((c): c is Extract<Content, { blob: string }> => "blob" in c)!;
    return decodeImage(new Uint8Array(Buffer.from(blob.blob, "base64"))).width;
  };
  assert.equal(await served(), whole);
  assert.equal(await served(registry), keyed);

  // The same walk asset of the fixture library, its card naming the pack's kind.
  const card = join(l.root, "walk.md");
  writeFileSync(card, readFileSync(card, "utf8").replaceAll("sprite-strip", "fx:strip"));
  const record = join(l.root, "walk.png.provenance.json");
  writeFileSync(
    record,
    JSON.stringify({
      ...JSON.parse(readFileSync(record, "utf8")),
      generator: "fx:strip",
      parameters: { frame: { width: 16, height: 32 }, frameCount: 8 },
    }),
  );
  assert.equal(await widthOf("walk/image", CORE_REGISTRY as never), 4 * 32);
  assert.notEqual(await widthOf("walk/image", registry), 4 * 32);
});

test("staleness: a strip kind's thumbnail is its key frames, a single kind's the whole image", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "fx.png"), strip(8));
  writeFileSync(
    join(dir, "fx.png.provenance.json"),
    JSON.stringify({
      ...provenance,
      parameters: { frame: { width: W, height: H }, frameCount: 8 },
    }),
  );
  const subject = (kind: string) => ({
    asset: "fx",
    media: join(dir, "fx.png"),
    provenance: join(dir, "fx.png.provenance.json"),
    sha256: "0".repeat(64),
    from: "1",
    kind,
    tags: [],
  });
  const width = async (kind: string, traits: ExtensionRegistry) =>
    decodeImage((await stalenessThumbnail(subject(kind), traits))[0]!.bytes).width;
  assert.equal(await width("fx:single", registry), 8 * W);
  assert.equal(await width("fx:strip", CORE_REGISTRY as never), 8 * W);
  assert.notEqual(await width("fx:strip", registry), 8 * W);
});

const provenance = {
  digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
  generator: "fx:strip",
  route: "scripted",
  models: ["scripted"],
  prompt: "a synthetic fx",
  parameters: {},
  requestIds: [],
  referenceHashes: [],
  bibleVersion: "synthetic-1",
  license: "MIT",
  providerTerms: [],
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  costUsd: 0,
  calls: [],
} as unknown as Provenance;

function atlasWrite(kind: string, targetDir: string) {
  const profile = syntheticProfile({ handoff: [{ preset: "atlas-json" }] });
  delete profile.validator;
  return {
    profile,
    spec: { kind, assetId: "fx", animationFamily: "idle" } as AssetSpec,
    bibleVersion: "v1",
    output: {
      bytes: strip(COUNT),
      mediaType: "image/png",
      extension: "png",
      fields: { frames: { width: W, height: H, count: COUNT } },
    },
    provenance,
    run: { runId: "r1", candidateId: "c1", pickedAt: "2026-01-01T00:00:02.000Z" },
    targetDir,
    registry,
  };
}

test("atlas-json: a strip kind's hand-off writes the atlas, a single kind's is refused", async () => {
  const target = scratch();
  const result = await writeToTarget(atlasWrite("fx:strip", target));
  const file = result.handoff[0]!.files[0]!;
  const doc = JSON.parse(await readFile(join(target, file), "utf8"));
  assert.deepEqual(
    Object.keys(doc.frames),
    Array.from({ length: COUNT }, (_, i) => `fx_${String(i).padStart(3, "0")}`),
  );
  assert.deepEqual(doc.meta.size, { w: W * COUNT, h: H });

  await assert.rejects(
    writeToTarget(atlasWrite("fx:single", scratch())),
    (e: unknown) =>
      e instanceof InputError &&
      /preset "atlas-json" needs a sprite strip with frame width, height and count/.test(e.message),
  );
});

test("core's sprite-strip is still a strip under core's registry", () => {
  const parameters = { frame: { width: W, height: H }, frameCount: COUNT };
  assert.deepEqual(stripShape("sprite-strip", parameters), {
    strip: { width: W, height: H, count: COUNT },
  });
  assert.deepEqual(
    stripShape("sprite-strip", parameters, CORE_REGISTRY),
    stripShape("sprite-strip", parameters),
  );
  assert.equal(stripShape("still", parameters, CORE_REGISTRY), "image");
});
