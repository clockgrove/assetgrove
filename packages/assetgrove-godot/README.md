# @clockgrove/assetgrove-godot

The Godot pack for Assetgrove: Godot builds the hand-off's resources itself. Copying files into a Godot project is not enough, because Godot's exit codes do not report import errors and a hand-written `.tres` with a wrong UID breaks silently in the editor. So this pack never writes a Godot resource by hand: a pinned, headless Godot 4.7.2 builds each one through its own API, saves it with `ResourceSaver` and loads it back with `ResourceLoader`.

## Extension API

The package declares `"assetgrove": { "api": 2 }` and a peer range on `@clockgrove/assetgrove`. It imports only core's public exports: its types from `@clockgrove/assetgrove/extension` and, in its tests, the pack test kit `@clockgrove/assetgrove/testing` (a temporary project, core's CLI and the conformance suite in `test/conformance.test.ts`). The tests run with `node --conditions=assetgrove-source`, which resolves the linked core to its TypeScript source.

It declares, as extension `godot`:

- the preset `godot:sprite-frames` (scope `families`);
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

`assetgrove extensions setup godot` uses the binary that setting names. Without one, it downloads Godot 4.7.2 for this system from Godot's GitHub release (Linux x86_64 and arm64, macOS universal, Windows x86_64 and arm64, the console executable on Windows) through core's pinned download, checks it against the SHA512 the pack ships (`src/godot-release.json`, copied from the release's `SHA512-SUMS.txt`), unpacks it under `<stateDir>/models/godot/4.7.2-stable/<system>/` and returns its path under `godot`. Setup writes no settings: put that path in `extensionSettings["@clockgrove/assetgrove-godot"].godot`.

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

| Option     | Default          | What                                                                                                        |
| ---------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `project`  | `""`             | The Godot project's folder (where `project.godot` is), relative to the target. The media must be inside it. |
| `resource` | `{assetId}.tres` | The SpriteFrames, relative to the target, `{assetId}` replaced; inside the project, ending in `.tres`.      |
| `loop`     | `true`           | Whether each animation loops.                                                                               |

Frames are the profile's `frames.width` × `frames.height`, side by side in each strip; Godot counts them from the texture's width. Each animation plays at `1000 / frames.durationMs` frames per second (10 without a duration).

### What a hand-off runs

1. The preset lays out a scratch Godot project: the pack's own `project.godot` (never the game's, which can name autoloads and plugins), its build script `src/build.gd` (in `dist/` once built) as the project's one editor plugin, each family's media at its path in the game's project, each existing `.import` of that media, and `input.json` with the resource's path, the UID the target's resource already has (read from its header as text) and the animations.
2. Core runs Godot in that scratch folder, outside the game project, under its tool rules ([docs/extensions.md](../../docs/extensions.md#tools)): `godot --headless --editor -- project.godot addons/assetgrove_godot/plugin.cfg addons/assetgrove_godot/build.gd`. The arguments after `--` are Godot's user arguments, which it ignores; they name the files whose bytes the run's approval hashes, so a changed script asks again. The media and the input are data no argument names, so one approval holds for every asset. Headless settings need the run in `commands.approved`; attended, a person approves it once.
3. Godot's editor imports the media. The script builds the SpriteFrames through Godot's API, saves it with `ResourceSaver` (keeping the earlier UID with `ResourceSaver.set_uid`), reloads it with `ResourceLoader` and checks that every animation came back with its frames.
4. The run fails, exit 6 `handoff_check_failed` with nothing written, on any `ERROR` line in Godot's output (`ERROR:`, or any type before it: `SCRIPT ERROR:`, `USER ERROR:`, `SHADER ERROR:` and the rest), on a resource that does not load back, or when Godot leaves no result, whatever its exit code.
5. The preset returns what Godot saved: the resource, and for each source file the target has no `.import` for, the `.import` that scratch import produced, so its UID matches the resource's reference. Core writes them with the media, under its path checks and the hand-off's confirmation. An existing `.import` is never returned, so it is never touched; a replaced resource keeps its UID.

The preset's check reads the written resource back: a SpriteFrames with a UID, referencing each family's media by the UID its `.import` gives it.

## Tests

`pnpm test` runs the conformance suite (with a scripted tool run), setup and the output readers anywhere. `test/godot.test.ts` hands strips off to a fixture Godot project through core's CLI and needs Godot: it runs the first Godot 4.7.2 on `PATH` (as `godot`, or by the release's own executable name; on Windows only an `.exe`), which CI's `chickensoft-games/setup-godot` step puts there, and skips with the reason without one. The tests read no environment variable of their own: core allows a fixed list (`test/env-names.test.ts`).
