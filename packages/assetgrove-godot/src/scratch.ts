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

/** What the build script reads. */
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

/** What the build script writes back. */
export interface BuildResult {
  ok: boolean;
  errors: string[];
  resource?: string;
  uid?: string;
  animations?: Record<string, number>;
  textures?: Record<string, string>;
}
