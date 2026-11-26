# @clockgrove/assetgrove-godot

The Godot pack for Assetgrove: Godot builds or imports the hand-off's resources itself, a SpriteFrames of a character's animations, a TileSet of a terrain tile set, or the import of a 3D character's `.glb`. Copying files into a Godot project is not enough, because Godot's exit codes do not report import errors and a hand-written `.tres` with a wrong UID breaks silently in the editor. So this pack never writes a Godot resource by hand: a pinned, headless Godot 4.7.2 builds each one through its own API, saves it with `ResourceSaver` and loads it back with `ResourceLoader`.

The [launch guide](../../docs/launch-guide.md) walks the whole workflow on a synthetic game: generated, hand-drawn and third-party art into a Godot project, with review, provenance, licence records, where data goes and what disclosure cannot promise. The pack is an independent project, not affiliated with or endorsed by the Godot Engine project or the Godot Foundation.

## Extension API

The package declares `"assetgrove": { "api": 3 }` and a peer range on `@clockgrove/assetgrove`. It imports only core's public exports: its types from `@clockgrove/assetgrove/extension` and, in its tests, the pack test kit `@clockgrove/assetgrove/testing` (a temporary project, core's CLI and the conformance suite in `test/conformance.test.ts`). The tests run with `node --conditions=assetgrove-source`, which resolves the linked core to its TypeScript source.

It declares, as extension `godot`:

- the preset `godot:sprite-frames` (scope `families`);
- the preset `godot:tile-set`, for a `tiles:terrain` asset of the tiles pack;
- the preset `godot:gltf`, for a `character-3d` asset or any `.glb`;
- the tool `godot:engine`, the Godot executable at the pack setting `godot`;
- a setup, `assetgrove extensions setup godot`;
- on each of the three presets, the read-only `usage` hook: where the project's scenes and resources use an asset a pick is about to replace ([Usage before a replacement](#usage-before-a-replacement));
- on each of the three presets, the read-only `doctor` hook: `assetgrove doctor` reports orphan and duplicate UIDs, a tracked `.godot/` cache and text resources stored as LFS objects ([The doctor](#the-doctor)).

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

One SpriteFrames per asset, holding every animation family handed off so far: handing off `attack` after `idle` and `walk` gives one resource with all three. Each family is an animation named after it, each frame an `AtlasTexture` region of the family's strip. A resource that already exists is merged into, not rebuilt: the animations a developer added stay, and an animation of a family the developer edited is refused ([Re-exports and the developer's changes](#re-exports-and-the-developers-changes)).

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

1. The preset lays out a scratch Godot project: the pack's own `project.godot` (never the game's, which can name autoloads and plugins), its build script `src/build.gd` (in `dist/` once built) as the project's one editor plugin, each family's media at its path in the game's project, each existing `.import` of that media, and `input.json` with the resource's path, the UID the target's resource already has (read from its header as text) and the animations. When the target already has the resource, it goes into scratch too, with every file it references and their `.import` files (the developer's textures, say), and `input.json` says `existing` and lists the files the editor must import first. The family strips stay this hand-off's bytes, not the target's older ones.
2. Core runs Godot in that scratch folder, outside the game project, under its tool rules ([docs/extensions.md](../../docs/extensions.md#tools)): `godot --headless --editor -- project.godot addons/assetgrove_godot/plugin.cfg addons/assetgrove_godot/build.gd`. The arguments after `--` are Godot's user arguments, which it ignores; they name the files whose bytes the run's approval hashes, so a changed script asks again. The media and the input are data no argument names, so one approval holds for every asset. Headless settings need the run in `commands.approved`; attended, a person approves it once.
3. The script fails unless the running Godot is 4.7.2-stable. Godot's editor imports the media. The script builds the SpriteFrames through Godot's API, saves it with `ResourceSaver` (keeping the earlier UID with `ResourceSaver.set_uid`), reloads it with `ResourceLoader` and checks that every animation came back with its frames. For an existing resource it loads it, compares each family animation with what the preset last wrote, and stops without saving if the developer changed one; otherwise it replaces only the family animations and leaves the rest of the resource as it was.
4. The run fails, exit 6 `handoff_check_failed` with nothing written, on any `ERROR` line in Godot's output (`ERROR:`, or any type before it: `SCRIPT ERROR:`, `USER ERROR:`, `SHADER ERROR:` and the rest), on a resource that does not load back, or when Godot leaves no result, whatever its exit code.
5. The preset returns what Godot saved: the resource, and for each source file the target has no `.import` for, the `.import` that scratch import produced, so its UID matches the resource's reference. Core writes them with the media, under its path checks and the hand-off's confirmation. An existing `.import` is never returned, so it is never touched; a replaced resource keeps its UID.

Scratch is removed after the run, but Godot's editor, like any editor launch, also writes to the user's own Godot folders, which core's tool run does not redirect: its editor settings and caches (on Linux `~/.config/godot/editor_settings-4.7.tres` and `~/.cache/godot/`; on macOS `~/Library/Application Support/Godot/` and `~/Library/Caches/Godot/`; on Windows `%APPDATA%\Godot\`) and the scratch project's user data folder `app_userdata/assetgrove-godot/` there, which can keep a `.recovery_mode_lock`. They hold no target data; delete them freely.

The preset's check reads the written resource back: a SpriteFrames with a UID, referencing each family's media by the UID its `.import` gives it.

### Re-exports and the developer's changes

The preset owns the animations named after the families handed off. Every other animation in the resource is the developer's and is kept as it is, with the resource's other properties and metadata. The preset records what it wrote in the resource's metadata `assetgrove_godot` (saved as `metadata/assetgrove_godot`): for each family animation, its texture, frame count, frame width and height, speed and loop. A resource from before the record is compared with the shape the preset writes: the strip as the texture, the frame count it has, and this hand-off's frame size, speed and loop. Changing the profile's frame size, `durationMs` or `loop` between hand-offs is therefore no conflict: the comparison is with what was last written.

Before a family animation is replaced, it is compared with that record. It is a conflict when its speed or loop differs, its frame count differs, or a frame is not an `AtlasTexture` region of the recorded strip at `Rect2(i * width, 0, width, height)` of the recorded frame size with duration 1. Presets run before core writes anything, so a conflict is reported before anything is written: exit 6 `handoff_check_failed`, one problem per conflict, each starting `conflict:` and naming the animation and what differs, for example `conflict: animation "idle": speed is 3 in characters/fern.tres, the preset wrote 10`. Numbers are written the same in every Godot version: a whole number without a decimal, any other with up to three decimals, and a region as `x,y wxh`. Godot saves nothing.

The existing resource reaches the scratch project with every file it references, as data. Godot's editor runs a resource's tool script as it loads it, so a resource that carries a script, or references a script, a native library or a binary `.res` or `.scn`, is refused (exit 2) before Godot runs; the same holds for `godot:tile-set`.

To resolve one, rename the edited animation in Godot to keep it (the hand-off then adds the family's animation beside it), or delete it to take the preset's.

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

## Usage before a replacement

Before a person confirms a `pick` that replaces an asset's current version, core asks each preset of the profile for its usage of that asset and lists it in the confirmation: the TTY or MCP form, the exit 8 `confirmation_required` record and `assetgrove confirm` show it under `details.usage` and in the summary. The three Godot presets answer with one scan of the preset's `project`, which needs no Godot:

- **The asset.** Its `res://` path is the media's path inside the project, and its UID is the `uid` under `[remap]` in the media's `.import`, when it has one.
- **What is read.** Every `.tscn` and `.tres` under the project, outside Godot's `.godot/` folder, as text, and every `.import`, `.uid` sidecar (a script's or shader's, Godot 4.4+) and scene or resource header for the project's UIDs. A reference is the asset's when it names its UID, or its `res://` path with no UID or a UID the project does not know. Godot resolves a UID before a path, so a UID that names another file makes the reference that file's. Both `[ext_resource]` lines and quoted `"res://…"` or `"uid://…"` values count. A path to one of the project's folders resolves, and a `res://file::SubResource` path resolves as its file does. Only direct references are listed: a scene that reaches the asset only through another resource is not.
- **What it reports.** Each reference's file, line, path and UID as written, and where the file uses it: each `ExtResource("id")` as a node path and property (`node "Level/Player" texture`, `node "Level/Enemy" instance`), a sub-resource (`sub_resource "AtlasTexture_1" atlas`) or `resource`. A reference whose UID and path both resolve to nothing is `unresolved`, as it may be the asset. A binary `.scn` or `.res`, or a text file that cannot be read, is `unreadable`. The summary marks both as `UNRESOLVED` and `UNREADABLE`.
- **Read-only, cached outside the project.** The scan writes nothing in the target. It keeps each file's parse in core's state directory (`<stateDir>/cache/usage/`), reused only while the file's size, modification time and change time are unchanged and the target's Git `HEAD` is the commit the cache was made at. A source edit re-reads that file, and a new revision re-reads every file. Outside Git, nothing is reused.

## The doctor

```
assetgrove doctor --profile profile.json --target .
```

Each of the three presets checks its `project` folder (where `project.godot` is; nothing is reported when it is missing) and core merges identical findings, so a profile with several Godot presets on one project lists each problem once. Every finding has an exact path (and line), what is wrong and a safe correction:

- **`orphan-uid`**: a `.uid` sidecar or `.import` whose source file is missing (delete it, or move it beside the source if the source was moved, so the UID stays); an `[ext_resource]` in a `.tscn` or `.tres` whose `uid` no file of the project defines, with its line (change it to the UID the file at its `path` really has, remove the attribute so Godot loads by path, or fix the broken path). A source that is a link to a file still counts as present, and a reference to a file whose UID the doctor cannot read (a binary `.res` or `.scn`, an LFS pointer, an unreadable file) is not reported.
- **`duplicate-uid`**: one UID defined by several `.import`, `.uid`, scene or resource files. Each file after the first (by path) is reported with how to give it a new UID: for a `.import`, remove only its `uid=` line and reimport, so its other import options stay.
- **`tracked-engine-cache`**: Git tracks files of the project's `.godot/` folder. One finding for the folder: `git rm -r --cached -- <project>/.godot`, and adding `.godot/` to the project's `.gitignore` unless it is already there.
- **`lfs-text-resource`**: a `.import`, `.uid`, `.tres`, `.tscn`, `.gd`, `.gdshader` or `project.godot` that Git routes to LFS, or that is an LFS pointer in the work tree. Godot reads these as text; as LFS objects they diff and merge as binary and a clone without LFS gets a pointer Godot cannot parse. The correction is a `/<path> -filter -diff -merge text` line (`<path>` is the file's name) at the end of the `.gitattributes` in the file's own folder, which overrides every `.gitattributes` above it and `git add --renormalize`; for a pointer, `git lfs pull --include` first.

```
game/scenes/main.tscn:3  orphan-uid
  problem: game/scenes/main.tscn line 3 references uid://oldhero, which no file of the project defines.
  correction: change uid="uid://oldhero" to uid="uid://hero1" on line 3 of game/scenes/main.tscn, or open and re-save game/scenes/main.tscn in the Godot editor
```

The doctor is read-only and needs no Godot. It reads only the presets' project folders (never `.godot/`) through core, asks Git with `GIT_OPTIONAL_LOCKS=0`, writes nothing, and never edits `project.godot` or `.gitattributes`: the corrections are for the developer to make.

## The review dock (prototype)

`addons/assetgrove_review/` is an optional Godot editor dock that lists a project's staged candidates and shows each one's provenance and review state. It is a prototype. It is not in the package's `files`, so no release ships it, and neither core nor the pack loads it. Using it is up to the developer.

**Install.** Copy the folder into the Godot project as `res://addons/assetgrove_review/` and turn on _Assetgrove Review_ under Project Settings > Plugins. The dock reads two settings:

| Setting                                    | Default          | What                                                                                                                                       |
| ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Editor setting `assetgrove/review/command` | `["assetgrove"]` | The command that runs Assetgrove's CLI, as an argv prefix (for example `["node", "/path/to/assetgrove/dist/cli.js"]`). Kept per developer. |
| Project setting `assetgrove/review/target` | `res://`         | The Assetgrove target, whose `.assetgrove/runs/` holds the runs: `res://..` when the Godot project is a folder below the Git top level.    |

**What it shows.** For each run under `<target>/.assetgrove/runs/`, the candidates of its `run.json`. For the selected candidate it shows its media as a preview, its provenance (route, models, prompt, parameters, cost), its QA reasons and its review state. The state is `picked` when the run's pick named it, else what its `reviews/<candidate>.review.json` says ([Review records](../../docs/library.md#review-records)): `rejected` or `approved` by its latest decision, `changes-requested` while a change request is open, else `pending`. Text from records is shown as plain text, never rendered. The dock reads nothing outside the runs folder, and it reads a candidate's file only when the file is inside its run folder.

**What its buttons run.** Each button asks in the dock's own dialog first. Cancel runs nothing and changes nothing. Confirming in that dialog runs Assetgrove's own command, with its own confirmations, on a worker thread:

| Button     | Runs                                                                                  |
| ---------- | ------------------------------------------------------------------------------------- |
| Accept     | `assetgrove pick --run <run> --candidate <c> --target <target> --json`                |
| Reject     | `assetgrove review <run> --candidate <c> --reject <reason> --json`                    |
| Regenerate | `assetgrove vary --run <run> --candidate <c> --runs <target>/.assetgrove/runs --json` |

The dock never confirms or approves anything. When the developer settings or an earlier confirmation do not already cover a pick or a spend, the command exits 8 `confirmation_required` and writes nothing. The dock then shows the request's summary and its `assetgrove confirm <id>` command, with a button that copies it. A person runs that command at a terminal and presses the button again, and the command then completes. When no command is set, or it cannot be run, the dock still shows candidates but runs nothing.

## Tests

`pnpm test` runs the conformance suite (with a scripted tool run), setup, the output readers, what `godot:sprite-frames` hands Godot for an existing resource and a reported conflict (`test/sprite-frames-input.test.ts`) and what `godot:tile-set` hands Godot (`test/tile-set-input.test.ts`) anywhere. `test/round-trip.test.ts` covers the round trip with Godot: a re-export keeps the developer's animations, scene, UIDs and `.import` files, and a developer-edited family animation is refused. `test/gltf.test.ts` hands a synthetic skinned `.glb` (built with glTF Transform) off with `godot:gltf`, its `write` and `check` run with a tool runner that does what core's does: two animations imported with both and the options in the new `.import`, a declared animation the file lacks failing and named, a re-hand-off keeping the UID and the existing `.import` byte for byte, a GLB with no declared facts checked against its own, clips shaped without a `name` read from the file, an unskinned GLB handed off, and more meshes than declared failing. `test/usage.test.ts` scans a fixture project of `.tscn` and `.tres` files for an asset's path and UID references, their locations and the unresolved and unreadable ones, and shows a source edit and a new revision invalidating the cache while the project stays unchanged. `test/usage-preview.test.ts` runs core's `pick` with the pack and reads the usage in its replacement confirmation and in `assetgrove confirm`'s, and shows a second real preview taking an unchanged file from the cache in `<stateDir>/cache/usage/` and reading it again after an edit or a new commit. `test/doctor.test.ts` runs `assetgrove doctor` on a synthetic project with each kind of finding (exact paths, lines and corrections, merged across two presets), a healthy project with none, files outside the project folder left unreported, every file of the target, `.git` included, byte for byte unchanged, and the corrections, applied as written, clearing their findings. `test/texture-filter.test.ts` reads `project.godot` files and checks when the filter warning is given. `test/godot.test.ts` hands strips off to a fixture Godot project through core's CLI, with `import` options that each new strip's `.import` carries and that leave the existing `.import` files byte for byte, and `test/tile-set.test.ts` hands corner-16 atlases off with the tiles pack, built from `packages/assetgrove-tiles` and installed beside this one: a new TileSet from a fixture atlas, a re-hand-off that keeps a developer-added physics layer, custom-data layer, second source and alternative tile, a replaced atlas keeping its UID, a deliberately wrong peering bit failing the read-back, the new atlas's `.import` carrying the `import` options, the filter warning for a pixel-art profile with a Linear project and none with Nearest or a profile that is not pixel art (with `project.godot` left as it was), an existing TileSet whose own terrain sets (a Match Sides set and an unrelated Match Corners set) are kept while the preset adds its own, and the paint test. The paint test has Godot paint, with `TileMapLayer.set_cells_terrain_connect`, a map holding every neighbour pair Godot's terrain painting can make (every pair whose shared corners agree and each of whose upper corners belongs to a cell that can be all upper; the test enumerates them) and compares `get_cell_atlas_coords` of every cell with the expected map, where a corner is upper exactly where a painted cell touches it. `test/review-dock.test.ts` makes a scratch Godot project that is also an Assetgrove target, with a run staged by the scripted provider (no key). It turns on the review dock beside a test driver plugin and runs the headless editor once per step. The steps: the dock opens and shows a candidate's provenance, preview and `pending` state; cancelling each action runs nothing and leaves every record byte for byte; a reject records the decision and shows `rejected`; an accept stops at exit 8 with its `assetgrove confirm` command and, once a person confirms it, picks and shows `picked`; and a regenerate stops at the spend confirmation, then makes a new run. Every file the dock read is in the runs folder, and a decoy file elsewhere in the project is never read. `test/review-dock-reads.test.ts`, which needs no Godot, holds that list to every read: it scans the addon's GDScript and fails on any file-system read outside the store's helpers that record their path first. When a confirmed request's status shows, it names the button to press again (Refresh only re-reads the runs). These tests need Godot: they run the first Godot 4.7.2 on `PATH` (as `godot`, or by the release's own executable name; on Windows only an `.exe`), which CI's `chickensoft-games/setup-godot` step puts there, and skip with the reason without one. The tests read no environment variable of their own: core allows a fixed list (`test/env-names.test.ts`).
