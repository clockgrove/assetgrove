# Generic hand-off presets

Besides `manifest`, core has two presets that write sprite-atlas JSON beside a sprite strip, for engines and tools that read a standard atlas rather than a game's own manifest. List them in the target profile's `handoff` ([target-profile.md](target-profile.md#hand-off-presets)):

```json
"handoff": [{ "preset": "atlas-json", "options": { "shape": "array" } }]
```

Both write from the strip's own geometry (`frames` width, height, count and `durationMs`); nothing is repacked. An output that is not a sprite strip is invalid input (exit 2). The JSON is written beside the media, at the media path with `.atlas.json` or `.aseprite.json` in place of the extension.

| Preset          | Option `shape`              | Writes                                                                                                                                      |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `atlas-json`    | `hash` (default) or `array` | `frames` named `<assetId>_<nnn>`, each with `frame`, `rotated`, `trimmed`, `spriteSourceSize` and `sourceSize`; `meta`; `animations`        |
| `aseprite-json` | `array` (default) or `hash` | the same, with a `duration` in milliseconds on each frame and `meta.frameTags`, one tag named for the animation, `from` 0 to `to` count - 1 |

`meta` holds `app` (`assetgrove`), `version`, `image` (the strip's file name, in the same directory), `format` (`RGBA8888`), `size` (`w`, `h`) and `scale` (`"1"`). `animations` maps the animation (the spec's `animationFamily`, else its `assetId`) to its frame names in order.

## Checks

Each preset reads the JSON and the PNG back. A problem exits 6 `handoff_check_failed` and the validator does not run. The checks are: the **shape** (`frames` is an object or an array as chosen), the **size** (`meta.size`, and the PNG's own width and height, equal frame width times count by frame height), every frame's **rectangle** (`x` is index times frame width, `y` is 0), the **frame count**, the **image path** (`meta.image` is a relative path with `/` that names the written PNG), and the **tag coverage** (`animations` lists every frame name in order; `meta.frameTags` cover frames 0 to count - 1 and each frame has its `duration`).

## Engines

Phaser (`load.atlas`, hash or array JSON), PixiJS (`Spritesheet` with `animations`) and Defold's atlas tooling read `atlas-json`. Aseprite itself, and the Aseprite importers of Godot, Unity and others, read `aseprite-json`; PixiJS and Phaser also read its `frameTags`.

## Writer

The writers are hand-written: no maintained library writes these formats, and the output is a few fixed-shape JSON objects. See [decisions.md](decisions.md#atlas-writers-are-hand-written).
