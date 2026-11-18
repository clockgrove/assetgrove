/**
 * The test kit's conformance suite over the pack's entry. The suite runs no program, so the
 * sample context hands the preset a `run` that answers as Godot's build does: the files the
 * build script leaves in scratch. The real Godot runs are test/godot.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolResult, ToolRunOptions } from "@clockgrove/assetgrove/extension";
import { assertConformance } from "@clockgrove/assetgrove/testing";
import entry from "../src/extension.ts";
import { GODOT_ARGS, INPUT_PATH, RESULT_PATH, type BuildInput } from "../src/scratch.ts";

const TEXTURE_UID = "uid://cq2425ngttrok";
const RESOURCE_UID = "uid://b5wyq2abcdxy0";

/** What Godot leaves in scratch for the input: the resource, the `.import` and the result. */
function scripted(seen: ToolRunOptions[]) {
  return async (tool: string, options: ToolRunOptions): Promise<ToolResult> => {
    seen.push(options);
    const input = JSON.parse(String(options.files?.[INPUT_PATH])) as BuildInput;
    const texture = input.animations[0]!.texture;
    const resource = input.resource.slice("res://".length);
    return {
      exitCode: 0,
      stdout: "Godot Engine v4.7.2.stable.official\n",
      stderr: "",
      files: [
        {
          path: `${texture.slice("res://".length)}.import`,
          content: new TextEncoder().encode(
            `[remap]\n\nimporter="texture"\ntype="CompressedTexture2D"\nuid="${TEXTURE_UID}"\n`,
          ),
        },
        {
          path: resource,
          content: new TextEncoder().encode(
            `[gd_resource type="SpriteFrames" format=3 uid="${RESOURCE_UID}"]\n\n[ext_resource type="Texture2D" uid="${TEXTURE_UID}" path="${texture}" id="1_a"]\n`,
          ),
        },
        {
          path: RESULT_PATH,
          content: new TextEncoder().encode(JSON.stringify({ ok: true, errors: [] })),
        },
      ],
      step: { kind: "tool", tool, hash: "0".repeat(64), method: "settings" },
    };
  };
}

test("the entry passes the conformance suite, its preset building through the tool", async () => {
  const seen: ToolRunOptions[] = [];
  const report = await assertConformance(entry, {
    presets: { "godot:sprite-frames": { context: { run: scripted(seen) } } },
  });
  assert.equal(report.passed, true);
  assert.deepEqual(report.failures, []);
  // The suite wrote once; each run names the project and the plugin's files, and the media and
  // the input reach scratch as data no argument names.
  assert.ok(seen.length >= 1);
  for (const options of seen) {
    assert.deepEqual(options.args, [...GODOT_ARGS]);
    const input = JSON.parse(String(options.files?.[INPUT_PATH])) as BuildInput;
    assert.deepEqual(
      input.animations.map((a) => a.name),
      ["idle"],
    );
    for (const path of Object.keys(options.files ?? {}))
      if (!GODOT_ARGS.includes(path)) assert.ok(!options.args.includes(path), path);
  }
});
