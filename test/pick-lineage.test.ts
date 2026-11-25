/**
 * A pick of a strip staged from an editable source records `lineage` on the version it appends
 * (#470): a `derived-from` edge to the source file, library-relative with its sha256. A source
 * outside the library root refuses the pick before anything is written.
 */
import "./fixtures/env.ts";
import { approve } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseReview } from "../src/library/review.ts";
import { relationshipGraph } from "../src/library/relations.ts";
import { scanLibrary } from "../src/library/write.ts";
import type { AssetSpec, EditableSource } from "../src/types.ts";
import { gitTarget } from "./fixtures/git.ts";
import { syntheticWorld, writeStyleBible } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
approve(script);

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}
function cli(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env["AI_GATEWAY_API_KEY"];
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = (r: Result): Record<string, any> => JSON.parse(r.stdout);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const spec: AssetSpec = { kind: "still", assetId: "lantern", subject: "fern" };

async function staged(source: (targetDir: string) => string) {
  const world = await syntheticWorld();
  const targetDir = realpathSync(gitTarget(world.targetDir));
  Object.assign(world.profile, {
    layout: {
      media: "props/lights/{{spec.assetId}}.{{output.extension}}",
      manifest: "manifests/{{spec.assetId}}.json",
    },
    manifest: {
      assetId: "{{spec.assetId}}",
      review: { status: "pending" },
      contentHash: "{{output.sha256}}",
    },
  });
  delete world.profile.validator;
  const specPath = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "BIBLE.md");
  const profile = join(world.dir, "profile.json");
  await writeFile(specPath, JSON.stringify(spec));
  await writeStyleBible(bible, world.bible);
  await writeFile(profile, JSON.stringify(world.profile));
  const stage = await cli([
    "stage",
    ...["--spec", specPath, "--bible", bible, "--profile", profile],
    ...["--runs", world.runsDir, "--candidates", "1"],
    ...["--provider-script", script, "--json"],
  ]);
  assert.equal(stage.code, 0, stage.stdout + stage.stderr);
  const runDir = doc(stage)["runDir"] as string;
  const path = source(targetDir);
  const editableSource: EditableSource = {
    path,
    sha256: sha("source one"),
    format: "aseprite",
    frames: [0, 1],
    durationsMs: [100, 100],
  };
  const runPath = join(runDir, "run.json");
  const run = JSON.parse(await readFile(runPath, "utf8"));
  run.candidates[0].provenance.editableSource = editableSource;
  await writeFile(runPath, JSON.stringify(run));
  const pick = () =>
    cli(["pick", "--run", runDir, "--candidate", "c1", "--target", targetDir, "--json"]);
  return { targetDir, profile, path, editableSource, pick };
}

const status = (dir: string) =>
  execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: dir, encoding: "utf8" });

test("a pick records a derived-from edge to the editable source, and a source edit lists it as changed", async () => {
  const s = await staged((dir) => {
    mkdirSync(join(dir, "props/lights/src"), { recursive: true });
    return join(dir, "props/lights/src/lantern.aseprite");
  });
  await writeFile(s.path, "source one");
  const picked = await s.pick();
  assert.equal(picked.code, 0, picked.stdout + picked.stderr);
  const reviewPath = join(s.targetDir, "props/lights/lantern.review.json");
  const record = parseReview(await readFile(reviewPath, "utf8"), reviewPath);
  assert.deepEqual(record.versions.at(-1)!["lineage"], [
    { relation: "derived-from", file: "src/lantern.aseprite", sha256: sha("source one") },
  ]);
  const libraryRoot = join(s.targetDir, "props/lights");
  const graph = () =>
    relationshipGraph(libraryRoot, scanAssets(libraryRoot, [reviewPath], [record]));
  assert.deepEqual(graph().problems, []);
  assert.deepEqual(graph().edges[0]!.source, {
    file: "src/lantern.aseprite",
    sha256: sha("source one"),
  });
  assert.deepEqual(graph().changedSources, []);
  const relations = await cli([
    "library",
    "relations",
    "--target",
    s.targetDir,
    "--profile",
    s.profile,
    "--json",
  ]);
  assert.equal(relations.code, 0, relations.stdout + relations.stderr);
  assert.deepEqual(
    doc(relations)["edges"].map((e: { source: unknown }) => e.source),
    [{ file: "src/lantern.aseprite", sha256: sha("source one") }],
  );
  const check = await cli([
    "library",
    "check",
    "--target",
    s.targetDir,
    "--profile",
    s.profile,
    "--json",
  ]);
  assert.equal(check.code, 0, check.stdout + check.stderr);

  await writeFile(s.path, "source two");
  const changed = graph().changedSources;
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.currentSha256, sha("source two"));
  const human = await cli([
    "library",
    "relations",
    "--target",
    s.targetDir,
    "--profile",
    s.profile,
  ]);
  assert.match(
    human.stdout,
    new RegExp(
      `file:src/lantern\\.aseprite recorded ${sha("source one")}, current ${sha("source two")}`,
    ),
  );
  assert.equal(scanLibrary(libraryRoot).unreadable.length, 0);
});

test("a source outside the library root refuses the pick with exit 2 and writes nothing", async () => {
  const s = await staged((dir) => join(dir, "art/lantern.aseprite"));
  mkdirSync(join(s.targetDir, "art"), { recursive: true });
  await writeFile(s.path, "source one");
  const before = status(s.targetDir);
  const picked = await s.pick();
  assert.equal(picked.code, 2, picked.stdout + picked.stderr);
  assert.match(picked.stdout + picked.stderr, /editable source/);
  assert.equal(status(s.targetDir), before);
});

function scanAssets(
  libraryRoot: string,
  paths: string[],
  records: Array<ReturnType<typeof parseReview>>,
) {
  return paths.map((reviewPath, i) => ({ reviewPath, review: { record: records[i]! } }));
}
