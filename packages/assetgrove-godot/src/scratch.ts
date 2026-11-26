/**
 * The scratch Godot project the pack lays out for one run: its own `project.godot` (never the
 * game's, which can name autoloads and plugins), its build script as the project's one editor
 * plugin, the run's input as JSON, and the media and existing `.import` files as data at their
 * paths in the game's project. The argv names the project file and the plugin's two files after
 * `--` (user arguments Godot ignores), so core hashes their bytes into the run's approval; the
 * media and the input are data no argument names, so one approval holds for every asset.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@clockgrove/assetgrove/extension";

/** The build script the pack ships, beside this module in `src/` and, once built, in `dist/`. */
export const BUILD_SCRIPT = fileURLToPath(new URL("./build.gd", import.meta.url));

const PLUGIN_DIR = "addons/assetgrove_godot";
/** Where the run's input and result live in scratch (a hidden folder Godot does not import). */
export const INPUT_PATH = ".assetgrove-godot/input.json";
export const RESULT_PATH = ".assetgrove-godot/result.json";

const PROJECT_GODOT = `; The scratch project @clockgrove/assetgrove-godot builds a hand-off's resources in.
config_version=5

[application]

config/name="assetgrove-godot"

[editor_plugins]

enabled=PackedStringArray("res://${PLUGIN_DIR}/plugin.cfg")
`;

const PLUGIN_CFG = `[plugin]

name="assetgrove-godot"
description="Builds an Assetgrove hand-off's resources and reloads them."
author="Clockgrove"
version="0.2.0"
script="build.gd"
`;

/** The project and plugin files, by their path in scratch. */
export function projectFiles(): Record<string, Uint8Array | string> {
  return {
    "project.godot": PROJECT_GODOT,
    [`${PLUGIN_DIR}/plugin.cfg`]: PLUGIN_CFG,
    [`${PLUGIN_DIR}/build.gd`]: readFileSync(BUILD_SCRIPT),
  };
}

/** The argv of a run: the headless editor in scratch, naming the files whose bytes it runs. */
export const GODOT_ARGS: readonly string[] = [
  "--headless",
  "--editor",
  "--",
  "project.godot",
  `${PLUGIN_DIR}/plugin.cfg`,
  `${PLUGIN_DIR}/build.gd`,
];

/** A scene import option's value, as the `.import` file's `[params]` section holds it. */
export type ImportOption = string | number | boolean;

/** The `import` option of the presets: Godot import options by their `.import` key. */
export const importOptionsSchema = (z: ExtensionContext["z"]) =>
  z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean()])).default({});

/** What the build script reads to build a SpriteFrames (`godot:sprite-frames`). */
export interface BuildInput {
  /** The Godot release the run must be, `4.7.2-stable`: the script fails on any other. */
  godot: string;
  /** The SpriteFrames to save, `res://...`. */
  resource: string;
  /** The media, `res://...`, the target has no `.import` for: only these get `options`. */
  fresh: string[];
  /** Godot texture import options by their `.import` key, applied to the `fresh` sources. */
  options: Record<string, ImportOption>;
  /** The UID the target's resource already has, kept on the new save. */
  uid?: string;
  /** Whether the resource exists at its path in scratch, to be loaded and merged into. */
  existing?: boolean;
  /** Every file, `res://...`, the editor must have imported before the build loads anything. */
  imports?: string[];
  frameWidth: number;
  frameHeight: number;
  animations: Array<{
    name: string;
    texture: string;
    speed: number;
    loop: boolean;
    /**
     * The frame count of the strip the target held before this hand-off (its width over the frame
     * width), when it is a PNG: what a resource from before the record is compared with.
     */
    previousFrames?: number;
  }>;
}

/** One tile of a corner-16 set as the build script writes it: its atlas cell and terrain data. */
export interface TileInput {
  /** The tile's atlas coordinates, `[column, row]`. */
  coords: [number, number];
  /** The tile's centre terrain: 0 the lower, 1 the upper. */
  terrain: 0 | 1;
  /** Each corner's terrain peering bit. */
  peering: { nw: 0 | 1; ne: 0 | 1; sw: 0 | 1; se: 0 | 1 };
}

/** What the build script reads to build a TileSet (`godot:tile-set`). */
export interface TileSetInput {
  build: "tile-set";
  /** The Godot release the run must be, as `BuildInput.godot`. */
  godot: string;
  /** The TileSet to save, `res://...`. */
  resource: string;
  /** Whether the resource exists at its path in scratch, to be loaded and updated. */
  existing: boolean;
  /** The UID the target's resource already has, kept on the new save. */
  uid?: string;
  /** The atlas, `res://...`: the texture of the atlas source the preset owns. */
  texture: string;
  /** The atlas as `[texture]` when the target has no `.import` for it, else none. */
  fresh: string[];
  /** Godot texture import options by their `.import` key, applied to the `fresh` atlas. */
  options: Record<string, ImportOption>;
  /** Every file, `res://...`, the editor must have imported before the build loads anything. */
  imports: string[];
  /** The tile size in pixels; the atlas is 4 × 4 tiles of it. */
  tileSize: number;
  /** The names a new TileSet gives terrain 0 and terrain 1. */
  terrains: { lower: string; upper: string };
  tiles: TileInput[];
}

/** What the build script reads to import a glTF scene and check it (`godot:gltf`). */
export interface GltfInput {
  build: "gltf";
  /** The Godot release the run must be, as `BuildInput.godot`. */
  godot: string;
  /** The `.glb`, `res://...`. */
  scene: string;
  /** Whether the target had no `.import` for it: only then are `options` applied. */
  fresh: boolean;
  /** Godot scene import options by their `.import` key (`nodes/root_type`), for a fresh source. */
  options: Record<string, ImportOption>;
  /**
   * What the asset declares; a fact left out is read from the file through Godot's
   * `GLTFDocument`: its animation names, the unique joints over every skin, and the nodes with a
   * mesh in its scene.
   */
  declared: { animations?: string[]; joints?: number; meshes?: number };
}

/** What the build script reads to import an audio stream, check it and build a randomizer (`godot:audio`). */
export interface AudioInput {
  build: "audio";
  /** The Godot release the run must be, as `BuildInput.godot`. */
  godot: string;
  /** The stream the version is delivered as, `res://...`: the WAV, or the Ogg rendition. */
  stream: string;
  format: "wav" | "ogg";
  /** The Ogg as `[stream]` when the target has no `.import` for it, else none: only then are `options` applied. */
  fresh: string[];
  /** Godot Ogg import options by their `.import` key (`loop`, `loop_offset`, `bpm`...), for a fresh Ogg. */
  options: Record<string, ImportOption>;
  /**
   * What the delivered version loops as and, for a music loop, its tempo; the imported stream's
   * properties must equal them, except for an Ogg whose `.import` came from the target, which is
   * only reported.
   */
  expected: {
    loop?: { begin: number; end: number };
    tempo?: { bpm: number; beatCount: number; barBeats: number };
  };
  /** Every file, `res://...`, the editor must have imported before the build loads anything. */
  imports: string[];
  /** The variant set's AudioStreamRandomizer: loaded when it `existing`, keeping its `uid`. */
  randomizer?: { resource: string; existing: boolean; uid?: string };
}

/** What the build script writes back. */
export interface BuildResult {
  ok: boolean;
  errors: string[];
  /** What the hand-off would overwrite of the developer's changes; nothing was saved. */
  conflicts?: string[];
  resource?: string;
  uid?: string;
  animations?: Record<string, number>;
  textures?: Record<string, string>;
  /**
   * For a TileSet: the id of the atlas source the preset owns, the terrain set its tiles use and
   * how many tiles were read back.
   */
  source?: number;
  terrainSet?: number;
  tiles?: number;
  /**
   * For a glTF scene: what was declared and what the imported scene holds, its animation names,
   * each `Skeleton3D`'s bone count and its meshes.
   */
  declared?: { animations: string[]; joints: number; meshes: number };
  imported?: { animations: string[]; skeletons: number[]; meshes: number };
  /**
   * For an audio stream: what the imported stream holds. A WAV has `loopMode`, `loopBegin` and
   * `loopEnd`; an Ogg `loop`, `loopOffset`, `bpm`, `beatCount` and `barBeats`.
   */
  stream?: Record<string, number | boolean | string>;
  /** For a randomizer: the paths of its streams, in order. */
  streams?: string[];
}
