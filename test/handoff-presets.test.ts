import "./fixtures/env.ts";
import { approve, approveProfile } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { failureOutcome } from "../src/commands/result.ts";
import { pick, writeToTarget } from "../src/handoff.ts";
import type { TargetWrite } from "../src/handoff.ts";
import { encodePng } from "../src/image/raster.ts";
import { writeRun } from "../src/loop.ts";
import type { RunRecord, StagedCandidate } from "../src/loop.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { GLB_MEDIA_TYPE } from "../src/model3d/glb.ts";
import { sha256 } from "../src/request.ts";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { defaultRoutes } from "../src/routes.ts";
import { importSheet, writeFamilies } from "../src/sheet/import.ts";
import type { Grouping } from "../src/sheet/types.ts";
import type { Provenance, TargetProfile } from "../src/types.ts";
import { syntheticCharacter } from "./fixtures/glb.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import {
  drawSubject,
  shelterSpec,
  syntheticProfile,
  syntheticWorld,
} from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
approve(passingScript);

const PNG = encodePng(drawSubject(32));
const SIDE = encodePng(drawSubject(8));

const provenance: Provenance = {
  digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
  generator: "sprite-strip",
  route: "scripted",
  models: ["scripted"],
  prompt: "a grey fox sheltering",
  parameters: { size: 32 },
  requestIds: ["req-1"],
  referenceHashes: ["abc"],
  bibleVersion: "synthetic-1",
  license: "MIT",
  providerTerms: [],
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  costUsd: 0,
  calls: [],
};

const RUN = { runId: "r1", candidateId: "c1", pickedAt: "2026-01-01T00:00:02.000Z" };

/** The example profile of docs/target-profile.md: provenance written beside the media. */
function docsProfile(): TargetProfile {
  const base = syntheticProfile();
  delete base.validator;
  return {
    ...base,
    manifest: {
      assetManifestVersion: 1,
      assetId: "{{spec.assetId}}",
      animationFamily: "{{spec.animationFamily}}",
      source: {
        kind: "generated",
        path: "{{output.path}}",
        creator: "{{profile.creator}}",
        tool: "assetgrove",
      },
      license: "{{profile.license}}",
      provenance: {
        prompt: "{{provenance.prompt}}",
        references: "{{provenance.referenceHashes}}",
      },
      review: { status: "pending" },
      semantic: "{{spec.fields.semantic?}}",
      frames: "{{output.frames}}",
      anchor: "{{output.anchor}}",
      bounds: "{{output.bounds}}",
      palette: "{{output.palette?}}",
      contentHash: "{{output.sha256}}",
    },
  };
}

/** The hand-offs whose bytes the base commit wrote, before presets. */
function cases(): Record<string, () => Omit<TargetWrite, "targetDir">> {
  const strip = (profile: TargetProfile) => ({
    profile,
    spec: shelterSpec,
    bibleVersion: "synthetic-1",
    output: {
      bytes: PNG,
      mediaType: "image/png",
      extension: "png",
      fields: {
        frames: { width: 32, height: 32, count: 1 },
        anchor: { x: 16, y: 30 },
        bounds: { x: 3, y: 12, width: 26, height: 15 },
        palette: ["#26242c"],
      },
    },
    provenance,
    run: RUN,
  });
  return {
    "embedded provenance": () => {
      const profile = syntheticProfile();
      delete profile.validator;
      return strip(profile);
    },
    "provenance beside the media": () => strip(docsProfile()),
    "3d with sidecars and a provenance path": () => {
      const profile = syntheticProfile({
        layout: {
          media: "characters/{{spec.assetId}}/{{spec.assetId}}.{{output.extension}}",
          manifest: "characters/{{spec.assetId}}/manifest.json",
          provenance: "characters/{{spec.assetId}}/provenance.json",
        },
        manifest: {
          assetId: "{{spec.assetId}}",
          eyes: "{{output.eyes?}}",
          clips: "{{output.clips?}}",
          provenancePath: "{{provenancePath}}",
          review: { status: "pending" },
        },
      });
      delete profile.validator;
      return {
        profile,
        spec: { kind: "character-3d", assetId: "fox", fields: {} } as TargetWrite["spec"],
        bibleVersion: "v1",
        output: {
          bytes: syntheticCharacter(),
          mediaType: GLB_MEDIA_TYPE,
          extension: "glb",
          fields: { clips: [{ name: "idle", seconds: 1 }] },
          sidecars: [
            {
              name: "fox.eyes.png",
              bytes: SIDE,
              mediaType: "image/png",
              field: "eyes",
              extra: { material: "eyes" },
            },
          ],
        },
        provenance: { ...provenance, generator: "model3d" },
        run: RUN,
      };
    },
  };
}

/**
 * The sha256 of every file each case writes, recorded from the base commit's `writeToTarget`
 * before hand-off went through presets.
 */
const BASE: Record<string, Record<string, string>> = {
  "embedded provenance": {
    "assets/source/fern/shelter.png":
      "f4655614107fdc4e3f50d1dd7a029af54b0e37c11cb781e09686d293247a2776",
    "assets/manifests/fern/shelter.json":
      "3047c8bfc2e3486c3c6af6b9784dd302143c4d31d5621ab01ffa52a645c8b2af",
  },
  "provenance beside the media": {
    "assets/source/fern/shelter.png":
      "f4655614107fdc4e3f50d1dd7a029af54b0e37c11cb781e09686d293247a2776",
    "assets/source/fern/shelter.png.provenance.json":
      "69ba466f7b597a2e4b4e9bbafeec1e89e7c8843ba6408438d5898a1a50d2699b",
    "assets/manifests/fern/shelter.json":
      "82a4c33d5e7e95825bb753491746b8d53ae783a1d2647cd192629389485b5df8",
  },
  "3d with sidecars and a provenance path": {
    "characters/fox/fox.eyes.png":
      "ce6f58b91dbe5ee416715d238409268356e76f7369f9c820bc5b6266e8056f29",
    "characters/fox/fox.glb": "dd5e045c438db73cc15d71f8e8b1452fbf8543e415d6d9794f0bc4904d890738",
    "characters/fox/manifest.json":
      "61c68a867d1db1c8945b0cd48fa018a1b12ab6bdfe14516341520d5058946566",
    "characters/fox/provenance.json":
      "c079a6364f9a15eaf50a2da1fca7f6df319f722b31a329c9f607a1d953e601fb",
  },
};

async function filesUnder(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out[relative(dir, full).replaceAll("\\", "/")] = sha256(await readFile(full));
  }
  return out;
}

async function target(): Promise<string> {
  return mkdtemp(join(tmpdir(), "assetgrove-presets-"));
}

test("existing fixtures produce byte-identical manifests through the manifest preset", async () => {
  for (const [name, make] of Object.entries(cases())) {
    const implicit = await target();
    await writeToTarget({ ...make(), targetDir: implicit });
    const files = await filesUnder(implicit);
    assert.deepEqual(files, BASE[name], name);

    const explicit = await target();
    const write = make();
    write.profile = { ...write.profile, handoff: [{ preset: "manifest" }] };
    const result = await writeToTarget({ ...write, targetDir: explicit });
    assert.deepEqual(await filesUnder(explicit), files, `${name}, named in handoff`);
    assert.equal(result.handoff.length, 1);
    assert.equal(result.handoff[0]!.preset, "manifest");
    assert.deepEqual(result.handoff[0]!.files, [
      relative(explicit, result.manifestPath).replaceAll("\\", "/"),
    ]);
  }
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env: process.env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function doc(result: Result): Record<string, any> {
  return JSON.parse(result.stdout);
}

/** A validator that leaves a mark in the target when it runs. */
const MARKING_VALIDATOR = [
  process.execPath,
  "-e",
  "require('node:fs').writeFileSync('validator-ran', '')",
  "{{manifest}}",
];

/** Stages one candidate through the CLI with `profile`, and returns a `pick` of it. */
async function stagedPick(change: (profile: TargetProfile) => void) {
  const world = await syntheticWorld();
  world.profile.validator = { command: MARKING_VALIDATOR };
  change(world.profile);
  approveProfile(world.profile, { targetDir: world.targetDir });
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  const base = ["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir];
  const staged = await cli([
    "stage",
    ...base,
    "--candidates",
    "1",
    "--provider-script",
    passingScript,
    "--json",
  ]);
  assert.equal(staged.code, 0, staged.stderr);
  const runDir = doc(staged)["runDir"] as string;
  const run = () =>
    cli(["pick", "--run", runDir, "--candidate", "c1", "--target", world.targetDir, "--json"]);
  return { world, runDir, run };
}

/** A layout whose provenance file lands on the manifest's path, so the manifest reads back wrong. */
function clobberManifest(profile: TargetProfile): void {
  profile.layout = { ...profile.layout, provenance: profile.layout.manifest };
}

test("a preset whose check fails exits 6 handoff_check_failed listing problems, and the validator does not run", async () => {
  const { world, runDir, run } = await stagedPick(clobberManifest);
  const r = await run();
  assert.equal(r.code, 6, r.stderr);
  const d = doc(r);
  assert.equal(d["error"].code, "handoff_check_failed");
  assert.ok(d["error"].problems.length > 0);
  for (const p of d["error"].problems) {
    assert.equal(p.preset, "manifest");
    assert.equal(typeof p.problem, "string");
  }
  assert.equal(existsSync(join(world.targetDir, "validator-ran")), false);
  const record = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  assert.equal(record.picked, undefined);

  // The same profile without the clash passes its check and runs the validator.
  const ok = await stagedPick(() => {});
  const passed = await ok.run();
  assert.equal(passed.code, 0, passed.stderr);
  assert.ok(existsSync(join(ok.world.targetDir, "validator-ran")));
  assert.deepEqual(
    doc(passed)["handoff"].map((h: { preset: string }) => h.preset),
    ["manifest"],
  );
});

test("invalid preset options exit 2 with nothing written", async () => {
  for (const handoff of [
    [{ preset: "manifest", options: { pretty: false } }],
    [{ preset: "no-such-preset" }],
    [],
  ]) {
    const { world, run } = await stagedPick((profile) => {
      profile.handoff = handoff as TargetProfile["handoff"];
    });
    const r = await run();
    assert.equal(r.code, 2, `${JSON.stringify(handoff)}: ${r.stderr}`);
    assert.equal(doc(r)["error"].code, "invalid_input");
    assert.deepEqual(await readdir(world.targetDir), [], JSON.stringify(handoff));
  }
});

/** A staged character-3d run, picked in process. */
async function staged3d(change: (profile: TargetProfile) => void) {
  const dir = await target();
  const runDir = join(dir, "run");
  const targetDir = join(dir, "target");
  await mkdir(runDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  const glb = syntheticCharacter();
  await writeFile(join(runDir, "fox.glb"), glb);
  const candidate: StagedCandidate = {
    id: "c1",
    file: "fox.glb",
    mediaType: GLB_MEDIA_TYPE,
    extension: "glb",
    sha256: sha256(glb),
    reasons: [],
    fields: {},
    provenance: { ...provenance, generator: "model3d" },
  };
  const profile = syntheticProfile({
    layout: {
      media: "characters/{{spec.assetId}}/{{spec.assetId}}.{{output.extension}}",
      manifest: "characters/{{spec.assetId}}/manifest.json",
    },
    manifest: { assetId: "{{spec.assetId}}", review: { status: "pending" } },
    validator: { command: MARKING_VALIDATOR },
    model3d: {} as TargetProfile["model3d"],
  });
  change(profile);
  approveProfile(profile, { targetDir });
  const record: RunRecord = {
    runId: "r1",
    createdAt: "2026-01-01T00:00:00.000Z",
    spec: { kind: "character-3d", assetId: "fox", fields: {} } as RunRecord["spec"],
    specDir: dir,
    profile,
    bibleVersion: "v1",
    capUsd: 1,
    estimateUsd: 0,
    spentUsd: 0,
    requested: 1,
    candidates: [candidate],
    filtered: 0,
    errors: [],
  };
  await writeRun(runDir, record);
  return { targetDir, run: () => pick({ runDir, candidateId: "c1", targetDir }) };
}

/** An imported, confirmed sheet, written in process. */
async function confirmedImport(change: (profile: TargetProfile) => void) {
  const dir = await target();
  const targetDir = join(dir, "target");
  await mkdir(targetDir);
  const profile = syntheticProfile({ validator: { command: MARKING_VALIDATOR } });
  change(profile);
  approveProfile(profile, { targetDir });
  const sheet = syntheticSheet();
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
    sheet: sheet.png,
    sheetPath: "sheets/synthetic.png",
    tool: "synthetic",
    assetId: "fern",
    profile,
    importsDir: join(dir, "imports"),
    importId: "imp1",
    propose: { call },
  });
  const confirmed: Grouping = {
    ...grouping,
    status: "confirmed",
    families: [grouping.families[0]!],
  };
  return {
    targetDir,
    run: () => writeFamilies({ importDir, grouping: confirmed, targetDir }),
  };
}

test("a character-3d pick and a write-families run go through the same pipeline", async () => {
  // Both hand off through the profile's presets and report them.
  const pick3d = await staged3d(() => {});
  const picked = await pick3d.run();
  assert.deepEqual(
    picked.handoff?.map((h) => h.preset),
    ["manifest"],
  );
  assert.equal(picked.validator?.accepted, true, picked.validator?.output);
  const families = await confirmedImport(() => {});
  const written = await families.run();
  for (const family of written.families) {
    assert.deepEqual(
      family.result.handoff.map((h) => h.preset),
      ["manifest"],
    );
    assert.equal(family.result.validator?.accepted, true, family.result.validator?.output);
  }

  // Both refuse invalid options before writing anything.
  const invalid = (profile: TargetProfile) => {
    profile.handoff = [{ preset: "manifest", options: { unknown: 1 } }];
  };
  for (const make of [staged3d, confirmedImport]) {
    const { targetDir, run } = await make(invalid);
    const outcome = failureOutcome(
      await run().then(
        () => undefined,
        (e: unknown) => e,
      ),
    );
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.error?.code, "invalid_input");
    assert.deepEqual(await readdir(targetDir), []);
  }

  // Both stop at a failed check, before the validator.
  for (const make of [staged3d, confirmedImport]) {
    const { targetDir, run } = await make(clobberManifest);
    const outcome = failureOutcome(
      await run().then(
        () => undefined,
        (e: unknown) => e,
      ),
    );
    assert.equal(outcome.exitCode, 6);
    assert.equal(outcome.error?.code, "handoff_check_failed");
    assert.ok((outcome.error?.problems ?? []).length > 0);
    assert.equal(existsSync(join(targetDir, "validator-ran")), false);
  }
});
