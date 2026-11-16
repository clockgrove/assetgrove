import "./fixtures/env.ts";
import { approve, approveProfile, ledgerPath } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";
import { canonicalJson, requestDigest } from "../src/runs/plan.ts";
import type { DigestInput, PlanJob } from "../src/runs/plan.ts";
import { gitTarget } from "./fixtures/git.ts";
import { quadrupedTemplate, walkGait } from "./fixtures/quadruped.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { syntheticStrip } from "./fixtures/strip.ts";
import { GAME, fixtureLibrary } from "./fixtures/library.ts";
import {
  PALETTE,
  drawSubject,
  shelterSpec,
  syntheticProfile,
  syntheticWorld,
} from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
const synthetic = fileURLToPath(new URL("./fixtures/synthetic.ts", import.meta.url));
const raster = fileURLToPath(new URL("../src/image/raster.ts", import.meta.url));
approve(passingScript);

const temporary: string[] = [];
const clients: Client[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["AI_GATEWAY_API_KEY"];
  return env;
}

function cli(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env: childEnv(), maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
const doc = (r: Result): Doc => JSON.parse(r.stdout);

/**
 * A provider script that answers like a passing model and appends one line to `events` for every
 * call it gets, so a missing events file proves no call was made. It is approved here.
 */
async function recorder(dir: string, name: string): Promise<{ script: string; events: string }> {
  const script = join(dir, `${name}.mjs`);
  const events = join(dir, `${name}.events`);
  await writeFile(
    script,
    `
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { drawSubject } = await import(pathToFileURL(${JSON.stringify(synthetic)}));
const { encodePng } = await import(pathToFileURL(${JSON.stringify(raster)}));
const note = (kind) => appendFileSync(${JSON.stringify(events)}, kind + '\\n');
const checks = ['transparency','frame-count','identity','perspective','style'].map(check => ({check, passed: true, reason: 'scripted match'}));
export default {
  image() { note('image'); return {images:[{mediaType:'image/png',bytes:encodePng(drawSubject(96))}]}; },
  vision() { note('vision'); return {text: JSON.stringify({prompt:'A friendly round icon, flat cel shading.',negativePrompt:'No text.',violations:[],clamps:[],styleScore:1,passed:true,reason:'scripted match',checks})}; },
  decide() { note('decide'); return {answer:{type:'score',score:1},confidence:0.5}; },
};`,
  );
  approve(script);
  return { script, events };
}

async function ledgerContent(): Promise<string | null> {
  return existsSync(ledgerPath) ? readFile(ledgerPath, "utf8") : null;
}

/** The synthetic world's spec, bible and profile written as files, with the stage arguments. */
async function stageFiles() {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  approveProfile(world.profile, { targetDir: world.targetDir });
  const args = { spec, bible, profile, runs: world.runsDir };
  const flags = ["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir];
  return { world, spec, bible, profile, runs: world.runsDir, args, flags };
}

/** A bible with a locked character, and a labelled case set, for the identity commands. */
async function identityFiles(dir: string) {
  const art = join(dir, "art");
  await mkdir(art, { recursive: true });
  const ref = createRaster(24, 24);
  setPixel(ref, 3, 3, [180, 90, 40, 255]);
  await writeFile(join(art, "bram-turnaround.png"), encodePng(ref));
  const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  data.referenceLicense = "NOASSERTION";
  data.world = "Synthetic";
  data.identities = {
    bram: {
      version: "bram-3",
      approved: true,
      turnaround: "bram-turnaround.png",
      signatureFeatures: ["striped tail"],
      proportions: "round body",
      palette: ["#b45a28"],
    },
  };
  const bible = join(art, "BIBLE.md");
  await writeFile(bible, serializeBible(data, "# Synthetic\n\n## Do's and Don'ts\nDo.\n"));
  await writeFile(join(dir, "sheet.png"), syntheticSheet().png);
  const cases = join(dir, "cases.json");
  await writeFile(
    cases,
    JSON.stringify([
      { image: "sheet.png", subject: "bram", same: true, qa: true },
      { image: "sheet.png", subject: "bram", same: false, qa: false },
    ]),
  );
  return { bible, cases, sheet: join(dir, "sheet.png") };
}

/** A look-dev request: a target with a rig template and a groom, and a model with its provenance. */
async function lookDevFiles(dir: string) {
  await mkdir(join(dir, "refs"), { recursive: true });
  const roles = ["turnaround-front", "turnaround-side", "turnaround-back"];
  for (const [i, role] of roles.entries())
    await writeFile(join(dir, "refs", `${role}.png`), encodePng(drawSubject(64, i * 4)));
  await mkdir(join(dir, "rig"));
  await writeFile(join(dir, "rig", "quadruped.json"), JSON.stringify(quadrupedTemplate()));
  const files = {
    spec: join(dir, "kit-spec.json"),
    bible: join(dir, "kit-bible.json"),
    profile: join(dir, "kit-profile.json"),
    model: join(dir, "kit.glb"),
    provenance: join(dir, "kit.provenance.json"),
  };
  await writeFile(
    files.spec,
    JSON.stringify({
      kind: "character-3d",
      assetId: "kit",
      subject: "kit",
      gait: "quadruped",
      clips: ["walk"],
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
      references: roles.map((role) => ({ path: `refs/${role}.png`, role, subject: "kit" })),
      perspective: "refs/turnaround-front.png",
      subjects: { kit: { description: "a small synthetic quadruped" } },
    }),
  );
  await writeFile(
    files.profile,
    JSON.stringify({
      format: "assetgrove-target-profile/1",
      name: "synthetic-grove-lookdev",
      license: "MIT",
      frames: { width: 32, height: 32 },
      model3d: {
        format: "glb",
        budgets: { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 1 },
        units: "m",
        turntable: { sizePx: 64 },
        rig: { template: "rig/quadruped.json", kind: "synthetic-quadruped" },
        gaits: { walk: walkGait() },
        groom: {
          sizePx: 256,
          seasons: ["summer", "winter"],
          traits: { summer: "short, sleek", winter: "long, dense" },
        },
      },
    }),
  );
  await writeFile(files.model, "synthetic model bytes: a dry run never parses them");
  await writeFile(files.provenance, "{}");
  return files;
}

/** A walk strip with its profile, for animation-qa and fix-frame. */
async function stripFiles(dir: string) {
  const { strip } = syntheticStrip({ count: 8, style: "painterly", motion: "walk" });
  const files = { strip: join(dir, "walk-right.png"), profile: join(dir, "strip-profile.json") };
  await writeFile(files.strip, encodePng(strip));
  await writeFile(
    files.profile,
    JSON.stringify({ ...syntheticProfile(), frames: { width: 64, height: 64, durationMs: 100 } }),
  );
  return files;
}

/** The materials request of material-cli.test.ts: an albedo, a derivation and a minimal profile. */
async function materialFiles(dir: string) {
  const files = {
    profile: join(dir, "materials-profile.json"),
    spec: join(dir, "materials-spec.json"),
    derivation: join(dir, "derivation.json"),
    albedo: join(dir, "unread.png"),
  };
  await writeFile(
    files.profile,
    JSON.stringify({ format: "assetgrove-target-profile/1", frames: { width: 4, height: 4 } }),
  );
  await writeFile(files.spec, JSON.stringify({ kind: "still", assetId: "synthetic" }));
  await writeFile(files.albedo, "not an image: a dry run never decodes it");
  await writeFile(
    files.derivation,
    JSON.stringify({
      maps: Object.fromEntries(
        ["normal", "height", "emissive", "roughness", "wind"].map((channel) => [
          channel,
          {
            method: channel === "normal" ? "height-derived-normal" : "mask-extraction",
            version: "1",
            path: "unread.png",
          },
        ]),
      ),
    }),
  );
  return files;
}

/** A plan request over the synthetic world's bible with a still spec; saves its plan at `out`. */
async function planFiles(dir: string, candidates: number) {
  const init = await cli([
    ...["init", "--directory", gitTarget(join(dir, "bible")), "--world", "Synthetic Grove"],
    ...["--profile-preset", "sprite-32", "--style-preset", "flat-cartoon-kids", "--json"],
  ]);
  assert.equal(init.code, 0, init.stderr);
  const files = {
    spec: join(dir, "still-spec.json"),
    bible: (doc(init)["files"] as { path: string; role: string }[]).find((f) => f.role === "bible")
      ?.path as string,
    profile: join(dir, "plan-profile.json"),
    runOptions: join(dir, "run-options.json"),
    out: join(dir, "plan.json"),
  };
  await writeFile(
    files.spec,
    JSON.stringify({ kind: "still", assetId: "icon", subject: "icon", animationFamily: "still" }),
  );
  await writeFile(files.profile, JSON.stringify(syntheticProfile()));
  await writeFile(files.runOptions, JSON.stringify({ candidates, strictness: 0.5 }));
  const flags = [
    ...["--spec", files.spec, "--bible", files.bible, "--profile", files.profile],
    ...["--run-options", files.runOptions, "--out", files.out, "--runs", join(dir, "plan-runs")],
  ];
  return { ...files, flags };
}

const DIGEST = /^[0-9a-f]{64}$/;

test("every paid command's --dry-run returns its plan with no provider call and no ledger entry", async () => {
  const dir = await tempDir("assetgrove-plan-step-");
  const runs = join(dir, "dry-runs");
  const stage = await stageFiles();
  const id = await identityFiles(await tempDir("assetgrove-plan-step-id-"));
  const lookDev = await lookDevFiles(await tempDir("assetgrove-plan-step-ld-"));
  const strip = await stripFiles(await tempDir("assetgrove-plan-step-strip-"));
  const material = await materialFiles(await tempDir("assetgrove-plan-step-mat-"));
  const planned = await planFiles(await tempDir("assetgrove-plan-step-plan-"), 2);
  const library = fixtureLibrary();
  temporary.push(library.dir);
  approveProfile(JSON.parse(await readFile(material.profile, "utf8")), { profileDir: dir });

  // apply needs a saved plan: make one with a script of its own, before the recorder is watched.
  const saver = await recorder(dir, "saver");
  const saved = await cli(["plan", ...planned.flags, "--provider-script", saver.script, "--json"]);
  assert.equal(saved.code, 0, saved.stderr);
  const watch = await recorder(dir, "watch");
  const ledgerBefore = await ledgerContent();

  const lookDevArgs = [
    ...["--model", lookDev.model, "--provenance", lookDev.provenance],
    ...["--spec", lookDev.spec, "--bible", lookDev.bible, "--profile", lookDev.profile],
  ];
  const cases: Array<[string, string[]]> = [
    [
      "plan",
      [
        ...["--spec", planned.spec, "--bible", planned.bible, "--profile", planned.profile],
        ...["--run-options", planned.runOptions, "--out", planned.out],
      ],
    ],
    ["apply", [planned.out]],
    ["stage", ["--spec", stage.spec, "--bible", stage.bible, "--profile", stage.profile]],
    ["generate-sheet", ["--spec", stage.spec, "--bible", stage.bible, "--profile", stage.profile]],
    [
      "import",
      ["--sheet", id.sheet, "--profile", stage.profile, "--asset", "fern", "--tool", "hand"],
    ],
    [
      "materials",
      [
        ...["--albedo", material.albedo, "--profile", material.profile, "--spec", material.spec],
        ...["--derivation", material.derivation, "--out", join(dir, "materials-out")],
      ],
    ],
    ["look-dev", lookDevArgs],
    [
      "animation-qa",
      ["--strip", strip.strip, "--family", "walk-right", "--profile", strip.profile],
    ],
    [
      "fix-frame",
      [
        ...["--strip", strip.strip, "--family", "walk-right", "--profile", strip.profile],
        ...["--frame", "3", "--from", "2", "--out", join(dir, "fixed")],
      ],
    ],
    ["identity-eval", ["--cases", id.cases, "--bible", id.bible]],
    ["identity-check", ["--bible", id.bible]],
    ["audit", [`asset://${GAME}/by-tag/prop/`, "--target", library.dir, "--bible", id.bible]],
  ];
  assert.equal(cases.length, 12);

  for (const [name, args] of cases) {
    // Extra arguments (the runs directory) are appended; apply stages under --out, not --runs.
    const run = await cli([
      name,
      ...args,
      ...(name === "apply" ? ["--out", runs] : ["--runs", runs]),
      ...["--provider-script", watch.script, "--dry-run", "--json"],
    ]);
    assert.equal(run.code, 0, `${name}: ${run.stdout}${run.stderr}`);
    const d = doc(run);
    assert.equal(d.dryRun, true, name);
    assert.ok(Array.isArray(d.jobs), `${name} jobs`);
    assert.equal(typeof d.forecastUsd, "number", name);
    assert.equal(typeof d.capUsd, "number", name);
    assert.equal(typeof d.paid, "boolean", name);
    assert.match(d.digest, DIGEST, name);
    assert.ok((d.runDir as string).endsWith(`r-${d.digest.slice(0, 16)}`), `${name} ${d.runDir}`);
    assert.equal(existsSync(d.runDir), false, `${name}: a dry run creates no run directory`);
    assert.ok(d.jobs.length > 0, `${name} has calls to forecast`);
    for (const job of d.jobs as PlanJob[])
      assert.ok(job.count > 0 && job.estimatedCostUsd >= 0 && job.model, `${name} job`);
  }

  assert.equal(existsSync(watch.events), false, "no provider call");
  assert.equal(await ledgerContent(), ledgerBefore, "no ledger entry");
});

test("the digest is stable across key order and changes with any input hash, option, round or job estimate", async () => {
  const job: PlanJob = {
    operation: "still",
    provider: "scripted",
    model: "m",
    count: 2,
    estimatedCostUsd: 0.04,
  };
  const base: DigestInput = {
    command: "stage",
    round: 1,
    inputs: { spec: "a".repeat(64), bible: "b".repeat(64) },
    options: { candidates: 4, nested: { x: 1, y: [1, { p: 1, q: 2 }] } },
    jobs: [job],
    forecastUsd: 0.08,
    capUsd: 2,
  };
  const digest = requestDigest(base);
  assert.match(digest, DIGEST);

  assert.equal(
    canonicalJson({ b: { d: 1, c: [{ z: 1, a: 2 }] }, a: undefined, e: 1 }),
    canonicalJson({ e: 1, b: { c: [{ a: 2, z: 1 }], d: 1 } }),
  );
  const reordered: DigestInput = {
    jobs: [
      {
        estimatedCostUsd: 0.04,
        count: 2,
        model: "m",
        provider: "scripted",
        operation: "still",
      },
    ],
    capUsd: 2,
    forecastUsd: 0.08,
    options: { nested: { y: [1, { q: 2, p: 1 }], x: 1 }, candidates: 4 },
    inputs: { bible: "b".repeat(64), spec: "a".repeat(64) },
    round: 1,
    command: "stage",
  };
  assert.equal(requestDigest(reordered), digest);

  const changed: Record<string, DigestInput> = {
    "an input hash": { ...base, inputs: { ...base.inputs, spec: "c".repeat(64) } },
    "an option": { ...base, options: { ...base.options, candidates: 5 } },
    "the round": { ...base, round: 2 },
    "a job estimate": { ...base, jobs: [{ ...job, estimatedCostUsd: 0.05 }] },
  };
  const seen = new Set([digest]);
  for (const [what, input] of Object.entries(changed)) {
    const other = requestDigest(input);
    assert.match(other, DIGEST);
    assert.equal(seen.has(other), false, `the digest does not change with ${what}`);
    seen.add(other);
  }

  // Through the CLI: the round, an option and a file's bytes each name another request.
  const stage = await stageFiles();
  const dry = async (...extra: string[]) =>
    doc(await cli(["stage", ...stage.flags, ...extra, "--dry-run", "--json"]));
  const first = await dry();
  assert.equal((await dry()).digest, first.digest, "the same request has the same digest");
  const round = await dry("--round", "2");
  const candidates = await dry("--candidates", "3");
  await writeFile(stage.spec, JSON.stringify({ ...shelterSpec, fields: { semantic: {} } }));
  const bytes = await dry();
  const digests = [first, round, candidates, bytes].map((d) => d.digest);
  for (const d of digests) assert.match(d, DIGEST);
  assert.equal(new Set(digests).size, 4, digests.join(" "));
});

test("MCP estimate for stage deep-equals stage --dry-run --json", async () => {
  const stage = await stageFiles();
  const { script } = await recorder(await tempDir("assetgrove-plan-step-mcp-"), "estimate");
  const cliRun = await cli([
    ...["stage", ...stage.flags, "--provider-script", script, "--dry-run", "--json"],
  ]);
  assert.equal(cliRun.code, 0, cliRun.stderr);
  const expected = doc(cliRun);

  const client = new Client({ name: "plan-step-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--provider-script", script],
      cwd: root,
      env: childEnv() as Record<string, string>,
      stderr: "pipe",
    }),
  );
  clients.push(client);
  const result = await client.callTool({
    name: "estimate",
    arguments: { command: "stage", args: stage.args },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const viaTool = result.structuredContent as Doc;

  const viaCli = doc(
    await cli([
      ...["estimate", "stage", "--args", JSON.stringify(stage.args)],
      ...["--provider-script", script, "--json"],
    ]),
  );
  // The result document is stage's own, its command name included.
  for (const actual of [viaTool, viaCli]) {
    assert.equal(actual["command"], "stage");
    assert.deepEqual(actual, expected, "estimate gives the document of stage --dry-run");
  }
});

test("a stage run writes request.json in <runs>/r-<16 hex of the digest>/ and run.json names that directory", async () => {
  const stage = await stageFiles();
  const flags = [...stage.flags, "--candidates", "1"];
  const dry = doc(await cli(["stage", ...flags, "--dry-run", "--json"]));
  const runDir = join(stage.runs, `r-${dry["digest"].slice(0, 16)}`);
  assert.equal(dry["runDir"], runDir);
  assert.equal(existsSync(runDir), false);

  const run = await cli(["stage", ...flags, "--provider-script", passingScript, "--json"]);
  assert.equal(run.code, 0, run.stderr + run.stdout);
  const result = doc(run);
  assert.equal(result["runDir"], runDir);
  const request = JSON.parse(await readFile(join(runDir, "request.json"), "utf8"));
  assert.equal(request.digest, dry["digest"]);
  assert.equal(request.runDir, runDir);
  assert.deepEqual(request.jobs, dry["jobs"]);
  const record = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  assert.equal(record.runDir, runDir);
});

test("plan's forecast holds the planning call and every job of the later apply", async () => {
  const dir = await tempDir("assetgrove-plan-step-apply-");
  const f = await planFiles(dir, 2);
  const { script, events } = await recorder(dir, "forecast");
  const forecast = doc(
    await cli(["plan", ...f.flags, "--provider-script", script, "--dry-run", "--json"]),
  );
  assert.equal(forecast["ok"], true);
  const jobs = forecast["jobs"] as PlanJob[];
  const job = (list: PlanJob[], operation: string) => list.find((j) => j.operation === operation);
  assert.equal(job(jobs, "compiler")?.count, 1, "the planning call");
  assert.equal(job(jobs, "still")?.count, 2, "one generation per candidate");
  assert.equal(job(jobs, "vision")?.count, 2, "one QA call per candidate");
  const sum = jobs.reduce((total, j) => total + j.count * j.estimatedCostUsd, 0);
  assert.ok(Math.abs(forecast["forecastUsd"] - sum) < 1e-9);
  assert.equal(existsSync(events), false);

  // Plan's own prompt-policy check and the up to two the later apply runs first (its second
  // decides on the person's text alone when the first objects to the compiler's).
  assert.equal(job(jobs, "prompt-policy")?.count, 3, "plan's and apply's prompt-policy checks");
  const saved = await recorder(dir, "saved");
  const made = await cli(["plan", ...f.flags, "--provider-script", saved.script, "--json"]);
  assert.equal(made.code, 0, made.stderr);
  const apply = doc(
    await cli([
      ...["apply", f.out, "--out", join(dir, "apply-runs")],
      ...["--provider-script", script, "--dry-run", "--json"],
    ]),
  );
  assert.equal(apply["ok"], true);
  const applyJobs = apply["jobs"] as PlanJob[];
  assert.ok(applyJobs.length > 0);
  for (const j of applyJobs) {
    const inPlan = job(jobs, j.operation);
    assert.ok(inPlan, `plan forecasts ${j.operation}`);
    // Plan makes one prompt-policy call itself beside the apply's.
    const own = j.operation === "prompt-policy" ? 1 : 0;
    assert.deepEqual(
      [inPlan.model, inPlan.count, inPlan.estimatedCostUsd],
      [j.model, j.count + own, j.estimatedCostUsd],
      j.operation,
    );
  }
  const compiler = job(jobs, "compiler")!;
  const policy = job(applyJobs, "prompt-policy")!;
  const expected =
    apply["forecastUsd"] + compiler.count * compiler.estimatedCostUsd + policy.estimatedCostUsd; // plan's own one check
  assert.ok(Math.abs(forecast["forecastUsd"] - expected) < 1e-9, `${forecast["forecastUsd"]}`);
});

test("the digest changes with a file the request reads through its arguments", async () => {
  // stage: a reference image the style bible names.
  const stage = await stageFiles();
  const dry = async (command: string, flags: string[]) =>
    doc(await cli([command, ...flags, "--dry-run", "--json"]));
  const before = await dry("stage", stage.flags);
  const reference = stage.world.bible.references[0]!.path;
  assert.ok(before["inputs"][`bible/${reference}`], JSON.stringify(before["inputs"]));
  const image = join(stage.world.bibleDir, reference);
  await writeFile(image, Buffer.concat([await readFile(image), Buffer.from([0])]));
  const changed = await dry("stage", stage.flags);
  assert.notEqual(changed["digest"], before["digest"], "a changed reference image");

  // plan: the default prompt template it reads when --template is absent.
  const dir = await tempDir("assetgrove-plan-step-reads-");
  const f = await planFiles(dir, 1);
  const { script } = await recorder(dir, "reads");
  const flags = [...f.flags, "--provider-script", script];
  const first = await dry("plan", flags);
  assert.ok(first["inputs"]["template"], JSON.stringify(first["inputs"]));
  const template = join(dirname(f.bible), "../prompts/default.md");
  await writeFile(template, `${await readFile(template, "utf8")}\nchanged\n`);
  assert.notEqual((await dry("plan", flags))["digest"], first["digest"], "a changed template");
});

test("plan forecasts the planning call only when its compiler route can be called", async () => {
  const dir = await tempDir("assetgrove-plan-step-compiler-");
  const f = await planFiles(dir, 1);
  // No provider script and no key: the compiler cannot be called, so the template fallback runs.
  const fallback = doc(await cli(["plan", ...f.flags, "--dry-run", "--json"]));
  assert.equal(fallback["ok"], true, JSON.stringify(fallback));
  const jobs = fallback["jobs"] as PlanJob[];
  assert.equal(
    jobs.some((j) => j.operation === "compiler"),
    false,
    JSON.stringify(jobs),
  );
});
