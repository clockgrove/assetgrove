import type {
  KindCheck,
  MediaOutput,
  Raster,
  TargetProfile,
} from "@clockgrove/assetgrove/extension";
import { extensionContext, sampleBible, sampleProfile } from "@clockgrove/assetgrove/testing";
import { BOUNDARY_CONTRAST_CHECK, iconsFamilyKind } from "../../src/kind.ts";

export const context = extensionContext("icons");
export const kind = iconsFamilyKind(context);

export const spec = { kind: "icons:family", assetId: "save", subject: "save" };

/** The target profile of the icons kind at 16px with the given backgrounds. */
export function profileOf(backgrounds: string[], style?: TargetProfile["style"]): TargetProfile {
  return sampleProfile({
    kinds: { "icons:family": { size: 16, backgrounds } },
    ...(style !== undefined && { style }),
  });
}

/** A raster of `size` painted by `paint`, as candidate media. */
export function iconOutput(size: number, paint: (r: Raster) => void): MediaOutput {
  const r = context.raster.create(size, size);
  paint(r);
  return {
    mediaType: "image/png",
    extension: "png",
    bytes: context.raster.encodePng(r),
    fields: { size },
  };
}

export function fill(
  r: Raster,
  from: number,
  to: number,
  rgba: readonly [number, number, number, number],
): void {
  for (let y = from; y < to; y++)
    for (let x = from; x < to; x++) context.raster.setPixel(r, x, y, rgba);
}

/** The reasons of the kind's exact contrast check on an icon. */
export async function contrastReasons(output: MediaOutput, profile: TargetProfile) {
  const check = kind.checks?.find((c) => c.name === BOUNDARY_CONTRAST_CHECK) as KindCheck;
  return check.run!({ spec, profile, bible: sampleBible(), output }, undefined as never);
}
