/**
 * The `godot:audio` preset with a real Godot (issue #521): an ambience loop and a music loop handed
 * off as WAV and as Ogg, and a variant set's members handed off into one randomizer. The preset's
 * `write` and `check` run as core runs them, with a tool runner that does what core's does (a fresh
 * scratch directory, the files written in, Godot run there, every new or changed file back) and
 * core's own audio helpers. Then a headless Godot imports each delivered file in the project,
 * reads its loop points and tempo back, loads the randomizer, and plays each loop from just
 * before its end until its playback has wrapped past the boundary. These tests need Godot 4.7.2 on
 * PATH (CI's setup-godot puts it there), and without it each test skips with the reason.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { after, test } from "node:test";
import type {
  PresetContext,
  PresetFile,
  ToolResult,
  ToolRunOptions,
} from "@clockgrove/assetgrove/extension";
import { extensionContext, sampleProfile, sampleWav } from "@clockgrove/assetgrove/testing";
import { AUDIO_PRESET, audioPreset } from "../src/audio.ts";
import { findGodot } from "./helpers/godot.ts";

const { godot: GODOT, skip: SKIP } = findGodot();
const usable = GODOT !== undefined;

const RATE = 44100;
/** An ambience loop of one second. */
const WIND = { frames: RATE, spec: { kind: "ambience", assetId: "wind", brief: "wind", loopS: 1 } };
/** A music loop of one bar of four beats at 120 bpm: two seconds. */
const VILLAGE = {
  frames: 2 * RATE,
  spec: {
    kind: "music",
    assetId: "village",
    brief: "a calm village theme",
    form: "track",
    loop: { bpm: 120, bars: 1, beatsPerBar: 4 },
  },
};

const stage = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-godot-audio-")));
after(() => rmSync(stage, { recursive: true, force: true }));

const entry = audioPreset(extensionContext("@clockgrove/assetgrove-godot"));
if (entry.scope === "families") throw new Error(`${AUDIO_PRESET} hands off one asset`);
const preset = entry;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((item) => item.isFile())
    .map((item) => relative(dir, join(item.parentPath, item.name)).split(sep).join("/"));
}

/** Runs the tool as core's runner does: in a new scratch directory, returning what changed. */
async function runner(tool: string, run: ToolRunOptions): Promise<ToolResult> {
  const scratch = realpathSync(mkdtempSync(join(stage, "scratch-")));
  const inputs = new Map<string, string>();
  for (const [path, content] of Object.entries(run.files ?? {})) {
    const bytes = typeof content === "string" ? Buffer.from(content) : content;
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    writeFileSync(join(scratch, path), bytes);
    inputs.set(path, sha(bytes));
  }
  const ran = spawnSync(GODOT!, run.args, {
    cwd: scratch,
    encoding: "utf8",
    timeout: run.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = listFiles(scratch)
    .map((path) => ({ path, content: new Uint8Array(readFileSync(join(scratch, path))) }))
    .filter((file) => inputs.get(file.path) !== sha(file.content));
  rmSync(scratch, { recursive: true, force: true });
  return {
    exitCode: ran.status ?? 1,
    stdout: ran.stdout ?? "",
    stderr: ran.stderr ?? "",
    files,
    step: { kind: "tool", tool, hash: "0".repeat(64), method: "settings" },
  };
}

/** A fresh target: a Godot project under `game/`. */
function target(): string {
  const dir = realpathSync(mkdtempSync(join(stage, "target-")));
  mkdirSync(join(dir, "game"));
  writeFileSync(
    join(dir, "game", "project.godot"),
    'config_version=5\n\n[application]\n\nconfig/name="fixture"\n',
  );
  return dir;
}

const reader = (dir: string) => async (path: string) => {
  try {
    return new Uint8Array(readFileSync(join(dir, path)));
  } catch {
    return undefined;
  }
};

/** An audio hand-off's context, as core gives the preset one: the spec, the WAV and its facts. */
function context(
  spec: Record<string, unknown>,
  wav: Uint8Array,
  frames: number,
  loop: boolean,
): PresetContext {
  const assetId = String(spec["assetId"]);
  return {
    profile: sampleProfile(),
    context: {
      spec,
      output: {
        path: `game/audio/${assetId}.wav`,
        mediaType: "audio/wav",
        extension: "wav",
        audio: {
          kind: spec["kind"],
          ...(spec["form"] !== undefined && { form: spec["form"] }),
          sampleRate: RATE,
          channels: 2,
          frames,
          durationS: frames / RATE,
          ...(loop && { loop: { frames, residual: 0 } }),
        },
      },
      provenance: {},
    },
    manifestRel: `game/audio/${assetId}.json`,
    mediaBytes: wav,
    run: runner,
  };
}

/** Hands a WAV off as core does: the preset writes, core writes the media and files, the check reads. */
async function handOff(dir: string, ctx: PresetContext, raw: object): Promise<PresetFile[]> {
  const opts = preset.optionsSchema.parse(raw);
  const files = await preset.write(ctx, opts, reader(dir));
  const media = String((ctx.context["output"] as Record<string, unknown>)["path"]);
  for (const file of [{ path: media, content: ctx.mediaBytes! }, ...files]) {
    mkdirSync(dirname(join(dir, file.path)), { recursive: true });
    writeFileSync(join(dir, file.path), file.content);
  }
  assert.deepEqual(await preset.check(ctx, opts, files, reader(dir)), []);
  return files;
}

/**
 * What Godot reads in the target's project: it imports every file (failing on any `ERROR` line),
 * then runs `body`, GDScript lines in a `SceneTree` script's `_initialize`, and returns the lines
 * it printed as `KEY value`.
 */
function inProject(dir: string, body: string): Record<string, string> {
  const project = join(dir, "game");
  const godot = (...args: string[]) =>
    spawnSync(GODOT!, ["--headless", "--path", project, ...args], {
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  const imports = godot("--import");
  assert.doesNotMatch(imports.stdout + imports.stderr, /ERROR/, imports.stdout + imports.stderr);
  const script = join(stage, `read-${Date.now()}-${Math.random().toString(36).slice(2)}.gd`);
  writeFileSync(script, `extends SceneTree\n\n${PLAY}\n\nfunc _initialize():\n${body}\tquit()\n`);
  const run = godot("--script", script);
  const out = run.stdout + run.stderr;
  assert.doesNotMatch(out, /ERROR/, out);
  return Object.fromEntries([...out.matchAll(/^([A-Z_]+) (.*)$/gm)].map((m) => [m[1]!, m[2]!]));
}

/**
 * Plays a stream from `lead` seconds before its loop's end for `span` seconds through its own
 * playback, mixed by the script (AudioStreamPlayback.mix_audio), and prints where the playback is
 * then, whether it still plays and the loudest sample mixed after the boundary.
 */
const PLAY = `func play(name: String, stream: AudioStream, end_s: float, lead: float, span: float) -> void:
\tvar playback := stream.instantiate_playback()
\tplayback.start(end_s - lead)
\tvar rate := AudioServer.get_mix_rate()
\tvar frames := playback.mix_audio(1.0, int(span * rate))
\tvar loudest := 0.0
\tfor i in range(int(lead * rate) + 64, frames.size()):
\t\tloudest = maxf(loudest, absf(frames[i].x))
\tprint("%s_POSITION %f" % [name, playback.get_playback_position()])
\tprint("%s_PLAYING %s" % [name, playback.is_playing()])
\tprint("%s_LOUDEST %f" % [name, loudest])`;

/** Asserts the stream played past its loop's boundary: still playing, wrapped, and not silent. */
function wrapped(seen: Record<string, string>, name: string, lead: number, span: number): void {
  assert.equal(seen[`${name}_PLAYING`], "true", JSON.stringify(seen));
  const position = Number(seen[`${name}_POSITION`]);
  // From `lead` before the end, `span` later it is `span - lead` into the loop, give or take a mix.
  assert.ok(Math.abs(position - (span - lead)) < 0.05, `${name} is at ${position}`);
  assert.ok(Number(seen[`${name}_LOUDEST`]) > 0.1, `${name} is silent after the boundary`);
}

const importUid = (text: string) => /^uid="(uid:\/\/[^"]+)"/m.exec(text)?.[1];

test("WAV loops keep their smpl loop points, get no .import, and play across the boundary", async (t) => {
  if (!usable) return t.skip(SKIP!);
  const dir = target();
  for (const { frames, spec } of [WIND, VILLAGE]) {
    const wav = sampleWav({ frames, loop: true });
    assert.deepEqual(await handOff(dir, context(spec, wav, frames, true), { project: "game" }), []);
    assert.deepEqual(
      new Uint8Array(readFileSync(join(dir, `game/audio/${spec.assetId}.wav`))),
      wav,
    );
  }
  const seen = inProject(
    dir,
    ["wind", "village"]
      .map(
        (name) =>
          `\tvar ${name} := load("res://audio/${name}.wav") as AudioStreamWAV\n` +
          `\tprint("${name.toUpperCase()}_LOOP %d %d %d" % [${name}.loop_mode, ${name}.loop_begin, ${name}.loop_end])\n` +
          `\tplay("${name.toUpperCase()}", ${name}, ${name}.get_length(), 0.05, 0.25)\n`,
      )
      .join(""),
  );
  // Godot's own import made each `.import`, with its default loop mode, Detect From WAV.
  for (const name of ["wind", "village"]) {
    const imported = readFileSync(join(dir, `game/audio/${name}.wav.import`), "utf8");
    assert.doesNotMatch(imported, /^edit\/loop_mode=[1-9]/m, imported);
  }
  assert.equal(seen["WIND_LOOP"], `${1} 0 ${WIND.frames}`, "a forward loop over the whole file");
  assert.equal(seen["VILLAGE_LOOP"], `${1} 0 ${VILLAGE.frames}`);
  wrapped(seen, "WIND", 0.05, 0.25);
  wrapped(seen, "VILLAGE", 0.05, 0.25);
});

test("an Ogg gets Godot's .import with its loop and tempo, kept on a re-hand-off, and plays across the boundary", async (t) => {
  if (!usable) return t.skip(SKIP!);
  const dir = target();
  const options = { project: "game", format: "ogg" };
  const ogg = "game/audio/village.ogg";
  const wav = sampleWav({ frames: VILLAGE.frames, loop: true });
  const files = await handOff(dir, context(VILLAGE.spec, wav, VILLAGE.frames, true), options);
  assert.deepEqual(files.map((f) => f.path).sort(), [ogg, `${ogg}.import`]);
  const imported = readFileSync(join(dir, `${ogg}.import`), "utf8");
  assert.match(imported, /^importer="oggvorbisstr"$/m, imported);
  assert.match(imported, /^loop=true$/m, imported);
  assert.match(imported, /^loop_offset=0(\.0)?$/m, imported);
  assert.match(imported, /^bpm=120(\.0)?$/m, imported);
  assert.match(imported, /^beat_count=4$/m, imported);
  assert.match(imported, /^bar_beats=4$/m, imported);
  const uid = importUid(imported);
  assert.ok(uid, imported);

  // A second hand-off of the same version: the existing .import is never returned or touched.
  const again = await handOff(dir, context(VILLAGE.spec, wav, VILLAGE.frames, true), options);
  assert.deepEqual(
    again.map((f) => f.path),
    [ogg],
  );
  assert.equal(readFileSync(join(dir, `${ogg}.import`), "utf8"), imported);

  const seen = inProject(
    dir,
    `\tvar village := load("res://audio/village.ogg") as AudioStreamOggVorbis
\tprint("VILLAGE_IMPORT %s %f %f %d %d" % [village.loop, village.loop_offset, village.bpm, village.beat_count, village.bar_beats])
\tprint("UID %s" % ResourceUID.id_to_text(ResourceLoader.get_resource_uid("res://audio/village.ogg")))
\tplay("VILLAGE", village, 2.0, 0.05, 0.25)
`,
  );
  assert.equal(seen["VILLAGE_IMPORT"], "true 0.000000 120.000000 4 4");
  assert.equal(seen["UID"], uid);
  wrapped(seen, "VILLAGE", 0.05, 0.25);

  // A developer's .import that disagrees with the version fails the check, naming the setting.
  writeFileSync(
    join(dir, `${ogg}.import`),
    imported.replace(/^loop_offset=.*$/m, "loop_offset=0.5").replace(/^bpm=.*$/m, "bpm=90.0"),
  );
  const ctx = context(VILLAGE.spec, wav, VILLAGE.frames, true);
  const opts = preset.optionsSchema.parse(options);
  const problems = await preset.check(ctx, opts, [], reader(dir));
  assert.ok(
    problems.some((p) => p.includes("loop_offset")),
    problems.join("\n"),
  );
  assert.ok(
    problems.some((p) => p.includes("bpm")),
    problems.join("\n"),
  );
});

test("a variant set gets one AudioStreamRandomizer per subject, built by Godot, keeping its UID", async (t) => {
  if (!usable) return t.skip(SKIP!);
  const dir = target();
  const options = { project: "game", randomizer: "game/audio/{subject}.tres" };
  const resource = "game/audio/step.tres";
  const member = (variant: number, hz: number) => {
    const assetId = `step-0${variant}`;
    const spec = {
      kind: "sfx",
      assetId,
      brief: "a footstep",
      maxDurationS: 1,
      subject: "step",
      variant,
    };
    return context(spec, sampleWav({ frames: RATE / 4, channels: 1, hz }), RATE / 4, false);
  };
  const first = await handOff(dir, member(1, 330), options);
  assert.deepEqual(
    first.map((f) => f.path),
    [resource],
  );
  const uid = /^\[gd_resource [^\]]*uid="([^"]+)"/m.exec(
    readFileSync(join(dir, resource), "utf8"),
  )?.[1];
  assert.ok(uid);
  // No WAV .import is ever written.
  assert.ok(
    !listFiles(dir).some((path) => path.endsWith(".wav.import")),
    listFiles(dir).join(", "),
  );

  const second = await handOff(dir, member(2, 440), options);
  assert.deepEqual(
    second.map((f) => f.path),
    [resource],
  );
  const text = readFileSync(join(dir, resource), "utf8");
  assert.match(text, /^\[gd_resource type="AudioStreamRandomizer"/m, text);
  assert.ok(text.includes(`uid="${uid}"`), text);

  const seen = inProject(
    dir,
    `\tvar steps := load("res://audio/step.tres") as AudioStreamRandomizer
\tvar paths := []
\tfor i in steps.streams_count:
\t\tpaths.append(steps.get_stream(i).resource_path)
\tprint("STREAMS %s" % ",".join(paths))
\tprint("UID %s" % ResourceUID.id_to_text(ResourceLoader.get_resource_uid("res://audio/step.tres")))
\tvar playback := steps.instantiate_playback()
\tplayback.start(0.0)
\tprint("MIXED %d" % playback.mix_audio(1.0, 512).size())
`,
  );
  assert.equal(seen["STREAMS"], "res://audio/step-01.wav,res://audio/step-02.wav");
  assert.equal(seen["UID"], uid);
  assert.equal(seen["MIXED"], "512");
});
