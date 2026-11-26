/**
 * Core's audio kinds `sfx`, `ambience` and `music` (#481), staged through the scripted provider's
 * `audio` route from a synthetic stereo tone: the default recipe makes a master every exact check
 * passes, the spec schemas refuse what a kind cannot make, and a profile without `audio.loudness`
 * is refused before any spend unless the developer settings carry it.
 */
import "./fixtures/env.ts";
import { approve, writeSettings } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import { AUDIO_CHECKS, loopFrames } from "../src/audio/checks.ts";
import { decodeAudio } from "../src/audio/engine.ts";
import { audioGenerators } from "../src/audio/kinds.ts";
import { InputError } from "../src/errors.ts";
import { CORE_REGISTRY } from "../src/extensions/registry.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { planStage, stage } from "../src/loop.ts";
import { mediaOf } from "../src/media.ts";
import { planJobs } from "../src/planning.ts";
import { defaultRoutes } from "../src/routes.ts";
import type { AssetSpec } from "../src/types.ts";
import { syntheticBibleMd, syntheticProfile, syntheticWorld } from "./fixtures/synthetic.ts";
import { toneWav } from "./fixtures/wav.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary: string[] = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

const LOUDNESS = { target: -23, tolerance: 1, truePeakCeiling: -1, encoderHeadroom: 1 };
const AUDIO_PROFILE = {
  audio: { loudness: LOUDNESS },
  layout: {
    media: "audio/{{spec.assetId}}.{{output.extension}}",
    manifest: "audio/{{spec.assetId}}.json",
  },
  manifest: {
    assetManifestVersion: 1,
    assetId: "{{spec.assetId}}",
    kind: "{{spec.kind}}",
    source: {
      kind: "generated",
      path: "{{output.path}}",
      mediaType: "{{output.mediaType}}",
      tool: "assetgrove",
    },
    license: "{{profile.license}}",
    review: { status: "pending" },
    contentHash: "{{output.sha256}}",
  },
};

/** A stereo tone of the requested length, as a stand-in for the provider's audio. */
const tone = (durationS: number) => toneWav({ channels: 2, length: Math.round(durationS * 44100) });

const SPECS: Record<string, Record<string, unknown>> = {
  sfx: { kind: "sfx", assetId: "door", brief: "a wooden door creaks open", maxDurationS: 2 },
  ambience: { kind: "ambience", assetId: "wind", brief: "wind in pine trees", loopS: 2 },
  musicLoop: {
    kind: "music",
    assetId: "theme",
    brief: "a calm village theme",
    form: "track",
    loop: { bpm: 240, bars: 2, beatsPerBar: 4 },
    instrumentation: "harp and flute",
    key: "D major",
  },
  track: {
    kind: "music",
    assetId: "credits",
    brief: "warm closing credits",
    form: "track",
    durationS: 1.5,
  },
  cue: {
    kind: "music",
    assetId: "sting",
    brief: "a bright discovery sting",
    form: "cue",
    durationS: 1,
  },
};

function provider(
  requests: Array<Record<string, unknown>> = [],
  lengthS: (requestedS: number) => number = (requestedS) => requestedS,
) {
  return new ScriptedProvider({
    image: () => {
      throw new Error("no image call expected");
    },
    vision: () => {
      throw new Error("no vision call expected");
    },
    audio: (request) => {
      requests.push(request as unknown as Record<string, unknown>);
      return {
        audio: { mediaType: "audio/wav", bytes: tone(lengthS(request.durationS ?? 1)) },
        costUsd: 0.08,
      };
    },
  });
}

async function stageOf(
  spec: Record<string, unknown>,
  requests: Array<Record<string, unknown>> = [],
  lengthS?: (requestedS: number) => number,
) {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const options = {
    spec: spec as unknown as AssetSpec,
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile: syntheticProfile(AUDIO_PROFILE as never),
    routes: defaultRoutes,
    provider: provider(requests, lengthS),
    providerName: "scripted",
    generators: [...CORE_REGISTRY.kinds],
    runsDir: world.runsDir,
    candidates: 1,
  };
  planStage(options);
  const { run, runDir } = await stage(options);
  return { run, runDir };
}

test("core registers sfx, ambience and music as audio kinds with the exact checks", () => {
  assert.deepEqual(
    audioGenerators.map((g) => g.kind),
    ["sfx", "ambience", "music"],
  );
  for (const generator of audioGenerators) {
    assert.equal(generator.media, "audio");
    assert.equal(generator.checks, AUDIO_CHECKS);
    assert.equal(mediaOf(generator.kind, CORE_REGISTRY), "audio");
  }
});

test("a spec a kind cannot make is refused by field before any spend", async () => {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const plan = (spec: Record<string, unknown>) =>
    planStage({
      spec: spec as unknown as AssetSpec,
      profile: syntheticProfile(AUDIO_PROFILE as never),
      routes: defaultRoutes,
      generators: [...CORE_REGISTRY.kinds],
      bible: world.bible,
    });
  const refused = (spec: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(
      () => plan(spec),
      (error: unknown) => error instanceof InputError && pattern.test(error.message),
    );
  refused({ ...SPECS["cue"]!, loop: { bpm: 120, bars: 2, beatsPerBar: 4 } }, /loop/);
  refused({ ...SPECS["sfx"]!, brief: undefined }, /brief/);
  refused({ ...SPECS["sfx"]!, maxDurationS: 31 }, /maxDurationS/);
  refused({ ...SPECS["ambience"]!, loopS: 0 }, /loopS/);
  refused({ ...SPECS["track"]!, durationS: undefined }, /durationS/);
  refused({ ...SPECS["track"]!, form: "jingle" }, /form/);
  assert.equal(plan(SPECS["musicLoop"]!).perCandidate.length, 1);
});

for (const [name, channels] of [
  ["sfx", 1],
  ["ambience", 2],
  ["musicLoop", 2],
  ["track", 2],
  ["cue", 2],
] as const) {
  test(`stage: ${name} is made by the default recipe and passes every exact check`, async () => {
    const spec = SPECS[name]!;
    const requests: Array<Record<string, unknown>> = [];
    const { run, runDir } = await stageOf(spec, requests);
    assert.deepEqual(run.errors, []);
    assert.equal(run.candidates.length, 1);
    const candidate = run.candidates[0]!;

    const failed = candidate.reasons.filter((r) => !r.passed);
    assert.deepEqual(failed, []);
    for (const check of AUDIO_CHECKS)
      assert.ok(
        candidate.reasons.some((r) => r.check === check.name),
        check.name,
      );

    const master = decodeAudio(new Uint8Array(await readFile(join(runDir, candidate.file))));
    assert.equal(master.sampleRate, 44100);
    assert.equal(master.channels.length, channels);
    assert.equal(master.bitDepth, "16");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const audio = candidate.fields["audio"] as Record<string, any>;
    assert.equal(audio["kind"], spec["kind"]);
    assert.equal(audio["sampleRate"], 44100);
    assert.equal(audio["channels"], channels);
    assert.equal(audio["bitDepth"], "16");
    assert.equal(audio["frames"], master.channels[0]!.length);
    assert.equal(audio["durationS"], audio["frames"] / 44100);
    assert.equal(audio["refused"], undefined);
    assert.equal(typeof audio["loudness"].truePeak, "number");
    assert.ok(Math.abs((audio["loudness"].integrated ?? audio["loudness"].momentaryMax) + 23) <= 1);
    assert.equal(audio["requested"].brief, spec["brief"]);
    assert.ok(audio["steps"].length > 0);

    const loop = loopFrames(spec, 44100);
    if (loop === undefined) assert.equal(audio["loop"], undefined);
    else {
      assert.equal(master.channels[0]!.length, loop.frames);
      assert.deepEqual(audio["loop"], { frames: loop.frames, residual: loop.residual });
    }
    if (name === "musicLoop" || name === "track" || name === "cue")
      assert.equal(audio["form"], spec["form"]);

    assert.equal(requests.length, 1);
    assert.match(String(requests[0]!["prompt"]), new RegExp(String(spec["brief"])));
    if (name === "musicLoop") assert.match(String(requests[0]!["prompt"]), /harp and flute/);
    const recipe = (audio["steps"] as Array<{ op: string }>).map((s) => s.op);
    assert.deepEqual(
      recipe,
      {
        sfx: ["mono", "trim-silence", "fade", "gain"],
        ambience: ["loop", "gain"],
        musicLoop: ["loop", "gain"],
        track: ["gain"],
        cue: ["gain"],
      }[name],
    );
  });
}

test("a gain that would pass the true-peak ceiling stops the recipe and the exact checks filter the candidate", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const made: Array<{ fields: Record<string, unknown> } & Record<string, any>> = [];
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const options = {
    spec: SPECS["track"] as unknown as AssetSpec,
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile: syntheticProfile({
      ...AUDIO_PROFILE,
      audio: { loudness: { ...LOUDNESS, target: -3, truePeakCeiling: -10 } },
    } as never),
    routes: defaultRoutes,
    provider: provider(),
    providerName: "scripted",
    generators: CORE_REGISTRY.kinds.map((g) =>
      g.kind === "music"
        ? {
            ...g,
            async generate(context: Parameters<typeof g.generate>[0]) {
              const result = await g.generate(context);
              made.push(result.output);
              return result;
            },
          }
        : g,
    ),
    runsDir: world.runsDir,
    candidates: 1,
  };
  planStage(options);
  const { run } = await stage(options);
  assert.equal(run.candidates.length, 0);
  assert.equal(run.filtered, 1);

  // The refusal is recorded on the candidate, and audio:loudness is the check that fails it.
  const output = made[0]!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const audio = output.fields["audio"] as Record<string, any>;
  assert.match(String(audio["refused"]), /ceiling/);
  assert.ok(!(audio["steps"] as Array<{ op: string }>).some((s) => s.op === "gain"));
  const failed = AUDIO_CHECKS.flatMap(
    (check) =>
      check.run!(
        { spec: options.spec, profile: options.profile, bible: {}, output } as never,
        undefined as never,
      ) as Array<{ check: string; passed: boolean; reason: string }>,
  ).filter((r) => !r.passed);
  const loudness = failed.find((r) => r.check === "audio:loudness");
  assert.match(String(loudness?.reason), /recipe stopped before the loudness was set: .*ceiling/);
});

test("an sfx under the 400 ms momentary window skips gain and passes on true peak", async () => {
  const { run } = await stageOf(SPECS["sfx"]!, [], () => 0.2);
  assert.deepEqual(run.errors, []);
  assert.equal(run.candidates.length, 1);
  const candidate = run.candidates[0]!;
  assert.deepEqual(
    candidate.reasons.filter((r) => !r.passed),
    [],
  );
  assert.match(
    candidate.reasons.find((r) => r.check === "audio:loudness")!.reason,
    /under the 400 ms momentary window, so true peak alone decides/,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const audio = candidate.fields["audio"] as Record<string, any>;
  assert.equal(audio["refused"], undefined);
  assert.deepEqual(
    (audio["steps"] as Array<{ op: string }>).map((s) => s.op),
    ["mono", "trim-silence", "fade"],
  );
});

/** A provider script for the CLI: a stereo tone as long as the request. */
const script = (() => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-audio-kinds-")));
  temporary.push(dir);
  const path = join(dir, "audio-script.ts");
  writeFileSync(
    path,
    `import { toneWav } from ${JSON.stringify(pathToFileURL(join(root, "test/fixtures/wav.ts")).href)};
export default {
  image() { throw new Error("no image call expected"); },
  vision() { throw new Error("no vision call expected"); },
  audio(request) {
    const length = Math.round((request.durationS ?? 1) * 44100);
    return { audio: { mediaType: "audio/wav", bytes: toneWav({ channels: 2, length }) }, costUsd: 0.08 };
  },
};
`,
  );
  approve(path);
  return path;
})();

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env["AI_GATEWAY_API_KEY"];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

async function files(spec: Record<string, unknown>) {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const bible = await syntheticBibleMd(world);
  const specPath = join(world.dir, "spec.json");
  const profilePath = join(world.dir, "profile.json");
  await writeFile(specPath, JSON.stringify(spec));
  // No audio.loudness: the profile as a game that never answered the question has it.
  await writeFile(
    profilePath,
    JSON.stringify({
      ...syntheticProfile({
        layout: AUDIO_PROFILE.layout,
        manifest: AUDIO_PROFILE.manifest,
      } as never),
    }),
  );
  return {
    world,
    base: ["--spec", specPath, "--bible", bible, "--profile", profilePath],
    runs: join(world.dir, "runs"),
  };
}

test("a profile without audio.loudness is refused at stage and plan, naming the block", async () => {
  const w = await files(SPECS["sfx"]!);
  const dry = await cli(["stage", ...w.base, "--dry-run", "--json"]);
  assert.equal(dry.code, 2, dry.stdout + dry.stderr);
  assert.equal(JSON.parse(dry.stdout)["error"].code, "invalid_input");
  assert.match(JSON.parse(dry.stdout)["error"].message, /audio\.loudness/);

  // Plan makes images, so it refuses an audio kind; on a profile without the block it names the block.
  const dir = join(w.world.dir, ".assetgrove/art-direction");
  await mkdir(dir, { recursive: true });
  await mkdir(join(w.world.dir, ".assetgrove/prompts"), { recursive: true });
  const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  data.referenceLicense = "NOASSERTION";
  data.world = "Woodland";
  await writeFile(
    join(dir, "BIBLE.md"),
    serializeBible(
      data,
      "# Rationale\n\n## Do's and Don'ts\nDo keep silhouettes readable. Don't add text.\n",
    ),
  );
  await writeFile(
    join(w.world.dir, ".assetgrove/prompts/default.md"),
    "# Prompt template v1\n{{spec}}\n",
  );
  await assert.rejects(
    planJobs({
      biblePath: join(dir, "BIBLE.md"),
      specPath: w.base[1]!,
      profilePath: w.base[5]!,
    }),
    /audio\.loudness/,
  );
  // With the developer settings' block, plan gets past the block to its real refusal.
  await assert.rejects(
    planJobs({
      biblePath: join(dir, "BIBLE.md"),
      specPath: w.base[1]!,
      profilePath: w.base[5]!,
      audioLoudness: LOUDNESS,
    }),
    (error: Error) =>
      /stage it instead/.test(error.message) && !/audio\.loudness/.test(error.message),
  );
});

test("developer settings carrying audio.loudness stage an audio kind on that profile", async () => {
  writeSettings({ audio: { loudness: LOUDNESS } });
  const w = await files(SPECS["ambience"]!);
  const dry = await cli(["stage", ...w.base, "--dry-run", "--json"]);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  assert.deepEqual(
    JSON.parse(dry.stdout)["plan"].perCandidate.map((c: { operation: string }) => c.operation),
    ["audio"],
  );
  // The settings' block is in the request digest: another loudness is another request.
  const workOf = (stdout: string) => JSON.parse(stdout)["work"] ?? JSON.parse(stdout);
  writeSettings({ audio: { loudness: { ...LOUDNESS, target: -16 } } });
  const other = await cli(["stage", ...w.base, "--dry-run", "--json"]);
  assert.equal(other.code, 0, other.stdout + other.stderr);
  assert.notEqual(workOf(other.stdout)["digest"], undefined);
  assert.notEqual(workOf(other.stdout)["digest"], workOf(dry.stdout)["digest"]);
  writeSettings({ audio: { loudness: LOUDNESS } });

  const run = await cli([
    "stage",
    ...w.base,
    "--runs",
    w.runs,
    "--provider-script",
    script,
    "--candidates",
    "1",
    "--json",
  ]);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const staged = JSON.parse(run.stdout);
  assert.equal(staged.candidates.length, 1);
  assert.ok(staged.candidates[0].reasons.every((r: { passed: boolean }) => r.passed));
});
