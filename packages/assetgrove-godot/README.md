# @clockgrove/assetgrove-godot

The Godot pack for Assetgrove: Godot builds or imports the hand-off's resources itself, a SpriteFrames of a character's animations, a TileSet of a terrain tile set, or the import of a 3D character's `.glb`. Copying files into a Godot project is not enough, because Godot's exit codes do not report import errors and a hand-written `.tres` with a wrong UID breaks silently in the editor. So this pack never writes a Godot resource by hand: a pinned, headless Godot 4.7.2 builds each one through its own API, saves it with `ResourceSaver` and loads it back with `ResourceLoader`.

## Extension API

The package declares `"assetgrove": { "api": 2 }` and a peer range on `@clockgrove/assetgrove`. It imports only core's public exports: its types from `@clockgrove/assetgrove/extension` and, in its tests, the pack test kit `@clockgrove/assetgrove/testing` (a temporary project, core's CLI and the conformance suite in `test/conformance.test.ts`). The tests run with `node --conditions=assetgrove-source`, which resolves the linked core to its TypeScript source.

It declares, as extension `godot`:

- the preset `godot:sprite-frames` (scope `families`);
- the preset `godot:tile-set`, for a `tiles:terrain` asset of the tiles pack;
- the preset `godot:gltf`, for a `character-3d` asset or any `.glb`;
- the tool `godot:engine`, the Godot executable at the pack setting `godot`;
- a setup, `assetgrove extensions setup godot`.

## Install

List the package in the developer settings and name the Godot it runs:

```json
{
  "extensions": ["@clockgrove/assetgrove-godot"],
  "extensionSettings": {
    "@clockgrove/assetgrove-godot": { "godot": "/opt/godot/Godot_v4.7.2-stable_linux.x86_64" }
  }
}
```

`assetgrove extensions setup godot` uses the binary that setting names; it does not run it, so it reports no `version` for it, and each hand-off's build script fails (`this is Godot …, not the pinned 4.7.2-stable`) unless `Engine.get_version_info()` says 4.7.2-stable. Without one, it downloads Godot 4.7.2 for this system from Godot's GitHub release (Linux x86_64 and arm64, macOS universal, Windows x86_64 and arm64, the console executable on Windows) through core's pinned download, checks it against the SHA512 the pack ships (`src/godot-release.json`, copied from the release's `SHA512-SUMS.txt`), unpacks it under `<stateDir>/models/godot/4.7.2-stable/<system>/` and returns its path under `godot`. Setup writes no settings: put that path in `extensionSettings["@clockgrove/assetgrove-godot"].godot`.

## The `godot:sprite-frames` preset

One SpriteFrames per asset, holding every animation family handed off so far: handing off `attack` after `idle` and `walk` gives one resource with all three. Each family is an animation named after it, each frame an `AtlasTexture` region of the family's strip.

```json
{
  "handoff": [
    { "preset": "manifest" },
    {
      "preset": "godot:sprite-frames",
      "options": { "project": "game", "resource": "game/characters/{assetId}.tres" }
    }
  ]
}
```

| Option     | Default          | What                                                                                                                                  |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `project`  | `""`             | The Godot project's folder (where `project.godot` is), relative to the target. The media must be inside it.                           |
| `resource` | `{assetId}.tres` | The SpriteFrames, relative to the target, `{assetId}` replaced; inside the project, ending in `.tres`.                                |
| `loop`     | `true`           | Whether each animation loops.                                                                                                         |
| `import`   | `{}`             | Godot texture import options by their `.import` key, applied to new strips only ([Import options](#import-options-for-new-2d-files)). |

Frames are the profile's `frames.width` × `frames.height`, side by side in each strip; Godot counts them from the texture's width. Each animation plays at `1000 / frames.durationMs` frames per second (10 without a duration).

### What a hand-off runs

1. The preset lays out a scratch Godot project: the pack's own `project.godot` (never the game's, which can name autoloads and plugins), its build script `src/build.gd` (in `dist/` once built) as the project's one editor plugin, each family's media at its path in the game's project, each existing `.import` of that media, and `input.json` with the resource's path, the UID the target's resource already has (read from its header as text) and the animations.
2. Core runs Godot in that scratch folder, outside the game project, under its tool rules ([docs/extensions.md](../../docs/extensions.md#tools)): `godot --headless --editor -- project.godot addons/assetgrove_godot/plugin.cfg addons/assetgrove_godot/build.gd`. The arguments after `--` are Godot's user arguments, which it ignores; they name the files whose bytes the run's approval hashes, so a changed script asks again. The media and the input are data no argument names, so one approval holds for every asset. Headless settings need the run in `commands.approved`; attended, a person approves it once.
3. The script fails unless the running Godot is 4.7.2-stable. Godot's editor imports the media. The script builds the SpriteFrames through Godot's API, saves it with `ResourceSaver` (keeping the earlier UID with `ResourceSaver.set_uid`), reloads it with `ResourceLoader` and checks that every animation came back with its frames.
4. The run fails, exit 6 `handoff_check_failed` with nothing written, on any `ERROR` line in Godot's output (`ERROR:`, or any type before it: `SCRIPT ERROR:`, `USER ERROR:`, `SHADER ERROR:` and the rest), on a resource that does not load back, or when Godot leaves no result, whatever its exit code.
5. The preset returns what Godot saved: the resource, and for each source file the target has no `.import` for, the `.import` that scratch import produced, so its UID matches the resource's reference. Core writes them with the media, under its path checks and the hand-off's confirmation. An existing `.import` is never returned, so it is never touched; a replaced resource keeps its UID.

Scratch is removed after the run, but Godot's editor, like any editor launch, also writes to the user's own Godot folders, which core's tool run does not redirect: its editor settings and caches (on Linux `~/.config/godot/editor_settings-4.7.tres` and `~/.cache/godot/`; on macOS `~/Library/Application Support/Godot/` and `~/Library/Caches/Godot/`; on Windows `%APPDATA%\Godot\`) and the scratch project's user data folder `app_userdata/assetgrove-godot/` there, which can keep a `.recovery_mode_lock`. They hold no target data; delete them freely.

The preset's check reads the written resource back: a SpriteFrames with a UID, referencing each family's media by the UID its `.import` gives it.

## The `godot:tile-set` preset

One Godot `TileSet` per `tiles:terrain` asset (the [tiles pack](../assetgrove-tiles/README.md)'s corner-16 terrain set: one atlas of 4 × 4 tiles, `output.fields.layout` `corner-16`). Any other asset is invalid input (exit 2).

```json
{
  "handoff": [
    { "preset": "manifest" },
    {
      "preset": "godot:tile-set",
      "options": { "project": "game", "resource": "game/tiles/{assetId}.tres" }
    }
  ]
}
```

| Option     | Default          | What                                                                                                                                   |
| ---------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `project`  | `""`             | The Godot project's folder (where `project.godot` is), relative to the target. The atlas must be inside it.                            |
| `resource` | `{assetId}.tres` | The TileSet, relative to the target, `{assetId}` replaced; inside the project, ending in `.tres`.                                      |
| `import`   | `{}`             | Godot texture import options by their `.import` key, applied to a new atlas only ([Import options](#import-options-for-new-2d-files)). |

The preset reads the corner-16 layout as data: tile `i` sits at column `i % 4`, row `floor(i / 4)`, its corner bits NW 1, NE 2, SW 4, SE 8 set where the corner is the upper terrain. The tile size is `output.fields.tileSize` (else the profile's `kinds["tiles:terrain"].tileSize`), and the terrains are the spec's `fields.terrains`.

- **A new `.tres`** has a `tile_size` of the tile size, one terrain set in Match Corners mode with terrain 0 the lower terrain and terrain 1 the upper (named after them), and one atlas source (id 0) of the atlas. Each of the 16 tiles has terrain set 0, a peering bit on each corner (0 lower, 1 upper), and a centre terrain that is the upper only when all four corners are: every mixed tile is lower-centred, so Godot's terrain painting makes a painted cell the all-upper tile.
- **An existing `.tres`** is loaded, and only the atlas source the preset owns changes: the `TileSetAtlasSource` whose texture is the asset's atlas (a new one at the next source id when there is none). Its texture, region size and tiles change: a missing tile is created, and each tile's base tile gets the preset's terrain set, its centre terrain and its peering bits; its other data stays. Every other source, terrain set, physics, navigation and custom-data layer, and every alternative tile a developer added, is kept, as is the `tile_size`. The preset's terrain set is the Match Corners terrain set the owned source's tiles already use (an earlier hand-off's), else a Match Corners set whose terrains 0 and 1 are named after the lower and upper terrains, else a new Match Corners set of the preset's own (terrain 0 lower, 1 upper), added after the developer's sets. A developer's terrain sets are never changed, and never reused for terrains they do not name. A TileSet with no terrain set so gets the new file's, as set 0.

### What a hand-off runs

As for `godot:sprite-frames`, with the same tool run, approval and failures (exit 6 `handoff_check_failed` on a load error, any `ERROR` line, or no result):

1. Scratch holds the pack's project and build script, the atlas this hand-off writes (core passes its bytes, as the preset cannot read them from the target yet), the atlas's existing `.import`, and, for an existing `.tres`, the `.tres` and every file it references at its path in the project (followed through referenced `.tres` and `.tscn` files), each with its `.import`, so Godot loads it as the game does. A referenced file the target lacks fails the run with Godot's load error. `input.json` names the resource, the UID it already has, the atlas, the tile size, the terrains and the 16 tiles' terrain data.
2. Godot's editor imports the atlas and the references. The script builds the TileSet through Godot's API, saves it with `ResourceSaver`, keeping the earlier UID with `ResourceSaver.set_uid`.
3. **The hand-off check**: the script reloads the saved TileSet with `ResourceLoader` and reads back every tile of the owned source against the corner-16 layout, which it computes from each tile's index rather than from the input: the preset's terrain set (which must load back in Match Corners mode), the centre terrain and the four peering bits. One wrong bit fails the run, naming the tile and the corner.
4. The preset returns the TileSet, and the atlas's `.import` only when the target had none. An existing `.import` is never returned, so it is never touched; a replaced atlas keeps the TileSet's UID and the atlas's.

The preset's check reads the written resource back: a TileSet with a UID, referencing the atlas by the UID its `.import` gives it.

## Import options for new 2D files

Godot writes a new source file's `.import` with its default import options. A pixel-art game wants lossless compression and no mipmaps, so `godot:sprite-frames` and `godot:tile-set` take `import`: Godot texture import options by their `.import` key, with string, number or boolean values (an integral number becomes an int), as `godot:gltf` takes scene options.

```json
{
  "preset": "godot:sprite-frames",
  "options": {
    "resource": "characters/{assetId}.tres",
    "import": { "compress/mode": 0, "mipmaps/generate": false }
  }
}
```

The options apply only to a source file the target has no `.import` for: a new strip or a new atlas. In scratch, Godot's editor imports it, and the build script writes the options into the `.import` Godot made, through `ConfigFile`. It then reimports the file and reads each value back. A value Godot does not keep fails the hand-off (exit 6). The preset returns that `.import`, so the game gets the file Godot wrote. An existing `.import` reaches scratch as data and is never returned, so it is left byte for byte, its options and UID as they were.

## The texture filter warning

In Godot 4 the texture filter is not an import option. It is the project setting `rendering/textures/canvas_textures/default_texture_filter`, and its default, Linear, blurs pixel art. When the target profile's style is pixel art (`style.edges` `crisp` and `style.color.rule` `palette`), `godot:sprite-frames` and `godot:tile-set` read the game's `project.godot` as data, at their `project` folder. If its default texture filter is anything but Nearest (`0`), the hand-off result carries a warning under the preset's entry, `handoff[i].warnings`. That covers an unset filter (Godot's default, Linear) as well as Linear (`1`), Linear Mipmap (`2`) and Nearest Mipmap (`3`). `pick`, `library adopt` and `write-families` print it as a `warning:` line:

```
warning: godot:sprite-frames: project.godot leaves rendering/textures/canvas_textures/default_texture_filter at Godot's default, Linear (1); a pixel-art profile (style.edges crisp, a palette) wants Nearest (0): set it in Project Settings > Rendering > Textures > Canvas Textures > Default Texture Filter, or add textures/canvas_textures/default_texture_filter=0 under [rendering]
```

The warning never fails the hand-off, and the pack never edits `project.godot`: the setting is the game's. A profile that is not pixel art, a project set to Nearest, or a target without `project.godot` at the project folder gets no warning. `godot:gltf` gives none.

## The `godot:gltf` preset

One hand-off of a `character-3d` asset's `.glb`, or of any `.glb` (`output.mediaType` `model/gltf-binary`, or a media path ending in `.glb`). Anything else is invalid input (exit 2). The preset writes no `.tscn`.

```json
{
  "handoff": [
    { "preset": "manifest" },
    {
      "preset": "godot:gltf",
      "options": { "project": "game", "import": { "nodes/root_type": "CharacterBody3D" } }
    }
  ]
}
```

| Option    | Default | What                                                                                                                                                                                                                                     |
| --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project` | `""`    | The Godot project's folder (where `project.godot` is), relative to the target. The `.glb` must be inside it.                                                                                                                             |
| `import`  | `{}`    | Godot scene import options by their `.import` key, with string, number or boolean values, e.g. `{ "nodes/root_type": "CharacterBody3D", "animation/import": true }`. An integral number becomes an int. They apply to a new source only. |

### What a hand-off runs

As for `godot:sprite-frames`, with the same pinned Godot 4.7.2, setup, `godot:engine` tool approval and failures:

1. Scratch holds the pack's project and build script, the `.glb` (core passes its bytes), its existing `.import` if the target has one, and the run's input with the `import` options as data.
2. Godot's editor imports the `.glb` in scratch. For a new source, the build script writes the `import` options into the `.import` Godot made, through `ConfigFile`, and reimports it. An existing `.import` reaches scratch as data, so Godot imports with its options and UID, and the `import` options do not apply.
3. **The hand-off check**: the run fails, exit 6 `handoff_check_failed` with nothing written, on a load error, on any `ERROR` line, or when the imported scene lacks what the asset declares: every animation family as an animation of the same name, and a `Skeleton3D` with the asset's joint count (an unskinned `.glb` declares no joints and needs none). It also fails when the scene has more `MeshInstance3D` meshes than the asset declares (the glTF nodes with a mesh in the scene).
4. The asset declares its animations by `output.clips[].name` and its joints by `output.bones`, when the hand-off gives them (a `character-3d` asset does). Otherwise, and when the profile's `model3d.handoff.clipFields` shapes the clips without a `name`, they are read from the file through Godot's `GLTFDocument`: its animation names, and the unique joints over every skin.
5. Core writes the `.glb`. The preset returns only the new source's `.import` that Godot made in scratch, with the options. An existing `.import` is never returned, so it is never touched; a replaced `.glb` keeps its UID.

## Tests

`pnpm test` runs the conformance suite (with a scripted tool run), setup, the output readers and what `godot:tile-set` hands Godot (`test/tile-set-input.test.ts`) anywhere. `test/gltf.test.ts` hands a synthetic skinned `.glb` (built with glTF Transform) off with `godot:gltf`, its `write` and `check` run with a tool runner that does what core's does: two animations imported with both and the options in the new `.import`, a declared animation the file lacks failing and named, a re-hand-off keeping the UID and the existing `.import` byte for byte, a GLB with no declared facts checked against its own, clips shaped without a `name` read from the file, an unskinned GLB handed off, and more meshes than declared failing. `test/texture-filter.test.ts` reads `project.godot` files and checks when the filter warning is given. `test/godot.test.ts` hands strips off to a fixture Godot project through core's CLI, with `import` options that each new strip's `.import` carries and that leave the existing `.import` files byte for byte, and `test/tile-set.test.ts` hands corner-16 atlases off with the tiles pack, built from `packages/assetgrove-tiles` and installed beside this one: a new TileSet from a fixture atlas, a re-hand-off that keeps a developer-added physics layer, custom-data layer, second source and alternative tile, a replaced atlas keeping its UID, a deliberately wrong peering bit failing the read-back, the new atlas's `.import` carrying the `import` options, the filter warning for a pixel-art profile with a Linear project and none with Nearest or a profile that is not pixel art (with `project.godot` left as it was), an existing TileSet whose own terrain sets (a Match Sides set and an unrelated Match Corners set) are kept while the preset adds its own, and the paint test. The paint test has Godot paint, with `TileMapLayer.set_cells_terrain_connect`, a map holding every neighbour pair Godot's terrain painting can make (every pair whose shared corners agree and each of whose upper corners belongs to a cell that can be all upper; the test enumerates them) and compares `get_cell_atlas_coords` of every cell with the expected map, where a corner is upper exactly where a painted cell touches it. These tests need Godot: they run the first Godot 4.7.2 on `PATH` (as `godot`, or by the release's own executable name; on Windows only an `.exe`), which CI's `chickensoft-games/setup-godot` step puts there, and skip with the reason without one. The tests read no environment variable of their own: core allows a fixed list (`test/env-names.test.ts`).
