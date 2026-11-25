/**
 * What `godot:tile-set` hands Godot, without Godot: the corner-16 tiles' terrain data, the refusal
 * of an asset that is not a corner-16 set, and an existing TileSet reaching scratch with every
 * file it references. The scripted run answers as the build script does; the real Godot runs are
 * test/tile-set.test.ts.
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
import { INPUT_PATH, RESULT_PATH, type TileSetInput } from "../src/scratch.ts";
import { corner16Tiles, tileSetPreset, type TileSetOptions } from "../src/tile-set.ts";

const preset = tileSetPreset(extensionContext("godot"));
/** The preset's write, an asset-scope one's. */
const write = preset.write as (
  ctx: PresetContext,
  options: TileSetOptions,
  read: TargetRead,
) => Promise<PresetFile[]>;
const encode = (text: string) => new TextEncoder().encode(text);

test("the corner-16 tiles: tile i at (i % 4, i / 4), corner bits NW 1, NE 2, SW 4, SE 8, only tile 15 upper-centred", () => {
  const tiles = corner16Tiles();
  assert.equal(tiles.length, 16);
  assert.deepEqual(tiles[6], {
    coords: [2, 1],
    terrain: 0,
    peering: { nw: 0, ne: 1, sw: 1, se: 0 },
  });
  assert.deepEqual(tiles[15], {
    coords: [3, 3],
    terrain: 1,
    peering: { nw: 1, ne: 1, sw: 1, se: 1 },
  });
  assert.deepEqual(
    tiles.map((t) => t.terrain),
    [...Array<number>(15).fill(0), 1],
  );
});

/** A run that records its scratch files and answers as the build script does. */
function scripted(seen: ToolRunOptions[]) {
  return async (tool: string, options: ToolRunOptions): Promise<ToolResult> => {
    seen.push(options);
    const input = JSON.parse(String(options.files?.[INPUT_PATH])) as TileSetInput;
    const resource = input.resource.slice("res://".length);
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      files: [
        { path: resource, content: encode(`[gd_resource type="TileSet" format=3]\n`) },
        { path: RESULT_PATH, content: encode(JSON.stringify({ ok: true, errors: [] })) },
      ],
      step: { kind: "tool", tool, hash: "0".repeat(64), method: "settings" },
    };
  };
}

const context = (spec: object, output: object, run: PresetContext["run"]): PresetContext => ({
  profile: sampleProfile(),
  context: { spec, output, provenance: {} },
  manifestRel: "manifest.json",
  mediaBytes: encode("atlas"),
  ...(run !== undefined && { run }),
});

test("a hand-off that is not a corner-16 tiles:terrain asset is refused as invalid input", async () => {
  const options = preset.optionsSchema.parse({});
  const still = context({ kind: "still", assetId: "fern" }, { path: "fern.png" }, scripted([]));
  await assert.rejects(
    write(still, options, async () => undefined),
    {
      code: "invalid_input",
      message:
        "the preset godot:tile-set hands off a tiles:terrain asset whose output.fields.layout is corner-16, not a still asset with layout undefined",
    },
  );
});

test("an existing TileSet reaches scratch with every file it references and their .import files", async () => {
  const target: Record<string, string> = {
    "game/tiles/grass-dirt.png.import": `[remap]\n\nuid="uid://atlas"\n`,
    "game/tiles/grass-dirt.tres": [
      `[gd_resource type="TileSet" load_steps=4 format=3 uid="uid://tileset"]`,
      `[ext_resource type="Texture2D" uid="uid://atlas" path="res://tiles/grass-dirt.png" id="1"]`,
      `[ext_resource type="Texture2D" uid="uid://rock" path="res://tiles/rock.png" id="2"]`,
      `[ext_resource type="PhysicsMaterial" path="res://physics/stone.tres" id="3"]`,
      `[ext_resource type="Texture2D" path="res://tiles/missing.png" id="4"]`,
    ].join("\n"),
    "game/tiles/rock.png": "rock",
    "game/tiles/rock.png.import": `[remap]\n\nuid="uid://rock"\n`,
    "game/physics/stone.tres": `[gd_resource type="PhysicsMaterial" format=3]\n[ext_resource type="Texture2D" path="res://physics/grit.png" id="1"]\n`,
    "game/physics/grit.png": "grit",
    "game/physics/grit.png.import": `[remap]\n\nuid="uid://grit"\n`,
  };
  const read = async (path: string) =>
    target[path] === undefined ? undefined : encode(target[path]);
  const seen: ToolRunOptions[] = [];
  const ctx = context(
    { kind: "tiles:terrain", assetId: "grass-dirt", terrains: { lower: "dirt", upper: "grass" } },
    { layout: "corner-16", tileSize: 16, path: "game/tiles/grass-dirt.png" },
    scripted(seen),
  );
  const options = preset.optionsSchema.parse({
    project: "game",
    resource: "game/tiles/{assetId}.tres",
  });
  const files = await write(ctx, options, read);
  // The atlas had an .import: it is never returned, so core never touches it.
  assert.deepEqual(
    files.map((f) => f.path),
    ["game/tiles/grass-dirt.tres"],
  );
  const scratch = seen[0]!.files!;
  assert.deepEqual(Object.keys(scratch).sort(), [
    ".assetgrove-godot/input.json",
    "addons/assetgrove_godot/build.gd",
    "addons/assetgrove_godot/plugin.cfg",
    "physics/grit.png",
    "physics/grit.png.import",
    "physics/stone.tres",
    "project.godot",
    "tiles/grass-dirt.png",
    "tiles/grass-dirt.png.import",
    "tiles/grass-dirt.tres",
    "tiles/rock.png",
    "tiles/rock.png.import",
  ]);
  // This hand-off's atlas, not the one the target held.
  assert.equal(new TextDecoder().decode(scratch["tiles/grass-dirt.png"] as Uint8Array), "atlas");
  const input = JSON.parse(String(scratch[INPUT_PATH])) as TileSetInput;
  assert.equal(input.existing, true);
  assert.equal(input.uid, "uid://tileset");
  assert.equal(input.resource, "res://tiles/grass-dirt.tres");
  assert.deepEqual(input.imports, [
    "res://tiles/grass-dirt.png",
    "res://tiles/rock.png",
    "res://physics/grit.png",
  ]);
});

test("an existing TileSet Godot saves unchanged, as a replaced atlas leaves it, is written as it was", async () => {
  const tres = `[gd_resource type="TileSet" format=3 uid="uid://tileset"]\n`;
  const target: Record<string, string> = {
    "tiles/grass-dirt.png.import": `[remap]\n\nuid="uid://atlas"\n`,
    "tiles/grass-dirt.tres": tres,
  };
  const read = async (path: string) =>
    target[path] === undefined ? undefined : encode(target[path]);
  // Core's tool runner returns only new or changed files: the unchanged TileSet is not among them.
  const run = async (tool: string): Promise<ToolResult> => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    files: [{ path: RESULT_PATH, content: encode(JSON.stringify({ ok: true, errors: [] })) }],
    step: { kind: "tool", tool, hash: "0".repeat(64), method: "settings" },
  });
  const ctx = context(
    { kind: "tiles:terrain", assetId: "grass-dirt", terrains: { lower: "dirt", upper: "grass" } },
    { layout: "corner-16", tileSize: 16, path: "tiles/grass-dirt.png" },
    run,
  );
  const options = preset.optionsSchema.parse({ resource: "tiles/{assetId}.tres" });
  const files = await write(ctx, options, read);
  assert.deepEqual(
    files.map((f) => [
      f.path,
      typeof f.content === "string" ? f.content : new TextDecoder().decode(f.content),
    ]),
    [["tiles/grass-dirt.tres", tres]],
  );
});
