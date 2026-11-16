/**
 * A provenance file named with media is the record of that media (assetgrove#286): hand-off binds
 * the record to the bytes it writes, and `lod`, `rig`, `look-dev` and `fix-frame` refuse a record
 * that is not the media's own.
 */
import "./fixtures/env.ts";
import { approve, approveProfile } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodePng } from "../src/image/raster.ts";
import { parseReview, writeReview } from "../src/library/review.ts";
import { DIGITAL_SOURCE_TYPES, embedDigitalSourceType } from "../src/metadata.ts";
import {
  bindProvenance,
  callsSha256,
  checkProvenance,
  ProvenanceError,
} from "../src/provenance-binding.ts";
import { pickRequest } from "../src/commands/pick.ts";
import { sha256 } from "../src/request.ts";
import { gitTarget } from "./fixtures/git.ts";
import { syntheticStrip } from "./fixtures/strip.ts";
import { PALETTE, drawSubject, syntheticProfile } from "./fixtures/synthetic.ts";
import { quadrupedTemplate, syntheticQuadruped, walkGait } from "./fixtures/quadruped.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/model3d-quadruped-script.ts", import.meta.url));
const VALIDATOR = fileURLToPath(new URL("./fixtures/validator-3d.ts", import.meta.url));
const FIX_SCRIPT = fileURLToPath(new URL("./fixtures/animation-script.ts", import.meta.url));
approve(SCRIPT);
approve(FIX_SCRIPT);

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<Result> {
  const env = { ...process.env };
  delete env["AI_GATEWAY_API_KEY"];
  delete env["TRIPO_API_KEY"];
  delete env["MESHY_API_KEY"];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
const doc = (r: Result): Doc => JSON.parse(r.stdout);
const readJson = async (path: string): Promise<Doc> => JSON.parse(await readFile(path, "utf8"));
const fileSha = async (path: string) => sha256(await readFile(path));

/** A target with a shared rig; `embed` also writes the provenance into the manifest and its own file. */
async function world(options: { embed?: boolean } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "assetgrove-binding-")));
  await mkdir(join(dir, "refs"));
  const roles = ["turnaround-front", "turnaround-side", "turnaround-back"];
  for (const [i, role] of roles.entries()) {
    await writeFile(join(dir, "refs", `${role}.png`), encodePng(drawSubject(64, i * 4)));
  }
  await mkdir(join(dir, "rig"));
  await writeFile(join(dir, "rig", "quadruped.json"), JSON.stringify(quadrupedTemplate()));
  const files = {
    spec: join(dir, "spec.json"),
    bible: join(dir, "bible.json"),
    profile: join(dir, "profile.json"),
  };
  await writeFile(
    files.spec,
    JSON.stringify({
      kind: "character-3d",
      assetId: "kit",
      subject: "kit",
      gait: "quadruped",
      clips: ["walk", "sniff"],
      heightM: 0.45,
    }),
  );
  await writeFile(
    files.bible,
    JSON.stringify({
      format: "assetgrove-style-bible/1",
      referenceLicense: "NOASSERTION",
      version: "2026-11-10",
      palette: PALETTE,
      references: roles.map((role) => ({
        path: `refs/${role}.png`,
        role,
        subject: "kit",
        view: { "turnaround-front": "front", "turnaround-side": "left", "turnaround-back": "back" }[
          role
        ],
      })),
      perspective: "refs/turnaround-front.png",
      subjects: { kit: { description: "a small synthetic quadruped" } },
    }),
  );
  await writeFile(
    files.profile,
    JSON.stringify({
      format: "assetgrove-target-profile/1",
      name: "synthetic-grove-rig",
      license: "MIT",
      frames: { width: 32, height: 32 },
      model3d: {
        format: "glb",
        budgets: { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 1 },
        units: "m",
        turntable: { sizePx: 64 },
        rig: { template: "rig/quadruped.json", kind: "synthetic-quadruped" },
        gaits: { walk: walkGait() },
      },
      layout: {
        media: "characters/{{spec.assetId}}/{{spec.assetId}}.{{output.extension}}",
        manifest: "characters/{{spec.assetId}}/manifest.json",
        ...(options.embed && { provenance: "characters/{{spec.assetId}}/provenance.json" }),
      },
      manifest: {
        assetId: "{{spec.assetId}}",
        source: { path: "{{output.path}}", mediaType: "{{output.mediaType}}" },
        license: "{{profile.license}}",
        review: { status: "pending" },
        ...(options.embed && { provenance: "{{provenance}}" }),
        model: {
          triangles: "{{output.triangles}}",
          textureMaxPx: "{{output.textureMaxPx}}",
          materials: "{{output.materials}}",
          bones: "{{output.bones}}",
          lods: "{{output.lods}}",
          clips: "{{output.clips}}",
          bounds: "{{output.bounds}}",
          rig: "{{output.rig}}",
        },
        contentHash: "{{output.sha256}}",
      },
      review: { path: "review.status", pending: "pending" },
      validator: { command: [process.execPath, VALIDATOR, "{{manifest}}"] },
    }),
  );
  const target = gitTarget(join(dir, "target"));
  approveProfile(
    { validator: { command: [process.execPath, VALIDATOR, "{{manifest}}"] } },
    { targetDir: target },
  );
  const base = ["--spec", files.spec, "--bible", files.bible, "--profile", files.profile];
  return { dir, files, base, runs: join(dir, "runs"), target };
}
type World = Awaited<ReturnType<typeof world>>;

const asset = (w: World) => join(w.target, "characters", "kit");

/** Stages one scripted candidate and hands it off: its media and provenance paths in the target. */
async function handedOff(w: World) {
  const staged = await cli([
    ...["stage", ...w.base, "--runs", w.runs, "--candidates", "1"],
    ...["--provider-script", SCRIPT, "--json"],
  ]);
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  const run = doc(staged);
  const picked = await cli([
    ...["pick", "--run", run["runDir"], "--candidate", "c1", "--target", w.target, "--json"],
  ]);
  assert.equal(picked.code, 0, picked.stdout + picked.stderr);
  return {
    model: join(asset(w), "kit.glb"),
    provenance: join(asset(w), "kit.glb.provenance.json"),
  };
}

/** `rig` over a model with the provenance file named with it. */
function rig(w: World, model: string, provenance: string) {
  return cli([
    ...["rig", "--model", model, "--provenance", provenance],
    ...["--spec", w.files.spec, "--profile", w.files.profile, "--runs", w.runs, "--json"],
  ]);
}

async function refused(r: Result, model: string, provenance: string) {
  assert.equal(r.code, 2, r.stdout + r.stderr);
  const error = doc(r)["error"];
  assert.equal(error.code, "provenance_mismatch");
  assert.ok(error.message.includes(model), error.message);
  assert.ok(error.message.includes(provenance), error.message);
}

/** The same record written again to `path` after `change`, in a folder of its own. */
async function altered(w: World, from: string, name: string, change: (record: Doc) => void) {
  const record = await readJson(from);
  change(record);
  const path = join(w.dir, name);
  await writeFile(path, JSON.stringify(record));
  return path;
}

test("a hand-off's provenance goes with its media through rig, and the next hand-off is bound to its own file", async () => {
  const w = await world();
  const first = await handedOff(w);
  const record = await readJson(first.provenance);
  const firstRecord = join(w.dir, "first.provenance.json");
  await writeFile(firstRecord, JSON.stringify(record));
  assert.equal(record.binding.mediaSha256, await fileSha(first.model));

  const r = await rig(w, first.model, first.provenance);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const picked = await cli([
    ...["pick", "--run", doc(r)["runDir"], "--candidate", "c1", "--target", w.target, "--json"],
  ]);
  assert.equal(picked.code, 0, picked.stdout + picked.stderr);

  const second = await readJson(first.provenance);
  const secondSha = await fileSha(first.model);
  assert.notEqual(secondSha, record.binding.mediaSha256, "the second hand-off wrote other bytes");
  assert.equal(second.binding.mediaSha256, secondSha);
  assert.notEqual(second.binding.recordSha256, record.binding.recordSha256);
  assert.deepEqual(second.calls, record.calls, "the model calls carry over");

  // The first record describes the first bytes: it is another file's record now.
  await refused(await rig(w, first.model, firstRecord), first.model, firstRecord);
});

test("rig refuses an emptied record and an edited call", async () => {
  const w = await world();
  const mine = await handedOff(w);

  const emptied = await altered(w, mine.provenance, "emptied.json", (p) => (p.calls = []));
  await refused(await rig(w, mine.model, emptied), mine.model, emptied);

  const flipped = await altered(w, mine.provenance, "flipped.json", (p) => {
    p.calls[0].outputGrant.commercial = false;
  });
  await refused(await rig(w, mine.model, flipped), mine.model, flipped);

  const swapped = await altered(w, mine.provenance, "swapped.json", (p) => {
    p.calls[0].model = "someone/else";
  });
  await refused(await rig(w, mine.model, swapped), mine.model, swapped);
});

test("media made outside Assetgrove goes through rig and pick, and the record says so in the sidecar and the manifest", async () => {
  const w = await world({ embed: true });
  const model = join(w.dir, "outside.glb");
  await writeFile(model, syntheticQuadruped({ providerRig: true }));
  const provenance = join(w.dir, "outside.provenance.json");
  await writeFile(
    provenance,
    JSON.stringify({
      generator: "character-3d",
      route: "hand",
      models: [],
      prompt: "modelled by hand",
      parameters: { gait: "quadruped", heightM: 0.45 },
      requestIds: [],
      referenceHashes: [],
      bibleVersion: "2026-11-10",
      license: "MIT",
      providerTerms: [],
      startedAt: "2026-11-10T00:00:00.000Z",
      finishedAt: "2026-11-10T00:00:01.000Z",
      costUsd: 0,
      calls: [],
    }),
  );
  const r = await rig(w, model, provenance);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const picked = await cli([
    ...["pick", "--run", doc(r)["runDir"], "--candidate", "c1", "--target", w.target, "--json"],
  ]);
  assert.equal(picked.code, 0, picked.stdout + picked.stderr);
  const sidecar = await readJson(join(asset(w), "provenance.json"));
  assert.equal(sidecar.madeOutsideAssetgrove, true);
  assert.equal(sidecar.binding.mediaSha256, await fileSha(join(asset(w), "kit.glb")));
  const manifest = await readJson(join(asset(w), "manifest.json"));
  assert.equal(manifest.provenance.madeOutsideAssetgrove, true);
  assert.equal(manifest.provenance.binding.mediaSha256, sidecar.binding.mediaSha256);
});

test("media another tool marked as model-made hands off with a record of no calls, and the confirmation, sidecar and manifest say no licence grant was checked", async () => {
  const w = await world({ embed: true });
  const model = join(w.dir, "outside.glb");
  const type = DIGITAL_SOURCE_TYPES.generated;
  await writeFile(
    model,
    embedDigitalSourceType(syntheticQuadruped({ providerRig: true }), "model/gltf-binary", type),
  );
  const provenance = join(w.dir, "outside.provenance.json");
  await writeFile(
    provenance,
    JSON.stringify({
      generator: "character-3d",
      route: "other-tool",
      models: [],
      prompt: "made by another tool",
      parameters: { gait: "quadruped", heightM: 0.45 },
      requestIds: [],
      referenceHashes: [],
      bibleVersion: "2026-11-10",
      license: "MIT",
      providerTerms: [],
      startedAt: "2026-11-10T00:00:00.000Z",
      finishedAt: "2026-11-10T00:00:01.000Z",
      costUsd: 0,
      calls: [],
    }),
  );
  const r = await rig(w, model, provenance);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const runDir = doc(r)["runDir"] as string;
  const request = await pickRequest({ run: runDir, candidate: "c1", target: w.target });
  assert.match(
    request.summary,
    /marked as model-made by another tool, and Assetgrove checked no licence grant for it/,
  );
  assert.deepEqual((request.details as Doc)["licenceGrantUnchecked"], ["c1"]);
  const picked = await cli([
    ...["pick", "--run", runDir, "--candidate", "c1", "--target", w.target, "--json"],
  ]);
  assert.equal(picked.code, 0, picked.stdout + picked.stderr);
  const stated = { digitalSourceType: type, licenceGrantChecked: false };
  const sidecar = await readJson(join(asset(w), "provenance.json"));
  assert.equal(sidecar.madeOutsideAssetgrove, true);
  assert.deepEqual(sidecar.modelMadeOutsideAssetgrove, stated);
  const manifest = await readJson(join(asset(w), "manifest.json"));
  assert.equal(manifest.provenance.madeOutsideAssetgrove, true);
  assert.deepEqual(manifest.provenance.modelMadeOutsideAssetgrove, stated);

  // Handed off again: its own mark now records no calls, and the statement goes with it.
  const again = await rig(w, join(asset(w), "kit.glb"), join(asset(w), "provenance.json"));
  assert.equal(again.code, 0, again.stdout + again.stderr);
  const rerun = await readJson(join(doc(again)["runDir"], "run.json"));
  assert.deepEqual(rerun.candidates[0].provenance.modelMadeOutsideAssetgrove, stated);
});

test("an emptied record with its binding deleted is refused on media whose mark names a model", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "assetgrove-binding-unit-")));
  const type = DIGITAL_SOURCE_TYPES.generated;
  const bytes = embedDigitalSourceType(syntheticQuadruped(), "model/gltf-binary", type, {
    models: ["x"],
  });
  const path = join(dir, "kit.glb");
  await writeFile(path, bytes);
  const provenancePath = join(dir, "kit.glb.provenance.json");
  const value = { generator: "character-3d", calls: [], models: ["x"] } as never;
  await assert.rejects(
    checkProvenance({
      media: { path, bytes, mediaType: "model/gltf-binary" },
      provenance: { path: provenancePath, bytes: JSON.stringify(value), value },
    }),
    (error: ProvenanceError) => {
      assert.equal(error.code, "provenance_mismatch");
      assert.ok(error.message.includes(path) && error.message.includes(provenancePath));
      assert.match(error.message, /names the model x/);
      return true;
    },
  );
  const unmarked = syntheticQuadruped();
  const accepted = await checkProvenance({
    media: { path, bytes: unmarked, mediaType: "model/gltf-binary" },
    provenance: { path: provenancePath, bytes: JSON.stringify(value), value },
  });
  assert.equal(accepted.madeOutsideAssetgrove, true);
});

test("a 0.1.0 record without a binding is accepted beside its library record, and refused once its calls are edited", async () => {
  const w = await world();
  const h = await handedOff(w);
  const record = await readJson(h.provenance);
  delete record.binding;
  const unbound = JSON.stringify(record, null, 2);
  await writeFile(h.provenance, unbound);
  const reviewPath = join(asset(w), "kit.review.json");
  const review = parseReview(await readFile(reviewPath, "utf8"), reviewPath);
  const handed = sha256(new Uint8Array(await readFile(h.model)));
  const version = review.versions.find((v) => v.sha256 === handed);
  assert.ok(version, "the hand-off's library record lists the media");
  // 0.1.0's hand-off marked the media with the digital source type alone.
  const bytes = embedDigitalSourceType(
    syntheticQuadruped(),
    "model/gltf-binary",
    DIGITAL_SOURCE_TYPES.generated,
  );
  await writeFile(h.model, bytes);
  version.sha256 = sha256(bytes);
  version.provenanceSha256 = sha256(new TextEncoder().encode(unbound));
  await writeFile(reviewPath, writeReview(review));

  const media = { path: h.model, bytes, mediaType: "model/gltf-binary" };
  const kept = await checkProvenance({
    media,
    provenance: { path: h.provenance, bytes: unbound, value: record as never },
  });
  assert.equal(kept.madeOutsideAssetgrove, undefined);

  record.calls[0].outputGrant.commercial = false;
  const edited = JSON.stringify(record, null, 2);
  await assert.rejects(
    checkProvenance({
      media,
      provenance: { path: h.provenance, bytes: edited, value: record as never },
    }),
    (error: ProvenanceError) => error.code === "provenance_mismatch",
  );

  const emptied = JSON.stringify({ ...record, calls: [] }, null, 2);
  await assert.rejects(
    checkProvenance({
      media,
      provenance: { path: h.provenance, bytes: emptied, value: JSON.parse(emptied) as never },
    }),
    (error: ProvenanceError) => error.code === "provenance_mismatch",
  );
});

test("fix-frame refuses a strip's own provenance whose calls were emptied, before any call", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "assetgrove-binding-strip-")));
  const { strip } = syntheticStrip({ count: 8, style: "painterly", motion: "walk" });
  const bytes = encodePng(strip);
  const stripPath = join(root, "walk-right.png");
  await writeFile(stripPath, bytes);
  await writeFile(
    join(root, "profile.json"),
    JSON.stringify({
      ...syntheticProfile(),
      style: { alpha: { mode: "soft" }, color: { rule: "full" } },
      frames: { width: 64, height: 64, durationMs: 100 },
    }),
  );
  const record = bindProvenance(
    {
      generator: "sheet-import",
      route: "import:hand",
      models: ["hand"],
      prompt: "imported",
      parameters: {},
      requestIds: [],
      referenceHashes: [],
      bibleVersion: "1",
      license: "MIT",
      providerTerms: [],
      startedAt: "2026-11-08T00:00:00.000Z",
      finishedAt: "2026-11-08T00:00:00.000Z",
      costUsd: 0.04,
      calls: [{ operation: "edit", model: "x/y" }],
    } as never,
    bytes,
  ) as unknown as Doc;
  record["calls"] = [];
  const provenance = join(root, "walk-right.png.provenance.json");
  await writeFile(provenance, JSON.stringify(record));
  const out = join(root, "fixed");
  const r = await cli([
    ...["fix-frame", "--strip", stripPath, "--family", "walk-right"],
    ...["--profile", join(root, "profile.json"), "--frame", "3", "--from", "2", "--out", out],
    ...["--provenance", provenance, "--provider-script", FIX_SCRIPT, "--json"],
  ]);
  await refused(r, stripPath, provenance);
  await assert.rejects(readFile(join(out, "walk-right.png")), "nothing written");
});

test("a record re-bound after its calls were emptied or edited is refused by the media's mark", async () => {
  const w = await world();
  const mine = await handedOff(w);
  const rebind = (p: Doc) => {
    delete p.binding;
    p.binding = (bindProvenance(p as never, new Uint8Array()) as unknown as Doc)["binding"];
  };
  // The binding is recomputed over the edited record; only the mark outside the file says no.
  const fixMedia = async (path: string) => {
    const record = await readJson(path);
    record.binding.mediaSha256 = await fileSha(mine.model);
    await writeFile(path, JSON.stringify(record));
    return path;
  };
  const emptied = await fixMedia(
    await altered(w, mine.provenance, "rebound-emptied.json", (p) => {
      p.calls = [];
      rebind(p);
    }),
  );
  await refused(await rig(w, mine.model, emptied), mine.model, emptied);
  const flipped = await fixMedia(
    await altered(w, mine.provenance, "rebound-flipped.json", (p) => {
      p.calls[0].outputGrant.commercial = false;
      rebind(p);
    }),
  );
  const r = await rig(w, mine.model, flipped);
  await refused(r, mine.model, flipped);
  assert.match(doc(r)["error"].message, /mark records/);
  const unbound = await altered(w, mine.provenance, "unbound-emptied.json", (p) => {
    p.calls = [];
    delete p.binding;
  });
  await refused(await rig(w, mine.model, unbound), mine.model, unbound);
});

test("fix-frame refuses the provenance 0.1.0 wrote beside a strip, naming the one command that brings it up to date, and takes it emptied as another tool's model-made strip", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "assetgrove-binding-010-")));
  const { strip } = syntheticStrip({ count: 8, style: "painterly", motion: "walk" });
  // What 0.1.0's hand-off of an imported strip wrote: the strip marked with the digital source
  // type alone (c692cfc src/handoff.ts passes no model names), and a record with its calls and no
  // binding.
  const stripPath = join(root, "walk-right.png");
  await writeFile(
    stripPath,
    embedDigitalSourceType(encodePng(strip), "image/png", DIGITAL_SOURCE_TYPES.composite),
  );
  await writeFile(
    join(root, "profile.json"),
    JSON.stringify({
      ...syntheticProfile(),
      style: { alpha: { mode: "soft" }, color: { rule: "full" } },
      frames: { width: 64, height: 64, durationMs: 100 },
    }),
  );
  const provenance = join(root, "walk-right.png.provenance.json");
  await writeFile(provenance, JSON.stringify(importedStripRecord()));
  const out = join(root, "fixed");
  const r = await cli([
    ...["fix-frame", "--strip", stripPath, "--family", "walk-right"],
    ...["--profile", join(root, "profile.json"), "--frame", "3", "--from", "2", "--out", out],
    ...["--provider-script", FIX_SCRIPT, "--json"],
  ]);
  await refused(r, stripPath, provenance);
  assert.match(doc(r)["error"].message, /assetgrove write-families --import/);
  await assert.rejects(readFile(join(out, "walk-right.png")), "nothing written");

  // Its calls emptied: the mark's digital source type alone cannot tell it from another tool's
  // model-made strip, so it goes through, its record stating no licence grant was checked for it
  // (docs/decisions.md, "What no check can catch").
  await writeFile(provenance, JSON.stringify(importedStripRecord([])));
  const emptied = await cli([
    ...["fix-frame", "--strip", stripPath, "--family", "walk-right"],
    ...["--profile", join(root, "profile.json"), "--frame", "3", "--from", "2", "--out", out],
    ...["--provider-script", FIX_SCRIPT, "--json"],
  ]);
  assert.equal(emptied.code, 0, emptied.stdout + emptied.stderr);
  const fixed = await readJson(join(out, "walk-right.png.provenance.json"));
  assert.deepEqual(fixed.modelMadeOutsideAssetgrove, {
    digitalSourceType: DIGITAL_SOURCE_TYPES.composite,
    licenceGrantChecked: false,
  });
  assert.equal(fixed.madeOutsideAssetgrove, undefined, "the fix added a call");
});

test("a record of no calls on media another tool marked as model-made is accepted, stating no licence grant was checked", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "assetgrove-binding-dst-")));
  const value = { generator: "character-3d", calls: [] } as never;
  const media = [
    {
      path: join(dir, "kit.glb"),
      mediaType: "model/gltf-binary",
      raw: syntheticQuadruped(),
    },
    { path: join(dir, "a.png"), mediaType: "image/png", raw: encodePng(drawSubject(32, 0)) },
  ];
  for (const m of media) {
    for (const type of [DIGITAL_SOURCE_TYPES.generated, DIGITAL_SOURCE_TYPES.composite]) {
      const bytes = embedDigitalSourceType(m.raw, m.mediaType, type);
      await writeFile(m.path, bytes);
      const provenancePath = `${m.path}.provenance.json`;
      for (const record of [value, bindProvenance(value, bytes)]) {
        const accepted = await checkProvenance({
          media: { path: m.path, bytes, mediaType: m.mediaType },
          provenance: { path: provenancePath, bytes: JSON.stringify(record), value: record },
        });
        assert.equal(accepted.madeOutsideAssetgrove, true);
        assert.deepEqual(accepted.modelMadeOutsideAssetgrove, {
          digitalSourceType: type,
          licenceGrantChecked: false,
        });
      }
      // The exact checks stay: a mark that records calls, or names a model, refuses it.
      const called = embedDigitalSourceType(m.raw, m.mediaType, type, {
        callsSha256: callsSha256({ calls: [{ model: "x" }] } as never),
      });
      const named = embedDigitalSourceType(m.raw, m.mediaType, type, { models: ["x"] });
      for (const [marked, why] of [
        [called, /calls sha256 differs/],
        [named, /names the model x/],
      ] as const) {
        await assert.rejects(
          checkProvenance({
            media: { path: m.path, bytes: marked, mediaType: m.mediaType },
            provenance: { path: provenancePath, bytes: JSON.stringify(value), value },
          }),
          (error: ProvenanceError) => {
            assert.equal(error.code, "provenance_mismatch");
            assert.ok(error.message.includes(m.path) && error.message.includes(provenancePath));
            assert.match(error.message, why);
            return true;
          },
        );
      }
    }
    // Marked as made by a person: media made outside Assetgrove, with no model to state.
    const human = embedDigitalSourceType(m.raw, m.mediaType, DIGITAL_SOURCE_TYPES.human);
    const accepted = await checkProvenance({
      media: { path: m.path, bytes: human, mediaType: m.mediaType },
      provenance: { path: `${m.path}.provenance.json`, bytes: JSON.stringify(value), value },
    });
    assert.equal(accepted.madeOutsideAssetgrove, true);
    assert.equal(accepted.modelMadeOutsideAssetgrove, undefined);
  }
});

test("a staged candidate copied out of its run folder with its calls emptied is refused", async () => {
  const w = await world();
  const staged = await cli([
    ...["stage", ...w.base, "--runs", w.runs, "--candidates", "1"],
    ...["--provider-script", SCRIPT, "--json"],
  ]);
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  const runDir = doc(staged)["runDir"] as string;
  const run = await readJson(join(runDir, "run.json"));
  const candidate = run["candidates"][0];
  const model = join(w.dir, "moved.glb");
  await writeFile(model, await readFile(join(runDir, candidate.file)));
  const provenance = join(w.dir, "moved.provenance.json");
  await writeFile(provenance, JSON.stringify({ ...candidate.provenance, calls: [] }));
  const r = await rig(w, model, provenance);
  await refused(r, model, provenance);
  assert.match(doc(r)["error"].message, /records no model call/);
});

/** The record 0.1.0's hand-off wrote for a strip imported from a sheet a model made in part. */
function importedStripRecord(calls: unknown[] = [{ operation: "edit", model: "x/y" }]): Doc {
  return {
    generator: "sheet-import",
    route: "import:hand",
    models: ["hand", "x/y"],
    prompt: "imported",
    parameters: {},
    requestIds: [],
    referenceHashes: [],
    bibleVersion: "1",
    license: "MIT",
    providerTerms: [],
    startedAt: "2026-11-08T00:00:00.000Z",
    finishedAt: "2026-11-08T00:00:00.000Z",
    costUsd: 0.04,
    sheet: { tool: "hand" },
    calls,
  };
}

/** checkProvenance over `bytes` at `path` with `record` written as JSON. */
function check(
  path: string,
  bytes: Uint8Array,
  record: Doc,
  provenancePath = `${path}.provenance.json`,
) {
  const text = JSON.stringify(record, null, 2);
  return checkProvenance({
    media: { path, bytes, mediaType: "image/png" },
    provenance: { path: provenancePath, bytes: text, value: record as never },
  });
}

test("an unbound record is refused on media whose mark has no calls sha256, edited or from other media", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "assetgrove-binding-unbound-")));
  const bytes = embedDigitalSourceType(
    encodePng(drawSubject(32, 0)),
    "image/png",
    DIGITAL_SOURCE_TYPES.generated,
    { models: ["x/y"] },
  );
  const path = join(dir, "a.png");
  await writeFile(path, bytes);
  const edited: Doc = {
    ...importedStripRecord([
      { operation: "edit", model: "x/y", outputGrant: { commercial: true } },
    ]),
    generator: "character",
    models: ["x/y"],
  };
  delete edited["sheet"];
  for (const record of [edited, { ...edited, prompt: "another media's record" }]) {
    await assert.rejects(check(path, bytes, record), (error: ProvenanceError) => {
      assert.equal(error.code, "provenance_mismatch");
      assert.ok(error.message.includes(path), error.message);
      assert.match(error.message, /not bound to the media/);
      assert.match(error.message, /assetgrove pick --run/);
      return true;
    });
  }
});

test("an imported strip's record, whose mark names the sheet tool, is accepted beside its library record or bound", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "assetgrove-binding-tool-")));
  // This release's hand-off names the sheet tool and the call's model in the mark.
  const bytes = embedDigitalSourceType(
    encodePng(drawSubject(32, 0)),
    "image/png",
    DIGITAL_SOURCE_TYPES.composite,
    { models: ["hand", "x/y"] },
  );
  const path = join(dir, "walk.png");
  await writeFile(path, bytes);
  const record = importedStripRecord();
  // Unbound, with nothing beside it: refused with the command that hands it off again.
  await assert.rejects(check(path, bytes, record), /assetgrove write-families --import/);

  // Bound to the bytes: the sheet tool the mark names is the record's sheet tool, not a call.
  const bound = bindProvenance(record as never, bytes) as unknown as Doc;
  assert.equal((await check(path, bytes, bound)).madeOutsideAssetgrove, undefined);
  const toolOnly = bindProvenance(
    importedStripRecord([]) as never,
    embedDigitalSourceType(
      encodePng(drawSubject(32, 0)),
      "image/png",
      DIGITAL_SOURCE_TYPES.composite,
      {
        models: ["hand"],
      },
    ),
  ) as unknown as Doc;
  const toolBytes = embedDigitalSourceType(
    encodePng(drawSubject(32, 0)),
    "image/png",
    DIGITAL_SOURCE_TYPES.composite,
    { models: ["hand"] },
  );
  await check(path, toolBytes, toolOnly);

  // A library review record that lists these bytes with this exact file answers first: a hand-off's
  // own review record, listing the strip and this record as 0.1.0's never did.
  const w = await world();
  await handedOff(w);
  const reviewPath = join(asset(w), "kit.review.json");
  const review = parseReview(await readFile(reviewPath, "utf8"), reviewPath);
  const text = JSON.stringify(record, null, 2);
  review.versions[0]!.sha256 = sha256(bytes);
  review.versions[0]!.provenanceSha256 = sha256(new TextEncoder().encode(text));
  await writeFile(join(dir, "kit.review.json"), writeReview(review));
  const listed = await check(path, bytes, record);
  assert.equal(listed.madeOutsideAssetgrove, undefined);
});

test("a staged candidate copied out of its run folder is refused, naming pick", async () => {
  const w = await world();
  const staged = await cli([
    ...["stage", ...w.base, "--runs", w.runs, "--candidates", "1"],
    ...["--provider-script", SCRIPT, "--json"],
  ]);
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  const runDir = doc(staged)["runDir"] as string;
  const run = await readJson(join(runDir, "run.json"));
  const candidate = run["candidates"][0];
  const model = join(w.dir, "moved.glb");
  await writeFile(model, await readFile(join(runDir, candidate.file)));
  const provenance = join(w.dir, "moved.provenance.json");
  await writeFile(provenance, JSON.stringify(candidate.provenance));
  const r = await rig(w, model, provenance);
  await refused(r, model, provenance);
  assert.match(doc(r)["error"].message, /assetgrove pick --run/);
});

test("fix-frame refuses a strip whose mark records calls when its provenance was moved away, before any call", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "assetgrove-binding-moved-")));
  const { strip } = syntheticStrip({ count: 8, style: "painterly", motion: "walk" });
  const stripPath = join(root, "walk-right.png");
  await writeFile(
    stripPath,
    embedDigitalSourceType(encodePng(strip), "image/png", DIGITAL_SOURCE_TYPES.composite, {
      callsSha256: callsSha256({ calls: [{ operation: "edit", model: "x/y" }] as never }),
    }),
  );
  await writeFile(
    join(root, "profile.json"),
    JSON.stringify({
      ...syntheticProfile(),
      style: { alpha: { mode: "soft" }, color: { rule: "full" } },
      frames: { width: 64, height: 64, durationMs: 100 },
    }),
  );
  const out = join(root, "fixed");
  const r = await cli([
    ...["fix-frame", "--strip", stripPath, "--family", "walk-right"],
    ...["--profile", join(root, "profile.json"), "--frame", "3", "--from", "2", "--out", out],
    ...["--provider-script", FIX_SCRIPT, "--json"],
  ]);
  await refused(r, stripPath, `${stripPath}.provenance.json`);
  assert.match(doc(r)["error"].message, /mark records model calls/);
  await assert.rejects(readFile(join(out, "walk-right.png")), "nothing written");
});
