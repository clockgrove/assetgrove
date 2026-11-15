/**
 * Measures how stable the image QA vision checks are on the default vision model. Each check of the
 * vision verdict (src/qa.ts) judges synthetic sprite strips drawn in code, some of them faulty, and
 * every case is judged several times; a check's agreement is the share of cases on which every
 * repeat gave the same verdict.
 *
 * Set AI_GATEWAY_API_KEY (the test skips without it) and optionally:
 * - QA_STABILITY_CASES: distinct strips (default 30, the minimum for a check to filter);
 * - QA_STABILITY_REPEATS: times each strip is judged (default 3, the minimum);
 * - QA_STABILITY_OUT: a file the measured entries are written to as a JSON array.
 * Calls run through the product's spend controls (test/real/budget.ts): each reserves the route's
 * estimate against the 1.50 USD run cap, and measuring stops at the cap, keeping the cases judged in
 * full. Run with `pnpm test:real`.
 *
 * The entries are printed, never applied: a person lands them in src/qa/stability.json by a PR.
 * This test never edits src.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { BudgetExceededError } from "../../src/budget.ts";
import { createRaster, encodePng, setPixel, type Raster } from "../../src/image/raster.ts";
import { buildVisionPrompt, parseVisionVerdict, VISION_CHECKS } from "../../src/qa.ts";
import {
  IMAGE_QA_CHECKS,
  MIN_CASES,
  MIN_REPEATS,
  qualifies,
  type StabilityEntry,
} from "../../src/qa/stability.ts";
import { sha256 } from "../../src/request.ts";
import { defaultRoutes } from "../../src/routes.ts";
import type { LoadedReference } from "../../src/types.ts";
import { realBudget, skipWithout } from "./budget.ts";

const skip = skipWithout("AI_GATEWAY_API_KEY");
const FRAME = 32;
const SUBJECT = "a coloured shape";

function count(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  assert.ok(Number.isInteger(n) && n > 0, `${name} must be a positive integer`);
  return n;
}

const COLOURS = [
  [200, 40, 40],
  [40, 160, 60],
  [50, 90, 210],
  [220, 180, 30],
  [150, 60, 190],
] as const;

function drawShape(r: Raster, left: number, i: number, shift: number): void {
  const colour = COLOURS[i % COLOURS.length]!;
  const round = i % 2 === 0;
  const cx = left + FRAME / 2;
  const cy = FRAME / 2 + shift;
  for (let y = 0; y < FRAME; y++) {
    for (let x = left; x < left + FRAME; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const inside = round ? dx * dx + dy * dy <= 100 : Math.abs(dx) <= 9 && Math.abs(dy) <= 9;
      if (inside) setPixel(r, x, y, [...colour, 255]);
    }
  }
}

interface Case {
  frameCount: number;
  candidate: LoadedReference;
  reference: LoadedReference;
}

function png(role: string, r: Raster): LoadedReference {
  const bytes = encodePng(r);
  return { role, path: `(${role})`, mediaType: "image/png", bytes, sha256: sha256(bytes) };
}

/** Every third case is faulty: an opaque background, or one empty frame. */
function drawCase(i: number): Case {
  const frameCount = 2 + (i % 3);
  const strip = createRaster(FRAME * frameCount, FRAME);
  const faulty = i % 3 === 2;
  for (let f = 0; f < frameCount; f++) {
    if (faulty && i % 2 === 1 && f === 1) continue;
    drawShape(strip, f * FRAME, i, f % 2);
  }
  if (faulty && i % 2 === 0) {
    for (let y = 0; y < strip.height; y++) {
      for (let x = 0; x < strip.width; x++) {
        if (strip.data[(y * strip.width + x) * 4 + 3] === 0) {
          setPixel(strip, x, y, [235, 235, 235, 255]);
        }
      }
    }
  }
  const reference = createRaster(FRAME, FRAME);
  drawShape(reference, 0, i, 0);
  return { frameCount, candidate: png("candidate", strip), reference: png("character", reference) };
}

test(
  "QA stability: the image QA vision checks, repeated on synthetic strips",
  { skip },
  async () => {
    const cases = count("QA_STABILITY_CASES", MIN_CASES);
    const repeats = count("QA_STABILITY_REPEATS", MIN_REPEATS);
    const model = defaultRoutes.vision.model;

    const rb = realBudget();
    const gateway = rb.provider("vercel-ai-gateway");
    const { caller } = rb.caller(gateway, defaultRoutes.vision.estimatedCostUsd, "qa stability");

    const checks = IMAGE_QA_CHECKS.filter((c) => c.modelBacked && c.source === "vision");
    assert.deepEqual(
      checks.map((c) => c.id),
      [...VISION_CHECKS],
    );
    /** Per check, per completed case: whether every repeat gave the same `passed`. */
    const agreed: Record<string, boolean[]> = Object.fromEntries(checks.map((c) => [c.id, []]));

    try {
      for (let i = 0; i < cases; i++) {
        const c = drawCase(i);
        const prompt = buildVisionPrompt({
          subject: SUBJECT,
          frameCount: c.frameCount,
          frame: { width: FRAME, height: FRAME },
          referenceRoles: [c.reference.role],
        });
        const verdicts: Map<string, boolean>[] = [];
        for (let r = 0; r < repeats; r++) {
          const text = await caller.vision("vision", prompt, [c.candidate, c.reference]);
          verdicts.push(new Map(parseVisionVerdict(text).map((x) => [x.check, x.passed])));
        }
        for (const check of checks) {
          const first = verdicts[0]?.get(check.id);
          agreed[check.id]!.push(verdicts.every((v) => v.get(check.id) === first));
        }
      }
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      console.log(`stopped at the budget: ${error.message}`);
    }

    const completed = agreed[checks[0]!.id]!.length;
    assert.ok(completed > 0, "no case was judged in full");
    const measuredAt = new Date().toISOString();
    const entries: StabilityEntry[] = checks.map((check) => ({
      checkId: check.id,
      version: check.version,
      model,
      cases: completed,
      repeats,
      // Rounded down, so rounding never lifts a check over the bar.
      agreement: Math.floor((agreed[check.id]!.filter(Boolean).length / completed) * 1000) / 1000,
      measuredAt,
    }));
    for (const e of entries) {
      console.log(`${JSON.stringify(e)} qualifies: ${qualifies(e)}`);
      assert.ok(e.checkId && e.version && e.model);
      assert.equal(e.cases, completed);
      assert.ok(e.agreement >= 0 && e.agreement <= 1);
      assert.ok(!Number.isNaN(Date.parse(e.measuredAt)));
    }
    const out = process.env["QA_STABILITY_OUT"];
    if (out) await writeFile(out, `${JSON.stringify(entries, null, 2)}\n`);
    console.log(`budget left: $${rb.budgetLeftUsd().toFixed(4)}`);
  },
);
