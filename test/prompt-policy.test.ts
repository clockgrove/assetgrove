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
import { checkPromptText, enforcePromptPolicy, PromptRefusedError } from "../src/policy/text.ts";
import { ProviderSet } from "../src/providers/set.ts";
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
const TERM = "greg rutkowski";
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

/** One argument set per paid command, each carrying `term` in the file its plan step reads. */
async function commandCases(term: string, dir: string): Promise<Array<[string, string[]]>> {
  const stage = await stageFiles(term);
  const id = await identityFiles(await tempDir("assetgrove-policy-id-"), term);
  const lookDev = await lookDevFiles(await tempDir("assetgrove-policy-ld-"), term);
  const strip = await stripFiles(await tempDir("assetgrove-policy-strip-"), term);
  const material = await materialFiles(await tempDir("assetgrove-policy-mat-"), term);
  approveProfile(JSON.parse(await readFile(material.profile, "utf8")), { profileDir: dir });
  const stageArgs = ["--spec", stage.spec, "--bible", stage.bible, "--profile", stage.profile];
  return [
    // TODO(lead): the plan and apply rows go here.
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
        ...["--runs", join(dir, "runs")],
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
  const cleared = checkPromptText(STYLE, ["Greg  Rutkowski"]);
  assert.equal(cleared.verdict, "allowed");
  assert.deepEqual(cleared.allowedBy, ["Greg  Rutkowski"]);
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
    "GREG RUTKOWSKI",
    "Grég Rutkowski",
    "ｇｒｅｇ ｒｕｔｋｏｗｓｋｉ",
    "greg    rutkowski",
    "greg-rutkowski",
    "greg\nrutkowski",
    "gregrutkowski",
    "paint like Greg_Rutkowski, please",
  ];
  for (const text of variants) {
    const record = checkPromptText(text);
    assert.equal(record.verdict, "refused", text);
    assert.equal(record.match?.term, TERM, text);
  }
  assert.equal(checkPromptText("a gregarious rutkowskian fox").verdict, "allowed");
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
