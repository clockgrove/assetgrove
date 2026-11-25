/**
 * What `godot:sprite-frames` hands Godot, without Godot: an existing SpriteFrames reaching scratch
 * with the files it references while the family strips stay this hand-off's bytes, and a conflict
 * the build reports failing the hand-off. The scripted run answers as the build script does; the
 * real Godot runs are test/godot.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  FamiliesContext,
  PresetFile,
  TargetRead,
  ToolResult,
  ToolRunOptions,
} from "@clockgrove/assetgrove/extension";
import { extensionContext, sampleProfile } from "@clockgrove/assetgrove/testing";
import { INPUT_PATH, RESULT_PATH, type BuildInput } from "../src/scratch.ts";
import { spriteFramesPreset, type SpriteFramesOptions } from "../src/sprite-frames.ts";

const preset = spriteFramesPreset(extensionContext("godot"));
const write = preset.write as (
  ctx: FamiliesContext,
  options: SpriteFramesOptions,
  read: TargetRead,
) => Promise<PresetFile[]>;
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | string) =>
  typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);

/** A run that records its scratch files and answers with `result`. */
function scripted(seen: ToolRunOptions[], result: object, exitCode = 0) {
  return async (tool: string, options: ToolRunOptions): Promise<ToolResult> => {
    seen.push(options);
    const input = JSON.parse(String(options.files?.[INPUT_PATH])) as BuildInput;
    const resource = input.resource.slice("res://".length);
    return {
      exitCode,
      stdout: "",
      stderr: "",
      files: [
        { path: resource, content: encode(`[gd_resource type="SpriteFrames" format=3]\n`) },
        { path: RESULT_PATH, content: encode(JSON.stringify(result)) },
      ],
      step: { kind: "tool", tool, hash: "0".repeat(64), method: "settings" },
    };
  };
}

const context = (run: FamiliesContext["run"]): FamiliesContext => ({
  profile: sampleProfile(),
  assetId: "fern",
  families: [
    {
      name: "idle",
      id: "fern-idle",
      media: "game/characters/fern-idle.png",
      sha256: "0".repeat(64),
      content: encode("new idle strip"),
    },
  ],
  ...(run !== undefined && { run }),
});

const options = preset.optionsSchema.parse({
  project: "game",
  resource: "game/characters/{assetId}.tres",
});

const targetReader =
  (target: Record<string, string>): TargetRead =>
  async (path) =>
    target[path] === undefined ? undefined : encode(target[path]);

test("an existing SpriteFrames reaches scratch with the developer's textures and this hand-off's strips", async () => {
  const target: Record<string, string> = {
    "game/characters/fern.tres": [
      `[gd_resource type="SpriteFrames" load_steps=3 format=3 uid="uid://frames"]`,
      `[ext_resource type="Texture2D" uid="uid://idle" path="res://characters/fern-idle.png" id="1"]`,
      `[ext_resource type="Texture2D" uid="uid://hurt" path="res://art/hurt.png" id="2"]`,
    ].join("\n"),
    "game/characters/fern-idle.png": "old idle strip",
    "game/characters/fern-idle.png.import": `[remap]\n\nuid="uid://idle"\n`,
    "game/art/hurt.png": "hurt",
    "game/art/hurt.png.import": `[remap]\n\nuid="uid://hurt"\n`,
  };
  const seen: ToolRunOptions[] = [];
  const result = { ok: true, errors: [] };
  await write(context(scripted(seen, result)), options, targetReader(target));
  const scratch = seen[0]!.files!;
  assert.deepEqual(Object.keys(scratch).sort(), [
    ".assetgrove-godot/input.json",
    "addons/assetgrove_godot/build.gd",
    "addons/assetgrove_godot/plugin.cfg",
    "art/hurt.png",
    "art/hurt.png.import",
    "characters/fern-idle.png",
    "characters/fern-idle.png.import",
    "characters/fern.tres",
    "project.godot",
  ]);
  assert.equal(decode(scratch["characters/fern.tres"]!), target["game/characters/fern.tres"]);
  assert.equal(decode(scratch["art/hurt.png"]!), "hurt");
  assert.equal(decode(scratch["characters/fern-idle.png"]!), "new idle strip");
  const input = JSON.parse(String(scratch[INPUT_PATH])) as BuildInput;
  assert.equal(input.existing, true);
  assert.equal(input.uid, "uid://frames");
  assert.deepEqual(input.imports, ["res://characters/fern-idle.png", "res://art/hurt.png"]);
});

test("a target without the resource builds a new one: no existing, no .tres in scratch", async () => {
  const seen: ToolRunOptions[] = [];
  await write(
    context(scripted(seen, { ok: true, errors: [] })),
    options,
    targetReader({ "game/characters/fern-idle.png.import": `[remap]\n\nuid="uid://idle"\n` }),
  );
  const scratch = seen[0]!.files!;
  assert.equal(
    Object.keys(scratch).some((path) => path.endsWith(".tres")),
    false,
  );
  const input = JSON.parse(String(scratch[INPUT_PATH])) as BuildInput;
  assert.equal(input.existing, undefined);
  assert.equal(input.imports, undefined);
});

test("a conflict the build reports fails the hand-off before anything is written", async () => {
  const conflict = `animation "idle": speed is 3 in characters/fern.tres, the preset wrote 10`;
  const target = { "game/characters/fern.tres": `[gd_resource type="SpriteFrames" format=3]\n` };
  const run = scripted([], { ok: false, errors: [conflict], conflicts: [conflict] }, 1);
  await assert.rejects(write(context(run), options, targetReader(target)), (error: unknown) => {
    const failed = error as { code: string; problems: Array<{ problem: string }> };
    assert.equal(failed.code, "handoff_check_failed");
    assert.deepEqual(
      failed.problems.map((p) => p.problem),
      [`conflict: ${conflict}`],
    );
    assert.match((error as Error).message, /nothing was written/);
    return true;
  });
});

test("an existing SpriteFrames that carries or references a script is refused before Godot runs", async () => {
  const header = `[gd_resource type="SpriteFrames" format=3 uid="uid://frames"]`;
  const cases: Array<[Record<string, string>, RegExp]> = [
    [
      {
        "game/characters/fern.tres": `${header}\n[ext_resource type="Script" path="res://tools/hook.gd" id="1"]\n`,
      },
      /characters\/fern\.tres carries a script/,
    ],
    [
      {
        "game/characters/fern.tres": `${header}\n[ext_resource type="Texture2D" path="res://art/baked.res" id="1"]\n`,
      },
      /characters\/fern\.tres references art\/baked\.res/,
    ],
    [
      {
        "game/characters/fern.tres": `${header}\n[sub_resource type="GDScript" id="1"]\nscript/source = "@tool"\n`,
      },
      /characters\/fern\.tres carries a script/,
    ],
    [
      {
        "game/characters/fern.tres": `${header}\n[ext_resource type="SpriteFrames" path="res://art/more.tres" id="1"]\n`,
        "game/art/more.tres": `[gd_resource type="SpriteFrames" format=3]\n\n[resource]\nscript = ExtResource("1")\n`,
      },
      /art\/more\.tres carries a script/,
    ],
    // Godot's parser skips whitespace before and inside a header and around `=`.
    [
      {
        "game/characters/fern.tres": `${header}\n [sub_resource type="GDScript" id="1"]\n`,
      },
      /characters\/fern\.tres carries a script/,
    ],
    [
      {
        "game/characters/fern.tres": `${header}\n[ sub_resource type = "GDScript" id="1"]\n`,
      },
      /characters\/fern\.tres carries a script/,
    ],
    [
      {
        "game/characters/fern.tres": `${header}\n\n[resource]\n  script = SubResource("1")\n`,
      },
      /characters\/fern\.tres carries a script/,
    ],
    [
      {
        "game/characters/fern.tres": `${header}\n\n[resource]\n"script" = ExtResource("1")\n`,
      },
      /characters\/fern\.tres carries a script/,
    ],
    // Only images and text resources are copied: compiled GDScript, whatever type the header says.
    [
      {
        "game/characters/fern.tres": `${header}\n[ext_resource type="Resource" path="res://tools/hook.gdc" id="1"]\n`,
      },
      /characters\/fern\.tres references tools\/hook\.gdc/,
    ],
    [
      {
        "game/characters/fern.tres": `${header}\n  [ ext_resource type="Resource" path = "res://tools/hook.gdc" id="1"]\n`,
      },
      /characters\/fern\.tres references tools\/hook\.gdc/,
    ],
  ];
  for (const [target, message] of cases) {
    const seen: ToolRunOptions[] = [];
    await assert.rejects(
      write(context(scripted(seen, { ok: true, errors: [] })), options, targetReader(target)),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "invalid_input");
        assert.match((error as Error).message, message);
        return true;
      },
    );
    assert.equal(seen.length, 0);
  }
});
