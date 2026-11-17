/**
 * The holes check of a strip: did background removal cut away part of the figure? The commonest
 * failure is a border flood that eats a pale belly or muzzle open to the outside, so where the
 * image before removal exists (a sheet import keeps each frame's crop), one typed Boolean decision
 * per frame sees the frame before and after removal, the removed parts over magenta, and answers
 * "Is any part of the character missing after background removal?". Where it does not (a strip
 * given on its own), pixels find the see-through areas the figure's outline encloses, at least a
 * share of the figure's area, and one decision per frame with such an area asks whether any of
 * them is a hole cut into the character rather than a natural opening between two parts.
 */
import type { Caller } from "../calls.ts";
import { ProviderError } from "../errors.ts";
import type { DecisionQuestion } from "../gateway/provider.ts";
import { createRaster, encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { sha256 } from "../request.ts";
import type { Routes } from "../routes.ts";
import { forDecision } from "../identity.ts";
import type { LoadedReference } from "../types.ts";
import type { AnimationReason, HoleDecision } from "./types.ts";

/** The backdrop the frame is shown over, and the colour that marks each enclosed area. */
const BACKDROP = [46, 120, 52] as const;
const MARK = [255, 0, 255] as const;
/** The judged image's longer side is at least this many px. */
const VIEW_PX = 384;

export interface EnclosedArea {
  /** Pixels below the alpha cut. */
  area: number;
  /** Bounding box, in frame px. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The see-through areas the figure's outline encloses: runs of pixels below the alpha cut
 * (8-connected) that do not reach the frame's edge, each at least `minPx` big. `marked` is 1 on
 * every pixel of those areas.
 */
export function enclosedAreas(
  frame: Raster,
  options: { threshold: number; minPx: number },
): { areas: EnclosedArea[]; marked: Uint8Array } {
  const { width, height, data } = frame;
  const n = width * height;
  const open = (p: number) => (data[p * 4 + 3] ?? 0) < options.threshold;
  const label = new Int32Array(n).fill(-1);
  const marked = new Uint8Array(n);
  const flood = (start: number, id: number): number[] => {
    const members: number[] = [];
    const stack = [start];
    label[start] = id;
    while (stack.length > 0) {
      const p = stack.pop() as number;
      members.push(p);
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const q = yy * width + xx;
          if (label[q] !== -1 || !open(q)) continue;
          label[q] = id;
          stack.push(q);
        }
      }
    }
    return members;
  };
  for (let x = 0; x < width; x++) {
    for (const p of [x, (height - 1) * width + x]) if (open(p) && label[p] === -1) flood(p, 0);
  }
  for (let y = 0; y < height; y++) {
    for (const p of [y * width, y * width + width - 1]) if (open(p) && label[p] === -1) flood(p, 0);
  }
  const areas: EnclosedArea[] = [];
  let next = 1;
  for (let start = 0; start < n; start++) {
    if (label[start] !== -1 || !open(start)) continue;
    const members = flood(start, next++);
    if (members.length < options.minPx) continue;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (const p of members) {
      marked[p] = 1;
      const x = p % width;
      const y = (p - x) / width;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    areas.push({
      area: members.length,
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    });
  }
  return { areas, marked };
}

/**
 * The frame as the model sees it: enlarged over a green backdrop, the marked pixels (enclosed areas)
 * over magenta. `under` sets the backdrop of every pixel instead (magenta, for the frame after removal).
 */
export function holeView(
  frame: Raster,
  marked: Uint8Array,
  under: readonly number[] = BACKDROP,
): Raster {
  const zoom = Math.max(1, Math.ceil(VIEW_PX / Math.max(frame.width, frame.height)));
  const out = createRaster(frame.width * zoom, frame.height * zoom);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const p = Math.floor(y / zoom) * frame.width + Math.floor(x / zoom);
      const a = (frame.data[p * 4 + 3] ?? 0) / 255;
      const back = marked[p] ? MARK : under;
      const o = (y * out.width + x) * 4;
      for (let k = 0; k < 3; k++) {
        out.data[o + k] = Math.round((frame.data[p * 4 + k] ?? 0) * a + (back[k] ?? 0) * (1 - a));
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

export function buildHolesPrompt(input: {
  subject: string;
  family: string;
  frame: number;
  areas: number;
}): string {
  return [
    `This is frame ${input.frame} of a "${input.family}" animation of ${input.subject}, enlarged, over a plain green backdrop. A program removed the character's original background.`,
    `Magenta marks the ${input.areas === 1 ? "place" : `${input.areas} places`} where the picture is see-through although the character's outline surrounds it.`,
    "A magenta area is either a natural opening between separate parts (between two legs, between a leg or an arm and the body, between the tail and the body), where the backdrop really shows through; or a hole in the middle of one part (the face, a marking, an eye, the torso, the tail, a stripe), where the removal wrongly cut the character away.",
  ].join("\n");
}

/** The enclosed-area view's question. */
export const ENCLOSED_QUESTION: DecisionQuestion = {
  type: "boolean",
  instructions:
    "Is any magenta area a hole cut into one part of the character, rather than a natural opening between separate parts?",
  whenTrue: "at least one magenta area is a hole in the middle of one part",
  whenFalse: "every magenta area is a natural opening between separate parts",
};

/** The prompt of the before-and-after view. */
export function buildBeforeAfterPrompt(input: {
  subject: string;
  family: string;
  frame: number;
}): string {
  return [
    `Image 1 is frame ${input.frame} of a "${input.family}" animation of ${input.subject}, enlarged, as it was drawn, before a program removed its background.`,
    "Image 2 is the same frame after the removal, enlarged the same way, over a plain magenta backdrop: everything the program took for background shows magenta.",
    "The original background and the natural gaps between separate parts (between two legs, between a leg or an arm and the body, between the tail and the body) should be gone. The character itself should be whole: a pale belly, muzzle, blaze, marking, eye, ear, whisker, tail tip or held prop that image 1 shows must still be there in image 2.",
  ].join("\n");
}

/** The before-and-after view's question (#376). */
export const BEFORE_AFTER_QUESTION: DecisionQuestion = {
  type: "boolean",
  instructions: "Is any part of the character missing after background removal?",
  whenTrue:
    "a part of the character that image 1 shows is magenta in image 2, wholly or in part (a bite out of the outline counts)",
  whenFalse: "only the background and the natural gaps between separate parts were removed",
};

/** The pixels at or above the alpha cut: the frame's figure area. */
export function figureArea(frame: Raster, threshold: number): number {
  let area = 0;
  for (let i = 3; i < frame.data.length; i += 4) if ((frame.data[i] ?? 0) >= threshold) area++;
  return area;
}

/** The smallest enclosed area judged on a frame: `minShare` of its figure area, at least 1 px. */
export function holeMinPx(frame: Raster, options: { threshold: number; minShare: number }): number {
  return Math.max(1, Math.ceil(options.minShare * figureArea(frame, options.threshold)));
}

/** A frame's image before background removal and the same crop after it (sheet resolution). */
export interface HoleSource {
  before: Raster;
  after: Raster;
}

/** One frame a holes check sends to the model, and how it is shown. */
export type HoleCandidate =
  | { frame: number; view: "before-after"; source: HoleSource }
  | { frame: number; view: "enclosed"; areas: EnclosedArea[]; marked: Uint8Array; minPx: number };

/**
 * The frames (1-based) a holes check would send to the model. A frame with its image before
 * removal is always sent; any other only with an enclosed see-through area of at least its
 * share of the figure's area.
 */
export function holeCandidates(
  frames: Raster[],
  options: { threshold: number; minShare: number; sources?: ReadonlyArray<HoleSource | undefined> },
): HoleCandidate[] {
  return frames.flatMap((f, i): HoleCandidate[] => {
    const source = options.sources?.[i];
    if (source) return [{ frame: i + 1, view: "before-after" as const, source }];
    const minPx = holeMinPx(f, options);
    const found = enclosedAreas(f, { threshold: options.threshold, minPx });
    return found.areas.length === 0
      ? []
      : [{ frame: i + 1, view: "enclosed" as const, ...found, minPx }];
  });
}

export function planHoles(
  frames: Raster[],
  options: { threshold: number; minShare: number; sources?: ReadonlyArray<HoleSource | undefined> },
  routes: Routes,
): { calls: number; model: string; estimatedCostUsd: number } {
  const calls = holeCandidates(frames, options).length;
  return {
    calls,
    model: routes.holes.model,
    estimatedCostUsd: calls * routes.holes.estimatedCostUsd,
  };
}

/**
 * A view as the model receives it: `holeView` enlarges by the longer side, so a tall narrow crop
 * is still enlarged (crisp edges) until its shorter side reaches `MIN_DECISION_EDGE`, as the
 * identity call does: some decision models reject small images (#27).
 */
export function viewReference(view: Raster, role: string, path: string): LoadedReference {
  const bytes = encodePng(view);
  return forDecision({ role, path, mediaType: "image/png", bytes, sha256: sha256(bytes) }, "crisp");
}

export async function checkHoles(options: {
  frames: Raster[];
  family: string;
  subject: string;
  threshold: number;
  minShare: number;
  cutoff: number;
  call: Caller;
  /** Per strip frame, its image before background removal, where one exists. */
  sources?: ReadonlyArray<HoleSource | undefined>;
  now?: () => Date;
}): Promise<{ reasons: AnimationReason[]; decisions: HoleDecision[] }> {
  const now = options.now ?? (() => new Date());
  const reasons: AnimationReason[] = [];
  const decisions: HoleDecision[] = [];
  const candidates = holeCandidates(options.frames, options);
  for (const c of candidates) {
    const asked =
      c.view === "before-after"
        ? {
            prompt: buildBeforeAfterPrompt({
              subject: options.subject,
              family: options.family,
              frame: c.frame,
            }),
            images: [
              viewReference(
                holeView(c.source.before, new Uint8Array(0)),
                `frame ${c.frame} before background removal`,
                `holes-frame-${c.frame}-before.png`,
              ),
              viewReference(
                holeView(c.source.after, new Uint8Array(0), MARK),
                `frame ${c.frame} after background removal, over magenta`,
                `holes-frame-${c.frame}-after.png`,
              ),
            ],
            question: BEFORE_AFTER_QUESTION,
          }
        : {
            prompt: buildHolesPrompt({
              subject: options.subject,
              family: options.family,
              frame: c.frame,
              areas: c.areas.length,
            }),
            images: [
              viewReference(
                holeView(options.frames[c.frame - 1] as Raster, c.marked),
                `frame ${c.frame}, enclosed see-through areas in magenta`,
                `holes-frame-${c.frame}.png`,
              ),
            ],
            question: ENCLOSED_QUESTION,
          };
    const { result, record } = await options.call.decide(
      "holes",
      asked.prompt,
      asked.images,
      asked.question,
    );
    if (result.answer.type !== "boolean") {
      throw new ProviderError("the holes decision gave no true or false");
    }
    const probability = Math.min(1, Math.max(0, result.answer.probability));
    const label = probability >= 0.5 ? "holes" : "none";
    const flagged = probability >= options.cutoff;
    const said =
      c.view === "before-after"
        ? label === "holes"
          ? "part of the character is missing after background removal"
          : "nothing of the character is missing after background removal"
        : label === "holes"
          ? "a see-through area inside the outline is a hole cut into the character"
          : "every see-through area inside the outline is an opening between parts";
    decisions.push({
      frame: c.frame,
      view: c.view,
      areas: c.view === "enclosed" ? c.areas : [],
      model: record.model,
      requestId: record.requestId,
      label,
      probability,
      cutoff: options.cutoff,
      flagged,
      reason: said,
      costUsd: record.costUsd,
      at: now().toISOString(),
    });
    const head =
      c.view === "before-after"
        ? `frame ${c.frame}, before and after background removal`
        : `frame ${c.frame}: ${c.areas.length} see-through area(s) inside the outline, ${c.areas.reduce((s, a) => s + a.area, 0)} px`;
    reasons.push({
      check: "holes",
      passed: !flagged,
      source: "decision",
      frames: [c.frame],
      reason: `${head}; ${said} (probability ${probability.toFixed(2)} ${flagged ? "≥" : "<"} cutoff ${options.cutoff})`,
    });
  }
  if (candidates.length === 0) {
    reasons.push({
      check: "holes",
      passed: true,
      source: "deterministic",
      reason: `no frame has a see-through area inside the figure's outline of ${options.minShare} of its figure area or more; with no image before background removal, a cut that reaches the outline is not judged`,
    });
  }
  return { reasons, decisions };
}
