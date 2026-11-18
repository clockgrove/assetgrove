import "./fixtures/env.ts";
import { approveProfile } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { createRaster, decodeImage, encodePng, getPixel, setPixel } from "../src/image/raster.ts";
import {
  DIGITAL_SOURCE_TYPES,
  readDigitalSourceType,
  embedDigitalSourceType,
} from "../src/metadata.ts";
import { sha256 } from "../src/request.ts";
import { defaultRoutes } from "../src/routes.ts";
import type { TargetProfile } from "../src/types.ts";
import { runMaterials } from "../src/material/pipeline.ts";
import { MATERIAL_FLICKER_CHECK, MATERIAL_LIT_CHECKS } from "../src/qa/stability.ts";
import type { OutputGrant } from "../src/types.ts";
import type { MaterialDerivation, MaterialProfile } from "../src/material/pipeline.ts";

async function setup(
  options: {
    failLit?: boolean;
    compression?: boolean;
    model?: boolean;
    qaGrant?: OutputGrant;
    /** Paints a still spot of the height map differently in frame 1 and answers map-flicker so. */
    flicker?: "same" | "follows-pose" | "flickers";
    /** Re-lights frame 1's albedo on every pixel but one, so too few pixels have unchanged albedo. */
    relit?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-material-pipeline-"));
  const albedo = createRaster(8, 4),
    height = createRaster(8, 4),
    zero = createRaster(8, 4);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 8; x++) {
      setPixel(albedo, x, y, [80, 100, 120, 255]);
      setPixel(height, x, y, [128, 128, 128, 255]);
      setPixel(zero, x, y, [0, 0, 0, 255]);
    }
  // Frame 1's height changes on pixels whose albedo (flat) did not change: over any bound.
  if (options.flicker) setPixel(height, 5, 1, [200, 200, 200, 255]);
  if (options.relit)
    for (let y = 0; y < 4; y++)
      for (let x = 4; x < 8; x++)
        if (x !== 4 || y !== 0) setPixel(albedo, x, y, [140, 160, 180, 255]);
  await writeFile(
    join(dir, "albedo.png"),
    embedDigitalSourceType(encodePng(albedo), "image/png", DIGITAL_SOURCE_TYPES.human),
  );
  await writeFile(
    join(dir, "height.png"),
    embedDigitalSourceType(encodePng(height), "image/png", DIGITAL_SOURCE_TYPES.human),
  );
  await writeFile(
    join(dir, "zero.png"),
    embedDigitalSourceType(encodePng(zero), "image/png", DIGITAL_SOURCE_TYPES.human),
  );
  // Synthetic Lambert rig proves normal-driven rendering; model judgement remains scripted.
  const renderer = join(dir, "renderer.mjs");
  await writeFile(
    renderer,
    `import {readFile,writeFile} from 'node:fs/promises';
    import {decodeImage,encodePng,getPixel,setPixel} from ${JSON.stringify(new URL("../src/image/raster.ts", import.meta.url).href)};
    const [manifest,out,scene]=process.argv.slice(2);
    const data=JSON.parse(await readFile(manifest,'utf8'));
    const rig=data.lightRig[scene];if(!rig)throw Error('missing synthetic light rig');
    const load=async channel=>decodeImage(new Uint8Array(await readFile(data.outputs.find(o=>o.channel===channel&&o.scale===1).path)));
    const albedo=await load('albedo');const normal=await load('normal');
    for(let y=0;y<albedo.height;y++)for(let x=0;x<albedo.width;x++){
      const p=getPixel(albedo,x,y),n=getPixel(normal,x,y);
      const dot=Math.max(0,rig.direction.reduce((sum,v,c)=>sum+v*(n[c]/127.5-1),0));
      setPixel(albedo,x,y,[...p.slice(0,3).map(v=>Math.round(v*(rig.ambient+rig.diffuse*dot))),p[3]]);
    }
    await writeFile(out,encodePng(albedo));console.log('rendered '+scene);`,
  );
  const config: MaterialProfile & {
    scales: (1 | 2 | 4)[];
    preview: { command: string[]; version: string };
  } = {
    channels: ["height", "normal", "emissive", "roughness", "wind"],
    scales: [1, 2],
    flickerBound: 0,
    lightRig: {
      "dusk-rain": { direction: [0, 0, 1], ambient: 0.1, diffuse: 0.5 },
      night: { direction: [0, 0, 1], ambient: 0.1, diffuse: 0.1 },
    },
    preview: {
      command: [process.execPath, renderer, "{{materials}}", "{{output}}", "{{scene}}"],
      version: "synthetic-1",
    },
  };
  if (options.compression) {
    // Fake-only codec proof: this is a structural KTX2 fixture, never an actual Basis encoder.
    const compressor = join(dir, "compressor.mjs");
    await writeFile(
      compressor,
      `import {readFile,writeFile} from 'node:fs/promises'; const [input,out]=process.argv.slice(2);const png=await readFile(input);const b=Buffer.alloc(133);Buffer.from([171,75,84,88,32,50,48,187,13,10,26,10]).copy(b);b.writeUInt32LE(1,16);b.writeUInt32LE(png.readUInt32BE(16),20);b.writeUInt32LE(png.readUInt32BE(20),24);b.writeUInt32LE(1,36);b.writeUInt32LE(1,40);b.writeUInt32LE(1,44);b.writeUInt32LE(104,48);b.writeUInt32LE(28,52);b.writeUInt32LE(28,104);b[116]=163;b.writeBigUInt64LE(132n,80);b.writeBigUInt64LE(1n,88);b.writeBigUInt64LE(1n,96);await writeFile(out,b);`,
    );
    config.compression = {
      command: [process.execPath, compressor, "{{input}}", "{{output}}"],
      version: "fake-ktx2-container",
    };
  }
  const profile = {
    format: "assetgrove-target-profile/1",
    name: "synthetic",
    license: "MIT",
    frames: { width: 2, height: 2 },
    style: { materials: config },
    layout: { media: "{{output.path}}", manifest: "asset.json" },
    manifest: {},
    review: { path: "review.status", pending: "pending" },
  } as TargetProfile;
  approveProfile(profile, { profileDir: dir });
  const derivation: MaterialDerivation = {
    maps: {
      height: {
        method: options.model ? "model-assisted-painting" : "mask-extraction",
        version: "painted-v1",
        path: "height.png",
      },
      normal: { method: "height-derived-normal", version: "1" },
      emissive: { method: "mask-extraction", version: "1", path: "zero.png" },
      roughness: { method: "mask-extraction", version: "1", path: "height.png" },
      wind: { method: "mask-extraction", version: "1", path: "zero.png" },
    },
  };
  const provider = new ScriptedProvider({
    ...(options.flicker && {
      mapFlicker: () => ({
        answer: { type: "choice" as const, choice: options.flicker as string },
        costUsd: 0.001,
      }),
    }),
    image: () => ({ images: [{ mediaType: "image/png", bytes: encodePng(height) }], costUsd: 0.1 }),
    vision: () => ({
      text: JSON.stringify({
        checks: [
          "flat-albedo",
          "normal-orientation",
          "emissive-placement",
          "dusk-rain",
          "night",
        ].map((check) => ({
          check,
          passed: !(options.failLit && check === "normal-orientation"),
          reason: "synthetic renderer judgement",
        })),
      }),
      costUsd: 0.1,
    }),
  });
  const call = new Caller({
    provider,
    providerName: "scripted",
    budget: new Budget(1),
    routes: {
      ...defaultRoutes,
      "material-qa": {
        model: "vision",
        estimatedCostUsd: 0.1,
        providerTerms: "synthetic",
        ...(options.qaGrant && { outputGrant: options.qaGrant }),
      },
      "material-height": { model: "depth", estimatedCostUsd: 0.1, providerTerms: "synthetic" },
    },
  });
  return {
    dir,
    config,
    provider,
    call,
    options: {
      albedoPath: join(dir, "albedo.png"),
      spec: { kind: "sprite-strip", assetId: "synthetic", frames: { count: 2 } },
      profile,
      derivation,
      baseDir: dir,
      outDir: join(dir, "out"),
      call,
    },
  };
}

const FLICKER_ENTRY = {
  checkId: MATERIAL_FLICKER_CHECK.id,
  version: MATERIAL_FLICKER_CHECK.version,
  model: defaultRoutes["map-flicker"]!.model,
  cases: 30,
  passCases: 15,
  failCases: 15,
  falsePasses: 0,
  falseFails: 0,
  repeats: 3,
  agreement: 0.95,
  measuredAt: "2026-11-17T00:00:00.000Z",
  measuredBy: "a synthetic fixture",
  labelledSetSha256: "0".repeat(64),
};

test("material pipeline emits aligned native 1x/2x maps, provenance and lit review", async () => {
  const f = await setup();
  const result = await runMaterials(f.options);
  assert.equal(result.passed, true);
  assert.equal(result.outputs.length, 12);
  for (const output of result.outputs) {
    const bytes = await readFile(output.path);
    assert.equal(readDigitalSourceType(bytes, output.mediaType), DIGITAL_SOURCE_TYPES.human);
    assert.equal(output.digitalSourceType, DIGITAL_SOURCE_TYPES.human);
    assert.equal(output.sha256, sha256(bytes));
    const provenance = JSON.parse(await readFile(`${output.path}.provenance.json`, "utf8"));
    assert.equal(provenance.digitalSourceType, DIGITAL_SOURCE_TYPES.human);
    assert.equal(provenance.steps.at(-1).op, "embed-digital-source-type");
    assert.deepEqual(provenance.steps.at(-1).inputs, provenance.steps.at(-1).outputs);
  }
  const normal = decodeImage(new Uint8Array(await readFile(join(f.dir, "out", "normal@1x.png"))));
  assert.equal(normal.width, 4);
  assert.equal(normal.height, 2);
  assert.deepEqual(getPixel(normal, 1, 1), [128, 128, 255, 255]);
  const record = JSON.parse(
    await readFile(join(f.dir, "out", "height@2x.png.provenance.json"), "utf8"),
  );
  assert.equal(record.derivation.method, "mask-extraction");
  assert.equal(record.derivation.version, "painted-v1");
  assert.equal(record.upscalerUsed, false);
  assert.equal(record.source.nativeScale, 2);
  assert.equal(record.calls[0].operation, "material-qa");
  assert.equal(record.costUsd, 0.1);
  const vision = f.provider.calls.find((c) => c.kind === "vision");
  assert.equal(vision?.request.images.length, 3);
  assert.match(await readFile(join(f.dir, "out", "preview.html"), "utf8"), /dusk-rain.png/);
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(report.calls[0].operation, "material-qa");
  assert.deepEqual(
    report.steps.slice(0, 5).map((s: { op: string }) => s.op),
    [
      "material-height",
      "material-normal",
      "material-emissive",
      "material-roughness",
      "material-wind",
    ],
  );
  assert.equal(
    report.steps.filter((s: { op: string }) => s.op === "material-rendition").length,
    12,
  );
  assert.equal(report.commandResults[0].exitCode, 0);
  assert.match(report.commandResults[0].stdout, /rendered dusk-rain/);
  for (const [scene, expected] of [
    ["dusk-rain", [48, 60, 72, 255]],
    ["night", [16, 20, 24, 255]],
  ] as const) {
    const path = join(f.dir, "out", `${scene}.png`);
    const bytes = await readFile(path);
    assert.equal(readDigitalSourceType(bytes, "image/png"), DIGITAL_SOURCE_TYPES.human);
    const provenance = JSON.parse(await readFile(`${path}.provenance.json`, "utf8"));
    assert.equal(provenance.digitalSourceType, DIGITAL_SOURCE_TYPES.human);
    assert.equal(provenance.sha256, sha256(bytes));
    assert.equal(provenance.steps.at(-1).op, "embed-digital-source-type");
    const lit = decodeImage(new Uint8Array(bytes));
    assert.deepEqual(getPixel(lit, 1, 1), expected);
  }
});

test("lit QA without a stability entry is advisory: a bad normal orientation is recorded, not failed", async () => {
  const f = await setup({ failLit: true });
  const result = await runMaterials(f.options);
  assert.equal(result.passed, true);
  const reason = result.qa.reasons.find((r) => r.check === "normal-orientation");
  assert.equal(reason?.passed, false);
  assert.equal(reason?.shadow, true);
  assert.deepEqual(
    result.filtering?.find((s) => s.check === "normal-orientation"),
    { check: "normal-orientation", state: "advisory", cause: "no-entry" },
  );
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(report.filtering.length, 5);
});

test("lit QA rejects bad normal orientation with a qualifying entry for the run's model", async () => {
  const f = await setup({ failLit: true });
  const stability = MATERIAL_LIT_CHECKS.map((c) => ({
    checkId: c.id,
    version: c.version,
    model: "vision",
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
  }));
  const result = await runMaterials({ ...f.options, stability });
  assert.equal(result.passed, false);
  assert.equal(result.qa.reasons.find((r) => r.check === "normal-orientation")?.passed, false);
  assert.ok(result.filtering?.every((s) => s.state === "filtering"));
  const other = await runMaterials({
    ...f.options,
    stability: stability.map((e) => ({ ...e, model: "another" })),
  });
  assert.equal(other.passed, true);
  assert.ok(other.filtering?.every((s) => s.cause === "model-differs"));
});

test("native resolution, named emitters and declared range fail closed", async () => {
  const f = await setup();
  f.config.scales.push(4);
  await assert.rejects(runMaterials(f.options), /without upscaling/);
  f.config.scales = [1, 2];
  f.options.derivation.lightSources = [{ name: "invented", mask: "zero.png" }];
  await assert.rejects(runMaterials(f.options), /not named/);
  f.options.derivation.lightSources = [];
  f.config.encoding = { height: { range: [0, 0.1], encoding: "unorm8" } };
  assert.equal((await runMaterials(f.options)).passed, false);
});

test("model-assisted maps reserve spend and record actual model calls", async () => {
  const f = await setup({ model: true });
  const result = await runMaterials(f.options);
  assert.equal(result.passed, true);
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(report.calls[0].model, "depth");
  assert.equal(report.calls[0].operation, "material-height");
  assert.equal(report.calls.length, 2);
  for (const name of ["height@1x", "normal@2x", "dusk-rain", "night"]) {
    const path = join(f.dir, "out", `${name}.png`);
    assert.equal(
      readDigitalSourceType(await readFile(path), "image/png"),
      DIGITAL_SOURCE_TYPES.composite,
    );
    const provenance = JSON.parse(await readFile(`${path}.provenance.json`, "utf8"));
    assert.equal(provenance.digitalSourceType, DIGITAL_SOURCE_TYPES.composite);
  }
});

test("fake-only KTX2 compressor exercises external container validation per rendition", async () => {
  const f = await setup({ compression: true });
  const result = await runMaterials(f.options);
  assert.equal(result.passed, true);
  assert.equal(result.outputs.filter((o) => o.mediaType === "image/ktx2").length, 12);
  const p = JSON.parse(
    await readFile(join(f.dir, "out", "normal@1x.ktx2.provenance.json"), "utf8"),
  );
  assert.equal(p.compression.version, "fake-ktx2-container");
  f.config.compression!.command = [
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], 'bad')",
    "{{output}}",
  ];
  approveProfile(f.options.profile, { profileDir: f.dir });
  await assert.rejects(runMaterials(f.options), /did not produce KTX2/);
});

test("fractional 3x native downsampling preserves frame grid and preview failure remains pending", async () => {
  const f = await setup();
  const source = createRaster(12, 6);
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 12; x++) setPixel(source, x, y, [128, 128, 128, 255]);
  await writeFile(f.options.albedoPath, encodePng(source));
  await writeFile(join(f.dir, "height.png"), encodePng(source));
  const zero = createRaster(12, 6);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 12; x++) setPixel(zero, x, y, [0, 0, 0, 255]);
  await writeFile(
    join(f.dir, "zero.png"),
    embedDigitalSourceType(encodePng(zero), "image/png", DIGITAL_SOURCE_TYPES.human),
  );
  let result = await runMaterials(f.options);
  assert.equal(result.passed, true);
  const map = decodeImage(new Uint8Array(await readFile(join(f.dir, "out", "height@2x.png"))));
  assert.equal(map.width, 8);
  assert.equal(map.height, 4);
  assert.equal(getPixel(map, 7, 3)[0], 128);
  f.config.preview.command = [process.execPath, "-e", "process.exit(1)"];
  approveProfile(f.options.profile, { profileDir: f.dir });
  await assert.rejects(runMaterials(f.options));
  result = JSON.parse(await readFile(join(f.dir, "out", "materials.json"), "utf8"));
  assert.equal(result.qa.passed, false);
  assert.equal(result.qa.reasons.at(-1)?.check, "material-delivery");
});

test("native 4x renditions retain exact geometry and temporal QA gates changed maps", async () => {
  const f = await setup();
  const flat = createRaster(16, 8);
  const emptyMask = createRaster(16, 8);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 16; x++) {
      setPixel(flat, x, y, [128, 128, 128, 255]);
      setPixel(emptyMask, x, y, [0, 0, 0, 255]);
    }
  await writeFile(f.options.albedoPath, encodePng(flat));
  await writeFile(join(f.dir, "height.png"), encodePng(flat));
  await writeFile(join(f.dir, "zero.png"), encodePng(emptyMask));
  f.config.scales.push(4);
  const result = await runMaterials(f.options);
  assert.equal(result.passed, true);
  const output = result.outputs.find((o) => o.channel === "normal" && o.scale === 4)!;
  const normal = decodeImage(new Uint8Array(await readFile(output.path)));
  assert.deepEqual([normal.width, normal.height], [16, 8]);
  assert.deepEqual(getPixel(normal, 12, 4), [128, 128, 255, 255]);
  setPixel(flat, 12, 4, [255, 255, 255, 255]);
  await writeFile(join(f.dir, "height.png"), encodePng(flat));
  // The changed pixel is over the bound where the albedo is unchanged; the decision (scripted:
  // flickers) fails the channel once the map-flicker model is measured.
  const rejected = await runMaterials({ ...f.options, stability: [FLICKER_ENTRY] });
  assert.equal(rejected.passed, false);
  assert.deepEqual(rejected.outputs, []);
  assert.ok(rejected.qa.reasons.some((r) => !r.passed && /height: frame/.test(r.reason)));
  f.options.derivation.maps.height!.path = "missing.png";
  await assert.rejects(runMaterials(f.options));
  await assert.rejects(readFile(result.reportPath), { code: "ENOENT" });
});

test("rendition normal renormalization fails QA before out-of-range delivery or compression", async () => {
  const f = await setup();
  f.config.channels = ["normal"];
  f.config.encoding = { normal: { range: [0, 0.9], encoding: "unorm8" } };
  // Exercise compression for accepted albedo renditions before rejecting the normal.
  const compressor = join(f.dir, "compressor.mjs");
  const compressed = await setup({ compression: true });
  await writeFile(compressor, await readFile(join(compressed.dir, "compressor.mjs")));
  f.config.compression = {
    command: [process.execPath, compressor, "{{input}}", "{{output}}"],
    version: "fake-ktx2-container",
  };
  approveProfile(f.options.profile, { profileDir: f.dir });
  const normal = createRaster(8, 4);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 8; x++) setPixel(normal, x, y, [x % 2 ? 38 : 217, 128, 219, 255]);
  await writeFile(join(f.dir, "normal.png"), encodePng(normal));
  f.options.derivation.maps.normal = {
    method: "mask-extraction",
    version: "1",
    path: "normal.png",
  };
  const result = await runMaterials(f.options);
  assert.equal(result.passed, false);
  assert.ok(
    result.qa.reasons.some(
      (r) => r.check === "material-range" && r.passed && r.reason.startsWith("normal:"),
    ),
  );
  assert.ok(
    result.qa.reasons.some(
      (r) => r.check === "material-range" && !r.passed && r.reason.startsWith("normal@1x:"),
    ),
  );
  assert.equal(
    result.outputs.some((o) => o.channel === "normal"),
    false,
  );
  await assert.rejects(readFile(join(f.dir, "out", "normal@1x.png")), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.dir, "out", "normal@1x.ktx2")), { code: "ENOENT" });
  assert.equal(f.provider.calls.length, 0);
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(report.qa.passed, false);
});

test("undeclared material PNG previews remain local while package compression refuses until declaration", async () => {
  const f = await setup();
  const untagged = createRaster(8, 4);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 8; x++) setPixel(untagged, x, y, [100, 100, 100, 255]);
  await writeFile(f.options.albedoPath, encodePng(untagged));
  await writeFile(join(f.dir, "height.png"), encodePng(untagged));
  const staged = await runMaterials(f.options);
  assert.equal(staged.outputs[0]!.digitalSourceType, "undeclared");
  assert.equal(
    readDigitalSourceType(await readFile(staged.outputs[0]!.path), "image/png"),
    undefined,
  );
  const compressed = await setup({ compression: true });
  f.config.compression = compressed.config.compression;
  approveProfile(f.options.profile, { profileDir: f.dir });
  await assert.rejects(runMaterials(f.options), /undeclared.*--digital-source-type/);
  const exported = await runMaterials({
    ...f.options,
    digitalSourceType: DIGITAL_SOURCE_TYPES.human,
  });
  assert.ok(exported.outputs.some((output) => output.mediaType === "image/ktx2"));
  const provenance = JSON.parse(
    await readFile(`${exported.outputs[0]!.path}.provenance.json`, "utf8"),
  );
  assert.equal(provenance.sourceDeclaration.value, DIGITAL_SOURCE_TYPES.human);
});

test("material sidecars declare the licence the routes' output grants allow", async () => {
  const plain = await setup();
  const ok = await runMaterials(plain.options);
  const mit = JSON.parse(await readFile(`${ok.outputs[0]!.path}.provenance.json`, "utf8"));
  assert.equal(mit.license, "MIT");
  const f = await setup({
    qaGrant: {
      license: "CC-BY-4.0",
      plan: "free",
      commercial: true,
      relabel: false,
      attribution: "Made with Synthetic",
    },
  });
  const result = await runMaterials(f.options);
  const sidecar = JSON.parse(await readFile(`${result.outputs[0]!.path}.provenance.json`, "utf8"));
  assert.equal(sidecar.license, "CC-BY-4.0");
  assert.equal(sidecar.outputGrant.relabel, false);
  assert.equal(sidecar.outputGrant.attribution, "Made with Synthetic");
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(report.license, "CC-BY-4.0");
  assert.equal(report.outputGrant.plan, "free");
});

test("map flicker: a pair over the bound where the albedo is unchanged is judged by one map-flicker decision per channel and pair, counted against the run's spend", async () => {
  const f = await setup({ flicker: "follows-pose" });
  const result = await runMaterials({ ...f.options, stability: [FLICKER_ENTRY] });
  assert.equal(result.passed, true, "follows the pose: the channel passes");
  const asked = f.provider.calls.filter(
    (c) => c.kind === "decide" && c.request.operation === "map-flicker",
  );
  // height, its derived normal and roughness (painted from height.png) change; each has 2 pairs.
  assert.equal(asked.length, 6);
  for (const c of asked) {
    if (c.kind !== "decide") continue;
    assert.equal(c.request.images.length, 4, "both frames' albedo and map");
    assert.equal(c.request.model, "perplexity/pplx-decider-v1.2");
    assert.equal(c.request.question.type, "choice");
    if (c.request.question.type === "choice")
      assert.deepEqual(Object.keys(c.request.question.options), [
        "same",
        "follows-pose",
        "flickers",
      ]);
  }
  const records = f.call.records.filter((r) => r.operation === "map-flicker");
  assert.equal(records.length, 6);
  assert.ok(records.every((r) => r.decision?.label === "follows-pose" && r.costUsd === 0.001));
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.ok(Math.abs(report.costUsd - (0.1 + 6 * 0.001)) < 1e-9, "the decisions are spent");
  const judged = result.qa.reasons.filter(
    (r) => r.check === "material-flicker" && r.source === "decision",
  );
  assert.equal(judged.length, 6);
  assert.ok(judged.every((r) => r.passed && /judged follows the pose/.test(r.reason)));
  // The still channels (emissive, wind) are cleared by pixels, with no call.
  assert.ok(
    result.qa.reasons.some(
      (r) => r.check === "material-flicker" && r.source === "deterministic" && r.passed,
    ),
  );
});

test("map flicker: a pair with too small a share of unchanged albedo is judged by a decision told the measured share", async () => {
  const f = await setup({ flicker: "same", relit: true });
  const result = await runMaterials({ ...f.options, stability: [FLICKER_ENTRY] });
  assert.equal(result.passed, true, "judged the same: the channel passes");
  const asked = f.provider.calls.filter(
    (c) => c.kind === "decide" && c.request.operation === "map-flicker",
  );
  assert.ok(asked.length > 0);
  for (const c of asked) {
    if (c.kind !== "decide") continue;
    assert.match(
      c.request.prompt,
      /found only 1 of 16 pose-corresponding pixels with unchanged albedo, under the 0\.25 share/,
    );
    assert.doesNotMatch(c.request.prompt, /no pixel with unchanged albedo/);
  }
  const judged = result.qa.reasons.filter(
    (r) => r.check === "material-flicker" && r.source === "decision",
  );
  assert.equal(judged.length, asked.length);
  assert.ok(
    judged.every((r) =>
      /frame \d: only 1 of 16 pose-corresponding pixels with unchanged albedo, under the 0\.25 share needed to compare by pixels; judged same$/.test(
        r.reason,
      ),
    ),
  );
});

test("map flicker: only flickers fails the channel, with a qualifying stability entry; without one it is advisory", async () => {
  const f = await setup({ flicker: "flickers" });
  const failed = await runMaterials({ ...f.options, stability: [FLICKER_ENTRY] });
  assert.equal(failed.passed, false);
  assert.equal(failed.outputs.length, 0, "the maps are rejected before any rendition");
  const reason = failed.qa.reasons.find(
    (r) => r.check === "material-flicker" && r.source === "decision" && !r.passed,
  );
  assert.match(reason?.reason ?? "", /^height: frame \d: residual .* > bound 0 .*judged flickers$/);
  assert.equal(reason?.shadow, undefined);
  assert.deepEqual(
    failed.filtering?.find((s) => s.check === "material-flicker"),
    { check: "material-flicker", state: "filtering" },
  );
  const advisory = await runMaterials(f.options);
  assert.equal(advisory.passed, true);
  const shadowed = advisory.qa.reasons.find(
    (r) => r.check === "material-flicker" && r.source === "decision",
  );
  assert.equal(shadowed?.passed, false);
  assert.equal(shadowed?.shadow, true);
  assert.deepEqual(
    advisory.filtering?.find((s) => s.check === "material-flicker"),
    { check: "material-flicker", state: "advisory", cause: "no-entry" },
  );
  const same = await setup({ flicker: "same" });
  assert.equal((await runMaterials({ ...same.options, stability: [FLICKER_ENTRY] })).passed, true);
});

test("map flicker: still maps make no decision", async () => {
  const f = await setup();
  await runMaterials({ ...f.options, stability: [FLICKER_ENTRY] });
  assert.equal(
    f.provider.calls.filter((c) => c.kind === "decide").length,
    0,
    "a still map is cleared by pixels",
  );
});
