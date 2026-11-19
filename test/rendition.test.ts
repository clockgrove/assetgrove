import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { REFUSED_VARIABLES } from "../src/env.ts";
import { createRaster, decodePng, encodePng, getPixel, setPixel } from "../src/image/raster.ts";
import { sha256Hex } from "../src/library/canonical.ts";
import {
  DIGITAL_SOURCE_TYPES,
  embedDigitalSourceType,
  readDigitalSourceType,
  readMarkedModels,
} from "../src/metadata.ts";
import { bindingOf } from "../src/provenance-binding.ts";
import { rasterEngine } from "../src/transform/raster-engine.ts";
import { buildRendition } from "../src/transform/rendition.ts";
import { transformFiles } from "../src/transform/run.ts";
import type { Provenance } from "../src/types.ts";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const temporary: string[] = [];
after(async () => {
  await Promise.all(temporary.map((d) => rm(d, { recursive: true, force: true })));
});
async function fixture() {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-rendition-")));
  temporary.push(dir);
  const recipes = join(dir, "recipes");
  await mkdir(recipes);
  const raster = createRaster(4, 4);
  setPixel(raster, 0, 0, [200, 20, 40, 255]);
  const bytes = embedDigitalSourceType(
    encodePng(raster),
    "image/png",
    DIGITAL_SOURCE_TYPES.generated,
    { models: ["synthetic-image"] },
  );
  const source = join(dir, "picked.png");
  await writeFile(source, bytes);
  const recipePath = join(recipes, "thumbnail.json");
  await writeFile(
    recipePath,
    JSON.stringify({
      format: "assetgrove-recipe/1",
      steps: [{ op: "scale", params: { factor: 2 } }],
    }),
  );
  return {
    dir,
    bytes,
    recipePath,
    options: {
      recipes,
      recipe: "thumbnail",
      source,
      sourceSha256: sha256Hex(bytes),
      out: join(dir, "out"),
    },
  };
}

test("named recipe reproduces exact output bytes and records pinned source, recipe and engines", async () => {
  const f = await fixture();
  const a = await buildRendition(f.options);
  const first = await readFile(a.record.outputs[0]!.path);
  const raster = decodePng(first);
  assert.equal(raster.width, 8);
  assert.equal(raster.height, 8);
  assert.deepEqual(getPixel(raster, 0, 0), [200, 20, 40, 143]);
  assert.deepEqual(getPixel(raster, 7, 7), [0, 0, 0, 0]);
  const b = await buildRendition(f.options);
  assert.equal(a.digest, b.digest);
  assert.deepEqual(await readFile(b.record.outputs[0]!.path), first);
  assert.equal(a.record.sources[0]!.sha256, f.options.sourceSha256);
  assert.equal(a.record.outputs[0]!.sha256, sha256Hex(first));
  const saved = JSON.parse(await readFile(a.provenancePath, "utf8"));
  assert.equal(saved.rendition.recipe.name, "thumbnail");
  assert.equal(saved.rendition.recipe.sha256, sha256Hex(await readFile(f.recipePath)));
  assert.equal(saved.rendition.build.decoder.version, rasterEngine.version);
  assert.equal(saved.rendition.resolvedRecipe[0].params.factor, 2);
  assert.equal(saved.sourceDeclaration, undefined);
  assert.equal(readDigitalSourceType(first, "image/png"), DIGITAL_SOURCE_TYPES.generated);
  assert.equal(readMarkedModels(first, "image/png"), "synthetic-image");
  // Identity follows effective parameters and bytes, not JSON formatting or source basenames.
  await writeFile(
    f.recipePath,
    '{ "steps": [{ "params": { "factor": 2 }, "op": "scale" }], "format": "assetgrove-recipe/1" }',
  );
  const formatted = await buildRendition({ ...f.options, preview: true });
  assert.equal(formatted.digest, a.digest);
  await writeFile(
    f.recipePath,
    JSON.stringify({
      format: "assetgrove-recipe/1",
      steps: [{ op: "scale", params: saved.rendition.resolvedRecipe[0].params }],
    }),
  );
  const renamed = join(f.dir, "different-name.png");
  await writeFile(renamed, f.bytes);
  const c = await buildRendition({ ...f.options, source: renamed, preview: true });
  assert.equal(c.digest, a.digest);
  assert.equal(c.record.outputs[0]!.path, a.record.outputs[0]!.path);
});

test("parameter, source and engine version changes each select a new identity", async () => {
  const f = await fixture();
  const original = await buildRendition({ ...f.options, preview: true });
  const version = await buildRendition({
    ...f.options,
    preview: true,
    engines: [{ ...rasterEngine, version: "test-next" }],
  });
  assert.notEqual(version.digest, original.digest);
  await writeFile(
    f.recipePath,
    JSON.stringify({
      format: "assetgrove-recipe/1",
      steps: [{ op: "scale", params: { factor: 3 } }],
    }),
  );
  const parameter = await buildRendition({ ...f.options, preview: true });
  assert.notEqual(parameter.digest, original.digest);
  const bytes = embedDigitalSourceType(
    encodePng(createRaster(3, 3)),
    "image/png",
    DIGITAL_SOURCE_TYPES.generated,
  );
  await writeFile(f.options.source, bytes);
  const source = await buildRendition({
    ...f.options,
    sourceSha256: sha256Hex(bytes),
    preview: true,
  });
  assert.notEqual(source.digest, parameter.digest);
  assert.equal(existsSync(f.options.out), false);
});

test("explicit output names stay distinct, source-name independent and inside the build directory", async () => {
  const f = await fixture();
  const source = join(f.dir, "a-much-longer-mezzanine-name.png");
  await writeFile(source, f.bytes);
  await writeFile(
    f.recipePath,
    JSON.stringify({
      format: "assetgrove-recipe/1",
      steps: [
        { op: "join", params: { name: "atlas" } },
        { op: "renditions", params: { scales: [1, 2] } },
      ],
    }),
  );
  const preview = await buildRendition({ ...f.options, source, preview: true });
  assert.deepEqual(
    preview.record.outputs.map((output) => output.path),
    ["atlas@1x.png", "atlas@2x.png"].map((name) => join(f.options.out, preview.digest, name)),
  );
  assert.equal(existsSync(f.options.out), false);
  const written = await buildRendition(f.options);
  assert.equal(written.digest, preview.digest);
  assert.deepEqual(written.record.outputs, preview.record.outputs);
  for (const output of written.record.outputs)
    assert.equal(sha256Hex(await readFile(output.path)), output.sha256);
  const unsafeOut = join(f.dir, "unsafe-out");
  for (const name of ["123456/../../../escaped", "folder\\escaped", "file:stream"]) {
    await writeFile(
      f.recipePath,
      JSON.stringify({
        format: "assetgrove-recipe/1",
        steps: [{ op: "join", params: { name } }],
      }),
    );
    await assert.rejects(
      buildRendition({ ...f.options, out: unsafeOut }),
      /output name|written path/,
    );
    assert.equal(existsSync(unsafeOut), false);
  }
});

test("source hash mismatch, stale provenance, undeclared export and unsafe recipe refuse without writes", async () => {
  const f = await fixture();
  await assert.rejects(
    buildRendition({ ...f.options, sourceSha256: "0".repeat(64) }),
    /SHA-256 mismatch/,
  );
  await assert.rejects(buildRendition({ ...f.options, recipe: "../thumbnail" }), /safe file stem/);
  await writeFile(
    `${f.options.source}.provenance.json`,
    JSON.stringify({ generator: "transform", outputs: [{ sha256: "0".repeat(64) }] }),
  );
  await assert.rejects(buildRendition(f.options), /selected source SHA-256/);
  await rm(`${f.options.source}.provenance.json`);
  const bytes = encodePng(createRaster(2, 2));
  await writeFile(f.options.source, bytes);
  const options = { ...f.options, sourceSha256: sha256Hex(bytes) };
  await assert.rejects(buildRendition(options), /undeclared/);
  assert.equal(existsSync(f.options.out), false);
  const declared = await buildRendition({
    ...options,
    digitalSourceType: DIGITAL_SOURCE_TYPES.human,
  });
  assert.equal(
    readDigitalSourceType(await readFile(declared.record.outputs[0]!.path), "image/png"),
    DIGITAL_SOURCE_TYPES.human,
  );
});

test("source generation record and required disclosure survive transformation", async () => {
  const f = await fixture();
  const generation = {
    generator: "synthetic",
    route: "synthetic",
    models: ["synthetic-image"],
    prompt: "synthetic geometric fixture",
    parameters: { seed: 7 },
    seed: 7,
    calls: [{ model: "synthetic-image", requestId: "synthetic-request" }],
    requestIds: ["synthetic-request"],
    startedAt: "2026-01-01T00:00:00Z",
    costUsd: 0,
  } as unknown as Provenance;
  const bound = { ...generation, binding: bindingOf(generation, f.bytes) };
  await writeFile(`${f.options.source}.provenance.json`, JSON.stringify(bound));
  const result = await buildRendition({
    ...f.options,
    digitalSourceType: DIGITAL_SOURCE_TYPES.human,
  });
  const saved = JSON.parse(await readFile(result.provenancePath, "utf8"));
  assert.deepEqual(saved.sourceProvenance.record.calls, generation.calls);
  assert.deepEqual(saved.sourceProvenance.record.models, generation.models);
  assert.equal(saved.sourceProvenance.record.prompt, generation.prompt);
  assert.equal(saved.sourceProvenance.record.binding.mediaSha256, f.options.sourceSha256);
  assert.equal(saved.outputs[0].digitalSourceType, DIGITAL_SOURCE_TYPES.generated);
  assert.equal(saved.sourceDeclaration.value, DIGITAL_SOURCE_TYPES.human);
  const tampered = { ...bound, prompt: "changed without updating binding" };
  await writeFile(`${f.options.source}.provenance.json`, JSON.stringify(tampered));
  await assert.rejects(
    buildRendition({ ...f.options, out: join(f.dir, "tampered") }),
    /recordSha256/,
  );
  assert.equal(existsSync(join(f.dir, "tampered")), false);
  const contradictory = embedDigitalSourceType(f.bytes, "image/png", DIGITAL_SOURCE_TYPES.human);
  await writeFile(f.options.source, contradictory);
  await writeFile(
    `${f.options.source}.provenance.json`,
    JSON.stringify({ ...generation, binding: bindingOf(generation, contradictory) }),
  );
  await assert.rejects(
    buildRendition({
      ...f.options,
      sourceSha256: sha256Hex(contradictory),
      out: join(f.dir, "contradictory"),
    }),
    /contradicts/,
  );
  assert.equal(existsSync(join(f.dir, "contradictory")), false);
});

test("async and material operations are rejected before execution", async () => {
  const f = await fixture();
  let called = false;
  await assert.rejects(
    buildRendition({
      ...f.options,
      engines: [
        {
          ...rasterEngine,
          asyncOperations: {
            scale: async () => {
              called = true;
              throw new Error("must not execute");
            },
          },
        },
      ],
    }),
    /synchronous deterministic/,
  );
  assert.equal(called, false);
  await writeFile(
    f.recipePath,
    JSON.stringify({ format: "assetgrove-recipe/1", steps: [{ op: "material-derive" }] }),
  );
  await assert.rejects(buildRendition(f.options));
  assert.equal(existsSync(f.options.out), false);
});

test("transformFiles dryRun computes exact bytes while preserving existing write behavior", async () => {
  const f = await fixture();
  const options = {
    inputs: [f.options.source],
    recipe: { steps: [{ op: "flip" }] },
    out: join(f.dir, "transform"),
  };
  const preview = await transformFiles({ ...options, dryRun: true });
  assert.equal(existsSync(options.out), false);
  const written = await transformFiles(options);
  assert.deepEqual(written.record, preview.record);
  assert.equal(
    sha256Hex(await readFile(written.record.outputs[0]!.path)),
    preview.record.outputs[0]!.sha256,
  );
});

test("CLI and real MCP preview expose identical outputs and target paths without an output directory", async () => {
  const f = await fixture();
  const args = { ...f.options, preview: true };
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const name of REFUSED_VARIABLES) {
    delete env[name];
    delete env[name.toLowerCase()];
  }
  delete env.AI_GATEWAY_API_KEY;
  const cli = await exec(
    process.execPath,
    [
      CLI,
      "rendition",
      "--recipes",
      args.recipes,
      "--recipe",
      args.recipe,
      "--source",
      args.source,
      "--source-sha256",
      args.sourceSha256,
      "--out",
      args.out,
      "--preview",
      "--json",
    ],
    { env },
  );
  const doc = JSON.parse(cli.stdout);
  assert.equal(doc.preview, true);
  assert.equal(doc.outputs.length, 1);
  assert.ok(doc.outputs[0].path.startsWith(join(args.out, doc.digest)));
  assert.equal(existsSync(args.out), false);
  const client = new Client({ name: "rendition-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    env,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(
      tools.tools.find((t) => t.name === "rendition")!.inputSchema.properties!.preview !==
        undefined,
      true,
    );
    const result = await client.callTool({ name: "rendition", arguments: args });
    assert.deepEqual(result.structuredContent, doc);
    assert.equal(existsSync(args.out), false);
  } finally {
    await client.close();
  }
});
