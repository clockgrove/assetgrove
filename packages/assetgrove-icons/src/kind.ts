/**
 * The `icons:family` kind: one icon per asset at one size, checked for boundary contrast against
 * each background the target profile declares. An icon family is the assets that share a `subject`.
 */
import { createHash } from "node:crypto";
import type {
  AssetKind,
  ExtensionContext,
  KindCheck,
  KindCheckInput,
  LoadedReference,
  Reason,
  StyleBible,
  TargetProfile,
} from "@clockgrove/assetgrove/extension";
import { MIN_CONTRAST, boundaryContrast, compositeOver, formatRatio } from "./contrast.ts";
import type { Rgb } from "./contrast.ts";

export const ICONS_KIND = "icons:family";
export const STILL_OPERATION = "icons:still";
export const IDENTIFY_OPERATION = "icons:identify";
export const BOUNDARY_CONTRAST_CHECK = "icons:boundary-contrast";
export const IDENTIFIABLE_CHECK = "icons:identifiable";

/** The profile's `kinds["icons:family"]` block, without `values` and `layout`. */
export interface IconsProfile {
  size: number;
  backgrounds: string[];
}

/** An error core maps to exit 2 `invalid_input` by its own code. */
function invalidInput(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid_input" });
}

function hexRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function iconsFamilyKind(context: ExtensionContext): AssetKind {
  const { z, raster } = context;
  const profileSchema = z.strictObject({
    size: z.number().int().positive(),
    backgrounds: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(1),
  });

  /** The kind's block of the profile, validated; its `values` and `layout` are core's. */
  function iconsProfileOf(profile: TargetProfile): IconsProfile {
    const block = profile.kinds?.[ICONS_KIND];
    if (block === undefined)
      throw invalidInput(
        `the target profile has no kinds["${ICONS_KIND}"] block (size, backgrounds)`,
      );
    const own = Object.fromEntries(
      Object.entries(block).filter(([field]) => field !== "values" && field !== "layout"),
    );
    const parsed = profileSchema.safeParse(own);
    if (!parsed.success)
      throw invalidInput(
        `kinds["${ICONS_KIND}"] is invalid: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(block)"} ${i.message}`)
          .join("; ")}`,
      );
    return parsed.data;
  }

  const thresholdOf = (profile: TargetProfile, bible: StyleBible): number =>
    raster.resolveStyle(profile.style, bible.palette).alpha.threshold;

  const boundaryContrastCheck: KindCheck = {
    name: BOUNDARY_CONTRAST_CHECK,
    mode: "exact",
    source: "deterministic",
    run({ profile, bible, output }: KindCheckInput): Reason[] {
      const { backgrounds } = iconsProfileOf(profile);
      const threshold = thresholdOf(profile, bible);
      const icon = raster.decode(output.bytes);
      return backgrounds.map((background): Reason => {
        const { minimum } = boundaryContrast(icon, threshold, hexRgb(background));
        const base = { check: BOUNDARY_CONTRAST_CHECK, source: "deterministic" } as const;
        if (minimum === undefined)
          return {
            ...base,
            passed: false,
            reason: `boundary contrast on ${background}: nothing visible at the threshold ${threshold}`,
          };
        const passed = minimum >= MIN_CONTRAST;
        return {
          ...base,
          passed,
          reason: `boundary contrast on ${background} is ${formatRatio(minimum)}:1, ${
            passed ? "at least" : "below"
          } ${MIN_CONTRAST}:1`,
        };
      });
    },
  };

  const identifiableCheck: KindCheck = {
    name: IDENTIFIABLE_CHECK,
    mode: "model",
    operation: IDENTIFY_OPERATION,
    version: "1",
    source: "decision",
    async run({ spec, profile, output }, call): Promise<Reason[]> {
      const { backgrounds } = iconsProfileOf(profile);
      const subject = context.prompt.subjectOf(spec);
      const icon = raster.decode(output.bytes);
      const reasons: Reason[] = [];
      for (const background of backgrounds) {
        const bg = hexRgb(background);
        const flat = raster.create(icon.width, icon.height);
        for (let y = 0; y < icon.height; y++)
          for (let x = 0; x < icon.width; x++) {
            const [r, g, b, a] = raster.getPixel(icon, x, y);
            const [cr, cg, cb] = compositeOver([r, g, b], a, bg);
            raster.setPixel(flat, x, y, [Math.round(cr), Math.round(cg), Math.round(cb), 255]);
          }
        const bytes = raster.encodePng(flat);
        const reference: LoadedReference = {
          role: "icon",
          path: `icon-on-${background}.png`,
          mediaType: "image/png",
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
        const { result } = await call.decide(
          IDENTIFY_OPERATION,
          `The image shows a UI icon of "${subject}" on a flat ${background} background.`,
          [reference],
          {
            type: "boolean",
            instructions: `Is the icon in this image recognisable as ${subject}, at a glance, against its ${background} background?`,
            whenTrue: "the icon is recognisable",
            whenFalse: "the icon is not recognisable",
          },
        );
        const answer = result.answer;
        const passed = answer.type === "boolean" && answer.probability >= 0.5;
        reasons.push({
          check: IDENTIFIABLE_CHECK,
          passed,
          reason: `the icon is ${passed ? "" : "not "}recognisable as ${subject} on ${background}`,
          source: "decision",
        });
      }
      return reasons;
    },
  };

  return {
    kind: ICONS_KIND,
    operations: { [STILL_OPERATION]: "image", [IDENTIFY_OPERATION]: "decisions" },
    profileSchema,
    checks: [boundaryContrastCheck, identifiableCheck],
    planCandidate(_spec, profile, routes) {
      const { backgrounds } = iconsProfileOf(profile);
      const plan = (operation: string) => {
        const route = routes[operation];
        if (route === undefined) throw invalidInput(`no route for the ${operation} operation`);
        return { operation, model: route.model, estimatedCostUsd: route.estimatedCostUsd };
      };
      return [plan(STILL_OPERATION), ...backgrounds.map(() => plan(IDENTIFY_OPERATION))];
    },
    async generate(ctx) {
      const { size, backgrounds } = iconsProfileOf(ctx.profile);
      const style = raster.resolveStyle(ctx.profile.style, ctx.bible.palette);
      const subject = context.prompt.subjectOf(ctx.spec);
      const prompt = context.prompt.withNote(
        [
          `A single UI icon of ${subject}, centred, on a transparent background, readable at ${size}px.`,
          `Palette, use only these colours: ${ctx.bible.palette.join(", ")}.`,
          ...context.prompt.styleNotes(ctx.spec, ctx.bible).map((n) => `Style note: ${n}`),
        ].join("\n"),
        ctx.note,
      );
      const image = await ctx.call.image(STILL_OPERATION, prompt, [], ctx.seed);
      const source = raster.decode(image.bytes);
      const scale = Math.min(size / source.width, size / source.height);
      const fitted = raster.scale(
        source,
        scale,
        { x: (size - source.width * scale) / 2, y: (size - source.height * scale) / 2 },
        { width: size, height: size },
        style.edges,
      );
      const icon = raster.applyStyle(fitted, style);
      return {
        output: {
          mediaType: "image/png",
          extension: "png",
          bytes: raster.encodePng(icon),
          fields: { size },
        },
        qa: { passed: true, reasons: [] },
        prompt,
        parameters: { size, backgrounds },
      };
    },
  };
}
