/**
 * Shared types of animation QA (PRD §5.2): motion templates, thresholds, per-frame measures,
 * check results, flicker decisions and per-frame fixes. Templates and thresholds are data: a
 * target adds or overrides them in its target profile's `animation` field.
 */
import type { Point, Reason, Size } from "../types.ts";

/** A named moment of the cycle. */
export interface MotionBeat {
  /** For example "contact-left", "passing", "down", "up", "bite", "hold". */
  name: string;
  /** Where the beat falls in the cycle, 0 (first frame) to 1 (exclusive end); maps to frame round(at × count) mod count. */
  at: number;
  /** The feet touch the ground line on this beat. */
  contact?: boolean;
}

/** One family's motion template, as data. */
export interface MotionTemplate {
  /** The family name it serves; also matches `<name>-<suffix>` families (walk → walk-right). */
  name: string;
  description?: string;
  /** The cycle loops: the last frame must flow into the first. */
  loop: boolean;
  /** Allowed frame counts, inclusive. */
  frames: { min: number; max: number };
  /** Allowed cycle length in ms (frame count × frame duration), inclusive, when given. */
  cycleMs?: { min: number; max: number };
  beats: MotionBeat[];
  /**
   * Which frames must keep the feet on the ground line: every frame (`all`, a walk), the beats
   * marked `contact` (`beats`), or none (`none`, a jump or a climb).
   */
  contact: "all" | "beats" | "none";
  /** Allowed silhouette change between consecutive frames, as 1 − IoU of their alpha masks. */
  silhouette: { min: number; max: number };
  /**
   * How the footprint behaves. `planted` (the default): the feet stay put, so every planted
   * frame's footprint is checked against the previous planted frame's. `moving`: the contacts move by design (a
   * walk's legs alternate, a hop crouches and lands), so each planted frame is checked against
   * its own phase: the same frame of the cycle's first stride when `strides` is 2 or more, else
   * the loop's mean footprint.
   */
  footprint?: "planted" | "moving";
  /**
   * How many times the contact pattern repeats in one cycle (a walk: 2, one stride per leg).
   * Frames a whole stride apart share a phase. Default 1. Used by `footprint: "moving"`.
   */
  strides?: number;
  /** Overrides the footprint drift bound for this family, as a fraction of the figure's height (0..1). */
  footprintDrift?: number;
  /**
   * Where a frame's footprint is measured. Unset: the span of the bottom two rows (one foot, the
   * lowest). Set: the centre of the pixels in the bottom `footprintBand` of the figure's height
   * (0..1), so every foot near the ground counts, which suits a gait with several feet down at once.
   */
  footprintBand?: number;
  /**
   * The footprint rule per gait, by gait name (for example `quadruped`). The gait comes from the
   * asset spec's `gait`, else the profile's `animation.gait`; its entry overrides this template's
   * footprint fields. No gait, or one the template does not list, keeps the template's own.
   */
  gaits?: Record<string, GaitRule>;
}

/** A gait's footprint rule: the template's footprint fields it overrides. */
export type GaitRule = Partial<
  Pick<MotionTemplate, "footprint" | "strides" | "footprintDrift" | "footprintBand">
>;

/** Bounds of the deterministic checks and the flicker cutoff. All optional in the profile. */
export interface AnimationThresholds {
  /**
   * How far a contact frame's baseline may sit from the ground line (anchor.y), as a fraction of
   * the strip's figure height (the median of baseline − top + 1). Default 0.02.
   */
  groundTolerance: number;
  /**
   * How far a planted footprint's centre may move between consecutive planted frames (or, for a
   * moving footprint, from its own phase's), as a fraction of the figure's height. Default 0.03.
   */
  footprintDrift: number;
  /** The last→first frame distance may be at most this × the largest consecutive distance. Default 1.5. */
  loopSeamRatio: number;
  /**
   * The smallest "largest consecutive distance" the seam bound uses, so a strip that barely
   * moves (an idle hold) is not failed for a seam step of noise. Default 0.02.
   */
  loopSeamFloor: number;
  /**
   * The identity-flicker decision's probability at or above which the pair fails. Default 0.5:
   * the Boolean's own answer, until a cut is chosen per model from the logged decisions.
   */
  flickerCutoff: number;
  /**
   * The share of a frame's soft edge pixels (0 < alpha < 255) whose colour is far from every
   * opaque colour near them, above which the frame has a colour halo. Default 0.22. Fully
   * transparent pixels that keep a colour are not counted: they are a passing note.
   */
  edgeHaloShare: number;
  /**
   * Where no image before background removal exists: the smallest see-through area inside the
   * figure's outline that the holes check judges, as a share of the frame's figure area (pixels
   * at or above the alpha cut), and at least 1 px. Default 0.001.
   */
  holeMinShare: number;
  /** The holes decision's probability at or above which the frame fails. Default 0.5. */
  holeCutoff: number;
}

/** The target profile's optional `animation` field. */
export interface AnimationProfile {
  /**
   * The target's default gait (for example `quadruped` for a world of four-legged animals); an
   * asset spec's `gait` overrides it. It picks each template's rule under `gaits`.
   */
  gait?: string;
  /** Templates the target adds (sleep, groom, climb, converse) or overrides, by name. */
  templates?: MotionTemplate[];
  thresholds?: Partial<AnimationThresholds>;
}

/** What is measured on one frame of a strip. */
export interface AnimationFrameMeasure {
  /** 1-based position in the strip. */
  frame: number;
  /** Lowest row at or above the alpha threshold, or -1 for an empty frame. */
  baseline: number;
  /** Highest row at or above the alpha threshold, or -1 for an empty frame. */
  top: number;
  centerX: number;
  centerY: number;
  /** Visible pixels at or above the alpha threshold. */
  area: number;
  /** Horizontal span of the bottom rows at the baseline, [left, right] inclusive, when any. */
  footprint?: [number, number];
}

/** A strip as animation QA sees it. */
export interface StripInput {
  /** RGBA strip, frames side by side. */
  frames: import("../image/raster.ts").Raster[];
  frame: Size;
  anchor: Point;
  family: string;
  /** Frame duration in ms, when known (the profile's `frames.durationMs`). */
  durationMs?: number;
  /** The subject's gait, from the asset spec; the profile's `animation.gait` when unset. */
  gait?: string;
}

/** The animation QA report of one strip. Each reason's text names the frame(s). */
export interface AnimationReport {
  family: string;
  /** The matched template's name, or undefined when none matched. */
  template?: string;
  /** The gait the checks used, when one was declared. */
  gait?: string;
  frameCount: number;
  /** The strip's figure height in px: the median over non-empty frames of baseline − top + 1; 0 when all are empty. */
  figureHeightPx: number;
  passed: boolean;
  reasons: AnimationReason[];
  measures: AnimationFrameMeasure[];
  /** Consecutive distances: distances[i] is between frame i+1 and i+2 (1-based); the seam last. */
  silhouetteChange: number[];
  thresholds: AnimationThresholds;
}

export interface AnimationReason extends Reason {
  /** The 1-based frames the reason is about. */
  frames?: number[];
}

/** One logged identity-flicker decision (one typed Boolean decision on a pair). */
export interface FlickerDecision {
  /** 1-based frames compared, in order. */
  pair: [number, number];
  model: string;
  requestId: string;
  /** The decision's answer: `flicker` when the identity changes (probability at least 0.5). */
  label: "same" | "flicker";
  /** The decision's probability that the identity changes, 0..1. */
  probability: number;
  cutoff: number;
  /** True when the pair fails: probability at or above the cutoff. */
  flagged: boolean;
  reason: string;
  costUsd: number;
  at: string;
}

/** One logged holes decision (one typed Boolean decision on one frame). */
export interface HoleDecision {
  /** The 1-based frame judged. */
  frame: number;
  /**
   * `before-after`: the frame before and after background removal was shown; `enclosed`: only the
   * removed frame, its see-through areas inside the outline marked.
   */
  view: "before-after" | "enclosed";
  /** The see-through areas inside its outline that were marked for the model (`enclosed` only). */
  areas: Array<{ area: number; x: number; y: number; width: number; height: number }>;
  model: string;
  requestId: string;
  /** The decision's answer: `holes` when part of the character is missing (probability at least 0.5). */
  label: "holes" | "none";
  /** The decision's probability that part of the character is missing, 0..1. */
  probability: number;
  cutoff: number;
  /** True when the frame fails: probability at or above the cutoff. */
  flagged: boolean;
  reason: string;
  costUsd: number;
  at: string;
}
