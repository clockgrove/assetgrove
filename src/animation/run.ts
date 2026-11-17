/**
 * Animation QA of one strip, end to end: the deterministic pixel checks against the family's
 * motion template, the optional identity-flicker and holes decisions, and the onion-skin sheet
 * and looping preview the person picking looks at.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Caller } from "../calls.ts";
import { InputError } from "../errors.ts";
import { encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { DIGITAL_SOURCE_TYPES, embedDigitalSourceType } from "../metadata.ts";
import type { DigitalSourceType } from "../metadata.ts";
import { applyStability, ANIMATION_VISION_CHECKS, filteringState } from "../qa/stability.ts";
import type { FilteringState } from "../qa/stability.ts";
import type { Routes } from "../routes.ts";
import type { ResolvedStyle } from "../style.ts";
import type { Point, Size, TargetProfile } from "../types.ts";
import { appendDecisionLog, checkFlicker } from "./flicker.ts";
import { clearTransparentColour } from "./halo.ts";
import { checkHoles } from "./holes.ts";
import type { HoleSource } from "./holes.ts";
import { loopPreview, onionSkinSheet, PREVIEW_MEDIA_TYPES } from "./preview.ts";
import { animationQa } from "./qa.ts";
import { measureThreshold, splitStrip } from "./strip.ts";
import { templateFor, templatesFor, thresholdsFor } from "./templates.ts";
import type { AnimationReport, FlickerDecision, HoleDecision } from "./types.ts";

export const DEFAULT_DURATION_MS = 120;
export const FLICKER_LOG = "flicker.jsonl";

/** The bottom centre of the frame, as the sheet import's default anchor. */
export function defaultAnchor(frame: Size): Point {
  return { x: Math.floor(frame.width / 2), y: frame.height - 1 };
}

/** The profile's frame size. */
export function profileFrame(profile: TargetProfile): Size {
  return { width: profile.frames.width, height: profile.frames.height };
}

/** Whether the family's cycle loops: its template's say, or a loop when no template matches. */
export function familyLoops(family: string, profile: TargetProfile): boolean {
  return templateFor(family, templatesFor(profile))?.loop ?? true;
}

export interface Previews {
  onion: Uint8Array;
  preview: Uint8Array;
}

/** The onion-skin sheet (PNG) and the looping preview (animated WebP) of a strip's frames. */
export function renderPreviews(
  frames: Raster[],
  options: {
    anchor: Point;
    loop: boolean;
    durationMs: number;
    report?: AnimationReport;
    digitalSourceType?: DigitalSourceType;
  },
): Previews {
  const flagged = [
    ...new Set(
      (options.report?.reasons ?? []).filter((r) => !r.passed).flatMap((r) => r.frames ?? []),
    ),
  ].sort((a, b) => a - b);
  const origin = options.digitalSourceType ?? DIGITAL_SOURCE_TYPES.undeclared;
  const onion = encodePng(
    onionSkinSheet(frames, { anchor: options.anchor, loop: options.loop, flagged }),
  );
  return {
    onion: embedDigitalSourceType(onion, PREVIEW_MEDIA_TYPES.onion, origin),
    preview: embedDigitalSourceType(
      loopPreview(frames, { durationMs: options.durationMs }),
      PREVIEW_MEDIA_TYPES.preview,
      origin,
    ),
  };
}

export interface StripQaOptions {
  strip: Raster;
  family: string;
  profile: TargetProfile;
  style: ResolvedStyle;
  /** Defaults to the profile's frame size. */
  frame?: Size;
  /** Defaults to the bottom centre of the frame. */
  anchor?: Point;
  /** Defaults to the profile's frame duration, else 120 ms. */
  durationMs?: number;
  /** The subject's gait from its asset spec; defaults to the profile's `animation.gait`. */
  gait?: string;
  /** Where the report, the previews and the flicker log are written. */
  outDir: string;
  /** Embedded in the previews when known. */
  digitalSourceType?: DigitalSourceType;
  /**
   * Per strip frame, its image before background removal and the same crop after it, where one
   * exists (a sheet import's frames): the holes decision is then asked on every such frame.
   */
  holeSources?: ReadonlyArray<HoleSource | undefined>;
  /**
   * Runs the model-backed checks (identity flicker per pair, and holes on frames with an image
   * before background removal or a see-through area inside the outline) through this caller;
   * omitted, both are skipped.
   */
  vision?: {
    call: Caller;
    /** The caller's routes: the model each vision check runs on decides whether it filters. */
    routes: Routes;
    subject: string;
    subjectDescription?: string;
    now?: () => Date;
  };
}

export interface StripQaResult {
  report: AnimationReport & {
    identityFlicker: "checked" | "skipped";
    holes: "checked" | "skipped";
    /**
     * Whether identity flicker and holes filtered (when checked): only where measured stable on
     * the run's model; otherwise advisory, their reasons marked `shadow`, with the cause.
     */
    filtering?: FilteringState[];
  };
  decisions: FlickerDecision[];
  holeDecisions: HoleDecision[];
  files: { report: string; onion: string; preview: string; flickerLog?: string };
}

/**
 * Runs the deterministic checks, then (when a caller is given) the identity-flicker check, and
 * writes `<family>.qa.json`, `<family>.onion.png` and `<family>.webp` into the output directory.
 */
export async function qaStrip(options: StripQaOptions): Promise<StripQaResult> {
  const { profile, style, family } = options;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(family)) {
    throw new InputError(`invalid family name "${family}"`);
  }
  const frame = options.frame ?? profileFrame(profile);
  const anchor = options.anchor ?? defaultAnchor(frame);
  if (anchor.x < 0 || anchor.x >= frame.width || anchor.y < 0 || anchor.y >= frame.height) {
    throw new InputError(`anchor ${anchor.x},${anchor.y} lies outside the frame`);
  }
  const durationMs = options.durationMs ?? profile.frames.durationMs ?? DEFAULT_DURATION_MS;
  const split = splitStrip(options.strip, frame);
  // Validate templates and thresholds before any spend.
  thresholdsFor(profile);
  // Measured on the strip as given, so a colour kept under alpha 0 is reported (a note)...
  const base = animationQa(
    {
      frames: split,
      frame,
      anchor,
      family,
      durationMs,
      ...(options.gait !== undefined && { gait: options.gait }),
    },
    profile,
    style,
  );
  const loop = familyLoops(family, profile);
  // ...and cleared before the vision checks and previews, as writing the strip would clear it.
  const frames = split.map(clearTransparentColour);

  let decisions: FlickerDecision[] = [];
  let holeDecisions: HoleDecision[] = [];
  let report: StripQaResult["report"] = { ...base, identityFlicker: "skipped", holes: "skipped" };
  if (options.vision) {
    const flicker = await checkFlicker({
      frames,
      family,
      subject: options.vision.subject,
      ...(options.vision.subjectDescription !== undefined && {
        subjectDescription: options.vision.subjectDescription,
      }),
      loop,
      cutoff: base.thresholds.flickerCutoff,
      call: options.vision.call,
      ...(options.vision.now !== undefined && { now: options.vision.now }),
    });
    decisions = flicker.decisions;
    const holes = await checkHoles({
      frames,
      family,
      subject: options.vision.subject,
      threshold: measureThreshold(style),
      minShare: base.thresholds.holeMinShare,
      cutoff: base.thresholds.holeCutoff,
      ...(options.holeSources !== undefined && { sources: options.holeSources }),
      call: options.vision.call,
      ...(options.vision.now !== undefined && { now: options.vision.now }),
    });
    holeDecisions = holes.decisions;
    // The vision checks filter only where measured stable on the run's model.
    const vision = applyStability([...flicker.reasons, ...holes.reasons], options.vision.routes, {
      checks: ANIMATION_VISION_CHECKS,
    });
    const reasons = [...base.reasons, ...vision.reasons];
    report = {
      ...base,
      reasons,
      passed: reasons.every((r) => r.passed || r.shadow),
      identityFlicker: "checked",
      holes: "checked",
      filtering: ANIMATION_VISION_CHECKS.map(
        (check) =>
          vision.filtering.find((f) => f.check === check.id) ??
          filteringState(check, options.vision!.routes[check.operation!]?.model),
      ),
    };
  }

  await mkdir(options.outDir, { recursive: true });
  const previews = renderPreviews(frames, {
    anchor,
    loop,
    durationMs,
    report,
    ...(options.digitalSourceType !== undefined && {
      digitalSourceType: options.digitalSourceType,
    }),
  });
  const files: StripQaResult["files"] = {
    report: join(options.outDir, `${family}.qa.json`),
    onion: join(options.outDir, `${family}.onion.png`),
    preview: join(options.outDir, `${family}.webp`),
  };
  await writeFile(files.onion, previews.onion);
  await writeFile(files.preview, previews.preview);
  await writeFile(
    files.report,
    `${JSON.stringify({ ...report, decisions, holeDecisions }, null, 2)}\n`,
  );
  if (decisions.length > 0) {
    files.flickerLog = join(options.outDir, FLICKER_LOG);
    await appendDecisionLog(files.flickerLog, decisions);
  }
  return { report, decisions, holeDecisions, files };
}

/** The human lines of a report: the verdict, then each failed check (each names its frames). */
export function formatReport(report: StripQaResult["report"]): string[] {
  const failed = report.reasons.filter((r) => !r.passed && !r.shadow);
  const advisory = report.reasons.filter((r) => !r.passed && r.shadow);
  const lines = [
    `${report.family}: ${report.frameCount} frames, template ${report.template ?? "none"}` +
      (report.gait !== undefined ? `, gait ${report.gait}` : "") +
      ", " +
      (report.passed ? "all checks passed" : `${failed.length} check(s) failed`) +
      (report.identityFlicker === "skipped" ? " (identity flicker and holes not checked)" : ""),
  ];
  for (const r of failed) lines.push(`  ${r.check} [${r.source}]: ${r.reason}`);
  // An advisory check is recorded beside QA: its verdict is shown, but it filtered nothing.
  for (const r of advisory)
    lines.push(`  ${r.check} [${r.source}; failed, not filtered]: ${r.reason}`);
  return lines;
}
