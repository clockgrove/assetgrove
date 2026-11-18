/**
 * The `aseprite-json` preset (design section 14): the `atlas-json` document with a `duration` on
 * each frame and `meta.frameTags` covering frames 0 to count-1, in the form Aseprite's own export
 * writes. Hand-written like `atlas-json`.
 */
import type { z } from "zod";
import type { HandoffPreset } from "./index.ts";
import {
  animationProblems,
  animationsOf,
  atlasFile,
  atlasOptions,
  buildAtlas,
  checkAtlas,
  sidecarPath,
  stripGeometry,
} from "./atlas-json.ts";
import type { AtlasShape } from "./atlas-json.ts";

export const asepriteJsonPreset: HandoffPreset<{ shape: AtlasShape }> = {
  name: "aseprite-json",
  optionsSchema: atlasOptions("array") as z.ZodType<{ shape: AtlasShape }>,
  async write(ctx, { shape }) {
    const g = stripGeometry(ctx, "aseprite-json");
    const doc = buildAtlas(g, shape, true);
    doc.animations = animationsOf(g);
    doc.meta["frameTags"] = [{ name: g.animation, from: 0, to: g.count - 1, direction: "forward" }];
    return [atlasFile(sidecarPath(g.media, ".aseprite.json"), doc)];
  },
  async check(ctx, { shape }, files, read) {
    const g = stripGeometry(ctx, "aseprite-json");
    const file = files[0]?.path ?? sidecarPath(g.media, ".aseprite.json");
    return checkAtlas(g, shape, file, read, (doc) => {
      const rawMeta = doc["meta"];
      const meta =
        rawMeta !== null && typeof rawMeta === "object" && !Array.isArray(rawMeta)
          ? (rawMeta as Record<string, unknown>)
          : {};
      const tags = Array.isArray(meta["frameTags"]) ? (meta["frameTags"] as unknown[]) : [];
      const covered = new Set<number>();
      const problems = animationProblems(g, doc, file);
      for (const t of tags) {
        const { from, to } = (t ?? {}) as { from?: unknown; to?: unknown };
        if (Number.isInteger(from) && Number.isInteger(to)) {
          if ((from as number) < 0 || (to as number) > g.count - 1) {
            problems.push(
              `${file} a meta.frameTags entry names frames outside 0 to ${g.count - 1}`,
            );
            continue;
          }
          for (let i = from as number; i <= (to as number); i++) covered.add(i);
        }
      }
      if (!Array.from({ length: g.count }, (_, i) => covered.has(i)).every(Boolean)) {
        problems.push(`${file} meta.frameTags do not cover frames 0 to ${g.count - 1}`);
      }
      const frames = doc["frames"];
      const list = Array.isArray(frames) ? frames : Object.values((frames ?? {}) as object);
      if (list.some((f) => (f as { duration?: unknown })?.duration !== g.durationMs)) {
        problems.push(`${file} a frame has no duration of ${g.durationMs}`);
      }
      return problems;
    });
  },
};
