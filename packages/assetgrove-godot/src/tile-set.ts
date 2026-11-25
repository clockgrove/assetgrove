/**
 * The `godot:tile-set` preset: one `tiles:terrain` asset (a corner-16 atlas, the tiles pack's
 * kind) handed off as a Godot `TileSet`. As `godot:sprite-frames`, Godot builds it in a scratch
 * project (src/scratch.ts) through core's tool runner: a new TileSet has one terrain set in Match
 * Corners mode (terrain 0 the lower, 1 the upper); an existing one is loaded, with every file it
 * references, and only the atlas source whose texture is the asset's atlas changes. Godot saves
 * it, keeping its UID, reloads it and reads every tile's peering bits back against the layout.
 *
 * The corner-16 layout is read as data, not imported from the tiles pack: tile `i` sits at column
 * `i % 4`, row `floor(i / 4)`, with corner bits NW 1, NE 2, SW 4, SE 8 set where the corner is
 * the upper terrain. A tile's centre terrain is the upper only when all four corners are.
 */
import type {
  EnginePreset,
  ExtensionContext,
  PresetContext,
  PresetFile,
  TargetRead,
} from "@clockgrove/assetgrove/extension";
import { externalReferences, resourceHeader } from "./godot-text.ts";
import {
  GodotInputError,
  inProject,
  layoutOf,
  relativePath,
  resourceProblems,
  runGodot,
  savedFile,
} from "./run.ts";
import { GODOT_RELEASE } from "./setup.ts";
import { godotUsage } from "./usage.ts";
import {
  INPUT_PATH,
  importOptionsSchema,
  projectFiles,
  type ImportOption,
  type TileInput,
  type TileSetInput,
} from "./scratch.ts";
import { textureFilterWarning } from "./texture-filter.ts";

export const TILE_SET_PRESET = "godot:tile-set";
/** The kind the preset hands off, and the layout its output declares. */
export const TILES_KIND = "tiles:terrain";
export const CORNER16_LAYOUT = "corner-16";

export interface TileSetOptions {
  /** The Godot project's directory (where `project.godot` is), relative to the target. */
  project: string;
  /** The TileSet, relative to the target, `{assetId}` replaced; inside the project. */
  resource: string;
  /**
   * Godot texture import options by their `.import` key (`compress/mode`, `mipmaps/generate`),
   * applied to the atlas's `.import` when the target has none for it. An existing `.import` is
   * never changed.
   */
  import: Record<string, ImportOption>;
}

/** Each corner's bit in a corner-16 tile index, set where the corner is the upper terrain. */
export const CORNER_BITS = { nw: 1, ne: 2, sw: 4, se: 8 } as const;

/** The 16 tiles of the corner-16 layout in index order, with their terrain data. */
export function corner16Tiles(): TileInput[] {
  return Array.from({ length: 16 }, (_, index) => {
    const bit = (mask: number): 0 | 1 => ((index & mask) !== 0 ? 1 : 0);
    return {
      coords: [index % 4, Math.floor(index / 4)],
      terrain: index === 15 ? 1 : 0,
      peering: {
        nw: bit(CORNER_BITS.nw),
        ne: bit(CORNER_BITS.ne),
        sw: bit(CORNER_BITS.sw),
        se: bit(CORNER_BITS.se),
      },
    };
  });
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const named = (v: unknown): v is string => typeof v === "string" && v !== "";

/** The hand-off's atlas: what the preset needs of a `tiles:terrain` asset. */
export interface TerrainAtlas {
  assetId: string;
  /** The atlas, relative to the target, with `/`. */
  media: string;
  tileSize: number;
  terrains: { lower: string; upper: string };
}

/** The asset's atlas from the hand-off context; anything that is not a corner-16 set is refused. */
export function terrainAtlas(ctx: PresetContext): TerrainAtlas {
  const spec = record(ctx.context["spec"]);
  const output = record(ctx.context["output"]);
  if (spec["kind"] !== TILES_KIND || output["layout"] !== CORNER16_LAYOUT)
    throw new GodotInputError(
      `the preset ${TILE_SET_PRESET} hands off a ${TILES_KIND} asset whose output.fields.layout is ${CORNER16_LAYOUT}, not a ${String(spec["kind"])} asset with layout ${String(output["layout"])}`,
    );
  const block = record(ctx.profile.kinds?.[TILES_KIND]);
  const tileSize = posInt(output["tileSize"]) ? output["tileSize"] : block["tileSize"];
  const terrains = record(spec["terrains"] ?? output["terrains"]);
  const { assetId, path } = { assetId: spec["assetId"], path: output["path"] };
  if (!posInt(tileSize))
    throw new GodotInputError(
      `the ${TILES_KIND} asset declares no tile size (output.fields.tileSize or kinds["${TILES_KIND}"].tileSize)`,
    );
  if (!named(terrains["lower"]) || !named(terrains["upper"]))
    throw new GodotInputError(
      `the ${TILES_KIND} spec names no terrains (fields.terrains { lower, upper })`,
    );
  if (!named(assetId) || !named(path))
    throw new GodotInputError(`the hand-off names no asset id or media path`);
  return {
    assetId,
    media: relativePath(path, "the atlas"),
    tileSize,
    terrains: { lower: terrains["lower"], upper: terrains["upper"] },
  };
}

/** A text resource that can reference other files: its references reach scratch too. */
const TEXT_RESOURCE = /\.(tres|tscn)$/;

/**
 * Puts every file an existing resource references into scratch as data, with its `.import`, so
 * Godot loads the resource as the game does; text resources are followed. A referenced file the
 * target lacks stays out, and Godot's load error fails the run. Returns the `res://` paths whose
 * `.import` came along, which the editor must have imported before the build loads anything.
 */
async function dependencies(
  project: string,
  bytes: Uint8Array,
  read: TargetRead,
  files: Record<string, Uint8Array | string>,
  seen: Set<string>,
): Promise<string[]> {
  const imports: string[] = [];
  for (const reference of externalReferences(bytes)) {
    const res = reference.path;
    if (res === undefined || !res.startsWith("res://")) continue;
    const at = relativePath(res.slice("res://".length), `the referenced file ${res}`);
    if (seen.has(at)) continue;
    seen.add(at);
    const target = project === "" ? at : `${project}/${at}`;
    const content = await read(target);
    if (content === undefined) continue;
    files[at] = content;
    const imported = await read(`${target}.import`);
    if (imported !== undefined) {
      files[`${at}.import`] = imported;
      imports.push(res);
    }
    if (TEXT_RESOURCE.test(at))
      imports.push(...(await dependencies(project, content, read, files, seen)));
  }
  return imports;
}

async function write(
  ctx: PresetContext,
  options: TileSetOptions,
  read: TargetRead,
): Promise<PresetFile[]> {
  const atlas = terrainAtlas(ctx);
  const { project, resource } = layoutOf(atlas.assetId, options);
  const at = inProject(project, atlas.media, "the atlas");
  const content = ctx.mediaBytes ?? (await read(atlas.media));
  if (content === undefined) throw new GodotInputError(`the atlas ${atlas.media} cannot be read`);
  const files: Record<string, Uint8Array | string> = { ...projectFiles(), [at]: content };
  // An existing .import keeps its UID and options; it reaches scratch as data only.
  const existingImport = await read(`${atlas.media}.import`);
  if (existingImport !== undefined) files[`${at}.import`] = existingImport;
  const imports = [`res://${at}`];

  const resourceAt = inProject(project, resource, "the resource");
  const before = await read(resource);
  const uid = before === undefined ? undefined : resourceHeader(before)?.uid;
  if (before !== undefined) {
    files[resourceAt] = before;
    imports.push(...(await dependencies(project, before, read, files, new Set([at, resourceAt]))));
  }
  const input: TileSetInput = {
    build: "tile-set",
    godot: GODOT_RELEASE.release,
    resource: `res://${resourceAt}`,
    existing: before !== undefined,
    ...(uid !== undefined && { uid }),
    texture: `res://${at}`,
    fresh: existingImport === undefined ? [`res://${at}`] : [],
    options: options.import,
    imports,
    tileSize: atlas.tileSize,
    terrains: atlas.terrains,
    tiles: corner16Tiles(),
  };
  files[INPUT_PATH] = JSON.stringify(input, null, 2);

  const { ran } = await runGodot(TILE_SET_PRESET, ctx.run, files);
  const output = (target: string) => savedFile(TILE_SET_PRESET, ran, project, target);
  return [
    // Godot saves it in scratch; an unchanged one (a replaced atlas, say) comes back as passed in.
    { path: resource, content: savedFile(TILE_SET_PRESET, ran, project, resource, before) },
    ...(existingImport === undefined
      ? [{ path: `${atlas.media}.import`, content: output(`${atlas.media}.import`) }]
      : []),
  ];
}

/** Reads the written resource back: a TileSet with a UID, referencing the atlas by its `.import`'s UID. */
async function check(
  ctx: PresetContext,
  options: TileSetOptions,
  _files: PresetFile[],
  read: TargetRead,
): Promise<string[]> {
  const atlas = terrainAtlas(ctx);
  const { project, resource } = layoutOf(atlas.assetId, options);
  return resourceProblems(
    "TileSet",
    project,
    resource,
    [{ path: atlas.media, name: atlas.assetId }],
    read,
  );
}

/** The preset, its options validated with core's zod. */
export function tileSetPreset(context: ExtensionContext): EnginePreset<TileSetOptions> {
  const { z } = context;
  return {
    name: TILE_SET_PRESET,
    optionsSchema: z.strictObject({
      project: z.string().default(""),
      resource: z.string().min(1).default("{assetId}.tres"),
      import: importOptionsSchema(z),
    }),
    write,
    check,
    warnings: (ctx, options, read) =>
      textureFilterWarning(ctx.profile, relativePath(options.project, "options.project"), read),
    usage: (ctx, options, read) =>
      godotUsage(ctx, relativePath(options.project, "options.project"), read),
  };
}
