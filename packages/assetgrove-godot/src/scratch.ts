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

/** What the build script reads to build a SpriteFrames (`godot:sprite-frames`). */
export interface BuildInput {
  /** The Godot release the run must be, `4.7.2-stable`: the script fails on any other. */
  godot: string;
  /** The SpriteFrames to save, `res://...`. */
  resource: string;
  /** The UID the target's resource already has, kept on the new save. */
  uid?: string;
  frameWidth: number;
  frameHeight: number;
  animations: Array<{ name: string; texture: string; speed: number; loop: boolean }>;
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
  /** Every file, `res://...`, the editor must have imported before the build loads anything. */
  imports: string[];
  /** The tile size in pixels; the atlas is 4 × 4 tiles of it. */
  tileSize: number;
  /** The names a new TileSet gives terrain 0 and terrain 1. */
  terrains: { lower: string; upper: string };
  tiles: TileInput[];
}

/** What the build script writes back. */
export interface BuildResult {
  ok: boolean;
  errors: string[];
  resource?: string;
  uid?: string;
  animations?: Record<string, number>;
  textures?: Record<string, string>;
  /** For a TileSet: the id of the atlas source the preset owns, and how many tiles were read back. */
  source?: number;
  tiles?: number;
}
