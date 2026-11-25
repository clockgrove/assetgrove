---
name: assetgrove-godot
description: Load when an Assetgrove target is a Godot project and its hand-off should give it Godot resources (a SpriteFrames of every animation family, a TileSet of a tiles:terrain set). Needs the optional @clockgrove/assetgrove-godot package listed in the developer settings; covers the godot:sprite-frames and godot:tile-set presets, their options, the Godot run's approval, setup and its exit codes.
---

# Assetgrove for Godot

`@clockgrove/assetgrove-godot` is a pack: it loads only once a person lists it under `extensions` in the developer settings. It gives the target profile the hand-off presets `godot:sprite-frames` and `godot:tile-set`, and runs a pinned Godot 4.7.2 headless to build what it writes. Nothing Godot reads is written by hand.

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

It writes one SpriteFrames per asset with every animation family handed off so far, so `write-families` of `attack` after `idle` and `walk` gives all three. A hand-off whose spec names no `animationFamily` exits 2. Frames are the profile's frame size; each frame is an AtlasTexture region of its strip.

## Hand off a tile set

`godot:tile-set` hands off a `tiles:terrain` asset (the tiles pack's corner-16 atlas) as a Godot `TileSet`; any other asset exits 2. Its options are `project` and `resource` (default `{assetId}.tres`), as above.

```json
{ "preset": "godot:tile-set", "options": { "resource": "tiles/{assetId}.tres" } }
```

- A new `.tres` gets one terrain set in Match Corners mode, terrain 0 the lower and 1 the upper terrain, and one atlas source of the 16 tiles, each with its four corner peering bits; a tile's centre terrain is the upper only when all four corners are.
- An existing `.tres` is loaded, and only the atlas source whose texture is the asset's atlas changes: its texture, region size, tiles and their terrain data. Every other source, terrain set, physics, navigation and custom-data layer, and every alternative tile a developer added, is kept. Its terrain set 0 must be Match Corners with terrain 0 lower and 1 upper; otherwise the hand-off exits 6 instead of rewriting it.
- Godot reloads what it saved and reads every tile's peering bits back against the layout; a wrong bit fails the hand-off with exit 6, naming the tile and the corner.

## What comes back

- The resource, and the `.import` of each strip or atlas the project had none for, written by core with the media. An existing `.import` is never touched; a replaced resource keeps its UID.
- Any `ERROR` line from Godot (`ERROR:`, `SCRIPT ERROR:`, `SHADER ERROR:` or any other type), a Godot that is not 4.7.2-stable, a resource that does not load back, or a missing result fails the hand-off with exit 6 `handoff_check_failed`, whatever Godot's exit code, and nothing is written. Read the problems: they quote Godot's lines.
- An option that puts the resource, a strip or the atlas outside the Godot project exits 2 `invalid_input`.
