import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Caller } from "../calls.ts";
import { ProviderError } from "../errors.ts";
import type { DecisionQuestion } from "../gateway/provider.ts";
import { encodePng, type Raster } from "../image/raster.ts";
import { sha256 } from "../request.ts";
import type { Routes } from "../routes.ts";
import type { LoadedReference } from "../types.ts";
import { flattenFrame } from "./preview.ts";
import type { AnimationReason, FlickerDecision } from "./types.ts";

/** Consecutive 1-based frame pairs, plus the seam (last, first) for a loop of more than two frames. */
export function flickerPairs(count: number, loop: boolean): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 1; i < count; i++) pairs.push([i, i + 1]);
  if (loop && count > 2) pairs.push([count, 1]);
  return pairs;
}

export function buildFlickerPrompt(input: {
  subject: string;
  family: string;
  pair: [number, number];
  subjectDescription?: string;
}): string {
  const [a, b] = input.pair;
  return [
    `Image 1 is frame ${a} and image 2 is frame ${b} of the same "${input.family}" animation of ${input.subject}.`,
    ...(input.subjectDescription ? [`The character: ${input.subjectDescription}`] : []),
    "Both frames are shown over the same plain light grey backdrop. The pose is expected to change between frames. Ignore the pose.",
    "Each frame may be painted on its own, so brush strokes, fur strands, texture grain, single small strokes or specks, and the fine, ragged edges of markings can differ between frames. That is texture, not identity.",
    "The character's identity is which markings it has, where they sit and their overall shape; its colours; its proportions; its accessories.",
  ].join("\n");
}

/** The question each pair is asked: a typed Boolean, so its probability is the model's own. */
export function flickerQuestion(pair: [number, number]): DecisionQuestion {
  const [a, b] = pair;
  return {
    type: "boolean",
    instructions: `Does the character's identity change between frame ${a} and frame ${b}, setting aside pose and brush texture?`,
    whenTrue:
      "a marking appears, disappears, moves or takes a clearly different overall shape, a colour changes, the proportions change, or an accessory changes",
    whenFalse:
      "the identity is the same; at most the pose, painterly texture or the fine edges of markings differ",
  };
}

export function planFlicker(
  count: number,
  loop: boolean,
  routes: Routes,
): { calls: number; model: string; estimatedCostUsd: number } {
  const calls = flickerPairs(count, loop).length;
  return {
    calls,
    model: routes.flicker.model,
    estimatedCostUsd: calls * routes.flicker.estimatedCostUsd,
  };
}

/**
 * The frame as the model sees it: flattened over the loop preview's neutral backdrop, so how a
 * provider treats transparent pixels (often dropping alpha and showing the colour left under a
 * matte's holes) cannot pass for a marking.
 */
function frameReference(raster: Raster, n: number): LoadedReference {
  const bytes = encodePng(flattenFrame(raster));
  return {
    role: `frame ${n}`,
    path: `frame-${n}.png`,
    mediaType: "image/png",
    bytes,
    sha256: sha256(bytes),
  };
}

export async function checkFlicker(options: {
  frames: Raster[];
  family: string;
  subject: string;
  subjectDescription?: string;
  loop: boolean;
  cutoff: number;
  call: Caller;
  now?: () => Date;
}): Promise<{ reasons: AnimationReason[]; decisions: FlickerDecision[] }> {
  const now = options.now ?? (() => new Date());
  const reasons: AnimationReason[] = [];
  const decisions: FlickerDecision[] = [];
  for (const pair of flickerPairs(options.frames.length, options.loop)) {
    const [a, b] = pair;
    const first = options.frames[a - 1];
    const second = options.frames[b - 1];
    if (!first || !second) continue;
    const prompt = buildFlickerPrompt({
      subject: options.subject,
      family: options.family,
      pair,
      ...(options.subjectDescription !== undefined && {
        subjectDescription: options.subjectDescription,
      }),
    });
    const { result, record } = await options.call.decide(
      "flicker",
      prompt,
      [frameReference(first, a), frameReference(second, b)],
      flickerQuestion(pair),
    );
    if (result.answer.type !== "boolean") {
      throw new ProviderError("the flicker decision gave no true or false");
    }
    const probability = Math.min(1, Math.max(0, result.answer.probability));
    const label = probability >= 0.5 ? "flicker" : "same";
    const flagged = probability >= options.cutoff;
    const said =
      label === "flicker"
        ? "the identity changes, setting aside pose and brush texture"
        : "the identity holds, setting aside pose and brush texture";
    decisions.push({
      pair,
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
    const p = probability.toFixed(2);
    reasons.push({
      check: "identity-flicker",
      passed: !flagged,
      source: "decision",
      frames: [a, b],
      reason: `frame ${a} → frame ${b}: ${label === "flicker" ? "flicker" : "same"} (probability ${p} ${flagged ? "≥" : "<"} cutoff ${options.cutoff}): ${said}`,
    });
  }
  return { reasons, decisions };
}

/** Appends one JSON line per decision: the logged data a later cutoff is chosen from. */
export async function appendDecisionLog(path: string, decisions: FlickerDecision[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, decisions.map((d) => `${JSON.stringify(d)}\n`).join(""));
}
