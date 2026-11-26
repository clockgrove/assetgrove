import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { OggVorbisDecoder } from "@wasm-audio-decoders/ogg-vorbis";
import { encodeWav } from "../src/audio/engine.ts";
import type { AudioItem } from "../src/audio/engine.ts";
import { createRaster, encodePng } from "../src/image/raster.ts";
import { developmentSigner, sidecarCredentialProblem } from "../src/credentials.ts";
import { planDelivery } from "../src/delivery.ts";
import { markProblems } from "../src/handoff/mark-check.ts";
import { sha256Hex } from "../src/library/canonical.ts";
import { appendVersion, emptyReview, writeReview } from "../src/library/review.ts";
import { DIGITAL_SOURCE_TYPES, embedDigitalSourceType } from "../src/metadata.ts";
import { buildRendition } from "../src/transform/rendition.ts";
import { gitTarget } from "./fixtures/git.ts";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const temporary: string[] = [];
after(async () => {
  await Promise.all(temporary.map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-audio-rendition-")));
  temporary.push(dir);
  return dir;
}

const MODELS = ["stable-audio-2.5"];
/** A marked stereo WAV master; `freq` makes another master. */
function master(freq = 440): Uint8Array {
  const rate = 44100;
  const tone = (f: number) => {
    const out = new Float64Array(rate);
    for (let i = 0; i < rate; i++) out[i] = 0.3 * Math.sin((2 * Math.PI * f * i) / rate);
    return out;
  };
  const item: AudioItem = {
    name: "master",
    channels: [tone(freq), tone(freq * 1.5)],
    sampleRate: rate,
    bitDepth: "16",
    meta: {},
  };
  return embedDigitalSourceType(encodeWav(item), "audio/wav", DIGITAL_SOURCE_TYPES.generated, {
    models: MODELS,
  });
}

async function project(quality = 4) {
  const dir = await tempDir();
  const recipes = join(dir, "recipes");
  await mkdir(recipes);
  await writeFile(
    join(recipes, "ogg.json"),
    JSON.stringify({
      format: "assetgrove-recipe/1",
      steps: [
        { op: "fade", params: { inMs: 5, outMs: 20 } },
        { op: "encode", params: { quality } },
      ],
    }),
  );
  const bytes = master();
  const source = join(dir, "picked.wav");
  await writeFile(source, bytes);
  return { dir, recipes, source, bytes, signer: await developmentSigner(join(dir, "state")) };
}

interface OggOutput {
  path: string;
  sha256: string;
  mediaType: string;
  encodedBy: { name: string; version: string; vendor?: string };
  contentCredentials?: { name: string; path: string; sha256: string };
}

test("an Ogg rendition records the master hash, its own hash and the resolved recipe with the encoder version", async () => {
  const p = await project();
  const options = {
    recipes: p.recipes,
    recipe: "ogg",
    source: p.source,
    sourceSha256: sha256Hex(p.bytes),
    out: join(p.dir, "out"),
    name: "loop",
    signer: p.signer,
  };
  const built = await buildRendition(options);
  const output = built.record.outputs[0] as unknown as OggOutput;
  assert.equal(output.mediaType, "audio/ogg");
  assert.equal(output.path, join(p.dir, "out", built.digest, "loop.ogg"));
  const ogg = new Uint8Array(await readFile(output.path));
  assert.equal(output.sha256, sha256Hex(ogg), "the rendition records its own byte hash");
  const rendition = built.record.rendition as {
    build: {
      sourceSha256: string;
      recipe: { op: string; params: Record<string, unknown>; engine: { version: string } }[];
      encoders: { mediaType: string; encodedBy: OggOutput["encodedBy"] }[];
    };
    digest: string;
  };
  assert.equal(rendition.build.sourceSha256, sha256Hex(p.bytes), "it records the master hash");
  const encode = rendition.build.recipe.find((s) => s.op === "encode");
  assert.deepEqual(encode?.params, { quality: 4 }, "the recipe with its resolved settings");
  assert.deepEqual(rendition.build.recipe.find((s) => s.op === "fade")?.params, {
    inMs: 5,
    outMs: 20,
  });
  const encoder = rendition.build.encoders[0]!.encodedBy;
  assert.equal(encoder.name, "@audio/encode-ogg");
  assert.match(encoder.version, /^\d+\.\d+\.\d+$/, "and the encoder version");
  assert.match(encoder.vendor ?? "", /libVorbis/);

  // The mark is a Vorbis comment, and the mark check reads it.
  const expected = { digitalSourceType: DIGITAL_SOURCE_TYPES.generated, models: MODELS };
  assert.deepEqual(markProblems(output.path, ogg, "audio/ogg", expected), []);
  // The C2PA sidecar sits beside it and binds these bytes.
  const sidecar = output.contentCredentials!;
  assert.equal(sidecar.path, join(p.dir, "out", built.digest, "loop.c2pa"));
  const manifest = new Uint8Array(await readFile(sidecar.path));
  assert.equal(sidecar.sha256, sha256Hex(manifest));
  assert.equal(await sidecarCredentialProblem(sidecar.path, manifest, ogg, expected), undefined);
  // Independently decodable.
  const decoder = new OggVorbisDecoder();
  await decoder.ready;
  const decoded = await decoder.decodeFile(ogg);
  decoder.free();
  assert.deepEqual(decoded.errors, []);
  assert.equal(decoded.samplesDecoded, 44100);

  // Unchanged master and recipe: the same rendition, byte for byte, sidecar included.
  const again = await buildRendition(options);
  assert.equal(again.digest, built.digest);
  assert.deepEqual(new Uint8Array(await readFile(output.path)), ogg);
  assert.deepEqual(new Uint8Array(await readFile(sidecar.path)), manifest);

  // A changed recipe or a changed master regenerates it.
  await writeFile(
    join(p.recipes, "ogg.json"),
    JSON.stringify({
      format: "assetgrove-recipe/1",
      steps: [{ op: "fade", params: { inMs: 5, outMs: 20 } }, { op: "encode" }],
    }),
  );
  const requality = await buildRendition(options);
  assert.notEqual(requality.digest, built.digest);
  const resolved = (requality.record.rendition as typeof rendition).build.recipe;
  assert.deepEqual(resolved.find((s) => s.op === "encode")?.params, { quality: 5 });
  const other = master(330);
  await writeFile(p.source, other);
  const remastered = await buildRendition({ ...options, sourceSha256: sha256Hex(other) });
  assert.notEqual(remastered.digest, requality.digest);
  assert.equal(
    (remastered.record.rendition as typeof rendition).build.sourceSha256,
    sha256Hex(other),
  );
  const fresh = remastered.record.outputs[0] as unknown as OggOutput;
  assert.notEqual(fresh.sha256, output.sha256);
});

test("an audio rendition takes only audio operations, and an image one only raster ones", async () => {
  const p = await project();
  await writeFile(
    join(p.recipes, "mixed.json"),
    JSON.stringify({ format: "assetgrove-recipe/1", steps: [{ op: "flip" }] }),
  );
  await assert.rejects(
    buildRendition({
      recipes: p.recipes,
      recipe: "mixed",
      source: p.source,
      sourceSha256: sha256Hex(p.bytes),
      out: join(p.dir, "out"),
      signer: p.signer,
    }),
    /only audio operations: flip/,
  );
  const png = embedDigitalSourceType(
    encodePng(createRaster(2, 2)),
    "image/png",
    DIGITAL_SOURCE_TYPES.generated,
  );
  await writeFile(join(p.dir, "icon.png"), png);
  await assert.rejects(
    buildRendition({
      recipes: p.recipes,
      recipe: "ogg",
      source: join(p.dir, "icon.png"),
      sourceSha256: sha256Hex(png),
      out: join(p.dir, "out"),
    }),
    /fade is an audio operation; the source is not a WAV master/,
  );
});

test("the rendition CLI writes the Ogg and its sidecar with the settings' signer", async () => {
  const p = await project();
  const { stdout } = await exec(process.execPath, [
    CLI,
    "rendition",
    "--recipes",
    p.recipes,
    "--recipe",
    "ogg",
    "--source",
    p.source,
    "--source-sha256",
    sha256Hex(p.bytes),
    "--out",
    join(p.dir, "out"),
    "--json",
  ]);
  const result = JSON.parse(stdout) as { outputs: OggOutput[]; digest: string };
  const output = result.outputs[0]!;
  assert.equal(output.mediaType, "audio/ogg");
  const ogg = new Uint8Array(await readFile(output.path));
  const manifest = new Uint8Array(await readFile(output.contentCredentials!.path));
  assert.equal(
    await sidecarCredentialProblem("sidecar", manifest, ogg, {
      digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
      models: MODELS,
    }),
    undefined,
  );
});

test("a target asks for an Ogg of a library master through deliver, and gets it with its sidecar", async () => {
  const p = await project();
  const target = gitTarget(join(p.dir, "target"));
  const assets = join(target, "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(
    join(target, "index.md"),
    "---\nokf_version: 0.2\ntype: Asset Library\ngame: test-grove\n---\n\n# test-grove\n",
  );
  const record = appendVersion(emptyReview("asset://test-grove/wind/review"), {
    sha256: sha256Hex(p.bytes),
    at: "2026-01-01T00:00:00Z",
    run: "r-wind",
    candidate: "c1",
    confirmation: { method: "tty" },
  });
  await writeFile(join(assets, "wind.review.json"), writeReview(record));
  await writeFile(join(assets, "wind.wav"), p.bytes);
  await writeFile(
    join(assets, "wind.md"),
    `---\ntype: Game Asset\nformat: assetgrove-card/1\ntitle: wind\nkind: ambience\nresource: wind.wav\nversion: 1\nlock: { sha256: ${sha256Hex(p.bytes)} }\n---\n`,
  );
  const selection = join(p.dir, "selection.json");
  await writeFile(
    selection,
    JSON.stringify({
      format: "assetgrove-delivery/1",
      recipes: "recipes",
      items: [
        { asset: "target/assets/wind.md", version: 1, recipe: "ogg", to: "audio", name: "wind" },
      ],
    }),
  );
  const out = join(p.dir, "game");
  const first = await planDelivery({ selection, out, signer: p.signer });
  assert.deepEqual(first.problems, []);
  const item = first.manifest.items[0]!;
  assert.equal(item.mezzanine.sha256, sha256Hex(p.bytes));
  const output = item.outputs[0]!;
  assert.equal(output.path, "audio/wind.ogg");
  assert.equal(output.mediaType, "audio/ogg");
  assert.equal(output.contentCredentials?.path, "audio/wind.c2pa");
  const ogg = new Uint8Array(await readFile(join(out, "audio", "wind.ogg")));
  const manifest = new Uint8Array(await readFile(join(out, "audio", "wind.c2pa")));
  assert.equal(output.sha256, sha256Hex(ogg));
  assert.equal(output.contentCredentials?.sha256, sha256Hex(manifest));
  const expected = { digitalSourceType: DIGITAL_SOURCE_TYPES.generated, models: MODELS };
  assert.deepEqual(markProblems("wind.ogg", ogg, "audio/ogg", expected), []);
  assert.equal(await sidecarCredentialProblem("wind.c2pa", manifest, ogg, expected), undefined);
  // Repeating the selection reproduces the same files: the sidecar is kept, not re-signed.
  const second = await planDelivery({ selection, out, signer: p.signer });
  assert.deepEqual(second.problems, []);
  assert.deepEqual(new Uint8Array(await readFile(join(out, "audio", "wind.c2pa"))), manifest);
});
