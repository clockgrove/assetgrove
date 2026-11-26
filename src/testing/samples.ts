/**
 * Synthetic inputs for pack tests (`@clockgrove/assetgrove/testing`): a style bible (its style
 * view, and that view written as a BIBLE.md), a target profile, a script for the scripted
 * provider and a WAV master. Nothing here names a real game or its art.
 */
import { encodeWav } from "../audio/engine.ts";
import { BIBLE_PRESETS, serializeBible } from "../bible.ts";
import type { ArtBible } from "../bible.ts";
import type { Script } from "../gateway/scripted.ts";
import { createRaster, encodePng, setPixel } from "../image/raster.ts";
import type { StyleBible, TargetProfile } from "../types.ts";

/** The synthetic palette every sample uses. */
export const SAMPLE_PALETTE = ["#1d2b35", "#5c8a4d", "#d9c27a", "#f4efe1"];

/** An 8x8 PNG: a 4x4 square of the palette's second colour on transparency. */
export function samplePng(size = 8): Uint8Array {
  const r = createRaster(size, size);
  const q = Math.floor(size / 4);
  for (let y = q; y < size - q; y++)
    for (let x = q; x < size - q; x++) setPixel(r, x, y, [0x5c, 0x8a, 0x4d, 255]);
  return encodePng(r);
}

export function sampleBible(overrides: Partial<StyleBible> = {}): StyleBible {
  return {
    format: "assetgrove-style-bible/1",
    version: "sample-1",
    referenceLicense: "NOASSERTION",
    palette: [...SAMPLE_PALETTE],
    references: [],
    perspective: "refs/perspective.png",
    subjects: { sample: { description: "a synthetic sample subject" } },
    mood: ["calm"],
    ...overrides,
  };
}

/**
 * A BIBLE.md whose style view (what `stage` and the other generation commands read) carries
 * `view`'s version, licence, palette, references, perspective, subjects and mood: the
 * cozy-storybook preset with the palette as tokens and the references as positive anchors. Its
 * style notes are the preset's axes and tone, since a BIBLE.md states style as axes. `edit` changes
 * the bible before it is written. Write it where a command's `--bible` will read it.
 */
export function bibleMarkdown(
  view: StyleBible = sampleBible(),
  edit: (bible: ArtBible) => void = () => {},
): string {
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
    positive: view.references.map(({ path, role, subject, look, view: shows, license }) => ({
      path,
      role,
      ...(subject !== undefined && { subject }),
      ...(look !== undefined && { look }),
      ...(shows !== undefined && { view: shows }),
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
  return serializeBible(
    bible,
    "# Synthetic Grove art direction\n\n## Do's and Don'ts\n\n- Do keep it plain.\n",
  );
}

export function sampleProfile(overrides: Partial<TargetProfile> = {}): TargetProfile {
  return {
    format: "assetgrove-target-profile/1",
    name: "sample-target",
    license: "MIT",
    frames: { width: 8, height: 8, maxEdge: 256, durationMs: 100 },
    layout: {
      media: "assets/{{spec.assetId}}.{{output.extension}}",
      manifest: "assets/manifests/{{spec.assetId}}.json",
    },
    manifest: { assetId: "{{spec.assetId}}", review: { status: "pending" } },
    review: { path: "review.status", pending: "pending" },
    ...overrides,
  };
}

/**
 * A script for the scripted provider: every image call answers `samplePng()` and every vision call
 * `{}`. Spread it into a script of your own to answer decisions or embeddings too.
 */
export function sampleScript(): Script {
  return {
    image: () => ({ images: [{ mediaType: "image/png", bytes: samplePng() }] }),
    vision: () => ({ text: "{}" }),
  };
}

/** What `sampleWav` makes: its length, rate, channels and tone. */
export interface SampleWavOptions {
  /** Sample frames (default 44100, one second at the default rate). */
  frames?: number;
  /** Sample rate in Hz (default 44100). */
  sampleRate?: number;
  /** Channels (default 2); a stereo file's right channel is a fifth above the left. */
  channels?: number;
  /** The tone in Hz (default 220). */
  hz?: number;
  /** Whether it is a loop: its RIFF `smpl` chunk loops all of it, as a loop master's does. */
  loop?: boolean;
}

/**
 * A synthetic 16-bit WAV master, a sine tone at half scale written by core's audio engine. A loop
 * carries the `smpl` chunk an `ambience` or music loop master carries: one forward loop from
 * frame 0 to its length.
 */
export function sampleWav(options: SampleWavOptions = {}): Uint8Array {
  const frames = options.frames ?? 44100;
  const sampleRate = options.sampleRate ?? 44100;
  const hz = options.hz ?? 220;
  const channels = Array.from({ length: options.channels ?? 2 }, (_, c) => {
    const tone = hz * (c === 0 ? 1 : 1.5);
    return Float64Array.from(
      { length: frames },
      (_, i) => 0.5 * Math.sin((2 * Math.PI * tone * i) / sampleRate),
    );
  });
  return encodeWav(
    { name: "sample", channels, sampleRate, bitDepth: "16", meta: {} },
    options.loop === true ? { loop: { start: 0, end: frames } } : {},
  );
}
