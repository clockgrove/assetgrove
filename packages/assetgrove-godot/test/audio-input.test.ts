/**
 * What `godot:audio` hands Godot and reads back, without Godot: the WAV delivery with no run and
 * no `.import`, the Ogg rendition and the `.import` Godot writes for it only when the target has
 * none, the check against an existing `.import` and the WAV's `smpl` loop, and the variant set's
 * AudioStreamRandomizer reaching scratch with its UID and dependencies. The scripted run answers as
 * the build script does; the real Godot runs are someone else's tests.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PresetContext,
  PresetFile,
  TargetRead,
  ToolResult,
  ToolRunOptions,
} from "@clockgrove/assetgrove/extension";
import { extensionContext, sampleProfile } from "@clockgrove/assetgrove/testing";
import { audioPreset, type AudioOptions } from "../src/audio.ts";
import { importParams } from "../src/godot-text.ts";
import { INPUT_PATH, RESULT_PATH, type AudioInput } from "../src/scratch.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | string) =>
  typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);

/** A stand-in for core's audio helpers: the WAV's loop is what the test says its smpl chunk holds. */
const smpl: { loop?: { start: number; end: number } } = {};
const oggCalls: Array<{ master: Uint8Array; quality?: number }> = [];
const audio = {
  wavLoop: () => smpl.loop,
  oggRendition: async (master: Uint8Array, options?: { quality?: number }) => {
    oggCalls.push({ master, ...(options?.quality !== undefined && { quality: options.quality }) });
    return { bytes: encode("OggS"), build: {}, digest: "0".repeat(64) };
  },
};
// Not a spread: the context's `settings` getter throws before the entry has returned.
const preset = audioPreset(
  Object.create(extensionContext("godot"), {
    audio: { value: audio },
  }) as ReturnType<typeof extensionContext>,
);
const write = preset.write as (
  ctx: PresetContext,
  options: AudioOptions,
  read: TargetRead,
) => Promise<PresetFile[]>;
const check = preset.check as (
  ctx: PresetContext,
  options: AudioOptions,
  files: PresetFile[],
  read: TargetRead,
) => Promise<string[]>;
const parse = (raw: object = {}) => preset.optionsSchema.parse(raw);

const UID = "uid://b5wyq2abcdxy0";
const STREAM_UID = "uid://cq2425ngttrok";
const importFile = (uid: string, params = "") =>
  `[remap]\n\nimporter="oggvorbisstr"\nuid="${uid}"\n\n[params]\n\n${params}`;

/** A run that records its scratch files and answers as the build script does. */
function scripted(seen: ToolRunOptions[]) {
  return async (tool: string, options: ToolRunOptions): Promise<ToolResult> => {
    seen.push(options);
    const input = JSON.parse(String(options.files?.[INPUT_PATH])) as AudioInput;
    const files = [
      { path: RESULT_PATH, content: encode(JSON.stringify({ ok: true, errors: [] })) },
    ];
    if (input.fresh.length > 0)
      files.push({
        path: `${input.stream.slice("res://".length)}.import`,
        content: encode(importFile(STREAM_UID, "loop=true\n")),
      });
    if (input.randomizer !== undefined)
      files.push({
        path: input.randomizer.resource.slice("res://".length),
        content: encode(
          `[gd_resource type="AudioStreamRandomizer" format=3 uid="${input.randomizer.uid ?? UID}"]\n`,
        ),
      });
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      files,
      step: { kind: "tool", tool, hash: "0".repeat(64), method: "settings" },
    };
  };
}

interface Sample {
  spec?: object;
  output?: object;
  audioFields?: object;
  mediaType?: string;
  path?: string;
}

const context = (sample: Sample, run: PresetContext["run"]): PresetContext => ({
  profile: sampleProfile(),
  context: {
    spec: { kind: "sfx", assetId: "rain", ...sample.spec },
    output: {
      path: sample.path ?? "game/audio/rain.wav",
      mediaType: sample.mediaType ?? "audio/wav",
      audio: { kind: "sfx", sampleRate: 44100, channels: 2, frames: 88200, ...sample.audioFields },
      ...sample.output,
    },
    provenance: {},
  },
  manifestRel: "manifest.json",
  mediaBytes: encode("RIFF"),
  ...(run !== undefined && { run }),
});

const looped = {
  spec: { kind: "music", assetId: "rain", loop: { bpm: 120, bars: 2, beatsPerBar: 4 } },
  audioFields: { loop: { frames: 88200, residual: 0 } },
};
const nothing: TargetRead = async () => undefined;
const targetOf =
  (files: Record<string, string>): TargetRead =>
  async (path) =>
    files[path] === undefined ? undefined : encode(files[path]);
const paths = (files: PresetFile[]) => files.map((f) => f.path);

test("a WAV hand-off returns no file and runs no tool, and no .import is ever returned", async () => {
  const seen: ToolRunOptions[] = [];
  const files = await write(context(looped, scripted(seen)), parse({ project: "game" }), nothing);
  assert.deepEqual(files, []);
  assert.equal(seen.length, 0);
});

test("a hand-off whose media is not a WAV is refused as invalid input", async () => {
  await assert.rejects(
    write(context({ mediaType: "image/png", path: "game/rain.png" }, undefined), parse(), nothing),
    {
      code: "invalid_input",
      message:
        "the preset godot:audio hands off a WAV (.wav, audio/wav), not game/rain.png (image/png)",
    },
  );
});

test("an Ogg hand-off returns the rendition and Godot's .import, with the loop and tempo as import options", async () => {
  const seen: ToolRunOptions[] = [];
  oggCalls.length = 0;
  const options = parse({
    project: "game",
    format: "ogg",
    quality: 7,
    import: { "x/y": 1, loop: false },
  });
  const files = await write(context(looped, scripted(seen)), options, nothing);
  assert.deepEqual(paths(files), ["game/audio/rain.ogg", "game/audio/rain.ogg.import"]);
  assert.equal(decode(files[0]!.content), "OggS");
  assert.equal(decode(files[1]!.content), importFile(STREAM_UID, "loop=true\n"));
  assert.deepEqual(oggCalls, [{ master: encode("RIFF"), quality: 7 }]);
  const scratch = seen[0]!.files!;
  assert.equal(decode(scratch["audio/rain.ogg"]!), "OggS");
  const input = JSON.parse(String(scratch[INPUT_PATH])) as AudioInput;
  assert.deepEqual(input, {
    build: "audio",
    godot: "4.7.2-stable",
    stream: "res://audio/rain.ogg",
    format: "ogg",
    fresh: ["res://audio/rain.ogg"],
    options: { "x/y": 1, loop: true, loop_offset: 0, bpm: 120, beat_count: 8, bar_beats: 4 },
    expected: {
      loop: { begin: 0, end: 88200 },
      tempo: { bpm: 120, beatCount: 8, barBeats: 4 },
    },
    imports: ["res://audio/rain.ogg"],
  });
});

test("a one-shot Ogg is imported with loop=false and the ogg option places it", async () => {
  const seen: ToolRunOptions[] = [];
  const options = parse({ project: "game", format: "ogg", ogg: "game/sfx/{assetId}.ogg" });
  const files = await write(context({}, scripted(seen)), options, nothing);
  assert.deepEqual(paths(files), ["game/sfx/rain.ogg", "game/sfx/rain.ogg.import"]);
  const input = JSON.parse(String(seen[0]!.files![INPUT_PATH])) as AudioInput;
  assert.deepEqual(input.options, { loop: false });
  assert.deepEqual(input.expected, {});
});

test("an Ogg the target has an .import for is returned alone, its .import never returned and no tool run", async () => {
  const seen: ToolRunOptions[] = [];
  const read = targetOf({ "game/audio/rain.ogg.import": importFile(STREAM_UID) });
  const files = await write(
    context(looped, scripted(seen)),
    parse({ project: "game", format: "ogg" }),
    read,
  );
  assert.deepEqual(paths(files), ["game/audio/rain.ogg"]);
  assert.equal(seen.length, 0);
});

test("a master WAV outside the project is handed off as an Ogg inside it, and refused as a WAV", async () => {
  const seen: ToolRunOptions[] = [];
  const outside = { ...looped, path: "masters/rain.wav" };
  const options = parse({ project: "game", format: "ogg", ogg: "game/audio/{assetId}.ogg" });
  const files = await write(context(outside, scripted(seen)), options, nothing);
  assert.deepEqual(paths(files), ["game/audio/rain.ogg", "game/audio/rain.ogg.import"]);
  const read = targetOf({
    "masters/rain.wav": "RIFF",
    "game/audio/rain.ogg": "OggS",
    "game/audio/rain.ogg.import": importFile(
      STREAM_UID,
      "loop=true\nloop_offset=0\nbpm=120\nbeat_count=8\nbar_beats=4\n",
    ),
  });
  smpl.loop = { start: 0, end: 88200 };
  assert.deepEqual(await check(context(outside, undefined), options, files, read), []);
  delete smpl.loop;
  await assert.rejects(write(context(outside, scripted([])), parse({ project: "game" }), nothing), {
    code: "invalid_input",
    message: /the audio masters\/rain\.wav is outside the Godot project game\//,
  });
});

test("the options are refused when they name an Ogg or a randomizer outside the project or not of the right type", async () => {
  const run = scripted([]);
  await assert.rejects(
    write(
      context({}, run),
      parse({ project: "game", format: "ogg", ogg: "other/rain.ogg" }),
      nothing,
    ),
    {
      code: "invalid_input",
      message: /the Ogg other\/rain\.ogg is outside the Godot project game\//,
    },
  );
  await assert.rejects(
    write(
      context({}, run),
      parse({ project: "game", format: "ogg", ogg: "game/rain.mp3" }),
      nothing,
    ),
    { code: "invalid_input", message: 'options.ogg "game/rain.mp3" must end in .ogg' },
  );
  const member = { spec: { kind: "sfx", assetId: "step-01", subject: "step", variant: 1 } };
  await assert.rejects(
    write(
      context(member, run),
      parse({ project: "game", randomizer: "game/{subject}.res" }),
      nothing,
    ),
    { code: "invalid_input", message: 'options.randomizer "game/step.res" must end in .tres' },
  );
  await assert.rejects(
    write(
      context(member, run),
      parse({ project: "game", randomizer: "../{subject}.tres" }),
      nothing,
    ),
    { code: "invalid_input" },
  );
  assert.throws(() => parse({ quality: 11 }));
  assert.throws(() => parse({ format: "mp3" }));
});

const member = (variant: number) => ({
  spec: { kind: "sfx", assetId: `step-0${variant}`, subject: "step", variant },
  path: `game/audio/step-0${variant}.wav`,
});

test("a variant-set member builds the randomizer of its subject, new, in scratch with the WAV", async () => {
  const seen: ToolRunOptions[] = [];
  const files = await write(
    context(member(1), scripted(seen)),
    parse({ project: "game", randomizer: "game/{subject}.tres" }),
    nothing,
  );
  assert.deepEqual(paths(files), ["game/step.tres"]);
  assert.equal(
    decode(files[0]!.content),
    `[gd_resource type="AudioStreamRandomizer" format=3 uid="${UID}"]\n`,
  );
  const scratch = seen[0]!.files!;
  assert.equal(decode(scratch["audio/step-01.wav"]!), "RIFF");
  const input = JSON.parse(String(scratch[INPUT_PATH])) as AudioInput;
  assert.deepEqual(input.randomizer, { resource: "res://step.tres", existing: false });
  assert.deepEqual(input.fresh, []);
  assert.deepEqual(input.imports, ["res://audio/step-01.wav"]);
});

test("an existing randomizer reaches scratch with its UID and the streams it holds, this hand-off's stream as handed", async () => {
  const seen: ToolRunOptions[] = [];
  const target: Record<string, string> = {
    "game/step.tres": [
      `[gd_resource type="AudioStreamRandomizer" format=3 uid="uid://rand"]`,
      `[ext_resource type="AudioStream" uid="uid://one" path="res://audio/step-01.wav" id="1"]`,
      `[ext_resource type="AudioStream" uid="uid://two" path="res://audio/step-02.ogg" id="2"]`,
    ].join("\n"),
    "game/audio/step-01.wav": "old",
    "game/audio/step-01.wav.import": `[remap]\nuid="uid://one"\n`,
    "game/audio/step-02.ogg": "OggS",
    "game/audio/step-02.ogg.import": `[remap]\nuid="uid://two"\n`,
  };
  const files = await write(
    context(member(1), scripted(seen)),
    parse({ project: "game", randomizer: "game/{subject}.tres" }),
    targetOf(target),
  );
  assert.deepEqual(paths(files), ["game/step.tres"]);
  const scratch = seen[0]!.files!;
  assert.equal(decode(scratch["audio/step-01.wav"]!), "RIFF");
  assert.equal(decode(scratch["audio/step-02.ogg"]!), "OggS");
  assert.ok("audio/step-02.ogg.import" in scratch && "audio/step-01.wav.import" in scratch);
  const input = JSON.parse(String(scratch[INPUT_PATH])) as AudioInput;
  assert.deepEqual(input.randomizer, {
    resource: "res://step.tres",
    existing: true,
    uid: "uid://rand",
  });
  assert.deepEqual(input.imports, ["res://audio/step-01.wav", "res://audio/step-02.ogg"]);
});

test("an existing randomizer with a script is refused before Godot runs", async () => {
  const seen: ToolRunOptions[] = [];
  const target = {
    "game/step.tres": `[gd_resource type="AudioStreamRandomizer" format=3]\n[ext_resource type="Script" path="res://x.gd" id="1"]\n`,
  };
  await assert.rejects(
    write(
      context(member(1), scripted(seen)),
      parse({ project: "game", randomizer: "game/{subject}.tres" }),
      targetOf(target),
    ),
    { code: "invalid_input", message: /carries a script/ },
  );
  assert.equal(seen.length, 0);
});

test("the check names the Ogg's .import settings that disagree with the delivered version", async () => {
  const options = parse({ project: "game", format: "ogg" });
  smpl.loop = { start: 0, end: 88200 };
  const read = (params: string) =>
    targetOf({
      "game/audio/rain.wav": "RIFF",
      "game/audio/rain.ogg": "OggS",
      "game/audio/rain.ogg.import": importFile(STREAM_UID, params),
    });
  assert.deepEqual(
    await check(
      context(looped, undefined),
      options,
      [],
      read("loop=true\nloop_offset=0.0\nbpm=120.0\nbeat_count=8\nbar_beats=4\n"),
    ),
    [],
  );
  assert.deepEqual(
    await check(
      context(looped, undefined),
      options,
      [],
      read("loop=true\nloop_offset=0.5\nbpm=90.0\nbeat_count=7\n"),
    ),
    [
      "game/audio/rain.ogg.import: loop_offset is 0.5, the delivered version has 0",
      "game/audio/rain.ogg.import: bpm is 90.0, the delivered version has 120",
      "game/audio/rain.ogg.import: beat_count is 7, the delivered version has 8",
    ],
  );
  assert.deepEqual(await check(context(looped, undefined), options, [], read("")), [
    "game/audio/rain.ogg.import: loop is false (Godot's default), the delivered version has true",
    "game/audio/rain.ogg.import: bpm is 0 (Godot's default), the delivered version has 120",
    "game/audio/rain.ogg.import: beat_count is 0 (Godot's default), the delivered version has 8",
  ]);
  assert.deepEqual(await check(context({}, undefined), options, [], read("loop=true\n")), [
    "game/audio/rain.ogg.import: loop is true, the delivered version has false",
  ]);
  assert.deepEqual(await check(context({}, undefined), options, [], nothing), [
    "game/audio/rain.ogg was not written",
    "game/audio/rain.ogg.import was not written",
  ]);
  const noUid = targetOf({
    "game/audio/rain.ogg": "OggS",
    "game/audio/rain.ogg.import": "[params]\nloop=false\n",
  });
  assert.deepEqual(await check(context({}, undefined), options, [], noUid), [
    "game/audio/rain.ogg.import has no UID",
  ]);
});

test("the check names the WAV's loop_mode, loop_begin and loop_end that disagree", async () => {
  const options = parse({ project: "game", randomizer: "game/{subject}.tres" });
  smpl.loop = { start: 0, end: 88200 };
  const read = (params: string) =>
    targetOf({
      "game/audio/rain.wav": "RIFF",
      "game/audio/rain.wav.import": `[params]\n${params}`,
    });
  const wav = (ctx: PresetContext, params: string) => check(ctx, options, [], read(params));
  const at = "game/audio/rain.wav.import";
  assert.deepEqual(await wav(context(looped, undefined), ""), []);
  assert.deepEqual(await wav(context(looped, undefined), "edit/loop_mode=0\n"), []);
  assert.deepEqual(await wav(context({}, undefined), "edit/loop_mode=0\n"), []);
  assert.deepEqual(await wav(context(looped, undefined), "edit/loop_mode=1\n"), [
    `${at}: edit/loop_mode is 1 (Disabled), the delivered version loops forward`,
  ]);
  assert.deepEqual(await wav(context(looped, undefined), "edit/loop_mode=3\n"), [
    `${at}: edit/loop_mode is 3 (Ping-Pong), the delivered version loops forward`,
  ]);
  assert.deepEqual(await wav(context({}, undefined), "edit/loop_mode=2\n"), [
    `${at}: edit/loop_mode is 2 (Forward), the delivered version does not loop`,
  ]);
  assert.deepEqual(await wav(context({}, undefined), "edit/loop_mode=1\n"), []);
  assert.deepEqual(await wav(context(looped, undefined), "edit/loop_mode=2\n"), []);
  assert.deepEqual(
    await wav(
      context(looped, undefined),
      "edit/loop_mode=2\nedit/loop_begin=10\nedit/loop_end=100\n",
    ),
    [
      `${at}: edit/loop_begin is 10, the delivered version loops from 0`,
      `${at}: edit/loop_end is 100, the delivered version loops to 88200`,
    ],
  );
  assert.deepEqual(
    await wav(context(looped, undefined), "edit/loop_mode=2\nedit/loop_end=88200\n"),
    [],
  );
});

test("the check fails a WAV whose smpl loop is missing or differs", async () => {
  const options = parse({ project: "game", randomizer: "game/{subject}.tres" });
  const read = targetOf({ "game/audio/rain.wav": "RIFF" });
  smpl.loop = undefined;
  assert.deepEqual(await check(context(looped, undefined), options, [], read), [
    "game/audio/rain.wav has no smpl loop, the delivered version loops 0-88200",
  ]);
  smpl.loop = { start: 10, end: 88000 };
  assert.deepEqual(await check(context(looped, undefined), options, [], read), [
    "game/audio/rain.wav smpl loop is 10-88000, the version loops 0-88200",
  ]);
  smpl.loop = { start: 0, end: 88200 };
  assert.deepEqual(await check(context(looped, undefined), options, [], read), []);
  assert.deepEqual(await check(context(looped, undefined), options, [], nothing), [
    "game/audio/rain.wav was not written",
  ]);
  smpl.loop = undefined;
  assert.deepEqual(await check(context({}, undefined), options, [], nothing), []);
});

test("the check reads the randomizer: its type, UID, the stream and the stream's UID", async () => {
  const options = parse({ project: "game", randomizer: "game/{subject}.tres" });
  const tres = (type: string, uid: string, header = ` uid="uid://rand"`) =>
    `[gd_resource type="${type}" format=3${header}]\n[ext_resource type="AudioStream" uid="${uid}" path="res://audio/step-01.wav" id="1"]\n`;
  const read = (target: Record<string, string>) => targetOf(target);
  const ctx = context(member(1), undefined);
  assert.deepEqual(
    await check(
      ctx,
      options,
      [],
      read({ "game/step.tres": tres("AudioStreamRandomizer", "uid://one") }),
    ),
    [],
  );
  assert.deepEqual(
    await check(
      ctx,
      options,
      [],
      read({
        "game/step.tres": tres("AudioStreamRandomizer", "uid://one"),
        "game/audio/step-01.wav.import": `[remap]\nuid="uid://one"\n`,
      }),
    ),
    [],
  );
  assert.deepEqual(
    await check(
      ctx,
      options,
      [],
      read({
        "game/step.tres": tres("AudioStreamRandomizer", "uid://other"),
        "game/audio/step-01.wav.import": `[remap]\nuid="uid://one"\n`,
      }),
    ),
    [
      "game/step.tres references res://audio/step-01.wav as uid://other, but its .import gives uid://one",
    ],
  );
  assert.deepEqual(
    await check(
      ctx,
      options,
      [],
      read({ "game/step.tres": tres("SpriteFrames", "uid://one", "") }),
    ),
    ["game/step.tres is not an AudioStreamRandomizer resource", "game/step.tres has no UID"],
  );
  assert.deepEqual(await check(ctx, options, [], nothing), ["game/step.tres was not written"]);
  assert.deepEqual(
    await check(
      ctx,
      options,
      [],
      read({
        "game/step.tres": `[gd_resource type="AudioStreamRandomizer" format=3 uid="uid://rand"]\n`,
      }),
    ),
    ["game/step.tres does not reference res://audio/step-01.wav"],
  );
});

test("an .import's [params] are read as written, quotes removed", () => {
  assert.deepEqual(
    importParams(
      `[remap]\nuid="uid://a"\n\n[params]\n\nloop=true\nedit/loop_mode=2\nname="x y"\n\n[other]\nz=1\n`,
    ),
    { loop: "true", "edit/loop_mode": "2", name: "x y" },
  );
});

test("an .import line of many spaces and no value is read in linear time", () => {
  const long = " ".repeat(100_000);
  const started = performance.now();
  const params = importParams(`[params]\n!${long}x\n!=${long}x\nkey ${long}= ${long}"v"\n; c=1\n`);
  assert.ok(performance.now() - started < 1000, `${performance.now() - started} ms`);
  assert.deepEqual(params, { "!": "x", key: "v" });
});
