/**
 * The per-frame fix: one bad frame of a strip is regenerated as a reference-guided edit from an
 * approved neighbour or the key pose, registered like every other frame and spliced back in. Only
 * that frame changes, and provenance records the call, the source and the pixels before and after.
 */
import { InputError, ProviderError } from "../errors.ts";
import type { Caller } from "../calls.ts";
import type { PlannedCall } from "../generators/generator.ts";
import { decodeImage, encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { forDecision } from "../identity.ts";
import { DIGITAL_SOURCE_TYPES, combineDigitalSourceTypes } from "../metadata.ts";
import { sha256 } from "../request.ts";
import type { Routes } from "../routes.ts";
import { measureFrame, pinX } from "../sheet/register.ts";
import { sheetImportRecipe } from "../sheet/import.ts";
import type { ResolvedStyle } from "../style.ts";
import { pixelHash, runOperation, runRecipe } from "../transform/run.ts";
import type { TransformRecord } from "../transform/run.ts";
import type { ImageItem, TransformStep } from "../transform/types.ts";
import { grantOf, grantProblems } from "../license.ts";
import type {
  CallRecord,
  LoadedReference,
  OutputGrant,
  Point,
  Provenance,
  Size,
} from "../types.ts";
import { onionCell } from "./preview.ts";
import { joinStrip, measureThreshold, splitStrip } from "./strip.ts";
import { DEFAULT_THRESHOLDS } from "./templates.ts";

export const DEFAULT_FIX_CAP_USD = 2;

export type FixSource = { neighbour: number } | { keyPose: { path: string; sha256: string } };

/** One recorded fix of one frame. */
export interface FrameFix {
  /** 1-based frame number. */
  frame: number;
  from: FixSource;
  prompt: string;
  model: string;
  requestId: string;
  seed?: number;
  costUsd: number;
  at: string;
  beforeHash: string;
  afterHash: string;
  /** The size the frame was registered at: the candidates, the one chosen and who chose it. */
  scale?: {
    chosen: string;
    value: number;
    candidates: Record<string, number>;
    /** Present when the candidates differed and the `fix-scale` decision was asked. */
    decision?: { model: string; requestId: string; probability?: number; costUsd: number };
  };
}

/** The edit, and the `fix-scale` decision (an upper bound: it is made only when candidates differ). */
export function planFix(routes: Routes): PlannedCall[] {
  const edit = routes["edit"];
  if (!edit) throw new InputError('no model route for operation "edit"');
  const scale = routes["fix-scale"];
  if (!scale) throw new InputError('no model route for operation "fix-scale"');
  return [
    { operation: "edit", model: edit.model, estimatedCostUsd: edit.estimatedCostUsd },
    { operation: "fix-scale", model: scale.model, estimatedCostUsd: scale.estimatedCostUsd },
  ];
}

export function buildFixPrompt(input: {
  subject: string;
  family: string;
  frame: number;
  count: number;
  source: "neighbour" | "key pose";
  sourceFrame?: number;
  note?: string;
}): string {
  const first =
    input.source === "neighbour"
      ? `Reference image 1 is the approved frame ${input.sourceFrame ?? "?"} of the "${input.family}" cycle of ${input.subject}.`
      : `Reference image 1 is the approved key pose of ${input.subject}.`;
  return [
    first,
    "Reference image 2 is the frame to fix.",
    "Keep the identity, design, colours and scale of image 1 exactly.",
    `Keep the pose of image 2, which is frame ${input.frame} of ${input.count} of the "${input.family}" cycle.`,
    "Draw one whole figure on a plain flat light background or transparent, with the feet at the bottom, no text.",
    ...(input.note ? [`Author's note: ${input.note}`] : []),
  ].join("\n");
}

export interface FixFrameOptions {
  strip: Raster;
  frame: Size;
  anchor: Point;
  family: string;
  /**
   * The point the fixed frame is registered by, the one its family's strip was registered by
   * (`registrationPin`). The fixed frame's pin point is put on the reference neighbour's measured
   * pin point (and its bottom row on the neighbour's, when the neighbour is on the ground), so a planted family's repaired frame keeps
   * its feet on its neighbours' however the strip was placed; `anchor` is used only for a strip of
   * one frame.
   */
  pin: "center" | "footprint";
  /**
   * The ground-contact tolerance, a fraction of the figure's height (the profile's
   * `groundTolerance`). The fixed frame's bottom row goes on the neighbour's only when the
   * neighbour stands within it of `anchor.y`; a neighbour off the ground (an airborne beat) leaves
   * the fixed frame on the ground line.
   */
  groundTolerance?: number;
  subject: string;
  /** 1-based frame to fix. */
  index: number;
  from: { neighbour: number } | { keyPose: LoadedReference };
  style: ResolvedStyle;
  call: Caller;
  /**
   * Calls made for this fix before its edit (the motion-template decision that chose its
   * registration pin): recorded in its provenance ahead of the edit call.
   */
  decisions?: CallRecord[];
  note?: string;
  provenance?: Provenance;
  stripPath?: string;
  /** The license recorded when the strip has no provenance yet (the target profile's). */
  license?: string;
  /** The style bible version recorded when the strip has no provenance yet. */
  bibleVersion?: string;
  now?: () => Date;
}

type FixedProvenance = Provenance & { fixes?: FrameFix[] };

function pngReference(raster: Raster, role: string, path: string): LoadedReference {
  const bytes = encodePng(raster);
  return { role, path, mediaType: "image/png", bytes, sha256: sha256(bytes) };
}

/** The first row holding a pixel at or above the alpha threshold (measureFrame's baseline is the last). */
function topRow(raster: Raster, threshold: number): number {
  for (let y = 0; y < raster.height; y++)
    for (let x = 0; x < raster.width; x++)
      if ((raster.data[(y * raster.width + x) * 4 + 3] as number) >= threshold) return y;
  return raster.height;
}

/** The area of the bounding box of the figure's top quarter of rows (its head). */
function headBoxArea(raster: Raster, threshold: number, top: number, height: number): number {
  const last = Math.min(raster.height - 1, top + Math.ceil(height / 4) - 1);
  let minX = raster.width;
  let maxX = -1;
  let minY = raster.height;
  let maxY = -1;
  for (let y = top; y <= last; y++)
    for (let x = 0; x < raster.width; x++)
      if ((raster.data[(y * raster.width + x) * 4 + 3] as number) >= threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  return maxX < 0 ? 0 : (maxX - minX + 1) * (maxY - minY + 1);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

const EXTENDABLE =
  "fix-frame extends a strip's own provenance (from write-families, pick or an earlier fix-frame) " +
  "or the transform record of recipe or op that lists this strip as an output";

function refuseProvenance(source: string, problems: string[]): InputError {
  return new InputError(
    `cannot extend the provenance ${source}: ${problems.join("; ")}. ${EXTENDABLE}; ` +
      "give that file with --provenance. Nothing was spent",
  );
}

/**
 * What stops a record from being extended by a fix, one entry per field the fix reads or appends
 * to. Empty for a strip's provenance (write-families, stage and pick, an earlier fix).
 */
export function provenanceProblems(value: unknown): string[] {
  if (!isObject(value)) return ["it is not a JSON object"];
  const problems: string[] = [];
  if (typeof value["generator"] !== "string") problems.push("generator is not a string");
  for (const key of ["models", "requestIds", "referenceHashes", "providerTerms"]) {
    if (!isStrings(value[key])) problems.push(`${key} is not a list of strings`);
  }
  if (!Array.isArray(value["calls"])) problems.push("calls is not a list");
  else {
    value["calls"].forEach((call: unknown, i: number) => {
      const grant = isObject(call) ? call["outputGrant"] : undefined;
      if (grant === undefined) return;
      const bad = grantProblems(grant);
      if (bad.length > 0) problems.push(`call ${i + 1}'s outputGrant: ${bad.join("; ")}`);
    });
  }
  if (typeof value["costUsd"] !== "number" || !Number.isFinite(value["costUsd"])) {
    problems.push("costUsd is not a number");
  }
  if (value["digitalSourceType"] !== undefined && typeof value["digitalSourceType"] !== "string") {
    problems.push("digitalSourceType is not a string");
  }
  for (const key of ["steps", "fixes"]) {
    if (value[key] !== undefined && !Array.isArray(value[key]))
      problems.push(`${key} is not a list`);
  }
  const frames = value["frames"];
  if (
    frames !== undefined &&
    !(
      Array.isArray(frames) &&
      frames.every(
        (f) => isObject(f) && typeof f["index"] === "number" && Array.isArray(f["transforms"]),
      )
    )
  ) {
    problems.push("frames is not a list of frames with an index and transforms");
  }
  return problems;
}

/**
 * The record a fix extends, from a provenance file Assetgrove wrote. A strip's own provenance is
 * kept as it is. A transform record (`recipe`, `op`) that lists this strip among its outputs
 * becomes a provenance carrying the record's sources, steps and output. Anything else is refused
 * with an InputError, so it is caught before any call is made.
 */
export function fixBaseProvenance(
  value: unknown,
  input: { strip: Raster; source: string; license: string; bibleVersion?: string; at: string },
): Provenance {
  if (isObject(value) && value["generator"] === "transform") {
    const problems: string[] = [];
    for (const key of ["sources", "steps", "outputs"]) {
      if (!Array.isArray(value[key])) problems.push(`the transform record's ${key} is not a list`);
    }
    if (problems.length > 0) throw refuseProvenance(input.source, problems);
    const record = value as unknown as TransformRecord;
    const pixels = pixelHash(input.strip);
    const output = record.outputs.find((o) => isObject(o) && o.pixels === pixels);
    if (!output) {
      throw refuseProvenance(input.source, [
        "it is a transform record, but none of its outputs has this strip's pixels",
      ]);
    }
    return {
      ...(typeof output.digitalSourceType === "string" && {
        digitalSourceType: output.digitalSourceType,
      }),
      ...(record.sourceDeclaration && { sourceDeclaration: record.sourceDeclaration }),
      generator: "transform",
      route: "transform",
      models: [],
      prompt: "",
      parameters: {
        ...(record.recipe && { recipe: record.recipe }),
        sources: record.sources,
        output,
      },
      requestIds: [],
      referenceHashes: unique(
        record.sources.flatMap((s) =>
          isObject(s) && typeof s.sha256 === "string" ? [s.sha256] : [],
        ),
      ),
      bibleVersion: input.bibleVersion ?? "unknown",
      license: input.license,
      providerTerms: [],
      startedAt: input.at,
      finishedAt: input.at,
      costUsd: 0,
      calls: [],
      steps: record.steps,
    };
  }
  const problems = provenanceProblems(value);
  if (problems.length > 0) throw refuseProvenance(input.source, problems);
  return value as Provenance;
}

export async function fixFrame(
  options: FixFrameOptions,
): Promise<{ strip: Raster; frame: Raster; provenance: FixedProvenance; fix: FrameFix }> {
  const { style, call, index } = options;
  const now = options.now ?? (() => new Date());
  const frames = splitStrip(options.strip, options.frame);
  const count = frames.length;
  if (!Number.isInteger(index) || index < 1 || index > count) {
    throw new InputError(`frame ${index} is not in the strip, which has ${count} frames`);
  }
  const neighbour = "neighbour" in options.from ? options.from.neighbour : undefined;
  if (neighbour !== undefined) {
    if (!Number.isInteger(neighbour) || neighbour < 1 || neighbour > count) {
      throw new InputError(`neighbour frame ${neighbour} is not in the strip of ${count} frames`);
    }
    if (neighbour === index) throw new InputError("the neighbour must be a different frame");
  }

  const bad = frames[index - 1] as Raster;
  const stripName = options.stripPath ?? "(strip)";
  const first =
    "neighbour" in options.from
      ? pngReference(
          frames[options.from.neighbour - 1] as Raster,
          `approved neighbour frame ${options.from.neighbour}`,
          `${stripName}#frame-${options.from.neighbour}`,
        )
      : options.from.keyPose;
  const second = pngReference(bad, `frame ${index} to fix`, `${stripName}#frame-${index}`);
  const prompt = buildFixPrompt({
    subject: options.subject,
    family: options.family,
    frame: index,
    count,
    source: neighbour === undefined ? "key pose" : "neighbour",
    ...(neighbour !== undefined && { sourceFrame: neighbour }),
    ...(options.note !== undefined && { note: options.note }),
  });
  if (options.provenance !== undefined) {
    const problems = provenanceProblems(options.provenance);
    if (problems.length > 0) throw refuseProvenance("given", problems);
  }
  const seed = Number.parseInt(sha256(new TextEncoder().encode(prompt)).slice(0, 8), 16);
  const startedAt = now().toISOString();
  const returned = await call.image("edit", prompt, [first, second], seed);
  const record = call.records[call.records.length - 1];
  if (!record) throw new Error("the edit call left no record");

  const steps: TransformStep[] = [];
  const edited = decodeImage(returned.bytes);
  let item: ImageItem = {
    name: "fixed-frame",
    raster: edited,
    mediaType: "image/png",
    meta: {},
    digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
  };
  let transparent = false;
  for (let i = 3; i < edited.data.length; i += 4) {
    if ((edited.data[i] as number) < 255) {
      transparent = true;
      break;
    }
  }
  if (!transparent) {
    const matted = runRecipe(sheetImportRecipe({ components: true }), [item], { style });
    steps.push(...matted.steps);
    let largest: { item: ImageItem; area: number } | undefined;
    for (const figure of matted.items) {
      const area = measureFrame(figure.raster, 1)?.area ?? 0;
      if (!largest || area > largest.area) largest = { item: figure, area };
    }
    if (!largest || largest.area === 0) throw new InputError("the edited frame has no figure");
    item = largest.item;
  }

  const threshold = measureThreshold(style);
  // The frame the size is judged against: the neighbour, with a key pose the frame beside the fixed
  // one, and only for a strip of one frame the bad frame itself.
  const beside = neighbour ?? (count > 1 ? (index > 1 ? index - 1 : index + 1) : undefined);
  const referenceFrame = beside === undefined ? bad : (frames[beside - 1] as Raster);
  const reference = measureFrame(referenceFrame, threshold);
  const figure = measureFrame(item.raster, threshold);
  if (!reference) throw new InputError("the reference frame is empty, so its size is unknown");
  if (!figure) throw new InputError("the edited frame has no visible figure");
  const refTop = topRow(referenceFrame, threshold);
  const figTop = topRow(item.raster, threshold);
  const refHeight = reference.baseline - refTop + 1;
  const figHeight = figure.baseline - figTop + 1;
  const refHead = headBoxArea(referenceFrame, threshold, refTop, refHeight);
  const figHead = headBoxArea(item.raster, threshold, figTop, figHeight);
  const candidates: Record<string, number> = {};
  for (const [name, value] of [
    ["area", Math.sqrt(reference.area / figure.area)],
    ["height", refHeight / figHeight],
    ["head", Math.sqrt(refHead / figHead)],
  ] as const) {
    if (Number.isFinite(value) && value > 0) candidates[name] = value;
  }

  // The fixed frame's pin point goes where its neighbour's is, not on the anchor: a strip stage made
  // places each frame by its box centre, so its neighbours' pin points are off the anchor, and
  // footprint-drift compares the fixed frame's feet with theirs. With a key pose, the frame next
  // to the fixed one stands in for the neighbour; a strip of one frame keeps the anchor.
  const placedBy = beside === undefined ? undefined : measureFrame(frames[beside - 1]!, threshold);
  const registerAt = (scale: number) => {
    const register = (anchor: Point) =>
      runOperation(
        [item],
        {
          op: "register",
          params: {
            frame: options.frame,
            anchor,
            scale,
            measureThreshold: threshold,
            pins: [options.pin],
          },
        },
        { style },
      );
    if (placedBy === undefined) return register(options.anchor);
    // The anchor is a whole pixel and the pin point is measured to the half pixel, so of the
    // anchor columns either side, keep the one that puts the pin point nearest the neighbour's.
    const target = pinX(placedBy, options.pin);
    // The neighbour's bottom row is the ground only when it stands on the ground line: next to an
    // airborne beat (a `play` landing after a jump), the fixed frame stays on the ground line.
    const tolerance = options.groundTolerance ?? DEFAULT_THRESHOLDS.groundTolerance;
    const height = placedBy.baseline - topRow(frames[beside! - 1]!, threshold) + 1;
    // Rows are whole pixels, so a neighbour one row off the line still counts as standing on it.
    const grounded =
      Math.abs(placedBy.baseline - options.anchor.y) <= Math.max(1, tolerance * height);
    const row = grounded ? placedBy.baseline : options.anchor.y;
    const near = Math.round(target - 0.5);
    let best: { registered: ReturnType<typeof register>; off: number } | undefined;
    for (const x of [near, near - 1, near + 1]) {
      if (x < 0 || x >= options.frame.width) continue;
      const tried = register({ x, y: row });
      const m = measureFrame((tried.items[0] as ImageItem).raster, threshold);
      const off =
        m === undefined ? Number.POSITIVE_INFINITY : Math.abs(pinX(m, options.pin) - target);
      if (best === undefined || off < best.off) best = { registered: tried, off };
    }
    return best?.registered ?? register(options.anchor);
  };

  // Candidates that register to the same pixels are one candidate, the first in order.
  const distinct: { name: string; registered: ReturnType<typeof registerAt> }[] = [];
  const seen = new Set<string>();
  for (const [name, scale] of Object.entries(candidates)) {
    const registered = registerAt(scale);
    const hash = pixelHash((registered.items[0] as ImageItem).raster);
    if (seen.has(hash)) continue;
    seen.add(hash);
    distinct.push({ name, registered });
  }
  if (distinct.length === 0) throw new InputError("the edited frame has no usable size");
  let chosen = distinct[0]!;
  let decision: { record: CallRecord; probability?: number } | undefined;
  if (distinct.length > 1) {
    const previous = index > 1 ? frames[index - 2] : undefined;
    const next = index < count ? frames[index] : undefined;
    const images = distinct.map(({ name, registered }, i) => {
      const cell = onionCell((registered.items[0] as ImageItem).raster, {
        ...(previous && { previous }),
        ...(next && { next }),
        anchor: options.anchor,
      });
      const bytes = encodePng(cell);
      return forDecision(
        {
          role: `image ${i + 1}`,
          path: `fix-scale-${name}.png`,
          mediaType: "image/png",
          bytes,
          sha256: sha256(bytes),
        },
        "crisp",
      );
    });
    const asked = await call.decide(
      "fix-scale",
      [
        `Each image shows frame ${index} of ${count} of the "${options.family}" cycle of ${options.subject} drawn at a different size,`,
        "at full opacity over the faint previous frame (red) and next frame (blue).",
        "Ignore the pose; judge only the size.",
      ].join("\n"),
      images,
      {
        type: "choice",
        instructions: "In which image is the character the same size as in the surrounding frames?",
        options: Object.fromEntries(distinct.map(({ name }, i) => [name, `image ${i + 1}`])),
      },
    );
    const answer = asked.result.answer;
    if (answer.type !== "choice") throw new ProviderError("the fix-scale decision gave no choice");
    const picked = distinct.find((d) => d.name === answer.choice);
    if (!picked) {
      throw new ProviderError(`the fix-scale decision chose "${answer.choice}", not an option`);
    }
    chosen = picked;
    const probability = answer.probabilities?.[answer.choice];
    decision = {
      record: asked.record,
      ...(probability !== undefined && { probability }),
    };
  }
  const scale = candidates[chosen.name] as number;
  const registered = chosen.registered;
  const styled = runOperation(registered.items, { op: "apply-style" }, { style });
  steps.push(registered.step, styled.step);
  const fixed = (styled.items[0] as ImageItem).raster;

  const outFrames = frames.slice();
  outFrames[index - 1] = fixed;
  const strip = joinStrip(outFrames);

  const from: FixSource =
    neighbour !== undefined
      ? { neighbour }
      : {
          keyPose: {
            path: (first as LoadedReference).path,
            sha256: (first as LoadedReference).sha256,
          },
        };
  const at = now().toISOString();
  const fix: FrameFix = {
    frame: index,
    from,
    prompt,
    model: record.model,
    requestId: record.requestId,
    ...(record.seed !== undefined && { seed: record.seed }),
    costUsd: record.costUsd,
    at,
    beforeHash: pixelHash(bad),
    afterHash: pixelHash(fixed),
    scale: {
      chosen: chosen.name,
      value: scale,
      candidates,
      ...(decision && {
        decision: {
          model: decision.record.model,
          requestId: decision.record.requestId,
          ...(decision.probability !== undefined && { probability: decision.probability }),
          costUsd: decision.record.costUsd,
        },
      }),
    },
  };

  const base: FixedProvenance = options.provenance ?? {
    generator: "frame-fix",
    route: record.route,
    models: [],
    prompt,
    parameters: {},
    requestIds: [],
    referenceHashes: [],
    bibleVersion: options.bibleVersion ?? "unknown",
    license: options.license ?? "unspecified",
    providerTerms: [],
    startedAt,
    finishedAt: at,
    costUsd: 0,
    calls: [],
  };
  // The decisions that shaped the fix, its edit call, then the fix-scale decision.
  const added = [...(options.decisions ?? []), record, ...(decision ? [decision.record] : [])];
  // The fix adds a call, so the strip is no longer media made outside Assetgrove.
  const { madeOutsideAssetgrove: _outside, ...extended } = base;
  void _outside;
  const provenance: FixedProvenance = {
    ...extended,
    digitalSourceType: combineDigitalSourceTypes([
      base.digitalSourceType ?? DIGITAL_SOURCE_TYPES.undeclared,
      DIGITAL_SOURCE_TYPES.generated,
    ]),
    models: unique([...base.models, ...added.map((r) => r.model)]),
    requestIds: [...base.requestIds, ...added.map((r) => r.requestId)],
    referenceHashes: unique([...base.referenceHashes, first.sha256, second.sha256]),
    providerTerms: unique([
      ...base.providerTerms,
      ...added.flatMap((r) => (r.providerTerms !== undefined ? [r.providerTerms] : [])),
    ]),
    finishedAt: at,
    costUsd: added.reduce((sum, r) => sum + r.costUsd, base.costUsd),
    calls: [...base.calls, ...added],
    ...grantFields(base, [...base.calls, ...added]),
    steps: [...(base.steps ?? []), ...steps],
    fixes: [...(base.fixes ?? []), fix],
    ...(base.frames && {
      frames: base.frames.map((f) =>
        f.index === index - 1
          ? {
              ...f,
              transforms: [
                ...f.transforms,
                {
                  op: "edit-frame",
                  from,
                  model: record.model,
                  requestId: record.requestId,
                },
              ],
            }
          : f,
      ),
    }),
  };
  return { strip, frame: fixed, provenance, fix };
}

/**
 * The combined output grant of a fixed strip's calls, and its licence: the granted licence once a
 * grant does not allow relabelling, else the base record's (the target's) licence.
 */
function grantFields(
  base: Provenance,
  calls: CallRecord[],
): { license: string; outputGrant?: OutputGrant } {
  const outputGrant = grantOf(calls);
  if (!outputGrant) return { license: base.license };
  return { license: outputGrant.relabel ? base.license : outputGrant.license, outputGrant };
}
