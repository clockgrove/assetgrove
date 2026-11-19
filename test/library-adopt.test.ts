import { readLibrary, rebuildLibrary } from "../src/library/maintain.ts";
import { parseCard } from "../src/library/card.ts";
/**
 * `library adopt` (issues #251 and #235): a hand edit becomes the next version, handed off as a pick
 * is, with credentials naming its original.
 */
import { resetSettings, stateDir, useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { credentialProblem, readCredentials } from "../src/credentials.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { HandoffCheckError, PRESETS } from "../src/handoff/presets/index.ts";
import type { HandoffPreset } from "../src/handoff/presets/index.ts";
import { GLB_MEDIA_TYPE, parseGlb, writeGlb } from "../src/model3d/glb.ts";
import { readDigitalSourceType } from "../src/metadata.ts";
import { defaultRoutes } from "../src/routes.ts";
import { importSheet, writeFamilies } from "../src/sheet/import.ts";
import { decodeImage } from "../src/image/raster.ts";
import { appendAnnotation, writeReview } from "../src/library/review.ts";
import { syntheticCharacter } from "./fixtures/glb.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { writeToTarget } from "../src/handoff.ts";
import { createRaster, encodePng } from "../src/image/raster.ts";
import { confirmCommand } from "../src/commands/confirm.ts";
import { libraryAdoptCommand } from "../src/commands/library.ts";
import { runCommand } from "../src/commands/runner.ts";
import type { ConfirmPort, ConfirmRequest } from "../src/confirm/prompt.ts";
import { loadAsset, locateAsset } from "../src/library/actions.ts";
import { adoptHandEdit, originalFile, workingFile } from "../src/library/adopt.ts";
import { parseReview } from "../src/library/review.ts";
import { loadSettings } from "../src/settings.ts";
import type { Provenance } from "../src/types.ts";
import { shelterSpec, syntheticProfile, syntheticWorld } from "./fixtures/synthetic.ts";
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

const OWN_PROVENANCE =
  "assets/source/{{spec.assetId}}/{{spec.animationFamily}}.png.provenance.json";

interface HandedOffMedia {
  bytes: Uint8Array;
  mediaType: string;
  extension: string;
}

const PNG_STRIP = (): HandedOffMedia => ({
  bytes: encodePng(createRaster(64, 8)),
  mediaType: "image/png",
  extension: "png",
});

async function handedOff(provenanceLayout?: string, made: HandedOffMedia = PNG_STRIP()) {
  const targetDir = await mkdtemp(join(tmpdir(), "assetgrove-adopt-"));
  const png = made.mediaType === "image/png";
  const profile = syntheticProfile({
    handoff: [
      { preset: "manifest" },
      ...(png ? [{ preset: "atlas-json", options: { shape: "array" } }] : []),
    ] as never,
  });
  delete profile.validator;
  if (provenanceLayout !== undefined) profile.layout.provenance = provenanceLayout;
  const fields = {
    frames: { width: 16, height: 8, count: 4, durationMs: 120 },
    anchor: { x: 8, y: 8 },
    bounds: { x: 0, y: 0, width: 16, height: 8 },
  };
  await writeToTarget({
    profile,
    spec: shelterSpec,
    bibleVersion: "v1",
    output: { ...made, fields },
    provenance,
    run: { runId: "r1", candidateId: "c1", pickedAt: "2026-01-01T00:00:02.000Z" },
    targetDir,
  });
  // The run that made the asset, in the project's runs directory, as adopt renders from it.
  const runDir = join(targetDir, ".assetgrove/runs/r1");
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "run.json"),
    JSON.stringify({
      runId: "r1",
      profile,
      spec: shelterSpec,
      bibleVersion: "v1",
      candidates: [
        {
          id: "c1",
          fields,
          provenance,
          mediaType: made.mediaType,
          extension: made.extension,
        },
      ],
    }),
  );
  const media = join(targetDir, `assets/source/fern/shelter.${made.extension}`);
  const card = join(targetDir, "assets/source/fern/fern-shelter.md");
  const original = join(targetDir, `original.${made.extension}`);
  await copyFile(media, original);
  /** The adopt of the file as it is now, with `originalPath` as the original. */
  const options = async (originalPath = original) => {
    const asset = await loadAsset(locateAsset(card));
    return {
      asset,
      targetDir,
      edited: await workingFile(asset),
      original: await originalFile(asset, originalPath),
      gate: { settings: loadSettings() },
    };
  };
  const reviewPath = join(targetDir, "assets/source/fern/fern-shelter.review.json");
  const manifest = join(targetDir, "assets/manifests/fern/shelter.json");
  return { targetDir, media, original, options, profile, card, reviewPath, manifest };
}

async function edit(media: string, red = 200) {
  const raster = createRaster(64, 8);
  raster.data[0] = red;
  raster.data[3] = 255;
  await writeFile(media, encodePng(raster));
}

test("an adopted hand edit records the edit with the AI-made original as an ingredient", async () => {
  const { targetDir, media, options } = await handedOff();
  await edit(media);
  const result = await adoptHandEdit(await options());
  assert.equal(result.version, 2);
  assert.ok(result.contentCredentials?.warning);

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
  await assert.rejects(options(), /nothing to adopt/);
  await edit(media);
  const other = join(dirname(media), "other.png");
  await writeFile(other, encodePng(createRaster(8, 8)));
  await assert.rejects(
    options(other),
    (error: Error) => error.name === "InputError" && /lock\.sha256/.test(error.message),
  );
});

test("an asset with a provenance file of its own gets it rewritten with the adopt step", async () => {
  const { targetDir, profile, card, media, options } = await handedOff(OWN_PROVENANCE);
  await edit(media);
  await adoptHandEdit(await options());
  const own = JSON.parse(await readFile(`${media}.provenance.json`, "utf8"));
  assert.equal(own.digitalSourceType, DIGITAL_SOURCE_TYPES.composite);
  assert.deepEqual(
    own.steps.slice(-2).map((s: { op: string }) => s.op),
    ["human-edit", "embed-digital-source-type"],
  );
  assert.ok(own.contentCredentials);
  const expected = { kind: "ai-generated", digitalSourceType: DIGITAL_SOURCE_TYPES.composite };
  assert.deepEqual(parseCard(await readFile(card, "utf8"), card).data["origin"], expected);
  await rebuildLibrary(await readLibrary(profile, targetDir));
  assert.deepEqual(parseCard(await readFile(card, "utf8"), card).data["origin"], expected);
});

test("a provenance file of another name keeps its card source and gets the adopt step", async () => {
  const { targetDir, media, options } = await handedOff(
    "assets/source/{{spec.assetId}}/{{spec.animationFamily}}.provenance.json",
  );
  const provenancePath = join(targetDir, "assets/source/fern/shelter.provenance.json");
  await edit(media);
  const result = await adoptHandEdit(await options());
  assert.ok(
    result.files.includes("assets/source/fern/shelter.provenance.json"),
    result.files.join(),
  );
  const own = JSON.parse(await readFile(provenancePath, "utf8"));
  assert.equal(own.digitalSourceType, DIGITAL_SOURCE_TYPES.composite);
  assert.equal(own.steps.at(-2).op, "human-edit");
  assert.equal(
    own.contentCredentials.certificateSha256,
    result.contentCredentials?.certificateSha256,
  );
  const card = await readFile(join(targetDir, "assets/source/fern/fern-shelter.md"), "utf8");
  assert.match(card, /id: provenance/);
  assert.match(card, /shelter\.provenance\.json/);
  const review = parseReview(
    await readFile(join(targetDir, "assets/source/fern/fern-shelter.review.json"), "utf8"),
    "review",
  );
  assert.equal(
    review.versions.at(-1)!.provenanceSha256,
    createHash("sha256")
      .update(await readFile(provenancePath))
      .digest("hex"),
  );
});

test("library adopt asks a person first: attended with no TTY it exits 8 and writes nothing; after confirm <id> the version records the confirmation", async (t) => {
  t.after(() => resetSettings());
  useAttended();
  const { targetDir, media, original, profile } = await handedOff();
  const profilePath = join(targetDir, "adopt-profile.json");
  await writeFile(profilePath, JSON.stringify(profile));
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
  assert.equal(id.kind, "pick");
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

const versionsOf = async (reviewPath: string) =>
  parseReview(await readFile(reviewPath, "utf8"), "review").versions;

/** The steps of the provenance a manifest embeds (the synthetic profile's `provenance.generated`). */
const embeddedSteps = async (manifest: string): Promise<string[]> =>
  (
    JSON.parse(await readFile(manifest, "utf8")) as {
      provenance: { generated: { steps: { op: string }[] } };
    }
  ).provenance.generated.steps.map((s) => s.op);

test("a second adopt builds on the first edit's provenance where the layout puts it, outside the library root", async () => {
  // The synthetic profile embeds provenance in a manifest under assets/manifests, outside the
  // library root assets/source, so the card names no provenance source.
  const { media, manifest, card, options, targetDir } = await handedOff();
  assert.doesNotMatch(await readFile(card, "utf8"), /id: provenance/);
  await edit(media, 200);
  await adoptHandEdit(await options());
  const second = join(targetDir, "second-original.png");
  await copyFile(media, second);
  await edit(media, 120);
  const result = await adoptHandEdit(await options(second));
  assert.equal(result.version, 3);
  const ops = await embeddedSteps(manifest);
  assert.equal(ops.filter((op) => op === "human-edit").length, 2, ops.join());
});

test("a hand-edited GLB is handed off with its own media type: marked composite, its manifest naming model/gltf-binary; bytes of another type exit 2", async () => {
  const { media, manifest, reviewPath, options, targetDir } = await handedOff(undefined, {
    bytes: syntheticCharacter(),
    mediaType: GLB_MEDIA_TYPE,
    extension: "glb",
  });
  const glb = parseGlb(new Uint8Array(await readFile(media)));
  glb.json.asset = { ...glb.json.asset, copyright: "edited by hand" };
  await writeFile(media, writeGlb(glb));
  const result = await adoptHandEdit(await options());
  assert.equal(result.version, 2);
  const bytes = new Uint8Array(await readFile(media));
  assert.equal(readDigitalSourceType(bytes, GLB_MEDIA_TYPE), DIGITAL_SOURCE_TYPES.composite);
  const written = JSON.parse(await readFile(manifest, "utf8"));
  assert.equal(written.source.mediaType, GLB_MEDIA_TYPE);
  assert.equal(
    (await versionsOf(reviewPath)).at(-1)!["digitalSourceType"],
    DIGITAL_SOURCE_TYPES.composite,
  );

  // A PNG saved over the .glb is not the version's media type: exit 2, nothing recorded.
  const second = join(targetDir, "second-original.glb");
  await copyFile(media, second);
  await writeFile(media, encodePng(createRaster(8, 8)));
  await assert.rejects(
    adoptHandEdit(await options(second)),
    (error: Error) => error.name === "InputError" && /model\/gltf-binary/.test(error.message),
  );
  assert.equal((await versionsOf(reviewPath)).length, 2);
});

test("a run id in the review record that is not one path segment exits 2 before anything is read from it", async () => {
  const { media, reviewPath, options } = await handedOff();
  await edit(media);
  const text = await readFile(reviewPath, "utf8");
  await writeFile(reviewPath, text.replace('"run":"r1"', '"run":"../../planted"'));
  assert.match(await readFile(reviewPath, "utf8"), /planted/);
  await assert.rejects(
    adoptHandEdit(await options()),
    (error: Error) => error.name === "InputError" && /one path segment/.test(error.message),
  );
});

test("a run that lacks the version's candidate exits 2", async () => {
  const { media, targetDir, options } = await handedOff();
  await edit(media);
  const runFile = join(targetDir, ".assetgrove/runs/r1/run.json");
  const run = JSON.parse(await readFile(runFile, "utf8"));
  run.candidates = [];
  await writeFile(runFile, JSON.stringify(run));
  await assert.rejects(
    adoptHandEdit(await options()),
    (error: Error) => error.name === "InputError" && /no candidate "c1"/.test(error.message),
  );
});

test("a failed read-back records no version and puts back every file the adopt wrote", async () => {
  const { media, manifest, reviewPath, card, targetDir, options, profile } = await handedOff();
  await edit(media);
  const editedBytes = await readFile(media);
  const manifestBefore = await readFile(manifest, "utf8");
  const cardBefore = await readFile(card, "utf8");
  // The run's profile adds a preset whose read-back finds a problem.
  const broken: HandoffPreset = {
    name: "broken",
    optionsSchema: PRESETS.get("manifest")!.optionsSchema,
    write: async () => [{ path: "assets/broken.txt", content: "written\n" }],
    check: async () => ["the broken preset always finds a problem"],
  };
  const runFile = join(targetDir, ".assetgrove/runs/r1/run.json");
  const run = JSON.parse(await readFile(runFile, "utf8"));
  run.profile = { ...profile, handoff: [...(profile.handoff ?? []), { preset: "broken" }] };
  await writeFile(runFile, JSON.stringify(run));
  await assert.rejects(
    adoptHandEdit({
      ...(await options()),
      registry: { presets: new Map([...PRESETS, ["broken", broken]]) },
    }),
    (error: Error) => error instanceof HandoffCheckError,
  );
  assert.equal((await versionsOf(reviewPath)).length, 1);
  assert.deepEqual(await readFile(media), editedBytes, "the person's edit is put back");
  assert.equal(await readFile(manifest, "utf8"), manifestBefore);
  assert.equal(await readFile(card, "utf8"), cardBefore);
  assert.equal(existsSync(join(targetDir, "assets/broken.txt")), false);
});

test("an asset write-families handed off is adopted from its import", async () => {
  const world = await syntheticWorld();
  const targetDir = world.targetDir;
  const profile = world.profile;
  delete profile.validator;
  const call = new Caller({
    provider: new ScriptedProvider({
      image: () => ({ images: [], costUsd: 0 }),
      vision: () => ({
        text: JSON.stringify({
          families: [{ name: "idle", frames: [1, 2, 3, 4], reason: "standing still" }],
          unassigned: [],
        }),
        costUsd: 0,
      }),
    }),
    providerName: "scripted",
    budget: new Budget(5),
    routes: defaultRoutes,
  });
  const { importDir, grouping } = await importSheet({
    digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
    sheet: syntheticSheet().png,
    sheetPath: "sheets/synthetic.png",
    tool: "synthetic",
    assetId: "fern",
    profile,
    importsDir: join(targetDir, ".assetgrove/imports"),
    importId: "imp1",
    propose: { call },
  });
  await writeFamilies({ importDir, grouping: { ...grouping, status: "confirmed" }, targetDir });
  const card = join(targetDir, "assets/source/fern/fern-idle.md");
  const media = join(targetDir, "assets/source/fern/idle.png");
  const original = join(world.dir, "original.png");
  await copyFile(media, original);
  // A person recolours one opaque pixel.
  const raster = decodeImage(new Uint8Array(await readFile(media)));
  const opaque = raster.data.findIndex((v, i) => i % 4 === 3 && v === 255) - 3;
  raster.data[opaque] = 255 - raster.data[opaque]!;
  await writeFile(media, encodePng(raster));

  const asset = await loadAsset(locateAsset(card));
  const result = await adoptHandEdit({
    asset,
    targetDir,
    edited: await workingFile(asset),
    original: await originalFile(asset, original),
    gate: { settings: loadSettings() },
  });
  assert.equal(result.version, 2);
  const bytes = new Uint8Array(await readFile(media));
  assert.equal(readDigitalSourceType(bytes, "image/png"), DIGITAL_SOURCE_TYPES.composite);
  const manifest = JSON.parse(
    await readFile(join(targetDir, "assets/manifests/fern/idle.json"), "utf8"),
  );
  assert.equal(manifest.contentHash, result.sha256);
  assert.equal(manifest.animationFamily, "idle");
  assert.ok(manifest.provenance.generated.steps.some((s: { op: string }) => s.op === "human-edit"));
});

test("library adopt confirms the run and its profile: a stored confirmation no longer applies once the run's profile changes, or the record gains a line", async (t) => {
  t.after(() => resetSettings());
  useAttended();
  const { targetDir, media, original, profile, reviewPath } = await handedOff();
  const profilePath = join(targetDir, "adopt-profile.json");
  await writeFile(profilePath, JSON.stringify(profile));
  await edit(media);
  const args = { target: targetDir, profile: profilePath, asset: "fern-shelter", original };
  const context = () => ({ settings: loadSettings(), log: () => {} });
  const port: ConfirmPort = { method: "tty", confirm: async () => true };
  const ask = async () => {
    const refused = await runCommand(libraryAdoptCommand, args, context());
    assert.equal(refused.exitCode, 8, refused.error?.message);
    return (refused.error as unknown as { confirmation: { id: string; summary?: string } })
      .confirmation;
  };
  const first = await ask();
  const done = await runCommand(confirmCommand, { id: first.id }, { ...context(), prompt: port });
  assert.equal(done.exitCode, 0, done.error?.message);

  // The run's profile changes after the person confirmed: the adopt asks again.
  const runFile = join(targetDir, ".assetgrove/runs/r1/run.json");
  const run = JSON.parse(await readFile(runFile, "utf8"));
  run.profile.values = { ...run.profile.values, creator: "Someone Else" };
  await writeFile(runFile, JSON.stringify(run));
  const second = await ask();
  assert.notEqual(second.id, first.id);
  assert.equal((await versionsOf(reviewPath)).length, 1);

  // The record gains a line after the person confirmed: the adopt asks again.
  const again = await runCommand(confirmCommand, { id: second.id }, { ...context(), prompt: port });
  assert.equal(again.exitCode, 0, again.error?.message);
  const asset = await loadAsset(locateAsset(join(targetDir, "assets/source/fern/fern-shelter.md")));
  await writeFile(
    reviewPath,
    writeReview(
      appendAnnotation(asset.record, {
        type: "Annotation",
        motivation: "commenting",
        created: "2030-01-01T00:00:00Z",
        body: { type: "TextualBody", value: "from another branch" },
        target: { source: "shelter.png" },
      }),
    ),
  );
  const third = await ask();
  assert.notEqual(third.id, second.id);
  assert.equal((await versionsOf(reviewPath)).length, 1);
});

test("library adopt checks the request again under the lock: a record changed while the person was asked exits 2 plan_changed and writes nothing", async (t) => {
  t.after(() => resetSettings());
  useAttended();
  const { targetDir, media, original, profile, reviewPath } = await handedOff();
  const profilePath = join(targetDir, "adopt-profile.json");
  await writeFile(profilePath, JSON.stringify(profile));
  await edit(media);
  const editedBytes = await readFile(media);
  const args = { target: targetDir, profile: profilePath, asset: "fern-shelter", original };
  // While the person is asked, another process appends a comment to the record.
  const port: ConfirmPort = {
    method: "tty",
    confirm: async () => {
      const asset = await loadAsset(
        locateAsset(join(targetDir, "assets/source/fern/fern-shelter.md")),
      );
      await writeFile(
        reviewPath,
        writeReview(
          appendAnnotation(asset.record, {
            type: "Annotation",
            motivation: "commenting",
            created: "2030-01-01T00:00:00Z",
            body: { type: "TextualBody", value: "while the form was open" },
            target: { source: "shelter.png" },
          }),
        ),
      );
      return true;
    },
  };
  const out = await runCommand(libraryAdoptCommand, args, {
    settings: loadSettings(),
    log: () => {},
    prompt: port,
  });
  assert.equal(out.exitCode, 2, out.error?.message);
  assert.equal(out.error?.code, "plan_changed");
  assert.equal((await versionsOf(reviewPath)).length, 1);
  assert.deepEqual(await readFile(media), editedBytes);
});
