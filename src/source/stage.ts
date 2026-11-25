/**
 * Renders an editable artwork file (Aseprite) into a staged run: the frames of one tag as a strip,
 * with the source's path and hash recorded in provenance, so `pick` writes the lineage.
 */
import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { InputError } from "../errors.ts";
import { isStripKind } from "../frames.ts";
import type { KindTraits } from "../frames.ts";
import { createRaster, encodePng, getPixel } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { readBytes, readJson, loadProfile } from "../inputs.ts";
import { licenseFields } from "../license.ts";
import { writeRun } from "../loop.ts";
import type { RunRecord, StagedCandidate } from "../loop.ts";
import { DIGITAL_SOURCE_TYPES, embedDigitalSourceType, metadataStep } from "../metadata.ts";
import type { DigitalSourceType } from "../metadata.ts";
import { sourceDeclaration } from "../metadata.ts";
import { sha256 } from "../request.ts";
import { canonicalJson } from "../runs/plan.ts";
import { pixelHash } from "../transform/run.ts";
import type { AssetSpec, Box, EditableSource, Point, Provenance } from "../types.ts";
import { readAseprite } from "./aseprite.ts";

export interface StageSourceOptions {
  source: string;
  spec: string;
  profile: string;
  runsDir: string;
  digitalSourceType?: DigitalSourceType;
  /** The loaded kinds; the spec's kind must be a strip kind. */
  traits: KindTraits;
  now?: () => Date;
}

export interface StagedSource {
  run: RunRecord;
  runDir: string;
  candidate: StagedCandidate;
  editableSource: EditableSource;
}

/** The union box of pixels with any alpha, over a strip of `count` frames of `width` x `height`. */
function visibleUnion(strip: Raster, count: number, width: number, height: number) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < count; i++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (getPixel(strip, i * width + x, y)[3] === 0) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) return undefined;
  const box: Box = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  return box;
}

export async function stageSource(options: StageSourceOptions): Promise<StagedSource> {
  const now = (options.now ?? (() => new Date()))();
  const spec = await readJson<AssetSpec>(options.spec);
  if (!isStripKind(spec.value.kind, options.traits) || spec.value.animationFamily === undefined)
    throw new InputError(
      "stage-source needs a spec of a strip kind (such as sprite-strip) with an assetId and an animationFamily",
    );
  const family = spec.value.animationFamily;
  const profile = await loadProfile(options.profile);
  const bytes = await readBytes(options.source, "source");
  const sourceSha = sha256(bytes);
  const doc = readAseprite(bytes, options.source);

  let tag: string | undefined;
  let frames: number[];
  if (doc.tags.length === 0) {
    frames = doc.frames.map((_, i) => i);
  } else {
    const found = doc.tags.find((t) => t.name === family);
    if (!found)
      throw new InputError(
        `${options.source} has no tag named "${family}" (the spec's animationFamily); its tags are ${doc.tags.map((t) => `"${t.name}"`).join(", ")}`,
      );
    tag = found.name;
    frames = Array.from({ length: found.to - found.from + 1 }, (_, i) => found.from + i);
  }
  const { width, height } = profile.value.frames;
  if (doc.width !== width || doc.height !== height)
    throw new InputError(
      `${options.source} is ${doc.width}x${doc.height}; the profile's frames are ${width}x${height}`,
    );

  const strip = createRaster(width * frames.length, height);
  frames.forEach((source, i) => {
    const frame = doc.frames[source] as Raster;
    for (let y = 0; y < height; y++)
      strip.data.set(
        frame.data.subarray(y * width * 4, (y + 1) * width * 4),
        (y * strip.width + i * width) * 4,
      );
  });
  const bounds = visibleUnion(strip, frames.length, width, height);
  if (!bounds) throw new InputError(`${options.source} has no visible pixel in ${family}`);

  const declaration =
    options.digitalSourceType === undefined
      ? undefined
      : sourceDeclaration(options.digitalSourceType);
  const digitalSourceType = declaration?.value ?? DIGITAL_SOURCE_TYPES.undeclared;
  const png = embedDigitalSourceType(encodePng(strip), "image/png", digitalSourceType);

  const runId = `r-${createHash("sha256")
    .update(
      canonicalJson({
        source: sourceSha,
        spec: spec.value,
        profile: profile.value,
        digitalSourceType,
      }),
    )
    .digest("hex")
    .slice(0, 16)}`;
  const runDir = resolve(options.runsDir, runId);
  await mkdir(runDir, { recursive: true });

  const anchor: Point = spec.value.anchor ?? { x: Math.floor(width / 2), y: height - 1 };
  const durationMs = profile.value.frames.durationMs;
  const fieldFrames = {
    count: frames.length,
    width,
    height,
    ...(durationMs !== undefined && { durationMs }),
  };
  const editableSource: EditableSource = {
    path: await realpath(options.source),
    sha256: sourceSha,
    format: "aseprite",
    ...(tag !== undefined && { tag }),
    frames,
    durationsMs: frames.map((i) => doc.durationsMs[i] as number),
  };
  const at = now.toISOString();
  const provenance: Provenance = {
    digitalSourceType,
    ...(declaration && { sourceDeclaration: declaration }),
    generator: "aseprite",
    route: "source:aseprite",
    models: [],
    prompt: `Rendered from the editable source ${basename(options.source)}; no model call.`,
    parameters: {
      frame: { width, height },
      frameCount: frames.length,
      anchor,
      ...(tag !== undefined && { tag }),
      sourceFrames: frames,
    },
    requestIds: [],
    referenceHashes: [],
    bibleVersion: "none",
    ...licenseFields(profile.value, []),
    providerTerms: [],
    startedAt: at,
    finishedAt: at,
    costUsd: 0,
    calls: [],
    editableSource,
    steps: [metadataStep(digitalSourceType, [pixelHash(strip)])],
  };
  const candidate: StagedCandidate = {
    id: "c1",
    file: "c1.png",
    mediaType: "image/png",
    extension: "png",
    sha256: sha256(png),
    reasons: [
      {
        check: "source-frames",
        passed: true,
        reason: `the frames are read from the source as drawn (${frames.length} from ${basename(options.source)})`,
        source: "deterministic",
      },
    ],
    fields: { frames: fieldFrames, anchor, bounds },
    provenance,
  };
  const run: RunRecord = {
    runId,
    runDir,
    createdAt: at,
    spec: spec.value,
    specDir: spec.dir,
    profile: profile.value,
    bibleVersion: "none",
    capUsd: 0,
    estimateUsd: 0,
    spentUsd: 0,
    requested: 1,
    candidates: [candidate],
    filtered: 0,
    errors: [],
  };
  await writeFile(join(runDir, candidate.file), png);
  await writeRun(runDir, run);
  return { run, runDir, candidate, editableSource };
}
