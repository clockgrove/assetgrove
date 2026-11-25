/**
 * The `tiles:terrain` kind: a corner-16 terrain tile set between two named terrains, made as one
 * atlas image (4 × 4 tiles of `kinds["tiles:terrain"].tileSize`, `output.fields.layout`
 * `corner-16`), checked exactly for its grid and its seam classes.
 */
import { createHash } from "node:crypto";
import type {
  AssetKind,
  AssetSpec,
  ExtensionContext,
  KindCheck,
  KindCheckInput,
  LoadedReference,
  Reason,
  StyleBible,
  TargetProfile,
} from "@clockgrove/assetgrove/extension";
import {
  CORNER16_LAYOUT,
  atlasSide,
  cellBox,
  cellName,
  classMismatches,
  emptyCells,
  isAtlasSize,
  templateAtlas,
} from "./corner16.ts";
import type { Pixels } from "./corner16.ts";

export const TILES_KIND = "tiles:terrain";
export const ATLAS_OPERATION = "tiles:atlas";
export const SEAMS_OPERATION = "tiles:seams";
export const GRID_CHECK = "tiles:grid";
export const CLASS_UNIFORMITY_CHECK = "tiles:class-uniformity";
export const SEAM_QUALITY_CHECK = "tiles:seam-quality";

/** The profile's `kinds["tiles:terrain"]` block, without `values` and `layout`. */
export interface TilesProfile {
  tileSize: number;
}

/** The two terrains a set joins, from the spec's `fields.terrains`. */
export interface Terrains {
  lower: string;
  upper: string;
}

/** The flat greys the template reference draws the lower and the upper terrain in. */
export const TEMPLATE_LOWER = [0x40, 0x40, 0x40, 255] as const;
export const TEMPLATE_UPPER = [0xc0, 0xc0, 0xc0, 255] as const;

/** An error core maps to exit 2 `invalid_input` by its own code. */
function invalidInput(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid_input" });
}

/** A `size` square texture of one colour. */
export function flatTexture(size: number, rgba: readonly number[]): Pixels {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: size, height: size, data };
}

function reference(role: string, path: string, bytes: Uint8Array): LoadedReference {
  return {
    role,
    path,
    mediaType: "image/png",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function tilesTerrainKind(context: ExtensionContext): AssetKind {
  const { z, raster } = context;
  const profileSchema = z.strictObject({ tileSize: z.number().int().positive() });
  const specSchema = z.looseObject({
    kind: z.string(),
    fields: z.looseObject({
      terrains: z.strictObject({ lower: z.string().min(1), upper: z.string().min(1) }),
    }),
  });

  /** The kind's block of the profile, validated; its `values` and `layout` are core's. */
  function tilesProfileOf(profile: TargetProfile): TilesProfile {
    const block = profile.kinds?.[TILES_KIND];
    if (block === undefined)
      throw invalidInput(`the target profile has no kinds["${TILES_KIND}"] block (tileSize)`);
    const own = Object.fromEntries(
      Object.entries(block).filter(([field]) => field !== "values" && field !== "layout"),
    );
    const parsed = profileSchema.safeParse(own);
    if (!parsed.success)
      throw invalidInput(
        `kinds["${TILES_KIND}"] is invalid: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(block)"} ${i.message}`)
          .join("; ")}`,
      );
    return parsed.data;
  }

  function terrainsOf(spec: AssetSpec): Terrains {
    const parsed = specSchema.safeParse(spec);
    if (!parsed.success)
      throw invalidInput(
        `a ${TILES_KIND} spec names its two terrains as fields.terrains { lower, upper }`,
      );
    return parsed.data.fields.terrains;
  }

  const styleOf = (profile: TargetProfile, bible: StyleBible) =>
    raster.resolveStyle(profile.style, bible.palette);

  const gridCheck: KindCheck = {
    name: GRID_CHECK,
    mode: "exact",
    source: "deterministic",
    run({ profile, bible, output }: KindCheckInput): Reason[] {
      const { tileSize } = tilesProfileOf(profile);
      const { threshold } = styleOf(profile, bible).alpha;
      const atlas = raster.decode(output.bytes);
      const base = { check: GRID_CHECK, source: "deterministic" } as const;
      const side = atlasSide(tileSize);
      if (!isAtlasSize(atlas, tileSize))
        return [
          {
            ...base,
            passed: false,
            reason: `the atlas is ${atlas.width} × ${atlas.height}, not ${side} × ${side} (4 × 4 tiles of ${tileSize}px)`,
          },
        ];
      const empty = emptyCells(atlas, tileSize, threshold);
      if (empty.length === 0)
        return [
          {
            ...base,
            passed: true,
            reason: `the atlas is 4 × 4 tiles of ${tileSize}px (${side} × ${side}), no cell empty`,
          },
        ];
      return empty.map((index) => ({
        ...base,
        passed: false,
        reason: `${cellName(index)} is empty: no pixel at alpha ${threshold} or above`,
      }));
    },
  };

  const classUniformityCheck: KindCheck = {
    name: CLASS_UNIFORMITY_CHECK,
    mode: "exact",
    source: "deterministic",
    run({ profile, bible, output }: KindCheckInput): Reason[] {
      const { tileSize } = tilesProfileOf(profile);
      const base = { check: CLASS_UNIFORMITY_CHECK, source: "deterministic" } as const;
      const { rule } = styleOf(profile, bible).color;
      if (rule !== "palette")
        return [
          {
            ...base,
            passed: true,
            reason: `skipped: the profile's colour rule is "${rule}", not palette-indexed, so edge strips are not compared exactly`,
          },
        ];
      const atlas = raster.decode(output.bytes);
      if (!isAtlasSize(atlas, tileSize))
        return [
          {
            ...base,
            passed: true,
            reason: `skipped: the atlas is not 4 × 4 tiles of ${tileSize}px, which ${GRID_CHECK} reports`,
          },
        ];
      const mismatches = classMismatches(atlas, tileSize);
      if (mismatches.length === 0)
        return [
          {
            ...base,
            passed: true,
            reason: "every tile's edge strip matches its (side, corner-label pair) class",
          },
        ];
      return mismatches.map(({ index, side, pair, pixels }) => ({
        ...base,
        passed: false,
        reason: `${cellName(index)}: its ${side} strip differs from its class (${side}, ${pair}) in ${pixels} px`,
      }));
    },
  };

  const seamQualityCheck: KindCheck = {
    name: SEAM_QUALITY_CHECK,
    mode: "model",
    operation: SEAMS_OPERATION,
    version: "1",
    source: "decision",
    async run({ spec, profile, output }, call): Promise<Reason[]> {
      const { tileSize } = tilesProfileOf(profile);
      const { lower, upper } = terrainsOf(spec);
      const atlas = raster.decode(output.bytes);
      // Each pure tile (0, all lower; 15, all upper) repeated 2 × 2, side by side.
      const wrap = raster.create(4 * tileSize, 2 * tileSize);
      [0, 15].forEach((index, n) => {
        const tile = raster.crop(atlas, cellBox(index, tileSize));
        for (let y = 0; y < 2 * tileSize; y++)
          for (let x = 0; x < 2 * tileSize; x++)
            raster.setPixel(
              wrap,
              n * 2 * tileSize + x,
              y,
              raster.getPixel(tile, x % tileSize, y % tileSize),
            );
      });
      const { result } = await call.decide(
        SEAMS_OPERATION,
        `The first image is a corner-16 terrain tile set between ${lower} (lower) and ${upper} (upper): 16 tiles of ${tileSize}px in a 4 × 4 grid. The second shows the pure ${lower} tile and the pure ${upper} tile, each repeated 2 × 2.`,
        [
          reference("atlas", "atlas.png", output.bytes),
          reference("wrap", "wrap.png", raster.encodePng(wrap)),
        ],
        {
          type: "boolean",
          instructions: `Placed by their corner labels, does each seam between neighbouring tiles look continuous, and does each pure tile wrap with itself without a visible edge?`,
          whenTrue: "the seams look continuous and each pure tile wraps",
          whenFalse: "a seam or a pure tile's wrap shows a visible break",
        },
      );
      const answer = result.answer;
      const passed = answer.type === "boolean" && answer.probability >= 0.5;
      return [
        {
          check: SEAM_QUALITY_CHECK,
          passed,
          reason: passed
            ? "the seams look continuous and each pure tile wraps with itself"
            : "a seam or a pure tile's wrap shows a visible break",
          source: "decision",
        },
      ];
    },
  };

  return {
    kind: TILES_KIND,
    operations: { [ATLAS_OPERATION]: "image", [SEAMS_OPERATION]: "decisions" },
    profileSchema,
    specSchema,
    checks: [gridCheck, classUniformityCheck, seamQualityCheck],
    planCandidate(spec, profile, routes) {
      tilesProfileOf(profile);
      terrainsOf(spec);
      const plan = (operation: string) => {
        const route = routes[operation];
        if (route === undefined) throw invalidInput(`no route for the ${operation} operation`);
        return { operation, model: route.model, estimatedCostUsd: route.estimatedCostUsd };
      };
      return [plan(ATLAS_OPERATION), plan(SEAMS_OPERATION)];
    },
    async generate(ctx) {
      const { tileSize } = tilesProfileOf(ctx.profile);
      const terrains = terrainsOf(ctx.spec);
      const style = styleOf(ctx.profile, ctx.bible);
      const side = atlasSide(tileSize);
      const template = templateAtlas(
        flatTexture(tileSize, TEMPLATE_LOWER),
        flatTexture(tileSize, TEMPLATE_UPPER),
      );
      const prompt = context.prompt.withNote(
        [
          `A corner-16 terrain tile set between ${terrains.lower} (the lower terrain) and ${terrains.upper} (the upper terrain), as one ${side} × ${side} image: 16 square tiles of ${tileSize}px in a 4 × 4 grid, no gaps, no borders.`,
          `The reference image is the layout: dark grey marks ${terrains.lower}, light grey marks ${terrains.upper}. Each tile's four corners are ${terrains.lower} or ${terrains.upper} as the reference shows, so tiles placed by their corners join seamlessly.`,
          `Tile 0 (top left) is all ${terrains.lower} and tile 15 (bottom right) all ${terrains.upper}; each must tile seamlessly with itself.`,
          `Palette, use only these colours: ${ctx.bible.palette.join(", ")}.`,
          ...context.prompt.styleNotes(ctx.spec, ctx.bible).map((n) => `Style note: ${n}`),
        ].join("\n"),
        ctx.note,
      );
      const image = await ctx.call.image(
        ATLAS_OPERATION,
        prompt,
        [reference("layout", "corner-16-template.png", raster.encodePng(template))],
        ctx.seed,
      );
      const source = raster.decode(image.bytes);
      const scale = Math.min(side / source.width, side / source.height);
      const fitted = raster.scale(
        source,
        scale,
        { x: (side - source.width * scale) / 2, y: (side - source.height * scale) / 2 },
        { width: side, height: side },
        style.edges,
      );
      const atlas = raster.applyStyle(fitted, style);
      return {
        output: {
          mediaType: "image/png",
          extension: "png",
          bytes: raster.encodePng(atlas),
          fields: { layout: CORNER16_LAYOUT, tileSize, terrains },
        },
        qa: { passed: true, reasons: [] },
        prompt,
        parameters: { tileSize, layout: CORNER16_LAYOUT, terrains },
      };
    },
  };
}
