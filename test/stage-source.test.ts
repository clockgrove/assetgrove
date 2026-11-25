import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BLOCK } from "../src/gitlfs.ts";
import { decodeImage } from "../src/image/raster.ts";
import { readAseprite } from "../src/source/aseprite.ts";
import { asepriteFile, fernAseprite, sampleProfile, tempProject } from "../src/testing/index.ts";
import type { CliResult } from "../src/testing/index.ts";

const fixture = join(import.meta.dirname, "fixtures", "aseprite", "fern.aseprite");
const DECLARED = "digitalCreation";

async function setup(spec: Record<string, unknown> = {}, size = { width: 32, height: 40 }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "assetgrove-stage-source-")));
  const specPath = join(dir, "spec.json");
  const profilePath = join(dir, "profile.json");
  await writeFile(
    specPath,
    JSON.stringify({ kind: "sprite-strip", assetId: "fern", animationFamily: "idle", ...spec }),
  );
  await writeFile(
    profilePath,
    JSON.stringify(
      sampleProfile({
        frames: { ...size, maxEdge: 256, durationMs: 100 },
        validator: undefined,
      }),
    ),
  );
  return { dir, specPath, profilePath };
}

function stageArgs(
  s: { dir: string; specPath: string; profilePath: string },
  source: string,
  extra: string[] = [],
) {
  return [
    ...["stage-source", "--source", source, "--spec", s.specPath, "--profile", s.profilePath],
    ...["--runs", join(s.dir, "runs"), "--digital-source-type", DECLARED, "--json", ...extra],
  ];
}

async function candidateOf(result: CliResult) {
  assert.equal(result.code, 0, result.stderr);
  const runDir = result.json?.["runDir"] as string;
  const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  return { runDir, run, candidate: run.candidates[0] };
}

test("stage-source renders a tag of the fixture as a strip with its editable source recorded", async () => {
  const project = tempProject();
  try {
    const s = await setup();
    const { runDir, candidate } = await candidateOf(await project.cli(stageArgs(s, fixture)));
    const doc = readAseprite(new Uint8Array(await readFile(fixture)), fixture);
    const strip = decodeImage(new Uint8Array(await readFile(join(runDir, "c1.png"))));
    assert.equal(strip.width, 128);
    assert.equal(strip.height, 40);
    for (let i = 0; i < 4; i++) {
      for (let y = 0; y < 40; y++) {
        const got = strip.data.subarray((y * 128 + i * 32) * 4, (y * 128 + i * 32 + 32) * 4);
        const want = (doc.frames[i] as { data: Uint8Array }).data.subarray(
          y * 32 * 4,
          (y + 1) * 32 * 4,
        );
        assert.deepEqual([...got], [...want], `frame ${i} row ${y}`);
      }
    }
    const bytes = new Uint8Array(await readFile(fixture));
    const { createHash } = await import("node:crypto");
    assert.deepEqual(candidate.provenance.editableSource, {
      path: await realpath(fixture),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      format: "aseprite",
      tag: "idle",
      frames: [0, 1, 2, 3],
      durationsMs: [100, 100, 100, 100],
    });
    assert.equal(candidate.provenance.costUsd, 0);
    assert.deepEqual(candidate.provenance.calls, []);
    assert.equal(candidate.fields.frames.count, 4);
  } finally {
    project.close();
  }
});

test("a file with no tags stages every frame", async () => {
  const project = tempProject();
  try {
    const s = await setup({ animationFamily: "anything" });
    const file = join(s.dir, "plain.aseprite");
    const cel = (shift: number) => {
      const rgba = new Uint8Array(32 * 40 * 4);
      for (let i = 0; i < 4; i++) rgba.set([200, 40, 40, 255], ((10 + shift) * 32 + 10 + i) * 4);
      return { layer: 0, x: 0, y: 0, width: 32, height: 40, rgba };
    };
    await writeFile(
      file,
      asepriteFile({
        width: 32,
        height: 40,
        layers: [{ name: "body" }],
        frames: [0, 1, 2].map((i) => ({ durationMs: 80, cels: [cel(i)] })),
      }),
    );
    const { candidate } = await candidateOf(await project.cli(stageArgs(s, file)));
    const source = candidate.provenance.editableSource;
    assert.equal(source.tag, undefined);
    assert.deepEqual(source.frames, [0, 1, 2]);
  } finally {
    project.close();
  }
});

test("a missing tag, a size mismatch and a non-strip spec exit 2", async () => {
  const project = tempProject();
  try {
    const missing = await setup({ animationFamily: "run" });
    const r = await project.cli(stageArgs(missing, fixture));
    assert.equal(r.code, 2);
    assert.match(r.stderr + r.stdout, /"idle", "walk"/);

    const size = await setup({}, { width: 16, height: 16 });
    const m = await project.cli(stageArgs(size, fixture));
    assert.equal(m.code, 2);
    assert.match(m.stderr + m.stdout, /32x40.*16x16/);

    const still = await setup({ kind: "still" });
    assert.equal((await project.cli(stageArgs(still, fixture))).code, 2);
  } finally {
    project.close();
  }
});

test("a staged source is pickable, and an edited source picks as a new version whose lineage names it", async () => {
  const project = tempProject();
  try {
    project.writeSettings();
    await writeFile(join(project.dir, ".gitattributes"), BLOCK);
    const s = await setup();
    // pick keeps the source inside the library root, so the artwork lives in the project.
    const inProject = join(project.dir, "assets", "source", "fern.aseprite");
    await mkdir(dirname(inProject), { recursive: true });
    await copyFile(fixture, inProject);
    const first = await candidateOf(await project.cli(stageArgs(s, inProject)));
    const again = await candidateOf(await project.cli(stageArgs(s, inProject)));
    assert.equal(again.runDir, first.runDir);

    const picked = await project.cli([
      ...["pick", "--run", first.runDir, "--candidate", "c1", "--target", project.dir, "--json"],
    ]);
    assert.equal(picked.code, 0, picked.stdout + picked.stderr);
    const provenance = JSON.parse(
      await readFile(join(project.dir, "assets", "fern.png.provenance.json"), "utf8"),
    );
    assert.match(provenance.digitalSourceType, /digitalCreation$/);
    assert.equal(
      provenance.editableSource.sha256,
      first.candidate.provenance.editableSource.sha256,
    );

    // The developer edits the source in place; a new stage and pick is a new version of the asset.
    await writeFile(inProject, fernAseprite({ edited: true }));
    const next = await candidateOf(await project.cli(stageArgs(s, inProject)));
    assert.notEqual(next.runDir, first.runDir);
    assert.notEqual(next.candidate.sha256, first.candidate.sha256);
    const repicked = await project.cli([
      ...["pick", "--run", next.runDir, "--candidate", "c1", "--target", project.dir, "--json"],
    ]);
    assert.equal(repicked.code, 0, repicked.stdout + repicked.stderr);
    const library = repicked.json?.["library"] as { files: string[] };
    const reviewFile = library.files.find((f) => f.endsWith(".review.json"));
    assert.ok(reviewFile, JSON.stringify(library.files));
    const review = JSON.parse(await readFile(join(project.dir, reviewFile), "utf8"));
    const versions = review["ag:versions"] as Array<Record<string, unknown>>;
    const sourceSha = (c: { provenance: { editableSource: { sha256: string } } }) =>
      c.provenance.editableSource.sha256;
    assert.deepEqual(
      versions.map((v) => v["lineage"]),
      // The library root is the profile's assets folder, so the path is relative to it.
      [first, next].map((r) => [
        { relation: "derived-from", file: "source/fern.aseprite", sha256: sourceSha(r.candidate) },
      ]),
    );
    const relations = await project.cli([
      "library",
      "relations",
      "--target",
      project.dir,
      "--profile",
      s.profilePath,
      "--json",
    ]);
    assert.equal(relations.code, 0, relations.stdout + relations.stderr);
    const changed = relations.json?.["changedSources"] as Array<Record<string, unknown>>;
    assert.deepEqual(
      changed.map((e) => [(e["downstream"] as { sha256: string }).sha256, e["currentSha256"]]),
      [[versions[0]!["sha256"], sourceSha(next.candidate)]],
    );
  } finally {
    project.close();
  }
});
