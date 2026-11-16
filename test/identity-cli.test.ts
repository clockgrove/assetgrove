import "./fixtures/env.ts";
import { approve, approveProfile } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/identity-script.ts", import.meta.url));
approve(SCRIPT);
const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "identity-cli-"));
  roots.push(root);
  const art = join(root, "art");
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
  await writeFile(
    join(art, "identity-thresholds.json"),
    JSON.stringify({
      format: "assetgrove-identity-thresholds/1",
      entries: [
        {
          question: "score",
          model: "perplexity/pplx-decider-v1.2",
          threshold: 0.68,
          recordedAt: "2026-01-01T00:00:00.000Z",
          eval: {
            casesFile: "cases.json",
            casesSha256: "0".repeat(64),
            cases: 4,
            scored: 4,
            falseAcceptRate: 0,
            falseRejectRate: 0,
            barMet: true,
          },
        },
      ],
    }),
  );
  await writeFile(join(root, "sheet.png"), syntheticSheet().png);
  await writeFile(join(root, "profile.json"), JSON.stringify(syntheticProfile()));
  return { root, bible };
}

const env = (scores: string, vision = '{"consistent": true, "conflicts": []}') => ({
  ...process.env,
  AI_GATEWAY_API_KEY: "",
  IDENTITY_TEST_SCORES: scores,
  IDENTITY_TEST_VISION: vision,
});

function importArgs(root: string, asset: string, extra: string[]) {
  return [
    CLI,
    "import",
    "--sheet",
    join(root, "sheet.png"),
    "--profile",
    join(root, "profile.json"),
    "--asset",
    asset,
    "--tool",
    "hand drawn",
    "--no-propose",
    "--imports",
    join(root, "imports"),
    "--provider-script",
    SCRIPT,
    "--json",
    ...extra,
  ];
}

test("import scores a locked character's sheet; enforce mode makes write-families refuse it with the reason", async () => {
  const f = await fixture();
  const imported = await exec(
    process.execPath,
    importArgs(f.root, "bram", ["--lock-bible", f.bible, "--identity-mode", "enforce"]),
    { env: env("1") },
  );
  const out = JSON.parse(imported.stdout);
  assert.equal(out.identity.lockVersion, "bram-3");
  assert.equal(out.identity.score, 0.25);
  assert.equal(out.identity.filtered, true);
  // Every decision call logs its label, confidence, latency and cost on stderr.
  assert.match(
    imported.stderr,
    /identity perplexity\/pplx-decider-v1\.2: .*confidence 0\.62, \d+ ms, \$0\.000030/,
  );
  const grouping = join(f.root, "grouping.json");
  await writeFile(grouping, JSON.stringify({ status: "confirmed", families: [], unassigned: [] }));
  const target = join(f.root, "target");
  await mkdir(target);
  approveProfile(syntheticProfile(), { targetDir: target });
  await assert.rejects(
    exec(
      process.execPath,
      [
        CLI,
        "write-families",
        "--import",
        out.importDir,
        "--target",
        target,
        "--grouping",
        grouping,
      ],
      { env: env("1") },
    ),
    /identity lock filtered this sheet: identity 0\.25 < threshold 0\.68 against "bram" lock bram-3/,
  );
});

test("import in the default shadow mode records the score and filters nothing; unlocked characters are unaffected", async () => {
  const f = await fixture();
  const shadow = JSON.parse(
    (
      await exec(process.execPath, importArgs(f.root, "bram", ["--lock-bible", f.bible]), {
        env: env("1"),
      })
    ).stdout,
  );
  assert.equal(shadow.identity.mode, "shadow");
  assert.equal(shadow.identity.filtered, false);
  assert.match(shadow.identity.reason, /shadow mode, not filtered/);
  const unlocked = JSON.parse(
    (
      await exec(process.execPath, importArgs(f.root, "badger", ["--lock-bible", f.bible]), {
        env: env("1"),
      })
    ).stdout,
  );
  assert.equal(unlocked.identity, undefined);
  assert.deepEqual(unlocked.calls, []);
  await assert.rejects(
    exec(process.execPath, importArgs(f.root, "bram", ["--identity-mode", "enforce"]), {
      env: env("1"),
    }),
    /--identity-mode needs --lock-bible/,
  );
});

test("identity-eval reports accuracy per threshold, the recommendation and agreement with QA", async () => {
  const f = await fixture();
  const cases = [
    { image: "sheet.png", subject: "bram", same: true, qa: true },
    { image: "sheet.png", subject: "bram", same: true, qa: true },
    { image: "sheet.png", subject: "bram", same: false, qa: true },
    { image: "sheet.png", subject: "bram", same: false, qa: false },
  ];
  await writeFile(join(f.root, "cases.json"), JSON.stringify(cases));
  const log = join(f.root, "eval.jsonl");
  const result = await exec(
    process.execPath,
    [
      CLI,
      "identity-eval",
      "--bible",
      f.bible,
      "--cases",
      join(f.root, "cases.json"),
      "--log",
      log,
      "--record",
      "--provider-script",
      SCRIPT,
      "--json",
    ],
    { env: env("4,3,1,0") },
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  const recorded = JSON.parse(
    await readFile(join(f.bible, "..", "identity-thresholds.json"), "utf8"),
  );
  assert.equal(recorded.format, "assetgrove-identity-thresholds/1");
  assert.equal(recorded.entries.length, 1);
  assert.equal(recorded.entries[0].question, "score");
  assert.equal(recorded.entries[0].model, report.model);
  assert.equal(recorded.entries[0].threshold, report.recommended.threshold);
  assert.equal(recorded.entries[0].eval.casesFile, join("..", "cases.json"));
  assert.equal(recorded.entries[0].eval.scored, 4);
  assert.equal(recorded.entries[0].eval.barMet, true);
  assert.equal(report.scored, 4);
  assert.equal(report.recommended.accuracy, 1);
  assert.equal(report.qaAgreement.rate, 0.75);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 4);
});

test("identity-eval --record refuses before any call without --bible or with a case of another bible, and never records a cut that fails the bar", async () => {
  const f = await fixture();
  const thresholds = join(f.bible, "..", "identity-thresholds.json");
  const before = await readFile(thresholds, "utf8");
  const output = (e: unknown) => {
    const { stdout = "", stderr = "" } = e as { stdout?: string; stderr?: string };
    return stdout + stderr;
  };
  const evalArgs = (casesFile: string, log: string, bible = true) => [
    CLI,
    "identity-eval",
    ...(bible ? ["--bible", f.bible] : []),
    "--cases",
    casesFile,
    "--log",
    log,
    "--record",
    "--provider-script",
    SCRIPT,
    "--json",
  ];
  const same = [
    { image: "sheet.png", subject: "bram", same: true, bible: "art/BIBLE.md" },
    { image: "sheet.png", subject: "bram", same: false, bible: "art/BIBLE.md" },
  ];
  await writeFile(join(f.root, "named.json"), JSON.stringify(same));
  const noBible = join(f.root, "no-bible.jsonl");
  await assert.rejects(
    exec(process.execPath, evalArgs(join(f.root, "named.json"), noBible, false), {
      env: env("4,0"),
    }),
    (e: unknown) => /--record needs --bible/.test(output(e)),
  );
  await assert.rejects(readFile(noBible, "utf8"), "no case was scored");

  const other = join(f.root, "other");
  await mkdir(other, { recursive: true });
  await writeFile(join(other, "BIBLE.md"), await readFile(f.bible, "utf8"));
  await writeFile(
    join(other, "bram-turnaround.png"),
    await readFile(join(f.root, "art", "bram-turnaround.png")),
  );
  await writeFile(
    join(f.root, "mixed.json"),
    JSON.stringify([same[0], { ...same[1], bible: "other/BIBLE.md" }]),
  );
  const mixed = join(f.root, "mixed.jsonl");
  await assert.rejects(
    exec(process.execPath, evalArgs(join(f.root, "mixed.json"), mixed), { env: env("4,0") }),
    (e: unknown) => /cases name other bibles/.test(output(e)),
  );
  await assert.rejects(readFile(mixed, "utf8"), "no case was scored");

  // The model cannot separate the cases: the only cut within the false-accept bar rejects
  // everything, so the bar (false rejects too) fails and nothing is recorded.
  await writeFile(
    join(f.root, "cases.json"),
    JSON.stringify([
      { image: "sheet.png", subject: "bram", same: true },
      { image: "sheet.png", subject: "bram", same: true },
      { image: "sheet.png", subject: "bram", same: false },
      { image: "sheet.png", subject: "bram", same: false },
    ]),
  );
  await assert.rejects(
    exec(process.execPath, evalArgs(join(f.root, "cases.json"), join(f.root, "eval.jsonl")), {
      env: env("2,2,2,2"),
    }),
    (e: unknown) => /enforce bar is not met/.test(output(e)),
  );
  assert.equal(await readFile(thresholds, "utf8"), before);
});

test("plan --identity-mode enforce, then apply: a strip below the threshold is filtered and the person sees why", async () => {
  const f = await fixture();
  const fixtureModule = fileURLToPath(new URL("./fixtures/synthetic.ts", import.meta.url));
  const rasterModule = fileURLToPath(new URL("../src/image/raster.ts", import.meta.url));
  const script = join(f.root, "provider.mjs");
  await writeFile(
    script,
    `import { pathToFileURL } from "node:url";
const { drawSubject } = await import(pathToFileURL(${JSON.stringify(fixtureModule)}));
const { encodePng } = await import(pathToFileURL(${JSON.stringify(rasterModule)}));
export default {
  image: () => ({ images: [{ mediaType: "image/png", bytes: encodePng(drawSubject(96)) }] }),
  vision: (request) => {
    if (request.prompt.includes('"violations":[]')) throw new Error("no compiler offline");
    if (request.prompt.includes("For each written claim")) return { text: '{"consistent": true, "conflicts": []}' };
    return { text: JSON.stringify({ styleScore: 1, passed: true, reason: "constitution matches" }) };
  },
  decide: (_request, index) => ({ answer: { type: "score", score: [1, 4][index] }, confidence: 0.7 }),
};
`,
  );
  approve(script);
  await writeFile(join(f.root, "key.png"), encodePng(createRaster(16, 16)));
  const spec = join(f.root, "spec.json");
  await writeFile(
    spec,
    JSON.stringify({
      kind: "sprite-strip",
      assetId: "bram-idle",
      subject: "bram",
      animationFamily: "idle",
      keyPose: "key.png",
      frames: { count: 2, width: 16, height: 16 },
    }),
  );
  const template = join(f.root, "template.md");
  await writeFile(template, "# Prompt template v1\n{{constitution}}\n{{spec}}\n");
  const runOptions = join(f.root, "run-options.json");
  await writeFile(runOptions, JSON.stringify({ candidates: 2, strictness: 0.5 }));
  const plan = join(f.root, "plan.json");
  const planned = await exec(
    process.execPath,
    [
      CLI,
      "plan",
      "--spec",
      spec,
      "--bible",
      f.bible,
      "--profile",
      join(f.root, "profile.json"),
      "--run-options",
      runOptions,
      "--template",
      template,
      "--out",
      plan,
      "--identity-mode",
      "enforce",
      "--provider-script",
      script,
      "--json",
    ],
    { env: env("") },
  );
  const { plan: saved } = JSON.parse(planned.stdout);
  // Enforce mode: the plan's operations name the scoring and the record check; apply resolves
  // their routes from the settings again.
  assert.deepEqual(saved.operations.slice(-2), ["identity", "identity-check"]);
  const applied = await exec(
    process.execPath,
    [CLI, "apply", plan, "--out", join(f.root, "runs"), "--provider-script", script],
    { env: env("") },
  );
  assert.match(
    applied.stdout,
    /candidate 1 filtered: identity-lock: identity 0\.25 < threshold 0\.68 against "bram" lock bram-3/,
  );
  assert.match(applied.stdout, /identity-lock \[decision\]: identity 1\.00 >= threshold 0\.68/);
  assert.match(
    applied.stdout,
    /identity enforce against "bram" lock bram-3 \(threshold 0\.68\): 2 scored, agrees with QA on 1 of 2/,
  );
  assert.match(applied.stderr, /identity perplexity\/pplx-decider-v1\.2: .*confidence 0\.70/);
});

test("identity-check exits 0 when every record agrees with its references and 1 when one does not", async () => {
  const f = await fixture();
  const args = [CLI, "identity-check", "--bible", f.bible, "--provider-script", SCRIPT, "--json"];
  const ok = await exec(process.execPath, args, { env: env("") });
  const agreed = JSON.parse(ok.stdout);
  assert.equal(agreed.ok, true);
  assert.equal(agreed.checks[0].subject, "bram");
  assert.match(agreed.checks[0].reason, /record "bram" lock bram-3 agrees with its references/);

  const conflicted =
    '{"consistent": false, "conflicts": [{"field": "proportions", "text": "round body", "observed": "long and thin"}]}';
  const bad = await exec(process.execPath, [...args, "--subject", "bram"], {
    env: env("", conflicted),
  }).then(
    () => assert.fail("expected exit 1"),
    (error: { code: number; stdout: string }) => error,
  );
  assert.equal(bad.code, 1);
  assert.match(
    JSON.parse(bad.stdout).checks[0].reason,
    /disagrees with its references: proportions "round body" vs "long and thin"/,
  );

  // An answer that cannot be read leaves the record unchecked, which is not trusted either.
  // The scripted answer changed but the request did not: a new round makes a new run.
  const garbled = await exec(process.execPath, [...args, "--round", "2"], {
    env: env("", "no json"),
  }).then(
    () => assert.fail("expected exit 1"),
    (error: { code: number; stdout: string }) => error,
  );
  assert.equal(garbled.code, 1);
  assert.equal(JSON.parse(garbled.stdout).checks[0].checked, false);

  const unknown = await exec(process.execPath, [...args, "--subject", "nobody"], {
    env: env(""),
  }).then(
    () => assert.fail("expected a refusal"),
    (error: { code: number }) => error,
  );
  assert.equal(unknown.code, 2);
});

test("identity-eval prints the per-medium breakdown, the bar and the record checks", async () => {
  const f = await fixture();
  for (const name of ["a", "b"]) await writeFile(join(f.root, `${name}.png`), syntheticSheet().png);
  await writeFile(
    join(f.root, "cases.json"),
    JSON.stringify([
      { image: "a.png", subject: "bram", same: true, bible: "art/BIBLE.md" },
      {
        image: "b.png",
        subject: "bram",
        same: false,
        kind: "drift",
        bible: "art/BIBLE.md",
        medium: "3d",
      },
    ]),
  );
  const result = await exec(
    process.execPath,
    [CLI, "identity-eval", "--cases", join(f.root, "cases.json"), "--provider-script", SCRIPT],
    { env: env("4,0") },
  );
  assert.match(result.stdout, /^2D at threshold 0\.68:$/m);
  assert.match(
    result.stdout,
    /^3D \(provisional, no threshold rests on it\) at threshold 0\.68:$/m,
  );
  assert.match(result.stdout, /kind same: 1 cases, false accepts 0%, false rejects 0%/);
  assert.match(result.stdout, /cast Synthetic: /);
  // One positive and no 2D negative: the 2D groups cannot be measured, so the bar is not met.
  assert.match(
    result.stdout,
    /enforce bar \(provisional\): not met: overall: not measured \(no negatives\); cast Synthetic: not measured \(no negatives\)/,
  );
  assert.match(result.stdout, /enforce bar: not judged on provisional 3D/);
  assert.match(result.stdout, /record check: record "bram" lock bram-3 agrees/);
});

test("identity-eval recommends only a cut within the false-accept bar in every kind and cast", async () => {
  const f = await fixture();
  // 20 generic negatives score 0 and one look-alike scores 0.75: a cut near 0.4 has a 4.8%
  // overall false-accept rate but accepts every look-alike, so it is not within the bar.
  const cases = [
    { image: "sheet.png", subject: "bram", same: true },
    { image: "sheet.png", subject: "bram", same: true },
    { image: "sheet.png", subject: "bram", same: false, kind: "lookalike" },
    ...Array.from({ length: 20 }, () => ({ image: "sheet.png", subject: "bram", same: false })),
  ];
  await writeFile(join(f.root, "cases.json"), JSON.stringify(cases));
  const result = await exec(
    process.execPath,
    [
      CLI,
      "identity-eval",
      "--bible",
      f.bible,
      "--cases",
      join(f.root, "cases.json"),
      "--provider-script",
      SCRIPT,
    ],
    { env: env(["4", "4", "3", ...Array.from({ length: 20 }, () => "0")].join(",")) },
  );
  assert.match(result.stdout, /^recommended threshold 0\.875 /m);
  // At a cut below the look-alike's score (the configured 0.68 here) the bar report fails it.
  assert.match(result.stdout, /not met: kind lookalike: false accepts 100% > 5%/);
});

test("identity-eval prints that none meets the bar when a different character scores the top level", async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, "cases.json"),
    JSON.stringify([
      { image: "sheet.png", subject: "bram", same: true },
      { image: "sheet.png", subject: "bram", same: false },
    ]),
  );
  const result = await exec(
    process.execPath,
    [
      CLI,
      "identity-eval",
      "--bible",
      f.bible,
      "--cases",
      join(f.root, "cases.json"),
      "--provider-script",
      SCRIPT,
    ],
    { env: env("4,4") },
  );
  assert.match(
    result.stdout,
    /no threshold recommended: none meets the bar \(false-accept rate within the enforce bar\)/,
  );
});
