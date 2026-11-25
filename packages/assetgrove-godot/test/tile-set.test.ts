/**
 * The `godot:tile-set` preset through core (issue #452): the Godot pack and the tiles pack built as
 * packs outside this repository are and installed in a temporary project, `stage` makes a
 * `tiles:terrain` atlas from a provider script and `pick` hands it off; a headless Godot loads,
 * edits and paints what was written. These tests need Godot 4.7.2 on PATH (CI's setup-godot puts it
 * there), and without it each test skips with the reason.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { bibleMarkdown, sampleProfile, tempProject } from "@clockgrove/assetgrove/testing";
import type { CliResult } from "@clockgrove/assetgrove/testing";
import { GODOT_ARGS, INPUT_PATH, RESULT_PATH, projectFiles } from "../src/scratch.ts";
import type { TileSetInput } from "../src/scratch.ts";
import { GODOT_RELEASE } from "../src/setup.ts";
import { corner16Tiles } from "../src/tile-set.ts";
import { cornerAtlas, flatPng } from "./helpers/atlas.ts";
import { findGodot } from "./helpers/godot.ts";
import { buildPack, packNodeModules, tilesRoot } from "./helpers/pack.ts";
import { legalPairs, paintMap, pairsIn } from "./helpers/paint.ts";

const GODOT_PACK = "@clockgrove/assetgrove-godot";
const TILES_PACK = "@clockgrove/assetgrove-tiles";
const { godot: GODOT, skip: SKIP } = findGodot();
const usable = GODOT !== undefined;

const TILE = 16;
const TRES = "tiles/grass-dirt.tres";
const ATLAS = "tiles/grass-dirt.png";
const LOWER = [0x6b, 0x4a, 0x2b, 255];
const UPPER = [0x4d, 0x8a, 0x3c, 255];

/** Texture import options a pixel-art game sets; `process/fix_alpha_border` is not Godot's default. */
const PIXEL_IMPORT = {
  "compress/mode": 0,
  "mipmaps/generate": false,
  "process/fix_alpha_border": false,
};
let baseProfile: object = {};

const stage = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-godot-tiles-")));
const project = tempProject();
const approved: Array<Record<string, unknown>> = [];
const route = {
  provider: "scripted",
  model: "scripted/tiles",
  estimatedCostUsd: 0.01,
  outputGrant: { license: "MIT", plan: "api", commercial: true, relabel: true },
};

function settings() {
  project.writeSettings({
    extensions: [GODOT_PACK, TILES_PACK],
    extensionSettings: { [GODOT_PACK]: { godot: GODOT } },
    roles: { image: route, decisions: route },
    commands: { approved },
  });
}

after(async () => {
  project.close();
  await rm(stage, { recursive: true, force: true });
});

const git = (...args: string[]) => execFileSync("git", args, { cwd: project.dir, stdio: "ignore" });
const text = (path: string) => readFileSync(join(project.dir, path), "utf8");
const headerUid = (path: string) => /^\[gd_resource[^\]]*uid="([^"]+)"/.exec(text(path))?.[1];
const importUid = (path: string) => /^uid="(uid:\/\/[^"]+)"/m.exec(text(path))?.[1];

/** Runs a core command; a command it needs approved is added to the settings, as a person would. */
async function approving(args: string[]): Promise<CliResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await project.cli(args);
    if (result.code !== 8) return result;
    const confirmation = (result.json?.["error"] as { confirmation?: { command?: object } }) ?? {};
    const command = confirmation.confirmation?.command as
      { hash: string; kind: string; argv: string[] } | undefined;
    assert.ok(command, result.stdout + result.stderr);
    approved.push({
      hash: command.hash,
      kind: command.kind,
      argv: command.argv,
      note: "godot test",
    });
    settings();
  }
  throw new Error("the approval did not hold");
}

let handoffs = 0;
/** Stages `atlas` as the `grass-dirt` tile set and picks it into the project. */
async function handOff(atlas: Uint8Array): Promise<CliResult> {
  const n = ++handoffs;
  const script = join(stage, `script-${n}.mjs`);
  writeFileSync(
    script,
    `const bytes = Buffer.from(${JSON.stringify(Buffer.from(atlas).toString("base64"))}, "base64");
export default {
  image: () => ({ images: [{ mediaType: "image/png", bytes }] }),
  vision: () => ({ text: "{}" }),
  decide: () => ({ answer: { type: "boolean", probability: 0.9 } }),
};
`,
  );
  const staged = await approving([
    ...["stage", "--spec", join(stage, "spec.json"), "--bible", join(stage, "BIBLE.md")],
    ...["--profile", join(stage, "profile.json"), "--runs", join(stage, `runs-${n}`)],
    ...["--candidates", "1", "--provider-script", script, "--json"],
  ]);
  assert.equal(staged.code, 0, staged.stderr + staged.stdout);
  const runDir = String(staged.json?.["runDir"]);
  return approving([
    "pick",
    "--run",
    runDir,
    "--candidate",
    "c1",
    "--target",
    project.dir,
    "--json",
  ]);
}

before(async () => {
  if (!usable) return;
  const godotPack = buildPack(stage);
  const tilesPack = buildPack(stage, tilesRoot);
  const installed = project.install(godotPack, GODOT_PACK);
  symlinkSync(packNodeModules, join(installed, "node_modules"), "junction");
  project.install(tilesPack, TILES_PACK);
  // The installed pack links to the pack's dependencies; Godot must not scan into them.
  writeFileSync(join(project.dir, "node_modules", ".gdignore"), "");
  settings();
  writeFileSync(
    join(project.dir, "project.godot"),
    'config_version=5\n\n[application]\n\nconfig/name="fixture"\n',
  );
  // Core hands media off only where Git would store it in LFS.
  writeFileSync(join(project.dir, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
  git("add", "project.godot", ".gitattributes");
  git("commit", "--quiet", "-m", "a godot project");
  const profile = sampleProfile({
    kinds: { "tiles:terrain": { tileSize: TILE } },
    layout: {
      media: "tiles/{{spec.assetId}}.{{output.extension}}",
      manifest: "tiles/manifests/{{spec.assetId}}.json",
    },
    handoff: [
      { preset: "manifest" },
      {
        preset: "godot:tile-set",
        options: { resource: "tiles/{assetId}.tres", import: PIXEL_IMPORT },
      },
    ],
  });
  baseProfile = profile;
  writeFileSync(join(stage, "profile.json"), JSON.stringify(profile));
  writeFileSync(join(stage, "BIBLE.md"), bibleMarkdown());
  writeFileSync(
    join(stage, "spec.json"),
    JSON.stringify({
      kind: "tiles:terrain",
      assetId: "grass-dirt",
      fields: { terrains: { lower: "dirt", upper: "grass" } },
    }),
  );
});

/** Runs a GDScript in the project after importing it, failing on any ERROR; returns its output. */
function godotScript(name: string, source: string): string {
  const script = join(stage, name);
  writeFileSync(script, source);
  const godot = (...args: string[]) =>
    spawnSync(GODOT!, ["--headless", "--path", project.dir, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  const imports = godot("--import");
  assert.doesNotMatch(imports.stdout + imports.stderr, /ERROR/);
  const run = godot("--script", script);
  const out = run.stdout + run.stderr;
  assert.doesNotMatch(out, /ERROR/, out);
  return out;
}

/** What the TileSet holds, as Godot reads it: one `KEY value` line per fact. */
function describe(): Record<string, string> {
  const out = godotScript(
    "describe.gd",
    `extends SceneTree
func _initialize():
\tvar ts = load("res://${TRES}") as TileSet
\tprint("SOURCES ", ts.get_source_count())
\tprint("TERRAIN_SETS ", ts.get_terrain_sets_count())
\tprint("MODE ", ts.get_terrain_set_mode(0) == TileSet.TERRAIN_MODE_MATCH_CORNERS)
\tprint("TERRAINS ", ts.get_terrain_name(0, 0), ",", ts.get_terrain_name(0, 1))
\tprint("PHYSICS ", ts.get_physics_layers_count())
\tprint("CUSTOM ", ts.get_custom_data_layers_count())
\tfor i in ts.get_source_count():
\t\tvar id = ts.get_source_id(i)
\t\tvar source = ts.get_source(id)
\t\tif source is TileSetAtlasSource and source.texture != null:
\t\t\tprint("SOURCE ", source.texture.resource_path, " ", id, " ", source.get_tiles_count())
\tvar own = null
\tfor i in ts.get_source_count():
\t\tvar source = ts.get_source(ts.get_source_id(i))
\t\tif source is TileSetAtlasSource and source.texture.resource_path == "res://${ATLAS}":
\t\t\town = source
\tvar bits = []
\tfor index in 16:
\t\tvar data = own.get_tile_data(Vector2i(index % 4, index / 4), 0)
\t\tbits.append("%d:%d%d%d%d%d" % [index, data.terrain, data.get_terrain_peering_bit(TileSet.CELL_NEIGHBOR_TOP_LEFT_CORNER), data.get_terrain_peering_bit(TileSet.CELL_NEIGHBOR_TOP_RIGHT_CORNER), data.get_terrain_peering_bit(TileSet.CELL_NEIGHBOR_BOTTOM_LEFT_CORNER), data.get_terrain_peering_bit(TileSet.CELL_NEIGHBOR_BOTTOM_RIGHT_CORNER)])
\tprint("BITS ", ",".join(bits))
\tprint("ALTERNATIVES ", own.get_alternative_tiles_count(Vector2i(0, 0)))
\tif ts.get_custom_data_layers_count() > 0:
\t\tprint("KIND ", own.get_tile_data(Vector2i(0, 0), 0).get_custom_data("kind"))
\tquit()
`,
  );
  return Object.fromEntries(
    [...out.matchAll(/^([A-Z_]+) (.*)$/gm)].map((m) => [
      m[1] === "SOURCE" ? `SOURCE ${m[2]!.split(" ")[0]}` : m[1]!,
      m[1] === "SOURCE" ? m[2]!.split(" ").slice(1).join(" ") : m[2]!,
    ]),
  );
}

/** The layout's terrain data, as `describe` prints it: centre, then NW, NE, SW, SE. */
const LAYOUT_BITS = corner16Tiles()
  .map(
    (tile, index) =>
      `${index}:${tile.terrain}${tile.peering.nw}${tile.peering.ne}${tile.peering.sw}${tile.peering.se}`,
  )
  .join(",");

let atlasImport = "";

test("a new TileSet from a fixture atlas: one Match Corners terrain set and every tile's peering bits", async (t) => {
  if (!usable) return t.skip(SKIP!);
  const done = await handOff(cornerAtlas(TILE, LOWER, UPPER));
  assert.equal(done.code, 0, done.stderr + done.stdout);
  assert.deepEqual(
    (done.json?.["handoff"] as Array<{ preset: string; files: string[] }>).find(
      (h) => h.preset === "godot:tile-set",
    )?.files,
    [TRES, `${ATLAS}.import`],
  );
  // A profile that is not pixel art gets no filter warning, whatever the project's filter.
  assert.equal(tileSetEntry(done)?.warnings, undefined);
  assert.ok(headerUid(TRES));
  atlasImport = text(`${ATLAS}.import`);
  // The new atlas's .import carries the preset's import options, as Godot wrote them.
  assert.match(atlasImport, /^compress\/mode=0$/m);
  assert.match(atlasImport, /^mipmaps\/generate=false$/m);
  assert.match(atlasImport, /^process\/fix_alpha_border=false$/m);
  const uid = importUid(`${ATLAS}.import`);
  assert.ok(uid);
  assert.match(
    text(TRES),
    new RegExp(`\\[ext_resource [^\\]]*uid="${uid}"[^\\]]*path="res://${ATLAS}"`),
  );
  const seen = describe();
  assert.equal(seen["SOURCES"], "1");
  assert.equal(seen["TERRAIN_SETS"], "1");
  assert.equal(seen["MODE"], "true");
  assert.equal(seen["TERRAINS"], "dirt,grass");
  assert.equal(seen[`SOURCE res://${ATLAS}`], "0 16");
  assert.equal(seen["BITS"], LAYOUT_BITS);
});

test("Godot paints a map holding every legal neighbour pair with the TileSet, each cell the expected tile", (t) => {
  if (!usable) return t.skip(SKIP!);
  const map = paintMap();
  // The map holds every legal pair, and its expected tiles only legal ones.
  assert.deepEqual([...pairsIn(map.expected)].sort(), [...legalPairs()].sort());
  const cells = join(stage, "paint.json");
  writeFileSync(cells, JSON.stringify(map));
  const out = godotScript(
    "paint.gd",
    `extends SceneTree
func _initialize():
\tvar map = JSON.parse_string(FileAccess.get_file_as_string(${JSON.stringify(cells.replaceAll("\\", "/"))}))
\tvar layer := TileMapLayer.new()
\tlayer.tile_set = load("res://${TRES}")
\tfor y in int(map["height"]):
\t\tfor x in int(map["width"]):
\t\t\tlayer.set_cell(Vector2i(x, y), 0, Vector2i(0, 0))
\tvar painted: Array[Vector2i] = []
\tfor cell in map["painted"]:
\t\tpainted.append(Vector2i(int(cell[0]), int(cell[1])))
\tlayer.set_cells_terrain_connect(painted, 0, 1)
\tvar rows = []
\tfor y in int(map["height"]):
\t\tvar row = []
\t\tfor x in int(map["width"]):
\t\t\tvar coords := layer.get_cell_atlas_coords(Vector2i(x, y))
\t\t\trow.append(coords.x + 4 * coords.y if layer.get_cell_source_id(Vector2i(x, y)) == 0 else -1)
\t\trows.append(row)
\tprint("PAINTED ", JSON.stringify(rows))
\tlayer.free()
\tquit()
`,
  );
  const line = /^PAINTED (.*)$/m.exec(out)?.[1];
  assert.ok(line, out);
  const painted = JSON.parse(line) as number[][];
  const wrong: string[] = [];
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++)
      if (painted[y]?.[x] !== map.expected[y]![x])
        wrong.push(`(${x}, ${y}): ${painted[y]?.[x]}, expected ${map.expected[y]![x]}`);
  assert.deepEqual(wrong, []);
});

test("a re-hand-off keeps a developer-added physics layer, custom-data layer, second source and alternative tile", async (t) => {
  if (!usable) return t.skip(SKIP!);
  mkdirSync(join(project.dir, "tiles"), { recursive: true });
  writeFileSync(join(project.dir, "tiles", "rock.png"), flatPng(TILE, [0x80, 0x80, 0x80, 255]));
  const uid = headerUid(TRES);
  assert.ok(uid);
  // Godot's editor keeps a resource's UID when it saves; a headless ResourceSaver.save over an
  // existing file does not, so the edit puts it back as the editor would.
  godotScript(
    "edit.gd",
    `extends SceneTree
func _initialize():
\tvar ts = load("res://${TRES}") as TileSet
\tts.add_physics_layer()
\tts.set_physics_layer_collision_layer(0, 4)
\tts.add_custom_data_layer()
\tts.set_custom_data_layer_name(0, "kind")
\tts.set_custom_data_layer_type(0, TYPE_STRING)
\tvar own = ts.get_source(0) as TileSetAtlasSource
\town.create_alternative_tile(Vector2i(0, 0))
\town.get_tile_data(Vector2i(0, 0), 0).set_custom_data("kind", "dirt")
\tvar rock := TileSetAtlasSource.new()
\trock.texture = load("res://tiles/rock.png")
\trock.texture_region_size = Vector2i(${TILE}, ${TILE})
\tts.add_source(rock, 7)
\trock.create_tile(Vector2i(0, 0))
\tvar saved = ResourceSaver.save(ts, "res://${TRES}")
\tif saved != OK:
\t\tpush_error("could not save")
\telif ResourceSaver.set_uid("res://${TRES}", ResourceUID.text_to_id("${uid}")) != OK:
\t\tpush_error("could not keep the UID")
\tquit()
`,
  );
  const edited = describe();
  assert.equal(edited["SOURCES"], "2");
  assert.equal(headerUid(TRES), uid);

  const done = await handOff(cornerAtlas(TILE, LOWER, UPPER));
  assert.equal(done.code, 0, done.stderr + done.stdout);
  const seen = describe();
  assert.equal(seen["SOURCES"], "2");
  assert.equal(seen[`SOURCE res://${ATLAS}`], "0 16");
  assert.equal(seen["SOURCE res://tiles/rock.png"], "7 1");
  assert.equal(seen["PHYSICS"], "1");
  assert.equal(seen["CUSTOM"], "1");
  assert.equal(seen["KIND"], "dirt");
  assert.equal(seen["ALTERNATIVES"], "2");
  assert.equal(seen["TERRAIN_SETS"], "1");
  assert.equal(seen["BITS"], LAYOUT_BITS);
  assert.equal(headerUid(TRES), uid);
});

test("a replaced atlas keeps the TileSet's UID, and its existing .import is never touched", async (t) => {
  if (!usable) return t.skip(SKIP!);
  // The developer changed an option of the atlas's .import: the profile's `import` would set it
  // back, so an unchanged file shows the options never reach an existing .import.
  const edited = atlasImport.replace(
    /^process\/fix_alpha_border=false$/m,
    "process/fix_alpha_border=true",
  );
  assert.notEqual(edited, atlasImport);
  writeFileSync(join(project.dir, `${ATLAS}.import`), edited);
  git("add", `${ATLAS}.import`);
  git("commit", "--quiet", "-m", "the developer's own atlas import option");
  atlasImport = edited;
  const before = readFileSync(join(project.dir, ATLAS));
  const uid = headerUid(TRES);
  assert.ok(uid);
  const done = await handOff(cornerAtlas(TILE, [0x30, 0x30, 0x60, 255], [0xd0, 0xc0, 0x70, 255]));
  assert.equal(done.code, 0, done.stderr + done.stdout);
  assert.notDeepEqual(readFileSync(join(project.dir, ATLAS)), before);
  assert.deepEqual(
    (done.json?.["handoff"] as Array<{ preset: string; files: string[] }>).find(
      (h) => h.preset === "godot:tile-set",
    )?.files,
    [TRES],
  );
  assert.equal(headerUid(TRES), uid);
  assert.equal(text(`${ATLAS}.import`), atlasImport);
  const seen = describe();
  assert.equal(seen["SOURCES"], "2");
  assert.equal(seen["BITS"], LAYOUT_BITS);
});

/** The `godot:tile-set` entry of a hand-off's result. */
const tileSetEntry = (done: CliResult) =>
  (done.json?.["handoff"] as Array<{ preset: string; files: string[]; warnings?: string[] }>).find(
    (h) => h.preset === "godot:tile-set",
  );

test("a pixel-art profile warns when the project's default texture filter is not Nearest, and never edits project.godot", async (t) => {
  if (!usable) return t.skip(SKIP!);
  const pixelArt = {
    ...baseProfile,
    style: {
      edges: "crisp",
      color: { rule: "palette", palette: ["#6b4a2b", "#4d8a3c"] },
    },
  };
  const godotFile = join(project.dir, "project.godot");
  try {
    writeFileSync(join(stage, "profile.json"), JSON.stringify(pixelArt));
    // The fixture project leaves the filter at Godot's default, Linear.
    const linear = readFileSync(godotFile);
    const warned = await handOff(cornerAtlas(TILE, LOWER, UPPER));
    assert.equal(warned.code, 0, warned.stderr + warned.stdout);
    const warnings = tileSetEntry(warned)?.warnings ?? [];
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0]!, /rendering\/textures\/canvas_textures\/default_texture_filter/);
    assert.match(warnings[0]!, /Linear \(1\)/);
    assert.match(warnings[0]!, /Nearest \(0\)/);
    assert.deepEqual(readFileSync(godotFile), linear);

    const nearest = `${linear.toString()}\n[rendering]\n\ntextures/canvas_textures/default_texture_filter=0\n`;
    writeFileSync(godotFile, nearest);
    git("commit", "--quiet", "-am", "nearest filtering");
    const quiet = await handOff(cornerAtlas(TILE, LOWER, UPPER));
    assert.equal(quiet.code, 0, quiet.stderr + quiet.stdout);
    assert.equal(tileSetEntry(quiet)?.warnings, undefined);
    assert.equal(text("project.godot"), nearest);
  } finally {
    writeFileSync(join(stage, "profile.json"), JSON.stringify(baseProfile));
  }
});

/** Lays out a scratch project with `files` and the build input, and runs the build script there. */
function buildInScratch(
  name: string,
  input: Partial<TileSetInput>,
  files: Record<string, string | Uint8Array> = {},
) {
  const scratch = join(stage, name);
  const full: TileSetInput = {
    build: "tile-set",
    godot: GODOT_RELEASE.release,
    resource: "res://built.tres",
    existing: false,
    texture: "res://atlas.png",
    fresh: [],
    options: {},
    imports: ["res://atlas.png"],
    tileSize: TILE,
    terrains: { lower: "dirt", upper: "grass" },
    tiles: corner16Tiles(),
    ...input,
  };
  const all = {
    ...projectFiles(),
    "atlas.png": cornerAtlas(TILE, LOWER, UPPER),
    ...files,
    [INPUT_PATH]: JSON.stringify(full),
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    writeFileSync(join(scratch, path), content);
  }
  const run = spawnSync(GODOT!, GODOT_ARGS, { cwd: scratch, encoding: "utf8" });
  const result = JSON.parse(readFileSync(join(scratch, RESULT_PATH), "utf8")) as {
    ok: boolean;
    errors: string[];
    terrainSet?: number;
  };
  return { scratch, run, result };
}

test("a deliberately wrong peering bit fails the read-back", (t) => {
  if (!usable) return t.skip(SKIP!);
  const tiles = corner16Tiles();
  // Tile 5 is NW and SW upper: its NE bit is the lower terrain.
  tiles[5]!.peering.ne = 1;
  const { run, result } = buildInScratch("wrong-bit", { resource: "res://wrong.tres", tiles });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "tile 5 of res://wrong.tres loaded back with its ne peering bit 1; the layout gives 0",
  ]);
  assert.match(run.stdout + run.stderr, /ERROR: assetgrove-godot: tile 5 of res:\/\/wrong\.tres/);
});

test("an existing TileSet's own terrain sets are kept, and the preset's tiles get a Match Corners set of its own", (t) => {
  if (!usable) return t.skip(SKIP!);
  // A developer's TileSet: set 0 is Match Sides, set 1 Match Corners with unrelated terrains.
  const existing = `[gd_resource type="TileSet" format=3]

[resource]
terrain_set_0/mode = 2
terrain_set_0/terrain_0/name = "water"
terrain_set_0/terrain_0/color = Color(0, 0, 1, 1)
terrain_set_0/terrain_1/name = "sand"
terrain_set_0/terrain_1/color = Color(1, 1, 0, 1)
terrain_set_1/mode = 1
terrain_set_1/terrain_0/name = "stone"
terrain_set_1/terrain_0/color = Color(0.5, 0.5, 0.5, 1)
terrain_set_1/terrain_1/name = "lava"
terrain_set_1/terrain_1/color = Color(1, 0, 0, 1)
`;
  const { scratch, run, result } = buildInScratch(
    "developer-terrains",
    { resource: "res://developer.tres", existing: true },
    { "developer.tres": existing },
  );
  assert.equal(result.ok, true, run.stdout + run.stderr);
  assert.equal(result.terrainSet, 2);
  const script = join(stage, "developer-terrains.gd");
  writeFileSync(
    script,
    `extends SceneTree
func _initialize():
\tvar ts = load("res://developer.tres") as TileSet
\tfor index in ts.get_terrain_sets_count():
\t\tprint("SET ", index, " ", ts.get_terrain_set_mode(index), " ", ts.get_terrain_name(index, 0), ",", ts.get_terrain_name(index, 1))
\tquit()
`,
  );
  const read = spawnSync(GODOT!, ["--headless", "--path", scratch, "--script", script], {
    encoding: "utf8",
  });
  const out = read.stdout + read.stderr;
  assert.doesNotMatch(out, /ERROR/, out);
  assert.deepEqual(
    [...out.matchAll(/^SET (.*)$/gm)].map((m) => m[1]),
    ["0 2 water,sand", "1 1 stone,lava", "2 1 dirt,grass"],
  );
});
