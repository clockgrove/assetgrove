/**
 * A kind's `frames` trait and the frame layout a strip kind's output carries (#417). Core's
 * frame features (plan/apply, vary, contact sheets, thumbnails, staleness, the atlas presets) ask
 * the trait of a kind, never its name, and read the layout. A kind that declares no trait has no
 * frames: every strip feature treats it as not a strip.
 */
import { z } from "zod";
import { decodeImage } from "./image/raster.ts";
import type { MediaOutput } from "./types.ts";

/** How a kind's output is cut into frames: one image, or a strip of frames in one row. */
export type FramesTrait = "single" | "strip";

/** The trait values a kind may declare. */
export const FRAMES_TRAITS: readonly FramesTrait[] = ["single", "strip"];

/**
 * The frame layout a strip kind's output carries as `output.fields.frames`: `count` frames of
 * `width` × `height` pixels in one row, in `order` (only `left-to-right`; absent means it).
 */
export interface FrameLayout {
  count: number;
  width: number;
  height: number;
  order?: "left-to-right";
  /** Each frame's duration, when the kind sets one; the profile's otherwise. */
  durationMs?: number;
}

const positive = z.number().int().positive();

/** Core's check of a frame layout. */
export const FRAME_LAYOUT_SCHEMA = z.object({
  count: positive,
  width: positive,
  height: positive,
  order: z.literal("left-to-right").optional(),
  durationMs: positive.optional(),
});

/** The kinds whose traits a frame feature reads: a registry, or a list of kinds. */
export interface KindTraits {
  readonly kinds: ReadonlyArray<{ readonly kind: string; readonly frames?: FramesTrait }>;
}

/** The kind's declared trait; undefined for a kind that declares none or is not registered. */
export function framesOf(kind: unknown, traits: KindTraits): FramesTrait | undefined {
  if (typeof kind !== "string") return undefined;
  return traits.kinds.find((k) => k.kind === kind)?.frames;
}

/** True when the kind declares `frames: "strip"`. */
export function isStripKind(kind: unknown, traits: KindTraits): boolean {
  return framesOf(kind, traits) === "strip";
}

/** The layout an output's fields carry, or undefined when they carry none that core accepts. */
export function frameLayoutOf(fields: unknown): FrameLayout | undefined {
  if (fields === null || typeof fields !== "object") return undefined;
  const parsed = FRAME_LAYOUT_SCHEMA.safeParse((fields as Record<string, unknown>)["frames"]);
  return parsed.success ? (parsed.data as FrameLayout) : undefined;
}

/**
 * The validated layout of a strip kind's output; throws naming the kind when the output carries
 * none, or when its image is not `count` frames of that size in one row.
 */
export function checkFrameLayout(kind: string, output: MediaOutput): FrameLayout {
  const parsed = FRAME_LAYOUT_SCHEMA.safeParse(output.fields["frames"]);
  if (!parsed.success)
    throw new Error(
      `kind ${kind} declares frames "strip" but its output carries no valid frame layout (output.fields.frames: positive integer count, width and height): ${parsed.error.issues.map((i) => `${i.path.join(".") || "frames"}: ${i.message}`).join("; ")}`,
    );
  const layout = parsed.data as FrameLayout;
  if (output.mediaType.startsWith("image/")) {
    let size: { width: number; height: number } | undefined;
    try {
      size = decodeImage(output.bytes);
    } catch {
      size = undefined;
    }
    if (
      size !== undefined &&
      (size.width !== layout.width * layout.count || size.height !== layout.height)
    )
      throw new Error(
        `kind ${kind}'s output is ${size.width}×${size.height}, not the ${layout.count} frames of ${layout.width}×${layout.height} in one row its frame layout declares`,
      );
  }
  return layout;
}

/**
 * A strip candidate's provenance parameters with its layout's `frame` and `frameCount`, which
 * thumbnails and staleness read; added only when the kind left them out, and refused when they
 * disagree with the layout.
 */
export function withLayoutParameters(
  kind: string,
  parameters: Record<string, unknown>,
  layout: FrameLayout,
): Record<string, unknown> {
  const frame = parameters["frame"] as { width?: unknown; height?: unknown } | undefined;
  const frameCount = parameters["frameCount"];
  if (frame === undefined && frameCount === undefined)
    return {
      ...parameters,
      frame: { width: layout.width, height: layout.height },
      frameCount: layout.count,
    };
  if (
    frame?.width !== layout.width ||
    frame.height !== layout.height ||
    frameCount !== layout.count
  )
    throw new Error(
      `kind ${kind}'s parameters record frame and frameCount that disagree with its output's frame layout`,
    );
  return parameters;
}
