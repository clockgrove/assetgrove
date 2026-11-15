import "./fixtures/env.ts";
import { approve, approveProfile, ledgerPath, writeSettings } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { failureOutcome } from "../src/commands/result.ts";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";
import { packageBlocklist } from "../src/policy/blocklist.ts";
import {
  checkPromptText,
  enforcePromptPolicy,
  promptStrings,
  PromptRefusedError,
} from "../src/policy/text.ts";
import { sheetBrief } from "../src/sheet/generate.ts";
import { ProviderSet } from "../src/providers/set.ts";
import { planDigest } from "../src/planning.ts";
import type { SavedPlan } from "../src/planning.ts";
import { quadrupedTemplate, walkGait } from "./fixtures/quadruped.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { syntheticStrip } from "./fixtures/strip.ts";
import {
  PALETTE,
  drawSubject,
  shelterSpec,
  syntheticProfile,
  syntheticWorld,
} from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
/** A two-word artist term from the package blocklist: names live in policy/ only. */
const TERM = packageBlocklist().terms.find(
  (t) => t.kind === "artist" && t.term.includes(" "),
)!.term;
const [FIRST, LAST] = TERM.split(" ") as [string, string];
const title = (word: string) => word[0]!.toUpperCase() + word.slice(1);
/** Each ASCII letter as its fullwidth form, which NFKC folds back. */
const fullwidth = (text: string) =>
  text.replace(/[a-z]/g, (c) => String.fromCodePoint(c.codePointAt(0)! + 0xfee0));
const STYLE = `painted by ${TERM}`;

const temporary: string[] = [];
after(async () => {
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

function cli(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env["AI_GATEWAY_API_KEY"];
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
const doc = (r: Result): Doc => JSON.parse(r.stdout);

/** A provider script that logs every call to `events`, so a missing file proves no call. */
async function recorder(dir: string): Promise<{ script: string; events: string }> {
  const script = join(dir, "watch.mjs");
  const events = join(dir, "watch.events");
  await writeFile(
    script,
    `
import { appendFileSync } from 'node:fs';
const note = (kind) => appendFileSync(${JSON.stringify(events)}, kind + '\\n');
export default {
  image() { note('image'); throw new Error('no call expected'); },
  vision() { note('vision'); throw new Error('no call expected'); },
  decide() { note('decide'); throw new Error('no call expected'); },
};`,
  );
  approve(script);
  return { script, events };
}

async function ledgerContent(): Promise<string | null> {
  return existsSync(ledgerPath) ? readFile(ledgerPath, "utf8") : null;
}

async function stageFiles(term: string) {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(
    spec,
    JSON.stringify({
      ...shelterSpec,
      fields: { ...shelterSpec.fields, accessibilityLabel: `Fern sheltering ${term}` },
    }),
  );
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  approveProfile(world.profile, { targetDir: world.targetDir });
  return { world, spec, bible, profile };
}

async function identityFiles(dir: string, term: string) {
  const art = join(dir, "art");
  await mkdir(art, { recursive: true });
  const ref = createRaster(24, 24);
  setPixel(ref, 3, 3, [180, 90, 40, 255]);
  await writeFile(join(art, "bram-turnaround.png"), encodePng(ref));
  const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  data.referenceLicense = "NOASSERTION";
  data.world = `Synthetic ${term}`;
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
  await writeFile(cases, JSON.stringify([{ image: "sheet.png", subject: "bram", same: true }]));
  return { bible, cases, sheet: join(dir, "sheet.png") };
}

async function lookDevFiles(dir: string, term: string) {
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
      subject: `kit ${term}`,
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

async function stripFiles(dir: string, term: string) {
  const { strip } = syntheticStrip({ count: 8, style: "painterly", motion: "walk" });
  const files = {
    strip: join(dir, "walk-right.png"),
    profile: join(dir, "strip-profile.json"),
    spec: join(dir, "strip-spec.json"),
  };
  await writeFile(files.strip, encodePng(strip));
  await writeFile(
    files.profile,
    JSON.stringify({ ...syntheticProfile(), frames: { width: 64, height: 64, durationMs: 100 } }),
  );
  await writeFile(
    files.spec,
    JSON.stringify({ kind: "sprite-strip", assetId: "fern", subject: `fern ${term}` }),
  );
  return files;
}

async function materialFiles(dir: string, term: string) {
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
  await writeFile(
    files.spec,
    JSON.stringify({ kind: "still", assetId: "synthetic", subject: `synthetic ${term}` }),
  );
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

/** A Markdown bible, a template, a profile and a spec carrying `term`, for plan. */
async function planFiles(dir: string, term: string) {
  const art = join(dir, ".assetgrove/art-direction");
  await mkdir(art, { recursive: true });
  await mkdir(join(dir, ".assetgrove/prompts"), { recursive: true });
  const data = structuredClone(BIBLE_PRESETS["flat-cartoon-kids"]!);
  data.referenceLicense = "NOASSERTION";
  data.world = "Synthetic Grove";
  const bible = join(art, "BIBLE.md");
  await writeFile(
    bible,
    serializeBible(data, "## Do's and Don'ts\nDo keep silhouettes readable.\n"),
  );
  await writeFile(
    join(dir, ".assetgrove/prompts/default.md"),
    "---\nversion: 1\n---\nCreate original art.\n{{constitution}}\n{{spec}}\n{{brief}}\n",
  );
  const spec = join(dir, "spec.json");
  await writeFile(
    spec,
    JSON.stringify({
      kind: "still",
      assetId: "icon",
      fields: { description: `a round icon ${term}` },
    }),
  );
  const profile = join(dir, "profile.json");
  await writeFile(profile, JSON.stringify(syntheticProfile()));
  const runOptions = join(dir, "run-options.json");
  await writeFile(runOptions, JSON.stringify({ candidates: 1 }));
  return { bible, spec, profile, runOptions, plan: join(dir, "plan.json") };
}

/** A saved plan made from clean inputs, then its prompts edited to carry `term`, digest recomputed. */
async function editedPlan(dir: string, term: string): Promise<string> {
  const files = await planFiles(dir, "");
  const made = await cli([
    ...["plan", "--spec", files.spec, "--bible", files.bible, "--profile", files.profile],
    ...["--run-options", files.runOptions, "--out", files.plan, "--runs", join(dir, "plan-runs")],
    "--json",
  ]);
  assert.equal(made.code, 0, made.stdout + made.stderr);
  const saved = JSON.parse(await readFile(files.plan, "utf8")) as SavedPlan;
  saved.prompts.images = saved.prompts.images.map((p) => `${p}\n${term}`);
  saved.prompts.generation = `${saved.prompts.generation}\n${term}`;
  saved.digest = planDigest(saved);
  await writeFile(files.plan, JSON.stringify(saved, null, 2));
  return files.plan;
}

/** One argument set per paid command, each carrying `term` in the file its plan step reads. */
async function commandCases(term: string, dir: string): Promise<Array<[string, string[]]>> {
  const stage = await stageFiles(term);
  const id = await identityFiles(await tempDir("assetgrove-policy-id-"), term);
  const lookDev = await lookDevFiles(await tempDir("assetgrove-policy-ld-"), term);
  const strip = await stripFiles(await tempDir("assetgrove-policy-strip-"), term);
  const material = await materialFiles(await tempDir("assetgrove-policy-mat-"), term);
  approveProfile(JSON.parse(await readFile(material.profile, "utf8")), { profileDir: dir });
  const plan = await planFiles(await tempDir("assetgrove-policy-plan-"), term);
  const edited = await editedPlan(await tempDir("assetgrove-policy-apply-"), term);
  const stageArgs = ["--spec", stage.spec, "--bible", stage.bible, "--profile", stage.profile];
  return [
    [
      "plan",
      [
        ...["--spec", plan.spec, "--bible", plan.bible, "--profile", plan.profile],
        ...["--run-options", plan.runOptions, "--out", plan.plan],
      ],
    ],
    ["apply", [edited, "--auto-approve", "--out", join(dir, "runs")]],
    ["stage", stageArgs],
    ["generate-sheet", stageArgs],
    [
      "import",
      [
        "--sheet",
        id.sheet,
        "--profile",
        stage.profile,
        "--asset",
        "fern",
        "--tool",
        "hand",
        "--lock-bible",
        id.bible,
      ],
    ],
    [
      "materials",
      [
        ...["--albedo", material.albedo, "--profile", material.profile, "--spec", material.spec],
        ...["--derivation", material.derivation, "--out", join(dir, "materials-out")],
      ],
    ],
    [
      "look-dev",
      [
        ...["--model", lookDev.model, "--provenance", lookDev.provenance],
        ...["--spec", lookDev.spec, "--bible", lookDev.bible, "--profile", lookDev.profile],
      ],
    ],
    [
      "animation-qa",
      [
        ...["--strip", strip.strip, "--family", "walk-right", "--profile", strip.profile],
        ...["--spec", strip.spec],
      ],
    ],
    [
      "fix-frame",
      [
        ...["--strip", strip.strip, "--family", "walk-right", "--profile", strip.profile],
        ...["--spec", strip.spec, "--frame", "3", "--from", "2", "--out", join(dir, "fixed")],
      ],
    ],
    ["identity-eval", ["--cases", id.cases, "--bible", id.bible]],
    ["identity-check", ["--bible", id.bible]],
  ];
}

test("every paid command refuses a blocklisted prompt with exit 9, before any call or ledger entry", async () => {
  const dir = await tempDir("assetgrove-policy-");
  const watch = await recorder(dir);
  const ledgerBefore = await ledgerContent();
  for (const [name, args] of await commandCases(STYLE, dir)) {
    for (const mode of [[], ["--dry-run"]]) {
      const run = await cli([
        name,
        ...args,
        ...(name === "apply" ? [] : ["--runs", join(dir, "runs")]),
        ...["--provider-script", watch.script, ...mode, "--json"],
      ]);
      assert.equal(run.code, 9, `${name}: ${run.stdout}${run.stderr}`);
      const d = doc(run);
      assert.equal(d.error.code, "prompt_refused", name);
      assert.equal(d.error.policy.match.term, TERM, name);
      assert.equal(d.error.policy.verdict, "refused", name);
    }
  }
  assert.equal(existsSync(join(dir, "runs")), false, "no run directory");
  assert.equal(existsSync(watch.events), false, "no provider call");
  assert.equal(await ledgerContent(), ledgerBefore, "no ledger entry");
});

test("a plan whose prompts were edited to a blocklisted term exits 9 at apply", async () => {
  const dir = await tempDir("assetgrove-policy-edited-");
  const watch = await recorder(dir);
  const plan = await editedPlan(dir, STYLE);
  const ledgerBefore = await ledgerContent();
  const run = await cli([
    ...["apply", plan, "--auto-approve", "--out", join(dir, "runs")],
    ...["--provider-script", watch.script, "--json"],
  ]);
  assert.equal(run.code, 9, run.stdout + run.stderr);
  assert.equal(doc(run).error.code, "prompt_refused");
  assert.equal(doc(run).error.policy.match.term, TERM);
  assert.equal(existsSync(watch.events), false, "no provider call");
  assert.equal(await ledgerContent(), ledgerBefore, "no ledger entry");
});

test("a ProviderSet image call with a blocklisted final prompt is refused with exit 9 and no call", async () => {
  const calls: string[] = [];
  const script = {
    image() {
      calls.push("image");
      return { images: [{ mediaType: "image/png", bytes: encodePng(drawSubject(16)) }] };
    },
    vision() {
      calls.push("vision");
      throw new Error("no call expected");
    },
  };
  const settings = {
    providers: { scripted: { limit: { kind: "prepaid", usd: 100 } } },
    roles: {},
    routes: {},
    path: "settings.json",
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider = ProviderSet.fromSettings(settings as any, { script: script as any });
  const caller = new Caller({ provider, budget: new Budget(5), routes: provider.routes });
  await assert.rejects(
    () => caller.image("edit", `a fox, ${STYLE}`, []),
    (error: unknown) => {
      assert.ok(error instanceof PromptRefusedError);
      assert.equal(error.code, "prompt_refused");
      assert.match(error.message, /the final edit prompt/);
      assert.equal(failureOutcome(error).exitCode, 9);
      return true;
    },
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(caller.records, []);

  const allowing = ProviderSet.fromSettings(settings as never, {
    script: script as never,
    promptAllow: [TERM],
  });
  const again = new Caller({ provider: allowing, budget: new Budget(5), routes: allowing.routes });
  await again.image("edit", `a fox, ${STYLE}`, []);
  assert.deepEqual(calls, ["image"]);
});

test("an allow term clears a hit and is recorded as allowedBy", async () => {
  assert.equal(checkPromptText(STYLE).verdict, "refused");
  const cleared = checkPromptText(STYLE, [`${title(FIRST)}  ${title(LAST)}`]);
  assert.equal(cleared.verdict, "allowed");
  assert.deepEqual(cleared.allowedBy, [`${title(FIRST)}  ${title(LAST)}`]);
  assert.equal(cleared.match, undefined);
  assert.throws(() => enforcePromptPolicy(STYLE), PromptRefusedError);

  const dir = await tempDir("assetgrove-policy-allow-");
  const watch = await recorder(dir);
  const stage = await stageFiles(STYLE);
  writeSettings({ promptPolicy: { allow: [TERM] } });
  const run = await cli([
    ...["stage", "--spec", stage.spec, "--bible", stage.bible, "--profile", stage.profile],
    ...["--runs", join(dir, "runs"), "--provider-script", watch.script, "--dry-run", "--json"],
  ]);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const d = doc(run);
  assert.equal(d.promptPolicy.verdict, "allowed");
  assert.deepEqual(d.promptPolicy.allowedBy, [TERM]);
  assert.match(d.policyTextSha256, /^[0-9a-f]{64}$/);
});

test("case, diacritic, fullwidth, spacing and run-together variants all match", () => {
  const variants = [
    TERM.toUpperCase(),
    `${title(FIRST)} ${title(LAST).replace(/[aeiou]/, (v) => `${v}\u0301`)}`,
    fullwidth(TERM),
    `${FIRST}    ${LAST}`,
    `${FIRST}-${LAST}`,
    `${FIRST}\n${LAST}`,
    `${FIRST}${LAST}`,
    `paint like ${title(FIRST)}_${title(LAST)}, please`,
  ];
  for (const text of variants) {
    const record = checkPromptText(text);
    assert.equal(record.verdict, "refused", text);
    assert.equal(record.match?.term, TERM, text);
  }
  assert.equal(checkPromptText(`a ${FIRST}arious ${LAST}ian fox`).verdict, "allowed");
});

test("policyTextSha256 is in the WorkPlan and changes the digest with the spec text", async () => {
  const dir = await tempDir("assetgrove-policy-digest-");
  const watch = await recorder(dir);
  const plans: Doc[] = [];
  for (const term of ["a quiet pond", "a noisy pond"]) {
    const stage = await stageFiles(term);
    const run = await cli([
      ...["stage", "--spec", stage.spec, "--bible", stage.bible, "--profile", stage.profile],
      ...["--runs", join(dir, "runs"), "--provider-script", watch.script, "--dry-run", "--json"],
    ]);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    plans.push(doc(run));
  }
  const [a, b] = plans as [Doc, Doc];
  assert.match(a.policyTextSha256, /^[0-9a-f]{64}$/);
  assert.equal(a.promptPolicy.textSha256, a.policyTextSha256);
  assert.notEqual(a.policyTextSha256, b.policyTextSha256);
  assert.notEqual(a.digest, b.digest);
});

test("only file names are left out of prompt text: slash- and dot-bearing words are checked", () => {
  const strings = promptStrings({
    description: `${FIRST}/${LAST}`,
    mood: `${FIRST}${LAST}.art`,
    tag: `style:${FIRST}/${LAST}`,
    reference: "refs/fox-turnaround.png",
    model: "models/fox.glb",
  });
  assert.deepEqual(strings, [`${FIRST}/${LAST}`, `${FIRST}${LAST}.art`, `style:${FIRST}/${LAST}`]);
  for (const text of strings) assert.equal(checkPromptText(text).match?.term, TERM, text);
});

test("a sheet brief honours the settings allow terms", () => {
  const brief = { purpose: `a fox ${STYLE}` };
  assert.throws(() => sheetBrief(brief), PromptRefusedError);
  assert.equal(sheetBrief(brief, [TERM]).purpose, brief.purpose);
});

test("stage keeps the plan step's promptPolicy in its run record and each candidate's provenance", async () => {
  const dir = await tempDir("assetgrove-policy-stage-");
  const stage = await stageFiles(STYLE);
  const script = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
  approve(script);
  writeSettings({ promptPolicy: { allow: [TERM] } });
  const run = await cli([
    ...["stage", "--spec", stage.spec, "--bible", stage.bible, "--profile", stage.profile],
    ...["--runs", join(dir, "runs"), "--provider-script", script, "--json"],
  ]);
  writeSettings({});
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const record = JSON.parse(await readFile(join(doc(run).runDir, "run.json"), "utf8")) as Doc;
  assert.equal(record.promptPolicy.verdict, "allowed");
  assert.deepEqual(record.promptPolicy.allowedBy, [TERM]);
  assert.ok(record.candidates.length > 0);
  for (const candidate of record.candidates)
    assert.deepEqual(candidate.provenance.promptPolicy, record.promptPolicy);
});
