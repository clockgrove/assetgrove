# Generic hand-off presets

Besides `manifest`, core has two presets that write sprite-atlas JSON beside a sprite strip, for engines and tools that read a standard atlas rather than a game's own manifest. List them in the target profile's `handoff` ([target-profile.md](target-profile.md#hand-off-presets)):

```json
"handoff": [{ "preset": "atlas-json", "options": { "shape": "array" } }]
```

Both write from the strip's own geometry (`frames` width, height, count and `durationMs`); nothing is repacked. Only a `sprite-strip` output is written: a still or an output without frame geometry (a 3D model) is invalid input (exit 2), so a profile that lists these presets suits a target whose outputs are strips. The JSON is written beside the media, at the media path with `.atlas.json` or `.aseprite.json` in place of the extension.

| Preset          | Option `shape`              | Writes                                                                                                                                                              |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atlas-json`    | `hash` (default) or `array` | `frames` named `<assetId>_<nnn>`, each with `frame`, `rotated`, `trimmed`, `spriteSourceSize` and `sourceSize`; `meta`; `animations`                                |
| `aseprite-json` | `array` (default) or `hash` | the same, including `animations`, with a `duration` in milliseconds on each frame and `meta.frameTags`, one tag named for the animation, `from` 0 to `to` count - 1 |

`meta` holds `app` (`assetgrove`), `version`, `image` (the strip's file name, in the same directory), `format` (`RGBA8888`), `size` (`w`, `h`) and `scale` (`"1"`). `animations` maps the animation (the spec's `animationFamily`, else its `assetId`) to its frame names in order.

## Checks

Each preset reads the JSON and the PNG back. A problem exits 6 `handoff_check_failed` and the validator does not run. The checks are: the **shape** (`frames` is an object or an array as chosen), the **size** (`meta.size`, and the PNG's own width and height, equal frame width times count by frame height), every frame's **rectangle** (`x` is index times frame width, `y` is 0), the **frame count**, the **image path** (`meta.image` is a relative path with `/` that names the written PNG), and the **tag coverage** (`animations` holds exactly the animation the preset wrote, listing every frame name in order, so a missing `animations`, a renamed animation or a dropped frame fails; `meta.frameTags` cover frames 0 to count - 1 without naming a frame outside that range, and each frame has its `duration`).

## Engines

Phaser reads both: `load.atlas` takes `atlas-json` in either shape, and `load.aseprite` takes `aseprite-json` (`array` shape, with its `frameTags`). PixiJS's `Spritesheet` reads `atlas-json` with the `hash` shape and its `animations`.

## Presets and the target

Every preset's `write` is async and gets `read`, which reads a file of the target, such as an engine's `.import` file, under the rule every hand-off write follows: a path outside the target, in `.git`, or in the settings or state is refused (exit 2). A preset returns its files and core writes them: it checks each path, writes them with the media, reads them back through the preset's check and lists them under `handoff` in the result. A preset may declare `scope: "families"`: it then writes once for every animation family handed off for the asset so far, read from the library, not only the families of this run, so rewriting one family keeps the others in its output. `manifest`, `atlas-json` and `aseprite-json` write for one hand-off. See [extensions.md](extensions.md#engine-presets).

## Writer

The writers are hand-written: no maintained library writes these formats, and the output is a few fixed-shape JSON objects. See [decisions.md](decisions.md#atlas-writers-are-hand-written).
