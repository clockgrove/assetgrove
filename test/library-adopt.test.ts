/** `library adopt` (issue #251): a hand edit becomes the next version with credentials naming its original. */
import { resetSettings, stateDir, useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { credentialProblem, readCredentials } from "../src/credentials.ts";
import { writeToTarget } from "../src/handoff.ts";
import { createRaster, encodePng } from "../src/image/raster.ts";
import { confirmCommand } from "../src/commands/confirm.ts";
import { libraryAdoptCommand } from "../src/commands/library.ts";
import { runCommand } from "../src/commands/runner.ts";
import type { ConfirmPort, ConfirmRequest } from "../src/confirm/prompt.ts";
import { adoptHandEdit } from "../src/library/adopt.ts";
import { parseReview } from "../src/library/review.ts";
import { loadSettings } from "../src/settings.ts";
import type { Provenance } from "../src/types.ts";
import { shelterSpec, syntheticProfile } from "./fixtures/synthetic.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";

const provenance: Provenance = {
  digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
  generator: "sprite-strip",
  route: "scripted",
  models: ["model-a"],
  prompt: "a fern",
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

async function handedOff(ownProvenance = false) {
  const targetDir = await mkdtemp(join(tmpdir(), "assetgrove-adopt-"));
  const profile = syntheticProfile({
    handoff: [{ preset: "atlas-json", options: { shape: "array" } }] as never,
  });
  delete profile.validator;
  if (ownProvenance) {
    profile.layout.provenance =
      "assets/source/{{spec.assetId}}/{{spec.animationFamily}}.png.provenance.json";
  }
  await writeToTarget({
    profile,
    spec: shelterSpec,
    bibleVersion: "v1",
    output: {
      bytes: encodePng(createRaster(64, 8)),
      mediaType: "image/png",
      extension: "png",
      fields: { frames: { width: 16, height: 8, count: 4, durationMs: 120 } },
    },
    provenance,
    run: { runId: "r1", candidateId: "c1", pickedAt: "2026-01-01T00:00:02.000Z" },
    targetDir,
  });
  const media = join(targetDir, "assets/source/fern/shelter.png");
  const original = join(targetDir, "original.png");
  await copyFile(media, original);
  const options = {
    profile,
    targetDir,
    assetId: "fern-shelter",
    originalPath: original,
    settings: loadSettings(),
  };
  return { targetDir, media, original, options };
}

async function edit(media: string) {
  const raster = createRaster(64, 8);
  raster.data[0] = 200;
  raster.data[3] = 255;
  await writeFile(media, encodePng(raster));
}

test("an adopted hand edit records the edit with the AI-made original as an ingredient", async () => {
  const { targetDir, media, options } = await handedOff();
  await edit(media);
  const result = await adoptHandEdit(options);
  assert.equal(result.version, 2);
  assert.ok(result.contentCredentials.warning);

  const bytes = new Uint8Array(await readFile(media));
  const read = await readCredentials(bytes, "image/png");
  assert.ok(read);
  const names = read.actions.map((a) => a.action);
  assert.deepEqual(names.slice(0, 2), ["c2pa.opened", "c2pa.edited"]);
  assert.ok(read.ingredients.some((i) => i.relationship === "parentOf"));
  assert.equal(
    await credentialProblem("shelter.png", bytes, "image/png", {
      digitalSourceType: DIGITAL_SOURCE_TYPES.composite,
      models: ["model-a"],
      adopted: true,
    }),
    undefined,
  );

  const review = parseReview(
    await readFile(join(targetDir, "assets/source/fern/fern-shelter.review.json"), "utf8"),
    "review",
  );
  assert.equal(review.versions.length, 2);
  assert.ok(
    review.annotations.some((a) => (a as { "ag:action"?: string })["ag:action"] === "adopt"),
  );
});

test("adopting refuses a wrong original and an unedited file with exit 2", async () => {
  const { media, options } = await handedOff();
  await assert.rejects(adoptHandEdit(options), /nothing to adopt/);
  await edit(media);
  const other = join(options.targetDir, "other.png");
  await writeFile(other, encodePng(createRaster(8, 8)));
  await assert.rejects(
    adoptHandEdit({ ...options, originalPath: other }),
    (error: Error) => error.name === "InputError" && /lock\.sha256/.test(error.message),
  );
});

test("an asset with a provenance file of its own gets it rewritten with the adopt step", async () => {
  const { media, options } = await handedOff(true);
  await edit(media);
  await adoptHandEdit(options);
  const own = JSON.parse(await readFile(`${media}.provenance.json`, "utf8"));
  assert.equal(own.digitalSourceType, DIGITAL_SOURCE_TYPES.composite);
  assert.equal(own.steps.at(-1).op, "adopt-hand-edit");
  assert.ok(own.contentCredentials);
});

test("library adopt asks a person first: attended with no TTY it exits 8 and writes nothing; after confirm <id> the version records the confirmation", async (t) => {
  t.after(() => resetSettings());
  useAttended();
  const { targetDir, media, original, options } = await handedOff();
  const profilePath = join(targetDir, "adopt-profile.json");
  await writeFile(profilePath, JSON.stringify(options.profile));
  await edit(media);
  const editedBytes = await readFile(media);
  const args = { target: targetDir, profile: profilePath, asset: "fern-shelter", original };
  const context = (prompt?: ConfirmPort) => ({
    settings: loadSettings(),
    log: () => {},
    ...(prompt && { prompt }),
  });
  const reviewPath = join(targetDir, "assets/source/fern/fern-shelter.review.json");
  const versions = async () => parseReview(await readFile(reviewPath, "utf8"), "review").versions;

  const refused = await runCommand(libraryAdoptCommand, args, context());
  assert.equal(refused.exitCode, 8);
  assert.equal(refused.error?.code, "confirmation_required");
  const id = (refused.error as unknown as { confirmation: { id: string; kind: string } })
    .confirmation;
  assert.equal(id.kind, "write");
  assert.ok(existsSync(join(stateDir, "pending", `${id.id}.json`)));
  assert.deepEqual(await readFile(media), editedBytes, "the media is not signed or replaced");
  assert.equal((await versions()).length, 1);

  const asked: ConfirmRequest[] = [];
  const port: ConfirmPort = {
    method: "tty",
    confirm: async (request) => {
      asked.push(request);
      return true;
    },
  };
  const confirmed = await runCommand(confirmCommand, { id: id.id }, context(port));
  assert.equal(confirmed.exitCode, 0, confirmed.error?.message);
  assert.equal(asked[0]!.details["asset"], "fern-shelter");

  const adopted = await runCommand(libraryAdoptCommand, args, context());
  assert.equal(adopted.exitCode, 0, adopted.error?.message);
  const stack = await versions();
  assert.equal(stack.length, 2);
  assert.equal(stack[1]!.confirmation?.method, "terminal");
  assert.equal(stack[1]!.confirmation?.digest, id.id);
});
