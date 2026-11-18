/**
 * The `atlas-json` preset (design section 14): sprite-atlas JSON written from a strip's own
 * geometry, without repacking. Frames are named `<assetId>_<nnn>`; `meta` holds app, version,
 * image, format, size and scale; `animations` maps the animation to its frame names. `shape` is
 * `hash` (frames keyed by name) or `array`. The check reads the JSON and the PNG back. The writer
 * is hand-written (docs/decisions.md: no library writes these).
 */
import { posix } from "node:path";
import { z } from "zod";
import { InputError } from "../../errors.ts";
import { decodePng } from "../../image/raster.ts";
import { lookup } from "../../template.ts";
import type { HandoffPreset, PresetContext, PresetFile } from "./index.ts";

export type AtlasShape = "hash" | "array";

export const atlasOptions = (defaultShape: AtlasShape) =>
  z.strictObject({ shape: z.enum(["hash", "array"]).default(defaultShape) });

export interface StripGeometry {
  assetId: string;
  animation: string;
  width: number;
  height: number;
  count: number;
  durationMs: number;
  /** The media path relative to the target directory, with `/`. */
  media: string;
}

const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** The strip's geometry from the hand-off context; anything that is not a strip is invalid input. */
export function stripGeometry(ctx: PresetContext, preset: string): StripGeometry {
  const spec = (lookup(ctx.context, "spec") ?? {}) as Record<string, unknown>;
  const frames = lookup(ctx.context, "output.frames") as Record<string, unknown> | undefined;
  const media = lookup(ctx.context, "output.path");
  const assetId = spec["assetId"];
  if (
    ctx.frames !== "strip" ||
    frames === undefined ||
    frames === null ||
    !posInt(frames["width"]) ||
    !posInt(frames["height"]) ||
    !posInt(frames["count"]) ||
    typeof media !== "string" ||
    typeof assetId !== "string"
  ) {
    throw new InputError(
      `preset "${preset}" needs a sprite strip with frame width, height and count`,
    );
  }
  const family = spec["animationFamily"];
  const duration = frames["durationMs"] ?? ctx.profile.frames.durationMs;
  return {
    assetId,
    animation: typeof family === "string" && family !== "" ? family : assetId,
    width: frames["width"],
    height: frames["height"],
    count: frames["count"],
    durationMs: posInt(duration) ? duration : 100,
    media: media.replaceAll("\\", "/"),
  };
}

export const frameName = (assetId: string, i: number) => `${assetId}_${String(i).padStart(3, "0")}`;

/** The JSON path beside the media: `<media without extension><suffix>`. */
export function sidecarPath(media: string, suffix: string): string {
  const ext = posix.extname(media);
  return `${ext === "" ? media : media.slice(0, -ext.length)}${suffix}`;
}

export interface AtlasDoc {
  frames: Record<string, unknown> | Record<string, unknown>[];
  meta: Record<string, unknown>;
  animations?: Record<string, string[]>;
}

export function buildAtlas(g: StripGeometry, shape: AtlasShape, withDuration: boolean): AtlasDoc {
  const entries = Array.from({ length: g.count }, (_, i) => ({
    filename: frameName(g.assetId, i),
    frame: { x: i * g.width, y: 0, w: g.width, h: g.height },
    rotated: false,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: g.width, h: g.height },
    sourceSize: { w: g.width, h: g.height },
    ...(withDuration && { duration: g.durationMs }),
  }));
  const frames =
    shape === "array"
      ? entries
      : Object.fromEntries(entries.map(({ filename, ...rest }) => [filename, rest]));
  return {
    frames,
    meta: {
      app: "assetgrove",
      version: "1.0",
      image: posix.basename(g.media),
      format: "RGBA8888",
      size: { w: g.width * g.count, h: g.height },
      scale: "1",
    },
  };
}

export const animationsOf = (g: StripGeometry): Record<string, string[]> => ({
  [g.animation]: Array.from({ length: g.count }, (_, i) => frameName(g.assetId, i)),
});

/**
 * Compares a read-back document's `animations` with what the preset wrote (`animationsOf`): the same
 * animation names, each listing the same frame names in the same order.
 */
export function animationProblems(
  g: StripGeometry,
  doc: Record<string, unknown>,
  file: string,
): string[] {
  const want = animationsOf(g);
  const raw = doc["animations"];
  if (!isObject(raw)) return [`${file} has no animations object`];
  const problems: string[] = [];
  const names = Object.keys(want);
  for (const name of Object.keys(raw)) {
    if (!names.includes(name)) problems.push(`${file} animations has an unexpected ${name}`);
  }
  for (const name of names) {
    const got = raw[name];
    const frames = want[name]!;
    if (!Array.isArray(got)) problems.push(`${file} animations has no ${name}`);
    else if (got.length !== frames.length || got.some((n, i) => n !== frames[i])) {
      problems.push(`${file} animations.${name} does not list frames 0 to ${g.count - 1} in order`);
    }
  }
  return problems;
}

export function atlasFile(path: string, doc: unknown): PresetFile {
  return { path, content: `${JSON.stringify(doc, null, 2)}\n` };
}

type Read = (path: string) => Promise<Uint8Array | undefined>;
const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Reads the JSON and the PNG back and returns what disagrees with the strip's geometry. */
export async function checkAtlas(
  g: StripGeometry,
  shape: AtlasShape,
  file: string,
  read: Read,
  extra: (doc: Record<string, unknown>) => string[],
): Promise<string[]> {
  const bytes = await read(file);
  if (bytes === undefined) return [`${file} is missing`];
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return [`${file} is not JSON`];
  }
  if (!isObject(doc)) return [`${file} is not a JSON object`];
  const problems: string[] = [];
  const raw = doc["frames"];
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : isObject(raw)
      ? Object.entries(raw).map(([filename, v]) => (isObject(v) ? { filename, ...v } : v))
      : [];
  if (shape === "hash" ? !isObject(raw) : !Array.isArray(raw)) {
    problems.push(
      `${file} frames is not ${shape === "hash" ? "an object keyed by frame name" : "an array"}`,
    );
  }
  if (list.length !== g.count) {
    problems.push(`${file} lists ${list.length} frames, expected ${g.count}`);
  }
  list.forEach((entry, i) => {
    const e = isObject(entry) ? entry : {};
    const rect = e["frame"];
    const want = { x: i * g.width, y: 0, w: g.width, h: g.height };
    if (e["filename"] !== frameName(g.assetId, i)) {
      problems.push(`${file} frame ${i} is not named ${frameName(g.assetId, i)}`);
    }
    if (!isObject(rect) || (["x", "y", "w", "h"] as const).some((k) => rect[k] !== want[k])) {
      problems.push(`${file} frame ${i} rectangle is not ${JSON.stringify(want)}`);
    }
  });
  const meta = isObject(doc["meta"]) ? doc["meta"] : {};
  const size = isObject(meta["size"]) ? meta["size"] : {};
  const wantSize = { w: g.width * g.count, h: g.height };
  if (size["w"] !== wantSize.w || size["h"] !== wantSize.h) {
    problems.push(`${file} meta.size is not ${wantSize.w}x${wantSize.h}`);
  }
  if (meta["scale"] !== "1") problems.push(`${file} meta.scale is not "1"`);
  const image = meta["image"];
  if (
    typeof image !== "string" ||
    posix.isAbsolute(image) ||
    image.includes("\\") ||
    image.split("/").includes("..")
  ) {
    problems.push(`${file} meta.image is not a relative path with "/"`);
  } else {
    const imagePath = posix.join(posix.dirname(file), image);
    const png = await read(imagePath);
    if (png === undefined)
      problems.push(`${file} meta.image ${image} does not name a written file`);
    else {
      try {
        const px = decodePng(png);
        if (px.width !== wantSize.w || px.height !== wantSize.h) {
          problems.push(
            `${imagePath} is ${px.width}x${px.height}, expected ${wantSize.w}x${wantSize.h}`,
          );
        }
      } catch {
        problems.push(`${imagePath} is not a PNG`);
      }
    }
    if (posix.normalize(imagePath) !== posix.normalize(g.media))
      problems.push(`${file} meta.image does not name ${g.media}`);
  }
  return [...problems, ...extra(doc)];
}

export const atlasJsonPreset: HandoffPreset<{ shape: AtlasShape }> = {
  name: "atlas-json",
  optionsSchema: atlasOptions("hash") as z.ZodType<{ shape: AtlasShape }>,
  write(ctx, { shape }) {
    const g = stripGeometry(ctx, "atlas-json");
    const doc = buildAtlas(g, shape, false);
    doc.animations = animationsOf(g);
    return [atlasFile(sidecarPath(g.media, ".atlas.json"), doc)];
  },
  async check(ctx, { shape }, files, read) {
    const g = stripGeometry(ctx, "atlas-json");
    const file = files[0]?.path ?? sidecarPath(g.media, ".atlas.json");
    return checkAtlas(g, shape, file, read, (doc) => animationProblems(g, doc, file));
  },
};
