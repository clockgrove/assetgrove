/**
 * A synthetic world for tests: a style bible (its style view, written as a BIBLE.md by
 * `writeStyleBible`) whose reference images are drawn in code, a target
 * profile with a typical asset manifest, and a scripted provider
 * that "generates" opaque images of a blob on a plain background. Nothing here is private art.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BIBLE_PRESETS, serializeBible } from "../../src/bible.ts";
import type { ArtBible } from "../../src/bible.ts";
import { ScriptedProvider } from "../../src/gateway/scripted.ts";
import type { ImageRequest } from "../../src/gateway/provider.ts";
import { createRaster, encodePng, setPixel } from "../../src/image/raster.ts";
import type { Raster } from "../../src/image/raster.ts";
import type { AssetSpec, StyleBible, TargetProfile } from "../../src/types.ts";

export const PALETTE = ["#26242c", "#5f6470", "#8d939e", "#c4c9d2"];
export const VALIDATOR = fileURLToPath(new URL("./validator.ts", import.meta.url));

function fill(r: Raster, rgb: [number, number, number]): void {
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++) setPixel(r, x, y, [...rgb, 255]);
}

/** A grey "fox" blob: body, a darker mask band and a light belly, offset by `dx`. */
export function drawSubject(
  size: number,
  dx = 0,
  background: [number, number, number] = [245, 243, 238],
): Raster {
  const r = createRaster(size, size);
  fill(r, background);
  const cx = size / 2 + dx;
  const cy = size * 0.6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x - cx) / (size * 0.3);
      const ny = (y - cy) / (size * 0.22);
      if (nx * nx + ny * ny > 1) continue;
      let colour: [number, number, number] = [96, 100, 110];
      if (ny < -0.4) colour = [40, 36, 44];
      else if (ny > 0.4 && Math.abs(nx) < 0.5) colour = [190, 200, 210];
      setPixel(r, x, y, [...colour, 255]);
    }
  }
  return r;
}

export interface World {
  dir: string;
  bibleDir: string;
  bible: StyleBible;
  profile: TargetProfile;
  targetDir: string;
  runsDir: string;
}

export function syntheticProfile(overrides: Partial<TargetProfile> = {}): TargetProfile {
  return {
    format: "assetgrove-target-profile/1",
    name: "synthetic-grove",
    license: "MIT",
    values: { creator: "Synthetic Grove" },
    frames: { width: 32, height: 32, maxEdge: 256, durationMs: 250 },
    layout: {
      media: "assets/source/{{spec.assetId}}/{{spec.animationFamily}}.{{output.extension}}",
      manifest: "assets/manifests/{{spec.assetId}}/{{spec.animationFamily}}.json",
    },
    manifest: {
      assetManifestVersion: 1,
      assetId: "{{spec.assetId}}",
      animationFamily: "{{spec.animationFamily}}",
      source: {
        kind: "generated",
        path: "{{output.path}}",
        mediaType: "{{output.mediaType}}",
        creator: "{{profile.creator}}",
        tool: "assetgrove",
      },
      license: "{{profile.license}}",
      provenance: {
        prompt: "{{provenance.prompt}}",
        references: "{{provenance.referenceHashes}}",
        generated: "{{provenance}}",
      },
      review: { status: "pending" },
      semantic: "{{spec.fields.semantic?}}",
      frames: "{{output.frames}}",
      anchor: "{{output.anchor}}",
      bounds: "{{output.bounds}}",
      palette: "{{output.palette?}}",
      contentHash: "{{output.sha256}}",
      accessibilityLabel: "{{spec.fields.accessibilityLabel?}}",
    },
    review: { path: "review.status", pending: "pending" },
    validator: { command: [process.execPath, VALIDATOR, "{{manifest}}"] },
    ...overrides,
  };
}

export async function syntheticWorld(): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-"));
  const bibleDir = join(dir, "bible");
  await mkdir(join(bibleDir, "refs"), { recursive: true });
  await writeFile(join(bibleDir, "refs/fern-sheet.png"), encodePng(drawSubject(48)));
  await writeFile(join(bibleDir, "refs/fern-turnaround.png"), encodePng(drawSubject(48, 4)));
  await writeFile(join(bibleDir, "refs/den.png"), encodePng(drawSubject(48, -2)));
  await writeFile(
    join(bibleDir, "refs/perspective.png"),
    encodePng(drawSubject(48, 0, [200, 220, 200])),
  );
  const bible: StyleBible = {
    version: "synthetic-1",
    referenceLicense: "NOASSERTION",
    palette: PALETTE,
    references: [
      { path: "refs/fern-sheet.png", role: "character sheet", subject: "fern" },
      { path: "refs/fern-turnaround.png", role: "turnaround", subject: "fern" },
      { path: "refs/den.png", role: "prop", subject: "den" },
      { path: "refs/perspective.png", role: "perspective" },
    ],
    perspective: "refs/perspective.png",
    subjects: {
      fern: { description: "a grey adult fox with a dark mask" },
      den: { description: "a wooden fox den" },
    },
    mood: ["quiet", "storybook realism"],
  };
  // An author-approved key pose beside the spec, which shelterSpec names.
  await writeFile(join(dir, "key-pose.png"), encodePng(drawSubject(96, 3)));
  const targetDir = join(dir, "target");
  await mkdir(targetDir);
  return {
    dir,
    bibleDir,
    bible,
    profile: syntheticProfile(),
    targetDir,
    runsDir: join(dir, "runs"),
  };
}

export const shelterSpec: AssetSpec = {
  kind: "sprite-strip",
  assetId: "fern",
  animationFamily: "shelter",
  frames: { count: 6 },
  anchor: { x: 16, y: 30 },
  keyPose: "key-pose.png",
  fields: {
    semantic: { role: "actor", entity: "grove.fern" },
    accessibilityLabel: "Fern sheltering",
  },
};

export interface ScriptOptions {
  /** Candidate indices (zero-based) whose vision verdict fails identity. */
  failIdentity?: number[];
  imageCostUsd?: number;
  visionCostUsd?: number;
  /** Draws the image for a frame number an edit prompt asks for; drawSubject(96, frame) else. */
  drawFrame?: (frame: number) => Raster;
  /** The `cutout` decision's probability of a fault per call (zero-based); 0 (no fault) else. */
  cutout?: (index: number) => number;
  cutoutCostUsd?: number;
}

/** The frame number an edit prompt asks for, so scripted frames differ. */
function frameOf(request: ImageRequest): number {
  const m = /frame (\d+) of/.exec(request.prompt);
  return m?.[1] ? Number(m[1]) : 0;
}

export function scriptedProvider(options: ScriptOptions = {}): ScriptedProvider {
  let cutouts = 0;
  return new ScriptedProvider({
    ...(options.cutout !== undefined && {
      cutout: () => ({
        answer: { type: "boolean" as const, probability: options.cutout?.(cutouts++) ?? 0 },
        ...(options.cutoutCostUsd !== undefined && { costUsd: options.cutoutCostUsd }),
      }),
    }),
    image: (request) => ({
      images: [
        {
          mediaType: "image/png",
          bytes: encodePng(
            options.drawFrame?.(frameOf(request)) ?? drawSubject(96, frameOf(request)),
          ),
        },
      ],
      ...(options.imageCostUsd !== undefined && { costUsd: options.imageCostUsd }),
      ...(request.seed !== undefined && { seed: request.seed }),
    }),
    vision: (_request, index) => {
      const identity = !(options.failIdentity ?? []).includes(index);
      return {
        text:
          "```json\n" +
          JSON.stringify({
            checks: [
              {
                check: "transparency",
                passed: true,
                reason: "the background is fully transparent",
              },
              {
                check: "frame-count",
                passed: true,
                reason: "the frames are distinct and in their cells",
              },
              {
                check: "identity",
                passed: identity,
                reason: identity
                  ? "same grey fox with a dark mask as the sheet"
                  : "a different animal",
              },
              {
                check: "perspective",
                passed: true,
                reason: "three-quarter view matches the sample",
              },
            ],
          }) +
          "\n```",
        ...(options.visionCostUsd !== undefined && { costUsd: options.visionCostUsd }),
      };
    },
  });
}

/**
 * Writes a BIBLE.md whose style view (`styleBibleOf`) carries `view`'s version, licence, palette,
 * references, perspective, subjects and mood: the cozy-storybook preset with the palette as
 * tokens and the references as positive anchors. Its notes are the preset's axes and tone, since a
 * BIBLE.md states style as axes. `edit` changes the bible before it is written. Returns `path`.
 */
export async function writeStyleBible(
  path: string,
  view: StyleBible,
  edit: (bible: ArtBible) => void = () => {},
): Promise<string> {
  const bible = structuredClone(BIBLE_PRESETS["cozy-storybook"]) as ArtBible;
  bible.version = view.version;
  bible.world = "Synthetic Grove";
  if (view.referenceLicense !== undefined) bible.referenceLicense = view.referenceLicense;
  const palette: Record<string, unknown> = { $type: "color" };
  view.palette.forEach((hex, i) => {
    const h = hex.trim().replace(/^#/, "");
    palette[`swatch-${i}`] = {
      $value: {
        colorSpace: "srgb",
        components: [0, 2, 4].map((n) => parseInt(h.slice(n, n + 2), 16) / 255),
      },
    };
  });
  bible.tokens = { ...bible.tokens, palette };
  bible.anchors = {
    positive: view.references.map(({ path, role, subject, look, view: v, license }) => ({
      path,
      role,
      ...(subject !== undefined && { subject }),
      ...(look !== undefined && { look }),
      ...(v !== undefined && { view: v }),
      ...(license !== undefined && { license }),
    })),
    negative: [],
  };
  if (view.perspective !== undefined) bible.perspective = view.perspective;
  if (view.perspectiveDescription !== undefined)
    bible.perspectiveDescription = view.perspectiveDescription;
  if (view.subjects !== undefined) bible.subjects = view.subjects;
  if (view.mood !== undefined) {
    bible.tone = { ...bible.tone, moodRange: view.mood };
    bible.adjustable = { ...bible.adjustable, mood: view.mood.slice(0, 1) };
  }
  edit(bible);
  await writeFile(
    path,
    serializeBible(
      bible,
      "# Synthetic Grove art direction\n\n## Do's and Don'ts\n\n- Do keep it plain.\n",
    ),
  );
  return path;
}

/** The synthetic world's bible as `bible/BIBLE.md` (`writeStyleBible`); returns its path. */
export async function syntheticBibleMd(
  world: World,
  edit: (bible: ArtBible) => void = () => {},
): Promise<string> {
  return writeStyleBible(join(world.bibleDir, "BIBLE.md"), world.bible, edit);
}
