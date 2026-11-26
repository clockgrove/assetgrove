import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { OggVorbisDecoder } from "@wasm-audio-decoders/ogg-vorbis";
import type { AudioItem } from "../src/audio/engine.ts";
import { encodeWav } from "../src/audio/engine.ts";
import { encodeOgg, oggEncoder } from "../src/audio/ogg.ts";
import { runAudioRecipe, transformAudioFiles } from "../src/audio/run.ts";
import { readVorbisComments, vorbisComment } from "../src/audio/vorbis-comments.ts";
import {
  developmentSigner,
  readSidecarCredentials,
  sidecarCredentialProblem,
  sidecarCredentialed,
  signSidecarCredentials,
} from "../src/credentials.ts";
import { InputError } from "../src/errors.ts";
import { markProblems, markableMediaType } from "../src/handoff/mark-check.ts";
import {
  DIGITAL_SOURCE_TYPES,
  embedDigitalSourceType,
  readDigitalSourceType,
  readMarkedCallsSha256,
  readMarkedModels,
} from "../src/metadata.ts";
import { parseRecipe } from "../src/transform/run.ts";

const temporary: string[] = [];
after(async () => {
  await Promise.all(temporary.map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-ogg-")));
  temporary.push(dir);
  return dir;
}

function tone(seconds: number, freq: number, rate = 44100): Float64Array {
  const out = new Float64Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = 0.3 * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}
const stereo = (): AudioItem => ({
  name: "loop",
  channels: [tone(1, 440), tone(1, 660)],
  sampleRate: 44100,
  bitDepth: "16",
  meta: {},
});

/** Decodes with an independent libvorbis decoder (a devDependency); core never decodes an Ogg. */
async function decode(bytes: Uint8Array) {
  const decoder = new OggVorbisDecoder();
  await decoder.ready;
  try {
    return await decoder.decodeFile(bytes);
  } finally {
    decoder.free();
  }
}

/** The Ogg's pages: [serial, sequence] of each, checking the capture pattern and CRC are present. */
function pageHeaders(bytes: Uint8Array): { serial: number; sequence: number }[] {
  const b = Buffer.from(bytes);
  const out = [];
  for (let at = 0; at < b.length; ) {
    assert.equal(b.toString("latin1", at, at + 4), "OggS");
    const count = b[at + 26]!;
    let size = 0;
    for (let i = 0; i < count; i++) size += b[at + 27 + i]!;
    out.push({ serial: b.readUInt32LE(at + 14), sequence: b.readUInt32LE(at + 18) });
    at += 27 + count + size;
  }
  return out;
}

test("encode writes Ogg Vorbis through libvorbis WASM, deterministically for a serial", async () => {
  const a = await encodeOgg(stereo(), 5, 0x1234);
  const b = await encodeOgg(stereo(), 5, 0x1234);
  assert.equal(Buffer.from(a).toString("latin1", 0, 4), "OggS");
  assert.deepEqual(a, b, "same samples, quality and serial give the same bytes");
  const pages = pageHeaders(a);
  assert.ok(pages.every((p) => p.serial === 0x1234));
  assert.deepEqual(
    pages.map((p) => p.sequence),
    pages.map((_, i) => i),
  );
  const { vendor } = readVorbisComments(a);
  assert.match(vendor, /^Xiph\.Org libVorbis/);
  const encoder = await oggEncoder();
  assert.equal(encoder.name, "@audio/encode-ogg");
  assert.match(encoder.version, /^\d+\.\d+\.\d+$/);
  assert.equal(encoder.vendor, vendor);
  assert.equal(encoder.license, "MIT AND BSD-3-Clause");
  const decoded = await decode(a);
  assert.deepEqual(decoded.errors, []);
  assert.equal(decoded.sampleRate, 44100);
  assert.equal(decoded.channelData.length, 2);
  assert.equal(decoded.samplesDecoded, 44100);
  const low = await encodeOgg(stereo(), 0, 0x1234);
  assert.ok(low.length < a.length, "a lower quality makes a smaller file");
});

test("encode is the recipe's last step and records quality and the encoder", async () => {
  const recipe = parseRecipe({ steps: [{ op: "fade" }, { op: "encode" }] });
  const { items, steps } = await runAudioRecipe(recipe, [stereo()]);
  assert.deepEqual(items[0]!.encoding, { mediaType: "audio/ogg", quality: 5 });
  const step = steps[1]!;
  assert.deepEqual(step.params, { quality: 5 }, "the default quality is resolved");
  assert.equal((step.report as { encoder: { name: string } }).encoder.name, "@audio/encode-ogg");
  await assert.rejects(
    runAudioRecipe(parseRecipe({ steps: [{ op: "encode" }, { op: "fade" }] }), [stereo()]),
    (e: unknown) => e instanceof InputError && /comes after encode/.test(e.message),
  );
  const surround: AudioItem = { ...stereo(), channels: [tone(1, 1), tone(1, 2), tone(1, 3)] };
  await assert.rejects(
    runAudioRecipe(parseRecipe({ steps: [{ op: "encode" }] }), [surround]),
    /mono or stereo/,
  );
  assert.throws(() => parseRecipe({ steps: [{ op: "encode", params: { quality: 11 } }] }));
});

test("transformAudioFiles writes an encoded item as a marked .ogg", async () => {
  const dir = await tempDir();
  const master = join(dir, "master.wav");
  await writeFile(
    master,
    embedDigitalSourceType(encodeWav(stereo()), "audio/wav", DIGITAL_SOURCE_TYPES.generated),
  );
  const { record } = await transformAudioFiles({
    recipe: parseRecipe({ steps: [{ op: "encode", params: { quality: 3 } }] }),
    inputs: [master],
    out: join(dir, "out"),
  });
  const output = record.outputs[0]!;
  assert.equal(output.mediaType, "audio/ogg");
  assert.equal(output.path, join(dir, "out", "master.ogg"));
  assert.equal(output.quality, 3);
  assert.equal(output.encodedBy.name, "@audio/encode-ogg");
  const bytes = new Uint8Array(await readFile(output.path));
  assert.equal(readDigitalSourceType(bytes, "audio/ogg"), DIGITAL_SOURCE_TYPES.generated);
});

test("the AI mark is a Vorbis comment, and the mark check reads it", async () => {
  const ogg = await encodeOgg(stereo(), 4, 7);
  const marked = embedDigitalSourceType(ogg, "audio/ogg", DIGITAL_SOURCE_TYPES.generated, {
    models: ["stable-audio-2.5"],
    callsSha256: "a".repeat(64),
  });
  const comments = readVorbisComments(marked);
  assert.equal(
    vorbisComment(comments, "DIGITALSOURCETYPE"),
    DIGITAL_SOURCE_TYPES.generated,
    "the IPTC source type is a Vorbis comment",
  );
  assert.equal(vorbisComment(comments, "aisystemused"), "stable-audio-2.5");
  assert.equal(comments.vendor, readVorbisComments(ogg).vendor, "the vendor string stays");
  assert.equal(readMarkedModels(marked, "audio/ogg"), "stable-audio-2.5");
  assert.equal(readMarkedCallsSha256(marked, "audio/ogg"), "a".repeat(64));
  const decoded = await decode(marked);
  assert.deepEqual(decoded.errors, [], "the rewritten header pages still decode");
  assert.equal(decoded.samplesDecoded, 44100);
  const again = embedDigitalSourceType(marked, "audio/ogg", DIGITAL_SOURCE_TYPES.generated, {
    models: ["stable-audio-2.5"],
    callsSha256: "a".repeat(64),
  });
  assert.deepEqual(again, marked, "marking twice is stable");

  assert.equal(markableMediaType("x/rendition.ogg"), "audio/ogg");
  const expected = {
    digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
    models: ["stable-audio-2.5"],
  } as const;
  assert.deepEqual(markProblems("a.ogg", marked, "audio/ogg", expected), []);
  assert.equal(markProblems("a.ogg", ogg, "audio/ogg", expected)[0]?.code, "mark_missing");
  const other = embedDigitalSourceType(ogg, "audio/ogg", DIGITAL_SOURCE_TYPES.human);
  assert.equal(markProblems("a.ogg", other, "audio/ogg", expected)[0]?.code, "mark_invalid");
  assert.equal(
    markProblems("a.ogg", new Uint8Array([1, 2, 3]), "audio/ogg", expected)[0]?.code,
    "mark_invalid",
  );
});

test("an Ogg carries a C2PA sidecar manifest bound to its bytes", async () => {
  const dir = await tempDir();
  const signer = await developmentSigner(dir);
  const ogg = embedDigitalSourceType(
    await encodeOgg(stereo(), 4, 9),
    "audio/ogg",
    DIGITAL_SOURCE_TYPES.generated,
    { models: ["stable-audio-2.5"] },
  );
  const claim = {
    digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
    models: ["stable-audio-2.5"],
    title: "loop.ogg",
  };
  const sidecar = await signSidecarCredentials(ogg, "audio/ogg", claim, signer, "test");
  const read = await readSidecarCredentials(sidecar, ogg);
  assert.ok(read);
  assert.deepEqual(read.failures, []);
  assert.equal(read.state, "Valid");
  assert.equal(read.actions[0]?.digitalSourceType, DIGITAL_SOURCE_TYPES.generated);
  assert.equal(read.actions[0]?.softwareAgent, "stable-audio-2.5");
  assert.equal(read.certificateSha256, signer.record.certificateSha256);
  const expected = { digitalSourceType: claim.digitalSourceType, models: claim.models };
  assert.equal(await sidecarCredentialProblem("loop.c2pa", sidecar, ogg, expected), undefined);
  // Other bytes than those signed: the binding fails.
  const changed = embedDigitalSourceType(ogg, "audio/ogg", DIGITAL_SOURCE_TYPES.generated, {
    models: ["other-model"],
  });
  assert.equal(
    (await sidecarCredentialProblem("loop.c2pa", sidecar, changed, expected))?.code,
    "credentials_mismatch",
  );
  assert.equal(
    (await sidecarCredentialProblem("loop.c2pa", undefined, ogg, expected))?.code,
    "credentials_missing",
  );
  // An existing sidecar that still holds is kept; one for other bytes is re-signed.
  assert.deepEqual(
    await sidecarCredentialed(ogg, "audio/ogg", claim, signer, "test", sidecar),
    sidecar,
  );
  const resigned = await sidecarCredentialed(changed, "audio/ogg", claim, signer, "test", sidecar);
  assert.notDeepEqual(resigned, sidecar);
  assert.equal(
    await sidecarCredentialProblem("loop.c2pa", resigned, changed, {
      digitalSourceType: claim.digitalSourceType,
      models: claim.models,
    }),
    undefined,
  );
});
