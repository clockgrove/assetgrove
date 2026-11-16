/**
 * `assetgrove look-dev`: gives a picked, rigged 3D character a base colour in the target's
 * character look on its own UVs, fur groom maps per season, and eyes that catch light, checks
 * them, and stages the result as a one-candidate run that `pick` hands off (assetgrove#82;
 * docs/look-dev.md). The mesh, UVs and rig are never regenerated. Assetgrove never approves it.
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, posix, resolve } from "node:path";
import { Budget, BudgetExceededError } from "../../budget.ts";
import { Caller } from "../../calls.ts";
import { InputError, ProviderError } from "../../errors.ts";
import { checkWrites } from "../../paths.ts";
import type { GenerationProvider } from "../../gateway/provider.ts";
import { identityReason, identitySettings3d, scoreIdentity } from "../../identity.ts";
import type { IdentityScore } from "../../identity.ts";
import { createRaster, decodeImage, encodePng } from "../../image/raster.ts";
import type { Raster } from "../../image/raster.ts";
import { grantOf } from "../../license.ts";
import { writeRun } from "../../loop.ts";
import type { RunRecord, StagedCandidate } from "../../loop.ts";
import {
  DIGITAL_SOURCE_TYPES,
  embedDigitalSourceType,
  metadataStep,
  readDigitalSourceType,
} from "../../metadata.ts";
import type { DigitalSourceType } from "../../metadata.ts";
import { sha256, styleNotes, subjectOf } from "../../request.ts";
import {
  IDENTITY_CAST_OPERATION,
  LOOKDEV_GROOM_OPERATION,
  LOOKDEV_LOCATE_OPERATION,
  LOOKDEV_MARKING_OPERATION,
  LOOKDEV_MARKINGS_OPERATION,
  LOOKDEV_OPERATION,
} from "../../routes.ts";
import type { Routes } from "../../routes.ts";
import { ledgerFor } from "../../spend.ts";
import type { SpendLedger } from "../../spend.ts";
import type {
  AssetSpec,
  LoadedReference,
  Provenance,
  Reason,
  StyleBible,
  TargetProfile,
} from "../../types.ts";
import { GLB_MEDIA_TYPE, parseGlb, writeGlb } from "../glb.ts";
import type { Glb } from "../glb.ts";
import { CHARACTER_3D_KIND, characterSpec, model3dSettings } from "../profile.ts";
import { budgetChecks, qaPassed, validatorCheck } from "../qa.ts";
import {
  TURNTABLE_VIEWS,
  closeUpCamera,
  framedCamera,
  figureMask,
  renderView,
  renderViewWithDepth,
  speckle,
} from "../render.ts";
import type { FurMaps, PreviewLighting, ViewCamera } from "../render.ts";
import { profileSha256 } from "../rig/candidate.ts";
import { declaresRig, loadRig } from "../rig/template.ts";
import type { LoadedRig } from "../rig/template.ts";
import { boundsOf, clips, measure, posedPrimitives, worldMatrices, yawBetween } from "../scene.ts";
import type { Bounds, Vec3 } from "../scene.ts";
import {
  EYE_MATERIAL,
  addExternalImage,
  baseColorImage,
  compactBin,
  nodePositions,
  replaceImage,
  setEmissiveAt,
  splitEyes,
} from "./edit.ts";
import {
  GROOM_REGIONS,
  groomMaps,
  groomMaskCheck,
  markerMask,
  padMask,
  texelRegions,
} from "./groom.ts";
import type { GroomMaps, GroomRegion, GroomSkeleton, SeasonGroom, SurfaceMarker } from "./groom.ts";
import { depthMap, dilate, fillUnseen, projectViews, seamError } from "./project.ts";
import type { PlannedCall } from "../../generators/generator.ts";
import {
  ReferenceViewCache,
  loadReferenceViews,
  planReferenceViews,
  requireFront,
  subjectBibleReferences,
  viewRecord,
} from "../views.ts";
import type { ReferenceView, ViewedReference } from "../views.ts";
import { bakeTexels } from "./texels.ts";
import type { TexelMap } from "./texels.ts";
import {
  deltaE,
  MARKING_VERDICTS,
  MAX_MARKINGS_JUDGED,
  markingCrop,
  markingDecisionPrompt,
  markingsPrompt,
  markingsFiltering,
  markingsReason,
  measureBox,
  parseMarkingsReply,
} from "./markings.ts";
import type { MarkingMeasure, MarkingVerdict } from "./markings.ts";
import type { PromptPolicyRecord } from "../../policy/text.ts";
import { lookdevSettings } from "./settings.ts";
import type { LookdevSettings, PreviewLightingSettings } from "./settings.ts";

export const LOOKDEV_STEP = "lookdev";
/** The groom key used when the profile declares no seasons. */
export const SINGLE_GROOM = "default";

/**
 * The views look-dev restyles and projects back, in the order it restyles them: the four turntable
 * views, the other side, and a high view of the back. The square-on views come first, so each
 * diagonal view continues markings that a square-on view already placed along the body
 * (assetgrove#129: restyled before the side, a diagonal view placed markings the side view then
 * redrew elsewhere, and the blend mixed the two).
 */
export const LOOKDEV_VIEWS = [
  { name: "front", yawDeg: 0, elevationDeg: 15 },
  { name: "side", yawDeg: 90, elevationDeg: 15 },
  { name: "other-side", yawDeg: 270, elevationDeg: 15 },
  { name: "back", yawDeg: 180, elevationDeg: 15 },
  { name: "three-quarter", yawDeg: 45, elevationDeg: 15 },
  { name: "other-three-quarter", yawDeg: 315, elevationDeg: 15 },
  { name: "top", yawDeg: 135, elevationDeg: 65 },
] as const;

/**
 * The detail pass: a view framed on the head (the rig template's head region, where the eyes and
 * nose are), from the close-up's direction, restyled after the views above and projected with
 * them. It sees the face at several times the turntable views' resolution, so the projection
 * hands the face to it (assetgrove#143: the front view painted the face about 200 px across, and
 * the close-up enlarged that). Without a head region it falls back to the close-up at the
 * target's closest zoom. `reference` names the turnaround view it is restyled against. Close-ups
 * from the diagonals were tried: each painted the cheeks its own way and took the face's sides
 * from the front one, so the mask came out as a hard bar.
 */
export const LOOKDEV_DETAIL_VIEWS = [{ name: "close-up", yawDeg: 0, reference: "front" }] as const;

/** The share of a restyled turntable view's larger side the figure's outline fills. */
const VIEW_FILL = 0.86;
/** The share of a detail view's larger side the head's outline fills. */
const DETAIL_FILL = 0.8;

/** Restyled views are rendered and projected at this edge. */
const VIEW_PX = 1024;
const CLOSE_UP_PX = 512;
const BACKGROUND: [number, number, number] = [216, 216, 216];
/**
 * The least share of the visible texels (those some restyled view's camera sees, facing it and
 * past its depth test) that must take colour from the restyled views. Hidden UV area is not in
 * the share, so the limit can be high.
 */
const MIN_COVERAGE = 0.9;
/** The most speckle (impulse pixels, fur render minus bare render) a fur preview view may show. */
const MAX_FUR_SPECKLE = 0.005;

export interface LookdevOptions {
  /** The picked `.glb` and the provenance it was handed off with. */
  model: { bytes: Uint8Array; path: string };
  provenance: Provenance;
  spec: AssetSpec;
  specDir: string;
  bible: StyleBible;
  bibleDir: string;
  profile: TargetProfile;
  profileDir: string;
  routes: Routes;
  provider: GenerationProvider;
  providerName?: string;
  ledger?: SpendLedger;
  runsDir: string;
  /** Overrides the profile's look-dev cap ($3 by default). */
  capUsd?: number;
  runId?: string;
  now?: () => Date;
  log?: (message: string) => void;
  /** The plan step's prompt-policy record, kept in the run record and the model's provenance. */
  promptPolicy?: PromptPolicyRecord;
  /** The settings' state directory; judged reference views are cached under it. */
  stateDir?: string;
}

export interface LookdevPlan {
  capUsd: number;
  calls: Array<{ operation: string; model: string; estimatedCostUsd: number }>;
  estimateUsd: number;
  withinCap: boolean;
  seasons: string[];
}

function seasonsOf(settings: LookdevSettings): string[] {
  return settings.seasons ?? [SINGLE_GROOM];
}

/** The calls one look-dev makes and their estimate, computed without spending anything. */
export function planLookdev(
  profile: TargetProfile,
  routes: Routes,
  capUsd?: number,
  viewCalls: PlannedCall[] = [],
): LookdevPlan {
  model3dSettings(profile);
  const settings = lookdevSettings(profile);
  const cap = capUsd ?? settings.capUsd;
  const calls: LookdevPlan["calls"] = [];
  const add = (operation: string) => {
    const route = routes[operation];
    if (!route) throw new InputError(`no model route for operation "${operation}"`);
    calls.push({ operation, model: route.model, estimatedCostUsd: route.estimatedCostUsd });
  };
  // Which view each undeclared reference shows: judged before the first restyle.
  calls.push(...viewCalls);
  for (let i = 0; i < LOOKDEV_VIEWS.length + LOOKDEV_DETAIL_VIEWS.length; i++) {
    add(LOOKDEV_OPERATION);
  }
  add(LOOKDEV_LOCATE_OPERATION);
  for (let i = 0; i < seasonsOf(settings).length; i++) add(LOOKDEV_GROOM_OPERATION);
  // At most one markings call per turntable view: only views with their own turnaround view call.
  for (let i = 0; i < TURNTABLE_VIEWS.length; i++) add(LOOKDEV_MARKINGS_OPERATION);
  // One decision per marking, view and season, for up to MAX_MARKINGS_JUDGED markings per view. A
  // view naming more is judged whole while the cap has room; a marking it cannot afford fails.
  const judged = TURNTABLE_VIEWS.length * seasonsOf(settings).length * MAX_MARKINGS_JUDGED;
  for (let i = 0; i < judged; i++) add(LOOKDEV_MARKING_OPERATION);
  // Identity never filters a 3D character, so no record check is forecast.
  const identity = identitySettings3d(profile);
  if (identity.mode !== "off") {
    add(identity.question === "cast" ? IDENTITY_CAST_OPERATION : "identity");
  }
  const estimateUsd = calls.reduce((sum, c) => sum + c.estimatedCostUsd, 0);
  return {
    capUsd: cap,
    calls,
    estimateUsd,
    withinCap: estimateUsd <= cap + 1e-9,
    seasons: seasonsOf(settings),
  };
}

/** The view calls a look-dev forecasts: one per reference of the spec's look with no declared view. */
export function lookdevViewCalls(
  spec: AssetSpec,
  bible: StyleBible,
  routes: Routes,
): PlannedCall[] {
  return planReferenceViews(subjectBibleReferences(spec, bible, { byLook: true }), routes);
}

/**
 * Bible references of the subject for the spec's look, each with the view it shows (declared, or
 * judged by a model and cached). A look-dev whose references show no front view is refused here,
 * before the first restyle.
 */
async function subjectReferences(
  spec: AssetSpec,
  bible: StyleBible,
  bibleDir: string,
  caller: Caller,
  cache: ReferenceViewCache,
): Promise<ViewedReference[]> {
  const refs = subjectBibleReferences(spec, bible, { byLook: true });
  if (refs.length === 0) {
    throw new InputError(
      `the style bible has no approved references for subject "${subjectOf(spec)}"`,
    );
  }
  const viewed = await loadReferenceViews(caller, refs, bibleDir, cache);
  requireFront(viewed);
  return viewed;
}

/**
 * The reference view each restyled, turntable or detail view is matched with: the side view (yaw
 * 90°, the character's left) with the left reference, the other side with the right one.
 */
export function referenceViewFor(view: string): ReferenceView {
  switch (view) {
    case "side":
      return "left";
    case "other-side":
      return "right";
    case "back":
    case "top":
      return "back";
    case "three-quarter":
    case "other-three-quarter":
      return "three-quarter";
    default:
      return "front";
  }
}

const AXIS_VECTORS: Record<string, Vec3> = {
  "+z": [0, 0, 1],
  "-z": [0, 0, -1],
  "+x": [1, 0, 0],
  "-x": [-1, 0, 0],
};

function png(bytes: Uint8Array): LoadedReference {
  return { role: "render", path: "(render)", mediaType: "image/png", bytes, sha256: sha256(bytes) };
}

/** Bilinear resize to any width and height (each axis on its own scale). */
export function resize(src: Raster, width: number, height: number): Raster {
  const out = createRaster(width, height);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const v = Math.min(src.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(v);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const fy = v - y0;
    for (let x = 0; x < width; x++) {
      const u = Math.min(src.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(u);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const fx = u - x0;
      for (let c = 0; c < 4; c++) {
        const a = src.data[(y0 * src.width + x0) * 4 + c]!;
        const b = src.data[(y0 * src.width + x1) * 4 + c]!;
        const d = src.data[(y1 * src.width + x0) * 4 + c]!;
        const e = src.data[(y1 * src.width + x1) * 4 + c]!;
        out.data[(y * width + x) * 4 + c] = Math.round(
          (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy,
        );
      }
    }
  }
  return out;
}

/** The bounding box of the set pixels of a `width`-wide mask. */
function maskBox(mask: Uint8Array, width: number) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % width;
    const y = (i - x) / width;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return x1 < x0 ? undefined : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * The figure cut out with a margin of `margin` of its larger side, so a vision model boxes markings
 * on the figure at its full resolution rather than on a small figure in a wide frame. The figure
 * is the render's depth `mask`; the crop carries the mask cut the same way.
 */
export function figureCrop(
  raster: Raster,
  mask: Uint8Array,
  margin = 0.08,
): { image: Raster; mask: Uint8Array } {
  const box = maskBox(mask, raster.width);
  if (!box) return { image: raster, mask };
  const pad = Math.round(Math.max(box.x1 - box.x0, box.y1 - box.y0) * margin);
  const x0 = Math.max(0, box.x0 - pad);
  const y0 = Math.max(0, box.y0 - pad);
  const x1 = Math.min(raster.width, box.x1 + pad);
  const y1 = Math.min(raster.height, box.y1 + pad);
  const out = createRaster(x1 - x0, y1 - y0);
  const outMask = new Uint8Array(out.width * out.height);
  for (let y = y0; y < y1; y++) {
    out.data.set(
      raster.data.subarray((y * raster.width + x0) * 4, (y * raster.width + x1) * 4),
      (y - y0) * out.width * 4,
    );
    outMask.set(mask.subarray(y * raster.width + x0, y * raster.width + x1), (y - y0) * out.width);
  }
  return { image: out, mask: outMask };
}

/** The median colour of the image's border: the background an edited image ended up with. */
function borderColour(raster: Raster): [number, number, number] {
  const samples: number[][] = [[], [], []];
  const { width, height, data } = raster;
  const push = (x: number, y: number) => {
    const o = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) samples[c]!.push(data[o + c]!);
  };
  for (let x = 0; x < width; x += 4) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 4) {
    push(0, y);
    push(width - 1, y);
  }
  return samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1]!) as [number, number, number];
}

/**
 * The background an edited view left, as a mask: pixels connected to the image's border whose
 * colour is within `tolerance` of the border colour, grown by `grow` pixels so the anti-aliased
 * fringe of the drawn figure is left out too (one pixel by default). Only border-connected pixels count, so a pale coat
 * inside the figure is never taken for background. With the view's flat `render`, a pixel the render
 * itself draws in the background's colour is kept: there, the model's own surface looks like
 * background, and the edit cannot be told apart from it.
 */
export function editedBackground(
  edited: Raster,
  render?: Raster,
  tolerance = 24,
  grow = 1,
): Uint8Array {
  const { width, height, data } = edited;
  const bg = borderColour(edited);
  const mask = new Uint8Array(width * height);
  const near = (i: number) =>
    Math.abs(data[i * 4]! - bg[0]) +
      Math.abs(data[i * 4 + 1]! - bg[1]) +
      Math.abs(data[i * 4 + 2]! - bg[2]) <=
    tolerance;
  const stack: number[] = [];
  const seed = (i: number) => {
    if (!mask[i] && near(i)) {
      mask[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % width;
    if (x > 0) seed(i - 1);
    if (x < width - 1) seed(i + 1);
    if (i >= width) seed(i - width);
    if (i < (height - 1) * width) seed(i + width);
  }
  let grown = mask;
  for (let ring = 0; ring < grow; ring++) {
    const next = Uint8Array.from(grown);
    for (let i = 0; i < width * height; i++) {
      if (grown[i]) continue;
      const x = i % width;
      if (
        (x > 0 && grown[i - 1]) ||
        (x < width - 1 && grown[i + 1]) ||
        (i >= width && grown[i - width]) ||
        (i < (height - 1) * width && grown[i + width])
      )
        next[i] = 1;
    }
    grown = next;
  }
  if (render && render.width === width && render.height === height) {
    for (let i = 0; i < width * height; i++) {
      if (!grown[i]) continue;
      const o = i * 4;
      const d =
        Math.abs(render.data[o]! - bg[0]) +
        Math.abs(render.data[o + 1]! - bg[1]) +
        Math.abs(render.data[o + 2]! - bg[2]);
      if (d <= tolerance) grown[i] = 0;
    }
  }
  return grown;
}

/** `mask` with every hole the figure encloses filled: 1 wherever the border cannot be reached through 0s. */
function filledSilhouette(mask: Uint8Array, width: number, height: number): Uint8Array {
  const outside = new Uint8Array(mask.length);
  const stack: number[] = [];
  const seed = (i: number) => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % width;
    if (x > 0) seed(i - 1);
    if (x < width - 1) seed(i + 1);
    if (i >= width) seed(i - width);
    if (i < (height - 1) * width) seed(i + width);
  }
  return outside.map((v) => (v ? 0 : 1));
}

/** The overlap under which `lookdev-registration` names a view: recorded, never a filter. */
const MIN_OVERLAP = 0.9;

/**
 * Registers an edited view onto its render. The render's figure is `mask` (its depth buffer). The
 * edit's figure is what is not background connected to its border. The fit starts from the box
 * of one onto the box of the other, then refines scale and offset in x and y to maximise the
 * intersection over union of the two figures, so a soft shadow or a pale outline that moves the
 * edit's box does not stretch the edit. `overlap` is that intersection over union at the fit:
 * low, the edit moved or reshaped the figure.
 */
export function register(
  edited: Raster,
  render: Raster,
  mask: Uint8Array,
): { image: Raster; overlap: number } {
  const size = render.width;
  const height = render.height;
  const sized =
    edited.width === size && edited.height === height ? edited : resize(edited, size, height);
  // The edit's figure is all that its border-connected background is not, so a gap the figure
  // encloses (between the legs) counts as figure there and the edit cannot tell it apart. The
  // overlap is scored against the exact mask on every pixel but those gaps, which count on
  // neither side; the filled silhouette only sets the fit's starting box and area.
  const filled = filledSilhouette(mask, size, height);
  const target = maskBox(filled, size);
  const background = editedBackground(sized, undefined, 24, 0);
  const foreground = new Uint8Array(background.length);
  for (let i = 0; i < foreground.length; i++) foreground[i] = background[i] ? 0 : 1;
  const source = maskBox(foreground, sized.width);
  if (!target || !source) return { image: sized, overlap: 0 };

  // A render pixel (x, y) reads the edit at (ox + sx * x, oy + sy * y).
  type Fit = [number, number, number, number];
  const sampleAt = (p: Fit, x: number, y: number): number => {
    const u = Math.round(p[2] + p[0] * x);
    const v = Math.round(p[3] + p[1] * y);
    return u < 0 || v < 0 || u >= sized.width || v >= sized.height
      ? 0
      : foreground[v * sized.width + u]!;
  };
  const iou = (p: Fit, stride: number): number => {
    let both = 0;
    let either = 0;
    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < size; x += stride) {
        const i = y * size + x;
        if (filled[i] && !mask[i]) continue;
        const m = mask[i]!;
        const f = sampleAt(p, x, y);
        if (m && f) both++;
        if (m || f) either++;
      }
    }
    return either === 0 ? 0 : both / either;
  };

  // Two starts, each refined: the figures' boxes, and the figures' areas and centroids (a shadow
  // moves the edit's box far more than its centroid).
  const sx = (source.x1 - source.x0) / (target.x1 - target.x0);
  const sy = (source.y1 - source.y0) / (target.y1 - target.y0);
  const stats = (m: Uint8Array, width: number) => {
    let n = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      n++;
      cx += i % width;
      cy += Math.floor(i / width);
    }
    return { n, cx: cx / n, cy: cy / n };
  };
  const t = stats(filled, size);
  const f = stats(foreground, sized.width);
  const area = Math.sqrt(f.n / t.n);
  const starts: Fit[] = [
    [sx, sy, source.x0 - target.x0 * sx, source.y0 - target.y0 * sy],
    [area, area, f.cx - t.cx * area, f.cy - t.cy * area],
  ];
  let fit = starts[0]!;
  let best = -1;
  for (const start of starts) {
    let at = start;
    let score = iou(at, 2);
    for (let step = 8; step >= 0.25; step /= 2) {
      for (let improved = true; improved;) {
        improved = false;
        for (let k = 0; k < 4; k++) {
          const delta = k < 2 ? step / size : step;
          for (const sign of [1, -1]) {
            const next = [...at] as Fit;
            next[k] = at[k]! + sign * delta;
            const nextScore = iou(next, 2);
            if (nextScore > score + 1e-9) {
              score = nextScore;
              at = next;
              improved = true;
            }
          }
        }
      }
    }
    if (score > best) {
      best = score;
      fit = at;
    }
  }

  const out = createRaster(size, height);
  for (let y = 0; y < height; y++) {
    const v = Math.min(sized.height - 1, Math.max(0, Math.round(fit[3] + fit[1] * y)));
    for (let x = 0; x < size; x++) {
      const u = Math.min(sized.width - 1, Math.max(0, Math.round(fit[2] + fit[0] * x)));
      const from = (v * sized.width + u) * 4;
      const to = (y * size + x) * 4;
      out.data[to] = sized.data[from]!;
      out.data[to + 1] = sized.data[from + 1]!;
      out.data[to + 2] = sized.data[from + 2]!;
      out.data[to + 3] = 255;
    }
  }
  return { image: out, overlap: iou(fit, 1) };
}

function restylePrompt(
  spec: AssetSpec,
  bible: StyleBible,
  view: string,
  referenceRoles: string[],
  continued = false,
  detail = false,
): string {
  const subject = subjectOf(spec);
  const description = bible.subjects?.[subject]?.description;
  return [
    "Repaint the surface colour of this 3D character render so it matches the approved references.",
    `The first image is a flat-lit render (${view} view) of the character's 3D model; the others are its approved references (${referenceRoles.join("; ")}).`,
    ...(detail
      ? [
          "The render is a close-up of the character's head: the figure runs on past the image's edges. Paint its identity markings and features at full detail, with the shape and clean edges the references give them. Leave out the fine strands the references draw standing off the face: paint the surface beneath them.",
        ]
      : []),
    ...(continued
      ? [
          "The render already carries colour painted from other views of the same model. Where a marking from that painting shows in this view, keep it where it is and continue it in the same colour; repaint what does not match the references.",
        ]
      : []),
    description ? `Subject: ${subject}, ${description}.` : `Subject: ${subject}.`,
    `Style bible version ${bible.version}:`,
    ...styleNotes(spec, bible).map((n) => `- ${n}`),
    "Keep the exact silhouette, pose, framing, camera and size of the render: change only the colour and texture painted on the surface, so it can be projected back onto the model.",
    "The character's features (its eyes, nose and mouth, and any ears, limbs or tail it has) are where the render has them: keep each one exactly there, even where the model's proportions differ from the references, and do not draw a feature (such as an eye) anywhere the render does not show it.",
    "Identity markings include broad colour regions (a paler or darker underside, limbs, back or face) as well as small marks, bands and rims. Keep every identity marking where the references have it relative to those features: each marking at the same place on the body, with the same shape, size, colour and contrast, and the same number of repeats where a marking repeats along a part. Where a part alternates bands of two colours, give each band the width the references give it against its neighbours (where the darker bands are broader than the paler ones in the references, keep them broader), and end the part in the colour the references end it in. A marking that surrounds or runs from a feature in the references (around an eye or running back from it) does so around or from that feature as the render places it. Do not soften, blur, shrink or blend a marking into the colour around it, and add none the references do not show.",
    "Paint the colour as evenly lit albedo: no cast shadows, no highlights, no rim light, no background objects. Keep the plain background colour.",
    "Paint nothing that stands off the surface, even where the references show it: no strands, bristles or stray hairs lying over the surface. They are not surface colour, and projected back they would break up the marking under them.",
  ].join("\n");
}

function locatePrompt(subject: string, description: string | undefined): string {
  return [
    "The first image is a close-up front render of a 3D character's head, 1:1 pixels; the others are the character's approved references.",
    description ? `Subject: ${subject}, ${description}.` : `Subject: ${subject}.`,
    'Reply with JSON only: {"has": {"eyes": boolean, "nose": boolean, "pawPads": boolean}, "eyes": [{"x": number, "y": number, "r": number}], "nose": {"x": number, "y": number, "r": number} | null}.',
    "has says whether the character, as the references show it, has each part: eyes; a bare nose (nose leather, not a beak or a muzzle covered in fur or scales); bare paw pads on its feet (not hooves, claws without pads, boots, fins or no feet).",
    "x and y are the pixel centre of each eyeball and of the nose leather (the bare tip of the nose) in the first image, from the top-left corner; r is its radius in pixels.",
    "List every visible eye. Use null for the nose if the character has none.",
  ].join("\n");
}

/** The parts the groom check asks a bare mask for, as the locate reply names them. */
export const BARE_PARTS = { eyes: "eyes", nose: "nose", pawPads: "paw pads" } as const;
export type BarePart = keyof typeof BARE_PARTS;

/**
 * Whether the character has each bare part, from the locate reply's `has`: `false` only where the
 * reply says so; a reply without it keeps every part.
 */
export function parseHas(text: string): Record<BarePart, boolean> {
  let has: unknown;
  try {
    has = parseJsonReply(text, "locate")["has"];
  } catch {
    has = undefined;
  }
  const h = (has ?? {}) as Record<string, unknown>;
  return { eyes: h["eyes"] !== false, nose: h["nose"] !== false, pawPads: h["pawPads"] !== false };
}

function groomPrompt(
  spec: AssetSpec,
  bible: StyleBible,
  season: string,
  traits: string | undefined,
  heightM: number,
): string {
  const subject = subjectOf(spec);
  const description = bible.subjects?.[subject]?.description;
  return [
    `The images are the approved references of ${subject}, a real-time 3D game character about ${heightM.toFixed(2)} m tall.`,
    description ? `Description: ${description}.` : "",
    season === SINGLE_GROOM
      ? "Describe its fur groom."
      : `Describe its fur groom in its ${season} coat: ${traits ?? "(no traits given)"}.`,
    `Regions: ${GROOM_REGIONS.join(", ")} (face is the front of the head around the eyes and muzzle; cheek is the side of the head).`,
    'Reply with JSON only: {"lengthMm": {<region>: number}, "density": {<region>: number from 0 to 1}, "tint": {"color": "#rrggbb", "tipWeight": number from 0 to 1} | null}.',
    "lengthMm is the fur length in millimetres. tint is the colour the fur tips are multiplied by where this coat's colour differs from the references; null when it does not.",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseJsonReply(text: string, what: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new ProviderError(`the ${what} reply holds no JSON object`);
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new ProviderError(`the ${what} reply is not valid JSON`);
  }
}

/** One season's groom from the model's reply, clamped to sane ranges. */
export function parseSeasonGroom(text: string): SeasonGroom {
  const reply = parseJsonReply(text, "groom");
  const lengths = (reply["lengthMm"] ?? {}) as Record<string, unknown>;
  const densities = (reply["density"] ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const lengthMm = {} as Record<GroomRegion, number>;
  const density = {} as Record<GroomRegion, number>;
  for (const region of GROOM_REGIONS) {
    lengthMm[region] = Math.min(300, Math.max(0.5, num(lengths[region], 10)));
    density[region] = Math.min(1, Math.max(0.05, num(densities[region], 0.6)));
  }
  const tint = reply["tint"] as { color?: unknown; tipWeight?: unknown } | null | undefined;
  const hex = typeof tint?.color === "string" ? /^#?([0-9a-f]{6})$/i.exec(tint.color) : null;
  return {
    lengthMm,
    density,
    ...(hex && {
      tint: {
        color: [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16) / 255) as [
          number,
          number,
          number,
        ],
        tipWeight: Math.min(1, Math.max(0, num(tint?.tipWeight, 0.5))),
      },
    }),
  };
}

/** Eye and nose points on a camera's depth map: pixel points cast onto the surface. */
export function parseMarkers(
  text: string,
  camera: ViewCamera,
  depth: Float32Array,
): { eyes: SurfaceMarker[]; nose: SurfaceMarker[] } {
  const reply = parseJsonReply(text, "locate");
  const size = camera.sizePx;
  const cast = (p: unknown): SurfaceMarker | undefined => {
    const q = p as { x?: unknown; y?: unknown; r?: unknown } | null;
    if (!q || typeof q.x !== "number" || typeof q.y !== "number") return undefined;
    const r = typeof q.r === "number" && q.r > 0 ? q.r : size / 40;
    // The nearest surface pixel within the marker's radius.
    let best: { d: number; x: number; y: number } | undefined;
    const reach = Math.ceil(Math.max(2, r));
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const x = Math.round(q.x) + dx;
        const y = Math.round(q.y) + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = depth[y * size + x]!;
        if (!Number.isFinite(d)) continue;
        const off = dx * dx + dy * dy;
        if (!best || off < (best.x - q.x) ** 2 + (best.y - q.y) ** 2) best = { d, x, y };
      }
    }
    if (!best) return undefined;
    const { eye, forward, right, up, focal } = camera;
    const sx = ((best.x + 0.5 - size / 2) * best.d) / focal;
    const sy = (-(best.y + 0.5 - size / 2) * best.d) / focal;
    const point: Vec3 = [
      eye[0] + forward[0] * best.d + right[0] * sx + up[0] * sy,
      eye[1] + forward[1] * best.d + right[1] * sx + up[1] * sy,
      eye[2] + forward[2] * best.d + right[2] * sx + up[2] * sy,
    ];
    return { point, radius: (r * best.d) / focal };
  };
  const eyes = (Array.isArray(reply["eyes"]) ? reply["eyes"] : [])
    .map(cast)
    .filter((m): m is SurfaceMarker => m !== undefined);
  const nose = [cast(reply["nose"])].filter((m): m is SurfaceMarker => m !== undefined);
  return { eyes, nose };
}

/**
 * Paints a soft catch-light into each eye of a texture on the model's UVs: a small near-white
 * spot on the eye's surface, offset from its centre toward the key light (above, in front, to the
 * character's left, as the turntable light). Changes only texels inside the eye markers. Look-dev
 * paints it into an emissive texture, never into the base colour. An eye whose texels are all
 * farther from the spot's centre than its radius gets the nearest one. Returns, per eye in order,
 * the indices of the texels it painted (none only for an eye with no texel inside it).
 */
export function paintCatchLights(
  albedo: Raster,
  texels: TexelMap,
  eyes: SurfaceMarker[],
  forward: Vec3,
): number[][] {
  const left: Vec3 = [forward[2], 0, -forward[0]];
  const l = [0.8 * 0 + 0.6 * forward[0] + 0.3 * left[0], 0.8, 0.6 * forward[2] + 0.3 * left[2]];
  const ll = Math.hypot(l[0]!, l[1]!, l[2]!);
  const light: Vec3 = [l[0]! / ll, l[1]! / ll, l[2]! / ll];
  const painted: number[][] = [];
  const size = texels.size;
  for (const eye of eyes) {
    const mine: number[] = [];
    painted.push(mine);
    // The eye's outward normal: the mean normal of its texels.
    const n: Vec3 = [0, 0, 0];
    const inside: number[] = [];
    for (let i = 0; i < size * size; i++) {
      if (!texels.covered[i]) continue;
      const dx = texels.position[i * 3]! - eye.point[0];
      const dy = texels.position[i * 3 + 1]! - eye.point[1];
      const dz = texels.position[i * 3 + 2]! - eye.point[2];
      if (dx * dx + dy * dy + dz * dz > eye.radius * eye.radius) continue;
      inside.push(i);
      for (let k = 0; k < 3; k++) n[k]! += texels.normal[i * 3 + k]!;
    }
    const nl = Math.hypot(...n);
    if (inside.length === 0 || nl === 0) continue;
    const normal: Vec3 = [n[0] / nl, n[1] / nl, n[2] / nl];
    const along = light[0] * normal[0] + light[1] * normal[1] + light[2] * normal[2];
    const t: Vec3 = [
      light[0] - normal[0] * along,
      light[1] - normal[1] * along,
      light[2] - normal[2] * along,
    ];
    const tl = Math.hypot(...t) || 1;
    const centre: Vec3 = [
      eye.point[0] + (t[0] / tl) * eye.radius * 0.35,
      eye.point[1] + (t[1] / tl) * eye.radius * 0.35,
      eye.point[2] + (t[2] / tl) * eye.radius * 0.35,
    ];
    const r = eye.radius * 0.3;
    const paint = (i: number, w: number) => {
      for (let c = 0; c < 3; c++) {
        const o = i * 4 + c;
        albedo.data[o] = Math.round(albedo.data[o]! * (1 - w) + 250 * w);
      }
      mine.push(i);
    };
    let nearest = inside[0]!;
    let nearestD = Infinity;
    for (const i of inside) {
      const d = Math.hypot(
        texels.position[i * 3]! - centre[0],
        texels.position[i * 3 + 1]! - centre[1],
        texels.position[i * 3 + 2]! - centre[2],
      );
      if (d < nearestD) {
        nearest = i;
        nearestD = d;
      }
      if (d >= r) continue;
      paint(i, 0.92 * (1 - (d / r) ** 2));
    }
    // An eye whose texels are coarser than the spot still gets one: the texel nearest its centre.
    if (mine.length === 0) paint(nearest, 0.92);
  }
  return painted;
}

/** The groom skeleton from the skin and, when the target declares one, its rig template. */
function groomSkeleton(glb: Glb, rig: LoadedRig | undefined, forward: Vec3): GroomSkeleton {
  const json = glb.json;
  const skin = json.skins?.[0];
  const world = worldMatrices(json);
  const roles = new Map(rig?.template.joints.map((j) => [j.name, j.role]) ?? []);
  const feet = new Set(rig?.template.feet.flatMap((f) => f.joints) ?? []);
  const parentOf = new Map<number, number>();
  for (const [i, node] of (json.nodes ?? []).entries()) {
    for (const c of node.children ?? []) parentOf.set(c, i);
  }
  const joints = (skin?.joints ?? []).map((node) => {
    const name = json.nodes?.[node]?.name ?? `joint-${node}`;
    const m = world.get(node);
    const parentNode = parentOf.get(node);
    const role = roles.get(name);
    return {
      name,
      parent: parentNode === undefined ? -1 : skin!.joints.indexOf(parentNode),
      position: (m ? [m[12]!, m[13]!, m[14]!] : [0, 0, 0]) as Vec3,
      ...(role !== undefined && { role }),
      ...(feet.has(name) && { foot: true }),
    };
  });
  return { joints, forward };
}

/** The focus of the close-up: the centre of the head region, else the top front of the bounds. */
function headFocus(texels: TexelMap, regions: Uint8Array, bounds: Bounds, forward: Vec3): Vec3 {
  const head = new Set(
    ["face", "cheek", "head"].map((r) => GROOM_REGIONS.indexOf(r as GroomRegion)),
  );
  const sum: Vec3 = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < regions.length; i++) {
    if (!texels.covered[i] || !head.has(regions[i]!)) continue;
    sum[0] += texels.position[i * 3]!;
    sum[1] += texels.position[i * 3 + 1]!;
    sum[2] += texels.position[i * 3 + 2]!;
    n++;
  }
  if (n > 0) return [sum[0] / n, sum[1] / n, sum[2] / n];
  const { min, max } = bounds;
  const c: Vec3 = [(min[0] + max[0]) / 2, min[1] + (max[1] - min[1]) * 0.75, (min[2] + max[2]) / 2];
  const reach = Math.max(max[0] - min[0], max[2] - min[2]) * 0.4;
  return [c[0] + forward[0] * reach, c[1], c[2] + forward[2] * reach];
}

/** The surface points of the head region (face, cheek and head texels), every `step`th texel. */
function headPoints(texels: TexelMap, regions: Uint8Array, step = 7): Float64Array {
  const head = new Set(
    ["face", "cheek", "head"].map((r) => GROOM_REGIONS.indexOf(r as GroomRegion)),
  );
  const points: number[] = [];
  for (let i = 0; i < regions.length; i += step) {
    if (!texels.covered[i] || !head.has(regions[i]!)) continue;
    points.push(texels.position[i * 3]!, texels.position[i * 3 + 1]!, texels.position[i * 3 + 2]!);
  }
  return Float64Array.from(points);
}

function sideBySide(images: Raster[], height: number): Raster {
  const scaled = images.map((r) =>
    r.height === height
      ? r
      : resize(r, Math.max(1, Math.round((r.width * height) / r.height)), height),
  );
  const width = scaled.reduce((s, r) => s + r.width, 0);
  const out = createRaster(width, height);
  let x0 = 0;
  for (const image of scaled) {
    for (let y = 0; y < height; y++) {
      out.data.set(
        image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
        (y * width + x0) * 4,
      );
    }
    x0 += image.width;
  }
  return out;
}

/** The share of pixels that differ between two same-size renders. */
function changedShare(a: Raster, b: Raster): number {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs(a.data[i]! - b.data[i]!) +
        Math.abs(a.data[i + 1]! - b.data[i + 1]!) +
        Math.abs(a.data[i + 2]! - b.data[i + 2]!) >
      12
    )
      changed++;
  }
  return changed / (a.width * a.height);
}

/**
 * Whether `amountUsd` beyond the forecast fits the cap and the cross-run limits while leaving
 * `keepUsd` for the forecast calls still to come.
 */
/**
 * The room a marking past the forecast must leave for the rest of the forecast: each later view's
 * `lookdev-markings` box call, its forecast `lookdev-marking` decisions per season, and identity.
 */
export function markingsRoomKeptUsd(rest: {
  viewsLeft: number;
  seasons: number;
  markingUsd: number;
  markingsUsd: number;
  identityUsd: number;
}): number {
  const perView = rest.markingsUsd + MAX_MARKINGS_JUDGED * rest.seasons * rest.markingUsd;
  return rest.viewsLeft * perView + rest.identityUsd;
}

export function canAfford(
  budget: Budget,
  amountUsd: number,
  keepUsd: number,
  what: string,
): boolean {
  try {
    budget.check(amountUsd + keepUsd, what);
    return true;
  } catch (e) {
    if (e instanceof BudgetExceededError) return false;
    throw e;
  }
}

/** How much of one eye's painted catch-light the close-up camera sees. */
export interface EyeCatchLight {
  /** Texels painted with the catch-light inside the eye. */
  painted: number;
  /** Of those, the texels inside the close-up's frame that pass its depth test. */
  visible: number;
}

/**
 * Whether every located eye got its catch-light and the close-up can see it, exactly: per eye, the
 * painted texels are more than zero and at least one of them projects inside the close-up and
 * passes its depth test (its depth along the view axis within half the eye's radius of the
 * nearest surface the close-up drew there). No brightness is measured: a pale eye or an eye
 * smaller than one triangle passes when its catch-light was painted where the close-up sees it.
 */
export function catchLight(
  camera: ViewCamera,
  depth: Float64Array,
  texels: TexelMap,
  eyes: SurfaceMarker[],
  painted: number[][],
): { found: boolean; eyes: number; perEye: EyeCatchLight[] } {
  const size = camera.sizePx;
  const perEye = eyes.map((eye, e) => {
    const mine = painted[e] ?? [];
    let visible = 0;
    for (const i of mine) {
      const [x, y, d] = camera.project(
        texels.position[i * 3]!,
        texels.position[i * 3 + 1]!,
        texels.position[i * 3 + 2]!,
      );
      const px = Math.floor(x);
      const py = Math.floor(y);
      if (!(d > 0) || px < 0 || py < 0 || px >= size || py >= size) continue;
      if (d <= depth[py * size + px]! + eye.radius * 0.5) visible++;
    }
    return { painted: mine.length, visible };
  });
  const lit = perEye.filter((p) => p.painted > 0 && p.visible > 0).length;
  return { found: eyes.length > 0 && lit === eyes.length, eyes: lit, perEye };
}

function greyMask(mask: Uint8Array, size: number): Raster {
  const out = createRaster(size, size);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 255 : 0;
    out.data[i * 4] = v;
    out.data[i * 4 + 1] = v;
    out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

const round = (v: number, places = 6) => Math.round(v * 10 ** places) / 10 ** places;

/** Mean luminance of the pixels set in `mask` (the figure, from the render's depth). */
export function figureLuminance(raster: Raster, mask: Uint8Array): number {
  let sum = 0;
  let n = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    sum += 0.2126 * raster.data[i]! + 0.7152 * raster.data[i + 1]! + 0.0722 * raster.data[i + 2]!;
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * The run's preview lighting. With `exposure: "auto"`, one exposure for the whole run: the one
 * that brings the source model's mean lit luminance over the four turntable views to its unlit
 * (albedo) luminance. It depends on the source model alone, so before and after share it.
 */
function resolveLighting(
  settings: PreviewLightingSettings,
  render: (
    lighting: PreviewLighting | undefined,
    unlit: boolean,
    view: number,
  ) => { raster: Raster; depth: Float64Array },
): PreviewLighting {
  const lighting: PreviewLighting = {
    ambient: settings.ambient,
    key: settings.key,
    keyDirection: settings.keyDirection,
    exposure: 1,
  };
  if (settings.exposure !== "auto") return { ...lighting, exposure: settings.exposure };
  let lit = 0;
  let unlit = 0;
  for (let v = 0; v < TURNTABLE_VIEWS.length; v++) {
    const albedo = render(undefined, true, v);
    const mask = figureMask(albedo.depth);
    lit += figureLuminance(render(lighting, false, v).raster, mask);
    unlit += figureLuminance(albedo.raster, mask);
  }
  return { ...lighting, exposure: lit > 0 ? unlit / lit : 1 };
}

interface Sidecar {
  name: string;
  field: string;
  bytes: Uint8Array;
  extra?: Record<string, unknown>;
}

export async function lookDev(
  options: LookdevOptions,
): Promise<{ run: RunRecord; runDir: string; passed: boolean; plan: LookdevPlan }> {
  const { spec, profile, provenance, bible } = options;
  if (spec.kind !== CHARACTER_3D_KIND) {
    throw new InputError(`look-dev needs a ${CHARACTER_3D_KIND} spec, not "${spec.kind}"`);
  }
  characterSpec(spec);
  const settings = model3dSettings(profile);
  const look = lookdevSettings(profile);
  if (!provenance || typeof provenance !== "object" || !Array.isArray(provenance.calls)) {
    throw new InputError("the provenance file is not an Assetgrove provenance record");
  }
  const plan = planLookdev(
    profile,
    options.routes,
    options.capUsd,
    lookdevViewCalls(spec, bible, options.routes),
  );
  const log = options.log ?? (() => {});
  const rig = declaresRig(profile) ? await loadRig(profile, options.profileDir) : undefined;

  const sourceSha256 = sha256(options.model.bytes);
  const glb = parseGlb(options.model.bytes);
  const textured = baseColorImage(glb.json);
  if (!textured) throw new InputError("the model has no base-colour texture to look-dev");
  const sourceImage = glb.json.images?.[textured.image];
  if (sourceImage?.bufferView === undefined) {
    throw new InputError("the model's base-colour image is not embedded in the .glb");
  }
  const view = glb.json.bufferViews![sourceImage.bufferView]!;
  const sourceTexture = decodeImage(
    glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength),
  );
  const framing = boundsOf(posedPrimitives(glb));
  if (!framing) throw new InputError("the model has no triangle geometry");
  const heightM = framing.max[1] - framing.min[1];
  const facingDeg = (yawBetween("+z", settings.forward) * 180) / Math.PI;
  const forward = AXIS_VECTORS[settings.forward]!;
  const textureSize = Math.min(
    Math.max(sourceTexture.width, sourceTexture.height),
    settings.budgets.textureMaxPx,
  );
  const groomSize = look.sizePx ?? textureSize;

  // Spend: the whole forecast must fit the cap and the cross-run limits before the first call.
  const budget = new Budget(plan.capUsd, ledgerFor(options.ledger, options.provider, profile));
  budget.check(plan.estimateUsd, "a look-dev of one character");
  const caller = new Caller({
    provider: options.provider,
    ...(options.providerName !== undefined && { providerName: options.providerName }),
    budget,
    routes: options.routes,
    ...(options.now && { now: options.now }),
    log,
  });

  // The run directory exists before the first call, so a run that stops part-way keeps the
  // views it already paid for.
  const now = options.now ?? (() => new Date());
  const runId =
    options.runId ??
    `${now().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = resolve(options.runsDir, runId);
  const id = "c1";
  const dir = `${id}-${CHARACTER_3D_KIND}`;
  await mkdir(join(runDir, dir), { recursive: true });

  // Which view each reference shows; no front view refuses the look-dev before the first restyle.
  const references = await subjectReferences(
    spec,
    bible,
    options.bibleDir,
    caller,
    new ReferenceViewCache(options.stateDir),
  );

  const texels = bakeTexels(glb, textureSize, textured.image);
  const skeleton = groomSkeleton(glb, rig, forward);
  const regions = texelRegions(texels, skeleton);
  const focus = headFocus(texels, regions, framing, forward);
  const zoom = look.closestZoom;
  // At another edge than the close-up's, the same framing: the character spans as much of it.
  const closeUp = (yawDeg: number, sizePx = CLOSE_UP_PX) =>
    closeUpCamera({
      sizePx,
      yawDeg: facingDeg + yawDeg,
      focus,
      heightM,
      screenHeightPx: (zoom.screenHeightPx * sizePx) / CLOSE_UP_PX,
      characterScreenFraction: zoom.characterScreenFraction,
    });

  // One preview lighting for every before and after render, every season.
  const turntablePx = settings.turntablePx;
  const lighting = resolveLighting(look.previewLighting, (l, unlit, v) =>
    renderViewWithDepth(glb, {
      sizePx: turntablePx,
      yawDeg: facingDeg + TURNTABLE_VIEWS[v]!.yawDeg,
      framing,
      ...(l && { lighting: l }),
      unlit,
    }),
  );
  const unlitView = (model: Glb, v: number) =>
    renderViewWithDepth(model, {
      sizePx: turntablePx,
      yawDeg: facingDeg + TURNTABLE_VIEWS[v]!.yawDeg,
      framing,
      unlit: true,
    });

  // Before: the turntable views and the close-up of the model as picked.
  const beforeViews = TURNTABLE_VIEWS.map((v) =>
    renderView(glb, { sizePx: turntablePx, yawDeg: facingDeg + v.yawDeg, framing, lighting }),
  );
  const unlitBefore = TURNTABLE_VIEWS.map((_, i) => unlitView(glb, i).raster);
  const beforeClose = renderView(glb, {
    sizePx: CLOSE_UP_PX,
    yawDeg: 0,
    framing,
    camera: closeUp(0),
    lighting,
  });

  // 1. Albedo: restyle flat-lit renders and project them back onto the UVs. The views are
  // restyled in turn: each later view starts from the model carrying what the earlier views
  // painted, so it extends their markings instead of placing its own (assetgrove#122: restyled
  // independently, the side view put the eye mask where the three-quarter view put pale coat,
  // and the blend averaged the two to grey).
  const source =
    sourceTexture.width === textureSize && sourceTexture.height === textureSize
      ? sourceTexture
      : resize(sourceTexture, textureSize, textureSize);
  const projected = [];
  const depths: Float32Array[] = [];
  const registration: Record<string, number> = {};
  const viewArtifacts: Array<{ name: string; bytes: Uint8Array }> = [];
  let painted = glb;
  // The turntable views framed on the figure's own outline, then the detail pass.
  const positions = posedPrimitives(glb).map((p) => p.positions);
  const head = headPoints(texels, regions);
  const restyleViews = [
    ...LOOKDEV_VIEWS.map((v) => ({
      name: v.name as string,
      reference: referenceViewFor(v.name) as string,
      detail: false,
      camera: framedCamera({
        sizePx: VIEW_PX,
        yawDeg: facingDeg + v.yawDeg,
        framing,
        elevationDeg: v.elevationDeg,
        positions,
        fill: VIEW_FILL,
      }),
    })),
    ...LOOKDEV_DETAIL_VIEWS.map((v) => ({
      name: v.name as string,
      reference: v.reference as string,
      detail: true,
      camera:
        head.length > 0
          ? framedCamera({
              sizePx: VIEW_PX,
              yawDeg: facingDeg + v.yawDeg,
              framing,
              positions: [head],
              fill: DETAIL_FILL,
            })
          : closeUp(v.yawDeg, VIEW_PX),
    })),
  ];
  for (const [k, v] of restyleViews.entries()) {
    const { camera } = v;
    const flatView = renderViewWithDepth(painted, {
      sizePx: VIEW_PX,
      yawDeg: 0,
      framing,
      camera,
      unlit: true,
      background: BACKGROUND,
    });
    const flat = flatView.raster;
    const flatMask = figureMask(flatView.depth);
    const flatPng = encodePng(flat);
    const matching = references.filter((r) => r.view === v.reference);
    const refs = [...matching, ...references.filter((r) => !matching.includes(r))].slice(0, 3);
    const edited = await caller.image(
      LOOKDEV_OPERATION,
      restylePrompt(
        spec,
        bible,
        v.name,
        refs.map((r) => r.role),
        k > 0,
        v.detail,
      ),
      [{ ...png(flatPng), role: `flat-lit render, ${v.name} view` }, ...refs],
    );
    const { image: aligned, overlap } = register(decodeImage(edited.bytes), flat, flatMask);
    registration[v.name] = overlap;
    projected.push({ camera, image: aligned, background: editedBackground(aligned, flat) });
    depths.push(depthMap(glb, camera));
    if (k < restyleViews.length - 1) {
      const sofar = projectViews(glb, texels, projected, depths);
      painted = parseGlb(options.model.bytes);
      replaceImage(
        painted,
        textured.image,
        encodePng(dilate(fillUnseen(sofar, texels, source), texels.covered, 8)),
      );
    }
    viewArtifacts.push(
      { name: `lookdev-view-${v.name}-render.png`, bytes: flatPng },
      { name: `lookdev-view-${v.name}-restyled.png`, bytes: encodePng(aligned) },
    );
    for (const a of viewArtifacts.slice(-2)) await writeFile(join(runDir, dir, a.name), a.bytes);
    log(`look-dev: restyled the ${v.name} view`);
  }
  const projection = projectViews(glb, texels, projected, depths);
  const albedo = dilate(fillUnseen(projection, texels, source), texels.covered, 8);
  const albedoPng = encodePng(albedo);

  // The new albedo goes into the model before the eyes and close-ups are made.
  replaceImage(glb, textured.image, albedoPng);

  // 2. Eyes and nose: located on a close-up front render, cast onto the surface.
  const locateCamera = closeUp(0);
  const locateRender = renderView(glb, {
    sizePx: CLOSE_UP_PX,
    yawDeg: 0,
    framing,
    camera: locateCamera,
    lighting,
  });
  // The locate call also says which bare parts the character has, from its references.
  const subjectName = subjectOf(spec);
  const locateText = await caller.vision(
    LOOKDEV_LOCATE_OPERATION,
    locatePrompt(subjectName, bible.subjects?.[subjectName]?.description),
    [
      { ...png(encodePng(locateRender)), role: "close-up front render" },
      ...[
        ...references.filter((r) => r.view === "front"),
        ...references.filter((r) => r.view !== "front"),
      ].slice(0, 3),
    ],
  );
  const has = parseHas(locateText);
  let markers: { eyes: SurfaceMarker[]; nose: SurfaceMarker[] };
  try {
    markers = parseMarkers(locateText, locateCamera, depthMap(glb, locateCamera));
  } catch {
    markers = { eyes: [], nose: [] };
  }

  // 3. Groom: bare masks, then each season's maps.
  const groomTexels =
    groomSize === textureSize ? texels : bakeTexels(glb, groomSize, textured.image);
  const groomRegions = groomTexels === texels ? regions : texelRegions(groomTexels, skeleton);
  const eyeMask = markerMask(groomTexels, markers.eyes);
  const noseMask = markerMask(groomTexels, markers.nose);
  const world = worldMatrices(glb.json);
  const joints = nodePositions(glb, world);
  const feet = (rig?.template.feet ?? [])
    .map((f) => ({ ankle: joints.get(f.joints[2]), toe: joints.get(f.joints[3]) }))
    .filter((f): f is { ankle: Vec3; toe: Vec3 } => f.ankle !== undefined && f.toe !== undefined);
  const padRadius =
    feet.length > 0
      ? Math.max(
          ...feet.map(
            (f) => Math.hypot(f.toe[0] - f.ankle[0], f.toe[2] - f.ankle[2]) * 0.75 + 0.005,
          ),
        )
      : 0;
  const pads = padMask(groomTexels, feet, padRadius);
  const bare = new Uint8Array(eyeMask.length);
  const count = (m: Uint8Array) =>
    m.reduce((s, v, i) => s + (v && groomTexels.covered[i] ? 1 : 0), 0);
  for (let i = 0; i < bare.length; i++) bare[i] = eyeMask[i] || noseMask[i] || pads[i] ? 1 : 0;
  // Each bare mask on its own: an empty one means that part has fur nobody checked. A part the
  // character lacks (the locate call says so) needs no mask; nor do paw pads on a profile with no
  // rig template, which leaves the feet unknown (decided from the profile, before any call).
  const bareCounts = { eyes: count(eyeMask), nose: count(noseMask), "paw pads": count(pads) };
  const parts: Record<BarePart, "required" | "absent" | "not required"> = {
    eyes: has.eyes ? "required" : "absent",
    nose: has.nose ? "required" : "absent",
    pawPads: !has.pawPads ? "absent" : rig ? "required" : "not required",
  };
  const partOf = (name: string) =>
    (Object.keys(BARE_PARTS) as BarePart[]).find((p) => BARE_PARTS[p] === name)!;
  const emptyMasks = Object.entries(bareCounts)
    .filter(([name, n]) => n === 0 && parts[partOf(name)] === "required")
    .map(([name]) => name);
  const unrequired = (Object.keys(BARE_PARTS) as BarePart[])
    .filter((p) => parts[p] !== "required")
    .map((p) =>
      parts[p] === "absent"
        ? `; ${BARE_PARTS[p]}: absent (the locate call says the character has none), no mask required`
        : `; ${BARE_PARTS[p]}: not required (the profile declares no rig template, so the feet are unknown)`,
    )
    .join("");
  const tooSmall = `no texel of the ${groomSize} px groom maps falls inside it`;
  const whyEmpty: Record<string, string> = {
    eyes: markers.eyes.length > 0 ? tooSmall : "the locate call found no eye",
    nose: markers.nose.length > 0 ? tooSmall : "the locate call found no nose",
    "paw pads": "no texel faces down under the rig template's feet",
  };

  const reasons: Reason[] = [];
  const sidecars: Sidecar[] = [];
  const asset = spec.assetId;
  const seasonGrooms: Record<string, SeasonGroom> = {};
  const seasonMaps: Record<string, GroomMaps> = {};
  const groomReferences = references.slice(0, 4);
  for (const season of plan.seasons) {
    const text = await caller.vision(
      LOOKDEV_GROOM_OPERATION,
      groomPrompt(spec, bible, season, look.traits[season], heightM),
      groomReferences,
    );
    const groom = parseSeasonGroom(text);
    seasonGrooms[season] = groom;
    const maps = groomMaps(groomTexels, groomRegions, bare, groom, skeleton, albedo);
    seasonMaps[season] = maps;
    const check = groomMaskCheck(maps.length, groomTexels, bare);
    const label = look.seasons ? `groom-${season}-masks` : "groom-masks";
    reasons.push({
      check: label,
      passed: check.ok && emptyMasks.length === 0,
      reason:
        `bare masks: ${Object.entries(bareCounts)
          .map(([name, n]) => `${name} ${n}`)
          .join(", ")} texel(s); ` +
        `${check.zeroOnBare} bare texel(s) with fur and ${check.zeroOutside} zero-length texel(s) outside the masks` +
        emptyMasks
          .map(
            (m) => `; the ${m} mask is empty (${whyEmpty[m]}), so zero length there is unchecked`,
          )
          .join("") +
        unrequired,
      source: "deterministic",
    });
    const key = look.seasons ? `${season}.` : "";
    for (const map of look.maps) {
      sidecars.push({
        name: `${asset}.groom.${key}${map}.png`,
        field: `groom.${key}${map}`,
        bytes: encodePng(maps[map]),
        ...(map === "length" && { extra: { maxLengthM: round(maps.maxLengthM) } }),
      });
    }
    if (maps.tint && look.seasons) {
      sidecars.push({
        name: `${asset}.tint.${season}.png`,
        field: `textures.tint.${season}`,
        bytes: encodePng(maps.tint),
      });
    }
  }

  // 4. The eye material and its mask.
  const eyeTriangles = splitEyes(glb, textured.material, markers.eyes);
  // The catch-light is an emissive texture, never the base colour, so the eyes read as
  // wet at the closest zoom whatever the eye geometry, while the base colour stays unlit albedo.
  // The target can keep it, or drop it and shade the eyes itself; the glossy eye material adds
  // the live highlight.
  // An eye smaller than one triangle moves no triangle into the eye material; its catch-light is
  // still painted, into the textured material's emissive texture (black everywhere else).
  const catchLightTexture = createRaster(textureSize, textureSize);
  for (let i = 3; i < catchLightTexture.data.length; i += 4) catchLightTexture.data[i] = 255;
  const catchLightTexels = paintCatchLights(catchLightTexture, texels, markers.eyes, forward);
  const catchLightOn = eyeTriangles > 0 ? EYE_MATERIAL : "textured";
  // With an eye split, the same texture is the emissive texture of both materials: an eye smaller
  // than one triangle beside a larger one has its painted texels on textured-material triangles,
  // and the texture is black there except inside the eyes.
  if (catchLightTexels.some((p) => p.length > 0)) {
    const index = setEmissiveAt(
      glb,
      textured.material,
      encodePng(catchLightTexture),
      "eyes.catchLight",
    );
    if (eyeTriangles > 0) {
      const eye = glb.json.materials?.find((m) => m.name === EYE_MATERIAL) as
        Record<string, unknown> | undefined;
      if (eye) {
        eye["emissiveTexture"] = { index };
        eye["emissiveFactor"] = [1, 1, 1];
      }
    }
  }
  const eyeMaskTexture = markerMask(texels, markers.eyes);
  sidecars.push({
    name: `${asset}.eyes.mask.png`,
    field: "eyes",
    bytes: encodePng(greyMask(eyeMaskTexture, textureSize)),
    extra: { material: EYE_MATERIAL },
  });
  sidecars.push({ name: `${asset}.baseColor.png`, field: "textures.baseColor", bytes: albedoPng });

  // Budgets are measured on the embedded model; the external maps are checked by their own size.
  compactBin(glb);
  const embeddedMeasures = measure(parseGlb(writeGlb(glb)));

  // External images: the groom maps, tints and eye mask beside the .glb, never embedded.
  const groomExtras: Record<string, unknown> = {};
  for (const s of sidecars) {
    if (s.field === "textures.baseColor") continue;
    const index = addExternalImage(glb.json, s.name, s.field);
    groomExtras[s.field] = { image: index, uri: s.name };
  }
  glb.json.asset.extras = {
    ...(glb.json.asset.extras as Record<string, unknown> | undefined),
    lookdev: {
      groom: {
        encoding: {
          length: "grey, 0 = no fur, 255 = maxLengthM",
          direction: "rest-pose model-space comb direction, rgb = d * 0.5 + 0.5",
          density: "grey, 0..1 of the material's strand density",
          tint: "rgb multiplies the base colour, alpha weights it toward the fur tips",
        },
        maxLengthM: Object.fromEntries(
          Object.entries(seasonMaps).map(([s, m]) => [s, round(m.maxLengthM)]),
        ),
      },
      images: groomExtras,
      eyes: {
        material: EYE_MATERIAL,
        catchLight:
          catchLightOn === EYE_MATERIAL
            ? "the eye and textured materials' shared emissiveTexture"
            : "the textured material's emissiveTexture (no triangle lies wholly inside an eye)",
      },
    },
  };
  const raw = writeGlb(glb);
  const written = parseGlb(raw);
  const measures = {
    ...embeddedMeasures,
    textureMaxPx: Math.max(embeddedMeasures.textureMaxPx ?? 0, groomSize),
  };

  // 5. After: per season, turntables with map-driven shell fur, and the close-up.
  const artifacts: Array<{ name: string; bytes: Uint8Array }> = [...viewArtifacts];
  const afterBySeason: Record<string, Raster[]> = {};
  const afterMaskBySeason: Record<string, Uint8Array[]> = {};
  const afterClose: Record<string, Raster> = {};
  const unlitAfterViews = TURNTABLE_VIEWS.map((_, i) => unlitView(written, i));
  const unlitAfter = unlitAfterViews.map((u) => u.raster);
  const unlitAfterMask = unlitAfterViews.map((u) => figureMask(u.depth));
  const litToUnlit: Record<string, Record<string, number>> = {};
  const furSpeckle: Record<string, Record<string, number>> = {};
  for (const season of plan.seasons) {
    const maps = seasonMaps[season]!;
    const fur: FurMaps = {
      length: maps.length,
      direction: maps.direction,
      density: maps.density,
      ...(maps.tint && { tint: maps.tint }),
      maxLengthM: maps.maxLengthM,
      // About one strand per two texels of the maps, so strands stay finer than a pixel at the closest zoom.
      strandsPerUv: Math.max(192, Math.round(groomSize / 2)),
    };
    const bare = TURNTABLE_VIEWS.map((v) =>
      renderViewWithDepth(written, {
        sizePx: turntablePx,
        yawDeg: facingDeg + v.yawDeg,
        framing,
        lighting,
      }),
    );
    const viewsDepth = TURNTABLE_VIEWS.map((v) =>
      renderViewWithDepth(written, {
        sizePx: turntablePx,
        yawDeg: facingDeg + v.yawDeg,
        framing,
        fur,
        lighting,
      }),
    );
    const views = viewsDepth.map((v) => v.raster);
    afterBySeason[season] = views;
    afterMaskBySeason[season] = viewsDepth.map((v) => figureMask(v.depth));
    const bareClose = renderViewWithDepth(written, {
      sizePx: CLOSE_UP_PX,
      yawDeg: 0,
      framing,
      camera: closeUp(0),
      lighting,
    });
    const furClose = renderViewWithDepth(written, {
      sizePx: CLOSE_UP_PX,
      yawDeg: 0,
      framing,
      camera: closeUp(0),
      fur,
      lighting,
    });
    afterClose[season] = furClose.raster;
    litToUnlit[season] = Object.fromEntries(
      TURNTABLE_VIEWS.map((v, i) => [
        v.name,
        round(
          figureLuminance(views[i]!, unlitAfterMask[i]!) /
            Math.max(1e-6, figureLuminance(unlitAfter[i]!, unlitAfterMask[i]!)),
          3,
        ),
      ]),
    );
    // Speckle the fur adds over the bare surface, in every view and the close-up.
    const speckles: Record<string, number> = {};
    TURNTABLE_VIEWS.forEach((v, i) => {
      speckles[v.name] = Math.max(
        0,
        speckle(views[i]!, afterMaskBySeason[season]![i]!) -
          speckle(bare[i]!.raster, figureMask(bare[i]!.depth)),
      );
    });
    speckles["close-up"] = Math.max(
      0,
      speckle(furClose.raster, figureMask(furClose.depth)) -
        speckle(bareClose.raster, figureMask(bareClose.depth)),
    );
    furSpeckle[season] = Object.fromEntries(
      Object.entries(speckles).map(([k, v]) => [k, round(v, 5)]),
    );
    const worst = Object.entries(speckles).reduce((a, b) => (b[1] > a[1] ? b : a));
    const share = Math.max(...views.map((v, i) => changedShare(v, bare[i]!.raster)));
    reasons.push({
      check: look.seasons ? `groom-${season}-render` : "groom-render",
      passed: share > 0.01 && worst[1] <= MAX_FUR_SPECKLE,
      reason:
        `shell fur driven by the maps changes ${(share * 100).toFixed(1)}% of the pixels of a turntable view; ` +
        `speckle it adds: at most ${(worst[1] * 100).toFixed(2)}% of the figure's pixels (${worst[0]}; limit ${(MAX_FUR_SPECKLE * 100).toFixed(1)}%)`,
      source: "deterministic",
    });
  }

  // Checks on the albedo.
  const visibleTexels = projection.visible.reduce((n, v) => n + v, 0);
  reasons.push({
    check: "lookdev-albedo-coverage",
    passed: projection.coverage >= MIN_COVERAGE,
    reason:
      `${(projection.coverage * 100).toFixed(1)}% of the ${visibleTexels} texels a restyled view's camera sees take colour from the restyled views ` +
      `(limit ${(MIN_COVERAGE * 100).toFixed(0)}%; ${(projection.uvCoverage * 100).toFixed(1)}% of all UV-covered texels); the rest keep the source texture, colour-matched`,
    source: "deterministic",
  });
  const overlaps = Object.entries(registration);
  const moved = overlaps.filter(([, o]) => o < MIN_OVERLAP).map(([k]) => k);
  reasons.push({
    check: "lookdev-registration",
    passed: moved.length === 0,
    reason:
      `recorded, never filters: overlap of each restyled view's figure with the render's figure (named under ${MIN_OVERLAP}): ` +
      overlaps.map(([k, o]) => `${k} ${o.toFixed(3)}`).join(", ") +
      (moved.length > 0
        ? `; ${moved.join(", ")} under ${MIN_OVERLAP}: the edit moved or reshaped the figure`
        : ""),
    source: "deterministic",
    shadow: true,
  });
  const seamsBefore = seamError(parseGlb(options.model.bytes), source, textured.image);
  const seamsAfter = seamError(written, albedo, textured.image);
  reasons.push({
    check: "lookdev-seams",
    passed: seamsAfter.mean <= Math.max(8, seamsBefore.mean * 1.25),
    reason:
      `colour difference across ${seamsAfter.edges} UV seam edge(s): mean ${seamsAfter.mean.toFixed(1)}, ` +
      `95th percentile ${seamsAfter.p95.toFixed(1)} (0-255; the source texture: mean ${seamsBefore.mean.toFixed(1)}, ` +
      `95th percentile ${seamsBefore.p95.toFixed(1)})`,
    source: "deterministic",
  });
  // The close-up's depth buffer: the catch-light check is a depth test, not a brightness one.
  const { depth: closeDepth } = renderViewWithDepth(written, {
    sizePx: CLOSE_UP_PX,
    yawDeg: 0,
    framing,
    camera: closeUp(0),
    lighting,
  });
  const light = catchLight(closeUp(0), closeDepth, texels, markers.eyes, catchLightTexels);
  // A character the locate call says has no eyes (a robot with a visor) has no eye material to
  // light: recorded as absent, not as a failure, like its groom mask.
  reasons.push({
    check: "eyes-catch-light",
    passed: parts.eyes === "absent" || light.found,
    reason:
      (parts.eyes === "absent"
        ? "eyes: absent (the locate call says the character has none), no eye material or catch-light required; "
        : "") +
      `${markers.eyes.length} eye(s) located, ${eyeTriangles} triangle(s) in the "${EYE_MATERIAL}" material; ` +
      `catch-light painted and seen by the close-up at the closest zoom in ${light.eyes} of ${markers.eyes.length} eye(s)` +
      (light.perEye.length > 0
        ? ` (${light.perEye.map((p, e) => `eye ${e + 1}: ${p.painted} texel(s) painted, ${p.visible} passing the close-up's depth test`).join("; ")})`
        : "") +
      `; the catch-light is the ${catchLightOn === EYE_MATERIAL ? "eye and textured materials' shared" : "textured material's"} emissive texture, the base colour has none`,
    source: "deterministic",
  });
  reasons.push(
    await validatorCheck(raw, Object.fromEntries(sidecars.map((s) => [s.name, s.bytes]))),
  );
  reasons.push(...budgetChecks(measures, settings));

  // Markings: each identity marking in the lit after renders against the matching turnaround view.
  const markingMeasures: MarkingMeasure[] = [];
  const unmeasured: string[] = [];
  const unreadable: string[] = [];
  const unjudged: string[] = [];
  const identityUsd = plan.calls
    .filter((c) => c.operation === "identity" || c.operation === IDENTITY_CAST_OPERATION)
    .reduce((sum, c) => sum + c.estimatedCostUsd, 0);
  for (const [v, view] of TURNTABLE_VIEWS.entries()) {
    const wanted = referenceViewFor(view.name);
    const ref = references.find((r) => r.view === wanted);
    if (!ref) {
      unmeasured.push(`${view.name} (the references have no ${wanted} view)`);
      continue;
    }
    // Each render cut to its figure, so the boxes land on the figure at full resolution.
    const crops = plan.seasons.map((s) =>
      figureCrop(afterBySeason[s]![v]!, afterMaskBySeason[s]![v]!),
    );
    const renders = crops.map((c) => c.image);
    const text = await caller.vision(
      LOOKDEV_MARKINGS_OPERATION,
      markingsPrompt({
        subject: subjectName,
        ...(bible.subjects?.[subjectName]?.description !== undefined && {
          description: bible.subjects[subjectName]!.description!,
        }),
        view: view.name,
        referenceRole: ref.role,
        seasons: plan.seasons,
      }),
      [
        ref,
        ...renders.map((r, k) => ({
          ...png(encodePng(r)),
          role: `lit render after look-dev, ${view.name} view, ${plan.seasons[k]}`,
        })),
      ],
    );
    let markings;
    try {
      markings = parseMarkingsReply(text, renders.length + 1);
    } catch {
      unreadable.push(`${view.name} (the markings reply held no JSON)`);
      continue;
    }
    if (markings.length === 0) unmeasured.push(`${view.name} (no marking was named)`);
    const refImage = decodeImage(ref.bytes);
    for (const [n, m] of markings.entries()) {
      // Past the forecast's markings, a marking is judged only while the cap has room for its
      // decisions; one it cannot afford is unjudged and fails the check, never passes unseen.
      if (n >= MAX_MARKINGS_JUDGED) {
        const each = options.routes[LOOKDEV_MARKING_OPERATION]?.estimatedCostUsd ?? 0;
        const later = markingsRoomKeptUsd({
          viewsLeft: TURNTABLE_VIEWS.length - 1 - v,
          seasons: renders.length,
          markingUsd: each,
          markingsUsd: options.routes[LOOKDEV_MARKINGS_OPERATION]?.estimatedCostUsd ?? 0,
          identityUsd,
        });
        if (!canAfford(budget, each * renders.length, later, `the ${m.name} marking decisions`)) {
          unjudged.push(`${m.name} in ${view.name}`);
          continue;
        }
      }
      const refBoxes = m.boxes[0];
      const refMark = refBoxes && measureBox(refImage, refBoxes.mark, undefined);
      const refGround = refBoxes && measureBox(refImage, refBoxes.ground, undefined);
      if (!refMark || !refGround) {
        unmeasured.push(`${m.name} in ${view.name} (not located on the reference)`);
        continue;
      }
      const refCrop = {
        ...png(encodePng(markingCrop(refImage, refBoxes))),
        role: `reference crop: ${m.name}, ${view.name}`,
      };
      for (const [k, crop] of crops.entries()) {
        const render = crop.image;
        const boxes = m.boxes[k + 1] ?? null;
        const image = plan.seasons[k]!;
        const renderMark = boxes && measureBox(render, boxes.mark, crop.mask);
        const { result, record } = await caller.decide(
          LOOKDEV_MARKING_OPERATION,
          markingDecisionPrompt({
            subject: subjectName,
            marking: m.name,
            against: m.against,
            view: view.name,
            season: image,
          }),
          [
            refCrop,
            {
              ...png(encodePng(markingCrop(render, boxes))),
              role: `render crop: ${m.name}, ${view.name}, ${image}`,
            },
          ],
          {
            type: "choice",
            instructions:
              "Is the marking still there in the render, in the same colour and contrast as in the reference?",
            options: MARKING_VERDICTS,
          },
        );
        if (
          result.answer.type !== "choice" ||
          !Object.hasOwn(MARKING_VERDICTS, result.answer.choice)
        ) {
          throw new ProviderError(`the marking decision for ${m.name} did not choose an option`);
        }
        const verdict = result.answer.choice as MarkingVerdict;
        const probability = record.decision?.value;
        markingMeasures.push({
          marking: m.name,
          view: view.name,
          image,
          verdict,
          ...(probability !== undefined && { probability }),
          ...(renderMark && { deltaE: deltaE(refMark, renderMark) }),
          drifts: verdict !== "kept",
        });
      }
    }
  }
  // lookdev-markings filters only where measured stable on the run's markings model.
  const markingsState = markingsFiltering(options.routes[LOOKDEV_MARKING_OPERATION]?.model);
  reasons.push(
    markingsReason(markingMeasures, { unmeasured, unreadable, unjudged }, markingsState),
  );

  // 6. Identity lock on the looked-dev turntable (front and three-quarter), as for wave 0.
  let identity: IdentityScore | undefined;
  const identityMode = identitySettings3d(profile);
  const firstSeason = plan.seasons[0]!;
  if (identityMode.mode !== "off") {
    const views = afterBySeason[firstSeason]!;
    const composite = encodePng(sideBySide([views[0]!, views[1]!], turntablePx));
    const subject = subjectOf(spec);
    identity = await scoreIdentity({
      caller,
      record: {
        subject,
        version: bible.version,
        sha256: sha256(
          Buffer.from(
            JSON.stringify({ subject, description: bible.subjects?.[subject]?.description }),
          ),
        ),
        fingerprint: {
          signatureFeatures: [bible.subjects?.[subject]?.description ?? subject],
          proportions: bible.subjects?.[subject]?.description ?? subject,
          palette: bible.palette,
        },
        references: references.map((r) => ({ role: r.role, path: r.path, sha256: r.sha256 })),
      },
      references,
      candidate: {
        role: "candidate turntable",
        path: "(front and three-quarter renders after look-dev)",
        mediaType: "image/png",
        bytes: composite,
        sha256: sha256(composite),
      },
      describe:
        "turntable renders of a 3D character model, front view on the left and three-quarter view on the right",
      settings: identityMode,
    });
    reasons.push(identityReason(identity));
  }

  // 7. Before and after beside the approved turnaround, for the person who approves.
  // Each compare image leads with the turnaround's matching view; one that has to borrow the
  // front view, or has no turnaround column at all, is named in a reason for the person.
  const substituted: string[] = [];
  const noColumn: string[] = [];
  const refFor = (name: string, wanted: string) => {
    let ref = references.find((r) => r.view === wanted);
    if (!ref) {
      ref = references.find((r) => r.view === "front");
      (ref ? substituted : noColumn).push(name);
    }
    return ref ? decodeImage(ref.bytes) : undefined;
  };
  const compareNames = [...TURNTABLE_VIEWS.map((v) => v.name), "close-up"];
  compareNames.forEach((name, i) => {
    const before = i < 4 ? beforeViews[i]! : beforeClose;
    const afters = plan.seasons.map((s) => (i < 4 ? afterBySeason[s]![i]! : afterClose[s]!));
    const ref = refFor(name, referenceViewFor(name));
    const height = before.height;
    artifacts.push({
      name: `compare-${name}.png`,
      bytes: encodePng(sideBySide([...(ref ? [ref] : []), before, ...afters], height)),
    });
    artifacts.push({ name: `before-${name}.png`, bytes: encodePng(before) });
    plan.seasons.forEach((s, k) =>
      artifacts.push({ name: `after-${s}-${name}.png`, bytes: encodePng(afters[k]!) }),
    );
  });

  TURNTABLE_VIEWS.forEach((v, i) => {
    artifacts.push({ name: `unlit-before-${v.name}.png`, bytes: encodePng(unlitBefore[i]!) });
    artifacts.push({ name: `unlit-after-${v.name}.png`, bytes: encodePng(unlitAfter[i]!) });
  });

  const views = references.map((r) => r.view);
  reasons.push({
    check: "lookdev-compare",
    passed: noColumn.length === 0,
    reason:
      substituted.length === 0 && noColumn.length === 0
        ? "every compare image leads with the matching view of the approved references"
        : [
            `the approved references show the view(s) ${views.length > 0 ? [...new Set(views)].join(", ") : "none"}`,
            ...(substituted.length > 0
              ? [`compare-${substituted.join(", compare-")} show(s) the front reference instead`]
              : []),
            ...(noColumn.length > 0
              ? [`compare-${noColumn.join(", compare-")} have no turnaround column`]
              : []),
          ].join("; "),
    source: "deterministic",
  });

  // Stage the candidate. Its whole write set is checked first; the per-view renders already written
  // above (names fixed by Assetgrove) are among the artifacts and are checked with it.
  checkWrites([
    ...artifacts.map((a) => posix.join(dir, a.name)),
    ...sidecars.map((s) => posix.join(dir, s.name)),
    `${id}.glb`,
  ]);
  const artifactNames: string[] = [];
  for (const a of artifacts) {
    await writeFile(join(runDir, dir, a.name), a.bytes);
    artifactNames.push(posix.join(dir, a.name));
  }
  const stagedSidecars: NonNullable<StagedCandidate["sidecars"]> = [];
  for (const s of sidecars) {
    const file = posix.join(dir, s.name);
    await writeFile(join(runDir, file), s.bytes);
    stagedSidecars.push({
      file,
      name: s.name,
      mediaType: "image/png",
      sha256: sha256(s.bytes),
      field: s.field,
      ...(s.extra && { extra: s.extra }),
    });
  }

  const digitalSourceType: DigitalSourceType =
    provenance.digitalSourceType && provenance.digitalSourceType !== "undeclared"
      ? provenance.digitalSourceType
      : (readDigitalSourceType(options.model.bytes, GLB_MEDIA_TYPE) ??
        DIGITAL_SOURCE_TYPES.generated);
  const bytes = embedDigitalSourceType(raw, GLB_MEDIA_TYPE, digitalSourceType);
  const calls = [...provenance.calls, ...caller.records];
  const outputGrant = grantOf(calls);
  const parameters = {
    ...provenance.parameters,
    targetProfileSha256: profileSha256(profile),
    lookdev: {
      // The file name only: a local path would leak into the target's public provenance.
      sourceModel: basename(options.model.path),
      sourceModelSha256: sourceSha256,
      views: LOOKDEV_VIEWS,
      detailViews: LOOKDEV_DETAIL_VIEWS,
      textureSizePx: textureSize,
      groomSizePx: groomSize,
      seasons: plan.seasons,
      groom: seasonGrooms,
      eyes: markers.eyes.map((m) => ({
        point: m.point.map((v) => round(v)),
        radius: round(m.radius),
      })),
      nose: markers.nose.map((m) => ({
        point: m.point.map((v) => round(v)),
        radius: round(m.radius),
      })),
      padRadiusM: round(padRadius),
      referenceViews: viewRecord(references),
      parts,
      bareTexels: {
        eyes: bareCounts.eyes,
        nose: bareCounts.nose,
        pads: bareCounts["paw pads"],
      },
      closestZoom: look.closestZoom,
      lighting: {
        ambient: lighting.ambient,
        key: lighting.key,
        keyDirection: lighting.keyDirection,
        exposure: round(lighting.exposure, 4),
        auto: look.previewLighting.exposure === "auto",
        litToUnlit,
      },
      furSpeckle,
      markings: markingMeasures.map((m) => ({
        ...m,
        ...(m.deltaE !== undefined && { deltaE: round(m.deltaE, 2) }),
      })),
      coverage: round(projection.coverage, 4),
      uvCoverage: round(projection.uvCoverage, 4),
      registration: Object.fromEntries(
        Object.entries(registration).map(([k, o]) => [k, round(o, 4)]),
      ),
      costUsd: round(budget.spentUsd),
    },
  };
  const step = {
    op: LOOKDEV_STEP,
    params: {
      views: LOOKDEV_VIEWS.length + LOOKDEV_DETAIL_VIEWS.length,
      seasons: plan.seasons,
      targetProfileSha256: profileSha256(profile),
    },
    engine: { name: "assetgrove-lookdev", version: "1" },
    inputs: [sourceSha256],
    outputs: [sha256(raw)],
  };
  const record: Provenance = {
    ...provenance,
    models: [...new Set([...provenance.models, ...caller.records.map((c) => c.model)])],
    requestIds: [...provenance.requestIds, ...caller.records.map((c) => c.requestId)],
    providerTerms: [
      ...new Set([
        ...provenance.providerTerms,
        ...caller.records.flatMap((c) => (c.providerTerms !== undefined ? [c.providerTerms] : [])),
      ]),
    ],
    referenceHashes: [
      ...new Set([...provenance.referenceHashes, ...references.map((r) => r.sha256)]),
    ],
    parameters,
    calls,
    costUsd: round((provenance.costUsd ?? 0) + budget.spentUsd),
    finishedAt: now().toISOString(),
    ...(outputGrant && { outputGrant }),
    ...(identity && { identity }),
    ...(options.promptPolicy && { promptPolicy: options.promptPolicy }),
    digitalSourceType,
    steps: [...(provenance.steps ?? []), step, metadataStep(digitalSourceType, [])],
  };

  const p = provenance.parameters as Record<string, unknown>;
  const rigParams = p["rig"] as { gaits?: unknown; fit?: { bodyLengthM?: number } } | undefined;
  const bodyLengthM = rigParams?.fit?.bodyLengthM;
  const assetExtras = written.json.asset.extras as Record<string, unknown> | undefined;
  const fields: Record<string, unknown> = {
    triangles: measures.triangles,
    textureMaxPx: measures.textureMaxPx,
    materials: measures.materials,
    bones: measures.bones,
    lods: measures.lods,
    clips: clips(written).map((c) => {
      const extras = (written.json.animations?.[c.index]?.["extras"] ?? {}) as Record<
        string,
        unknown
      >;
      const gait = rig?.gaits[c.name];
      return {
        name: c.name,
        durationMs: Math.round(c.durationS * 1000),
        loop: extras["loop"] === true,
        ...(extras["generated"] === true && { generated: true }),
        ...(extras["generated"] === true &&
          gait &&
          bodyLengthM !== undefined && {
            speedMps: round(gait.speedBodyLengthsPerSecond * bodyLengthM),
          }),
        // A declared motion stays put, as `rig` and `stage` report it.
        ...(extras["generated"] === true && !gait && rig?.motions[c.name] && { speedMps: 0 }),
      };
    }),
    ...(p["missingClips"] !== undefined && { missingClips: p["missingClips"] }),
    bounds: { min: framing.min.map((v) => round(v)), max: framing.max.map((v) => round(v)) },
    ...(assetExtras?.["rig"] !== undefined && { rig: assetExtras["rig"] }),
    ...(p["gait"] !== undefined && { gait: p["gait"] }),
    ...(identity && { identity }),
  };

  const passed = qaPassed(reasons);
  const run: RunRecord = {
    runId,
    runDir,
    ...(options.promptPolicy && { promptPolicy: options.promptPolicy }),
    createdAt: now().toISOString(),
    spec,
    specDir: resolve(options.specDir),
    profile,
    bibleVersion: bible.version,
    capUsd: plan.capUsd,
    estimateUsd: plan.estimateUsd,
    spentUsd: round(budget.spentUsd),
    requested: 1,
    candidates: [],
    filtered: passed ? 0 : 1,
    errors: [],
    filtering: [markingsState],
  };
  if (passed) {
    const file = `${id}.glb`;
    await writeFile(join(runDir, file), bytes);
    run.candidates.push({
      id,
      file,
      mediaType: GLB_MEDIA_TYPE,
      extension: "glb",
      sha256: sha256(bytes),
      reasons,
      fields,
      provenance: record,
      artifacts: artifactNames,
      sidecars: stagedSidecars,
    });
  } else {
    run.rejections = [
      { candidate: 1, reasons, costUsd: round(budget.spentUsd), artifacts: artifactNames },
    ];
  }
  await writeRun(runDir, run);
  return { run, runDir, passed, plan };
}
