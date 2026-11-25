---
name: assetgrove-godot
description: Load when an Assetgrove target is a Godot project and its hand-off should give it Godot resources (a SpriteFrames of every animation family, a TileSet of a tiles:terrain set, the import of a character-3d .glb). Needs the optional @clockgrove/assetgrove-godot package listed in the developer settings; covers the godot:sprite-frames, godot:tile-set and godot:gltf presets, their options, the Godot run's approval, setup and its exit codes.
---

# Assetgrove for Godot

`@clockgrove/assetgrove-godot` is a pack: it loads only once a person lists it under `extensions` in the developer settings. It gives the target profile the hand-off presets `godot:sprite-frames`, `godot:tile-set` and `godot:gltf`, and runs a pinned Godot 4.7.2 headless to build what it writes. Nothing Godot reads is written by hand.

For the whole workflow on a synthetic game (generated, hand-drawn and third-party art, review, provenance, licence records, data routes and disclosure limits), point the person to the launch guide: https://github.com/clockgrove/assetgrove/blob/main/docs/launch-guide.md

## Set it up

- `assetgrove extensions setup godot` uses the Godot at `extensionSettings["@clockgrove/assetgrove-godot"].godot` when it is set, without running it, so it reports no `version`; every hand-off fails unless that Godot is 4.7.2-stable. Otherwise it downloads Godot 4.7.2 for this system, checks it against the SHA512 the pack ships and returns its path under `godot`. Setup writes no settings: a person puts that path in the setting.
- Each hand-off runs Godot as a tool. Headless settings need the run's hash in `commands.approved` (kind `tool`); attended, a person approves it once. The approval holds while Godot and the pack's script are unchanged, for every asset. A refused run exits 8 `confirmation_required` with the hash.
- Godot's headless editor, like any editor launch, writes its editor settings, caches and the scratch project's `app_userdata/assetgrove-godot/` (a `.recovery_mode_lock` can stay) to the user's own Godot folders; they hold no target data.

## Use the preset

In the target profile, list it after `manifest`:

```json
{
  "handoff": [
    { "preset": "manifest" },
    { "preset": "godot:sprite-frames", "options": { "resource": "characters/{assetId}.tres" } }
  ]
}
```

- `project`: the Godot project's folder relative to the target (default the target itself); the media must be inside it.
- `resource`: where the SpriteFrames goes, `{assetId}` replaced, ending in `.tres` (default `{assetId}.tres`).
- `loop`: whether animations loop (default true).
- `import`: Godot texture import options by their `.import` key (default `{}`), such as `{ "compress/mode": 0, "mipmaps/generate": false }` for pixel art. Godot applies them to the `.import` of a new strip only; an existing `.import` is never changed.

It writes one SpriteFrames per asset with every animation family handed off so far, so `write-families` of `attack` after `idle` and `walk` gives all three. A hand-off whose spec names no `animationFamily` exits 2. Frames are the profile's frame size; each frame is an AtlasTexture region of its strip.

## Hand off a tile set

`godot:tile-set` hands off a `tiles:terrain` asset (the tiles pack's corner-16 atlas) as a Godot `TileSet`; any other asset exits 2. Its options are `project`, `resource` (default `{assetId}.tres`) and `import`, as above (`import` applies to a new atlas only).

```json
{ "preset": "godot:tile-set", "options": { "resource": "tiles/{assetId}.tres" } }
```

- A new `.tres` gets one terrain set in Match Corners mode, terrain 0 the lower and 1 the upper terrain, and one atlas source of the 16 tiles, each with its four corner peering bits; a tile's centre terrain is the upper only when all four corners are.
- An existing `.tres` is loaded, and only the atlas source whose texture is the asset's atlas changes: its texture, region size, tiles and their terrain data. Every other source, terrain set, physics, navigation and custom-data layer, and every alternative tile a developer added, is kept. The owned tiles use the Match Corners terrain set the owned source's tiles already use (an earlier hand-off's), else a Match Corners set whose terrains 0 and 1 are named after the lower and upper terrains, else a new Match Corners set of the preset's own (terrain 0 lower, 1 upper), added after the developer's sets. A developer's terrain sets are never changed, and never reused for terrains they do not name.
- Godot reloads what it saved and reads every tile's peering bits back against the layout; a wrong bit fails the hand-off with exit 6, naming the tile and the corner.

## Hand off a 3D character

`godot:gltf` hands off a `character-3d` asset's `.glb`, or any `.glb` (`output.mediaType` `model/gltf-binary` or a media path ending in `.glb`); anything else exits 2. It writes no `.tscn`. Options: `project` (as above; the `.glb` must be inside it) and `import` (default `{}`): Godot scene import options by their `.import` key, with string, number or boolean values (an integral number becomes an int).

```json
{
  "preset": "godot:gltf",
  "options": {
    "project": "game",
    "import": { "nodes/root_type": "CharacterBody3D", "animation/import": true }
  }
}
```

- The options go into a new source's `.import` as data; Godot writes them through `ConfigFile` and reimports. An existing `.import` is never touched: it reaches scratch as data, Godot imports with its options and UID, and a replaced `.glb` keeps its UID. Core writes the `.glb`; the preset returns only the new `.import`.
- Godot imports the `.glb` in a scratch project. The hand-off fails with exit 6 `handoff_check_failed` and nothing written on a load error, on any `ERROR` line, when the scene lacks an animation of the same name as any declared one or a `Skeleton3D` with the declared joint count (none for an unskinned `.glb`, which declares 0), or when it has more `MeshInstance3D` meshes than declared.
- Declared animations are `output.clips[].name` and joints are `output.bones`, when the hand-off gives them (a `character-3d` asset does). Otherwise, and when `model3d.handoff.clipFields` shapes the clips without a `name`, they are read from the file through `GLTFDocument`: its animation names and the unique joints over every skin. Declared meshes are the glTF nodes with a mesh in the scene.

## Pixel art and the texture filter

Godot 4 sets the texture filter in the project (`rendering/textures/canvas_textures/default_texture_filter`), not per file. For a pixel-art profile (`style.edges` `crisp` with `style.color.rule` `palette`), `godot:sprite-frames` and `godot:tile-set` read `project.godot` and add a warning under `handoff[i].warnings` when the filter is not Nearest (`0`). An unset filter counts, since Godot's default is Linear. The hand-off still succeeds, and the pack never edits `project.godot`. Tell the person to set Project Settings > Rendering > Textures > Canvas Textures > Default Texture Filter to Nearest.

## Usage before a replacement

A `pick` that replaces an asset's version lists, in its confirmation (`details.usage` and the summary), every `.tscn` and `.tres` in the preset's `project` that refers to the asset's media by `res://` path or by the UID in its `.import`, with each file, line and node or property that uses it. References that resolve to nothing are marked `UNRESOLVED`, and binary or unreadable scenes and resources `UNREADABLE`. The scan only reads the project. Its cache lives in `<stateDir>/cache/usage/` and is dropped on a file edit or a new Git revision.

## What comes back

- The resource, and the `.import` of each strip or atlas the project had none for, written by core with the media. An existing `.import` is never touched; a replaced resource keeps its UID.
- Any `ERROR` line from Godot (`ERROR:`, `SCRIPT ERROR:`, `SHADER ERROR:` or any other type), a Godot that is not 4.7.2-stable, a resource that does not load back, or a missing result fails the hand-off with exit 6 `handoff_check_failed`, whatever Godot's exit code, and nothing is written. Read the problems: they quote Godot's lines.
- An option that puts the resource, a strip or the atlas outside the Godot project exits 2 `invalid_input`.

## Check the project

Run `assetgrove doctor --profile profile.json --target .` before a hand-off or when Godot reports a missing UID, a tracked `.godot/` cache or text it cannot parse. It is read-only and needs no Godot. Each finding of the three presets has an exact path (and line), the problem and a correction for the developer to make: `orphan-uid` and `duplicate-uid` (sidecars, `.import` files and `[ext_resource]` UIDs), `tracked-engine-cache`, and `lfs-text-resource` (a `.import`, `.uid`, `.tres`, `.tscn`, `.gd`, `.gdshader` or `project.godot` stored in Git LFS). Never apply a correction yourself without the developer; the doctor never edits `project.godot` or `.gitattributes`.
