import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ExifTool } from "exiftool-vendored";
import jpeg from "jpeg-js";
import { failureOutcome } from "../src/commands/result.ts";
import { developmentSigner, readCredentials, signCredentials } from "../src/credentials.ts";
import { disclose } from "../src/disclosure.ts";
import { DEVELOPMENT_SIGNER_WARNING, writeToTarget } from "../src/handoff.ts";
import type { TargetWrite } from "../src/handoff.ts";
import { PRESETS } from "../src/handoff/presets/index.ts";
import type { AssetPreset, PresetRegistry } from "../src/handoff/presets/index.ts";
import { createRaster, encodePng } from "../src/image/raster.ts";
import { encodeWebpLossless } from "../src/image/webp.ts";
import {
  DIGITAL_SOURCE_TYPES,
  embedDigitalSourceType,
  readDigitalSourceType,
} from "../src/metadata.ts";
import { loadSettings, SettingsError } from "../src/settings.ts";
import type { Provenance } from "../src/types.ts";
import { readIndependently } from "./fixtures/c2pa-reader.ts";
import { shelterSpec, syntheticProfile } from "./fixtures/synthetic.ts";

const exiftool = new ExifTool({ maxProcs: 1 });
after(() => exiftool.end());

const generated = DIGITAL_SOURCE_TYPES.generated;
const MEDIA = "assets/source/fern/shelter";
const provenance: Provenance = {
  digitalSourceType: generated,
  generator: "sprite-strip",
  route: "scripted",
  models: ["model-a", "model-b"],
  prompt: "a prompt that never reaches the manifest",
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
};

function raster() {
  const r = createRaster(16, 8);
  for (let i = 0; i < r.data.length; i += 4) {
    r.data[i] = i % 251;
    r.data[i + 3] = 255;
  }
  return r;
}

const FORMATS = [
  { mediaType: "image/png", extension: "png", bytes: () => encodePng(raster()) },
  {
    mediaType: "image/jpeg",
    extension: "jpg",
    bytes: () => {
      const r = raster();
      return new Uint8Array(
        jpeg.encode({ data: Buffer.from(r.data), width: r.width, height: r.height }, 90).data,
      );
    },
  },
  { mediaType: "image/webp", extension: "webp", bytes: () => encodeWebpLossless(raster()) },
] as const;

function handoff(
  targetDir: string,
  format: (typeof FORMATS)[number],
  extra: Partial<TargetWrite> = {},
): TargetWrite {
  const profile = syntheticProfile();
  delete profile.validator;
  return {
    profile,
    spec: shelterSpec,
    bibleVersion: "v1",
    output: {
      bytes: format.bytes(),
      mediaType: format.mediaType,
      extension: format.extension,
      fields: {
        frames: { width: 16, height: 8, count: 1, durationMs: 120 },
        anchor: { x: 8, y: 8 },
        bounds: { x: 0, y: 0, width: 16, height: 8 },
      },
    },
    provenance,
    run: { runId: "r1", candidateId: "c1", pickedAt: "2026-01-01T00:00:02.000Z" },
    targetDir,
    ...extra,
  };
}

const temp = (name: string) => mkdtempSync(join(tmpdir(), `assetgrove-c2pa-${name}-`));

for (const format of FORMATS) {
  test(`${format.extension}: hand-off signs a manifest an independent reader validates`, async () => {
    const target = temp(format.extension);
    const result = await writeToTarget(handoff(target, format));
    const rel = `${MEDIA}.${format.extension}`;
    const file = join(target, rel);
    const bytes = new Uint8Array(await readFile(file));

    // Independently: exiftool's JUMBF, the COSE signature, the chain, the hashes.
    const read = await readIndependently(exiftool, file);
    assert.deepEqual(read.actions, [
      { action: "c2pa.created", digitalSourceType: generated, softwareAgent: "model-a; model-b" },
    ]);
    assert.equal(read.claimGenerator, "Assetgrove");
    assert.ok(read.signatureValid, "the COSE signature verifies with the leaf certificate");
    assert.ok(read.chainValid, "the certificate chain verifies");
    assert.ok(read.assertionsValid, "the claim's hashed URIs match the assertions");
    assert.ok(read.dataHashValid, "the data hash matches the file's bytes");
    assert.ok(!Buffer.from(bytes).includes(Buffer.from(provenance.prompt)));

    // The SDK's reader, and the IPTC mark beside the manifest.
    const sdk = await readCredentials(bytes, format.mediaType);
    assert.equal(sdk?.state, "Valid");
    assert.deepEqual(sdk?.failures, []);
    assert.equal(readDigitalSourceType(bytes, format.mediaType), generated);

    // The development certificate signed, and the result and provenance say so.
    assert.equal(result.contentCredentials?.development, true);
    assert.equal(result.contentCredentials?.warning, DEVELOPMENT_SIGNER_WARNING);
    assert.deepEqual(result.contentCredentials?.files, [rel]);
    assert.equal(read.signer.subject, "CN=Assetgrove development signer (not trusted)");
    // The profile embeds the provenance in its manifest.
    const manifest = JSON.parse(
      await readFile(join(target, "assets/manifests/fern/shelter.json"), "utf8"),
    ) as { provenance: { generated: Provenance } };
    const recorded = manifest.provenance.generated;
    assert.equal(
      recorded.contentCredentials?.certificateSha256,
      result.contentCredentials?.certificateSha256,
    );
    assert.equal(recorded.contentCredentials?.development, true);
  });

  test(`${format.extension}: re-running hand-off on an unchanged asset leaves its bytes identical`, async () => {
    const target = temp(`${format.extension}-again`);
    const file = join(target, `${MEDIA}.${format.extension}`);
    await writeToTarget(handoff(target, format));
    const first = await readFile(file);
    await writeToTarget(handoff(target, format));
    assert.ok(first.equals(await readFile(file)), "the manifest is not signed again");
    // A changed asset is signed again.
    await writeToTarget(
      handoff(target, format, { provenance: { ...provenance, models: ["model-c"] } }),
    );
    assert.ok(!first.equals(await readFile(file)));
  });
}

/** A preset that, at check time, replaces the written media with `replace(bytes)`. */
function tampering(replace: (bytes: Uint8Array) => Promise<Uint8Array>): PresetRegistry {
  const manifest = PRESETS.get("manifest") as AssetPreset;
  const tamper: AssetPreset = {
    ...manifest,
    name: "tamper",
    write: async () => [],
    check: async (context) => {
      const run = context.context["run"] as { targetDir: string };
      const file = join(run.targetDir, `${MEDIA}.png`);
      await writeFile(file, await replace(new Uint8Array(await readFile(file))));
      return [];
    },
  };
  return { presets: new Map([...PRESETS, ["tamper", tamper]]) };
}

test("a missing, invalid (wrong claim or broken signature) or mismatched manifest fails the mark check naming the file", async () => {
  const png = FORMATS[0];
  const signer = await developmentSigner(temp("other-signer"));
  const marked = embedDigitalSourceType(png.bytes(), "image/png", generated, {
    models: provenance.models,
  });
  const cases: Array<[string, (bytes: Uint8Array) => Promise<Uint8Array>, RegExp?]> = [
    // Stripped: the IPTC mark stays, the manifest is gone.
    ["credentials_missing", async () => marked],
    // Pixels changed after signing: the hard binding no longer matches.
    [
      "credentials_mismatch",
      async (bytes) => {
        const changed = bytes.slice();
        const idat = Buffer.from(changed).indexOf("IDAT");
        changed[idat + 8] = changed[idat + 8]! ^ 0xff;
        return changed;
      },
    ],
    // A valid signature over a claim that is not this asset's: another model.
    [
      "credentials_invalid",
      async () =>
        signCredentials(
          marked,
          "image/png",
          { digitalSourceType: generated, models: ["model-z"], title: "x.png" },
          signer,
          "0.1.0",
        ),
    ],
    // A broken signature: one byte of the COSE signature in the c2pa.signature box flipped.
    [
      "credentials_invalid",
      async (bytes) => {
        const buffer = Buffer.from(bytes);
        const label = buffer.indexOf("c2pa.signature");
        const content = buffer.indexOf("cbor", label);
        assert.ok(label > 0 && content > label, "the signature box");
        // The COSE_Sign1 ends with its signature: flip a byte inside it.
        const end = content - 4 + buffer.readUInt32BE(content - 4);
        const changed = bytes.slice();
        changed[end - 8] = changed[end - 8]! ^ 0xff;
        return changed;
      },
      /invalid \(claimSignature\.mismatch\)/,
    ],
  ];
  for (const [code, replace, says] of cases) {
    const target = temp(code);
    const write = handoff(target, png, { registry: tampering(replace) });
    write.profile.handoff = [{ preset: "manifest" }, { preset: "tamper" }];
    const error = await writeToTarget({
      ...write,
      // The tamper preset reads the target from its context.
      run: { ...write.run, targetDir: target },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error, `${code}: the hand-off must fail`);
    const outcome = failureOutcome(error);
    assert.equal(outcome.exitCode, 6);
    assert.equal(outcome.error?.code, "handoff_check_failed");
    const problem = outcome.error?.problems?.find((p) => p.code === code);
    assert.ok(problem, `${code}: ${JSON.stringify(outcome.error?.problems)}`);
    assert.equal(problem.file, `${MEDIA}.png`);
    assert.match(problem.problem ?? "", /assets\/source\/fern\/shelter\.png/);
    if (says) assert.match(problem.problem ?? "", says);
  }
});

test("a certificate from developer settings signs instead of the development one", async () => {
  const keys = temp("keys");
  const own = await developmentSigner(keys);
  const settings = {
    ...loadSettings(),
    contentCredentials: {
      certificate: join(keys, "content-credentials", "chain.pem"),
      privateKey: join(keys, "content-credentials", "signer.key"),
    },
  };
  const target = temp("settings-signer");
  const result = await writeToTarget(handoff(target, FORMATS[0], { gate: { settings } }));
  assert.equal(result.contentCredentials?.development, false);
  assert.equal(result.contentCredentials?.warning, undefined);
  assert.equal(result.contentCredentials?.certificateSha256, own.record.certificateSha256);
  const read = await readIndependently(exiftool, join(target, `${MEDIA}.png`));
  assert.ok(read.signatureValid && read.dataHashValid);
  assert.equal(
    read.signer.fingerprint256.replaceAll(":", "").toLowerCase(),
    own.record.certificateSha256,
  );
});

test("the signing key and certificate are refused inside a project", () => {
  const repo = temp("repo");
  execFileSync("git", ["init", "-q", repo]);
  const config = temp("config");
  const path = join(config, "settings.json");
  writeFileSync(
    path,
    JSON.stringify({
      format: "assetgrove-settings/1",
      stateDir: temp("state"),
      contentCredentials: { certificate: join(repo, "chain.pem"), privateKey: "/abs/signer.key" },
    }),
  );
  assert.throws(
    () => loadSettings({ env: { ASSETGROVE_CONFIG: path }, cwd: repo }),
    (error: unknown) =>
      error instanceof SettingsError && /contentCredentials\.certificate/.test(error.message),
  );
  writeFileSync(
    path,
    JSON.stringify({
      format: "assetgrove-settings/1",
      contentCredentials: { certificate: "chain.pem", privateKey: "/abs/signer.key" },
    }),
  );
  assert.throws(() => loadSettings({ env: { ASSETGROVE_CONFIG: path } }), SettingsError);
});

test("the disclosure summary lists the development certificate's assets", async () => {
  const target = temp("disclosure");
  await writeToTarget(handoff(target, FORMATS[0]));
  const summary = await disclose(target);
  assert.equal(summary.contentCredentials.signed, 1);
  assert.equal(summary.contentCredentials.development, 1);
  assert.match(summary.contentCredentials.note ?? "", /development certificate/);
});
