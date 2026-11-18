/**
 * A pick writes the model-written summary its candidate's QA call gave onto the card (#432): the
 * description and tags, marked machine-written in `verified`, never over a person's words, and
 * with no call staging did not already make.
 */
import "./fixtures/env.ts";
import { approve } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { parseCard } from "../src/library/card.ts";
import { summaryDigest } from "../src/library/summary.ts";
import type { AssetSpec } from "../src/types.ts";
import { SUMMARY } from "./fixtures/summary-script.ts";
import { gitTarget } from "./fixtures/git.ts";
import { syntheticWorld, writeStyleBible } from "./fixtures/synthetic.ts";
import type { World } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const plainScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
const summaryScript = fileURLToPath(new URL("./fixtures/summary-script.ts", import.meta.url));
const LFS = "*.png filter=lfs diff=lfs merge=lfs -text\n";
approve(plainScript, summaryScript);

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

async function setup(spec: AssetSpec, script: string, extra: string[] = []) {
  const world: World = await syntheticWorld();
  gitTarget(world.targetDir);
  await writeFile(join(world.targetDir, ".gitattributes"), LFS);
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
    ...["--provider-script", script, "--json", ...extra],
  ]);
  return { world, profile, stage };
}

async function pickCard(spec: AssetSpec) {
  const { world, profile, stage } = await setup(spec, summaryScript);
  assert.equal(stage.code, 0, stage.stdout + stage.stderr);
  const picked = await cli([
    ...["pick", "--run", doc(stage)["runDir"], "--candidate", "c1"],
    ...["--target", world.targetDir, "--json"],
  ]);
  assert.equal(picked.code, 0, picked.stdout + picked.stderr);
  const path = join(world.targetDir, "props/lights", `${spec.assetId}.md`);
  const card = parseCard(await readFile(path, "utf8"), path);
  const check = await cli([
    ...["library", "check", "--target", world.targetDir, "--profile", profile, "--json"],
  ]);
  return { card, check };
}

const still = (extra: Partial<AssetSpec> = {}): AssetSpec => ({
  kind: "still",
  assetId: "lantern",
  subject: "fern",
  ...extra,
});

test("a pick writes the QA call's summary onto the card as a machine-written entry, and library check passes", async () => {
  const { card, check } = await pickCard(still());
  assert.equal(check.code, 0, check.stdout + check.stderr);
  assert.equal(card.data["description"], SUMMARY.description);
  assert.deepEqual(card.data["tags"], SUMMARY.tags);
  const verified = card.data["verified"] as Array<Record<string, unknown>>;
  const entry = verified[verified.length - 1]!;
  assert.match(String(entry["by"]), /^process:assetgrove-summary:vision:.+/);
  assert.match(String(entry["at"]), /^\d{4}-\d\d-\d\dT/);
  assert.match(String(entry["summary"]), /^[0-9a-f]{64}$/);
  assert.equal(entry["summary"], summaryDigest(SUMMARY.description, SUMMARY.tags));
});

test("a description the spec's fields gave is kept and gets no summary entry", async () => {
  const { card, check } = await pickCard(still({ fields: { description: "My lantern." } }));
  assert.equal(check.code, 0, check.stdout + check.stderr);
  assert.equal(card.data["description"], "My lantern.");
  assert.equal(card.data["tags"], undefined);
  const verified = (card.data["verified"] ?? []) as Array<Record<string, unknown>>;
  assert.ok(!verified.some((v) => String(v["by"]).startsWith("process:assetgrove-summary:")));
});

test("the summary adds no call: the stage's spend form lists the same jobs, and a real stage makes one vision call per candidate", async () => {
  const jobs = (r: Result) =>
    doc(r)["jobs"].map((j: Record<string, unknown>) => [j["operation"], j["count"]]);
  const expected = [
    ["prompt-policy", 1],
    ["still", 1],
    ["cutout", 1],
    ["vision", 1],
  ];
  const plain = await setup(still(), plainScript, ["--dry-run"]);
  const summary = await setup(still(), summaryScript, ["--dry-run"]);
  assert.equal(plain.stage.code, 0, plain.stage.stderr);
  assert.equal(summary.stage.code, 0, summary.stage.stderr);
  assert.deepEqual(jobs(plain.stage), expected);
  assert.deepEqual(jobs(summary.stage), expected);

  // The real stage: the summary rides on the one QA call, so the provider sees one vision call
  // for the one candidate, as the forecast said.
  const dir = await mkdtemp(join(tmpdir(), "summary-count-"));
  const events = join(dir, "vision.events");
  const counting = join(dir, "counting.mjs");
  await writeFile(
    counting,
    `import { appendFileSync } from "node:fs";
import base from ${JSON.stringify(pathToFileURL(summaryScript).href)};
export default {
  ...base,
  vision: (...args) => {
    appendFileSync(${JSON.stringify(events)}, "vision\\n");
    return base.vision(...args);
  },
};
`,
  );
  approve(counting);
  const real = await setup(still(), counting);
  assert.equal(real.stage.code, 0, real.stage.stdout + real.stage.stderr);
  assert.equal(doc(real.stage)["candidates"].length, 1);
  assert.equal((await readFile(events, "utf8")).split("\n").filter(Boolean).length, 1);
  await rm(dir, { recursive: true, force: true });
});

test("stage returns a candidate's summary text only under sharedText", async () => {
  const { stage } = await setup(still(), summaryScript);
  assert.equal(stage.code, 0, stage.stdout + stage.stderr);
  const out = doc(stage);
  const candidate = out["candidates"][0];
  assert.deepEqual(Object.keys(candidate["summary"]).sort(), ["model", "operation"]);
  assert.equal(candidate["summary"]["operation"], "vision");
  assert.ok(!JSON.stringify(out["candidates"]).includes(SUMMARY.description));
  assert.deepEqual(
    out["sharedText"].filter((s: Record<string, string>) => s["source"].startsWith("candidates.")),
    [
      { source: "candidates.c1.summary.description", text: SUMMARY.description },
      ...SUMMARY.tags.map((text) => ({ source: "candidates.c1.summary.tags", text })),
    ],
  );
  // The run record on disk keeps the summary for pick.
  const run = JSON.parse(await readFile(join(out["runDir"], "run.json"), "utf8"));
  assert.equal(run.candidates[0].summary.description, SUMMARY.description);
});
