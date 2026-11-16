/**
 * Measures how stable the image QA vision checks are on the default vision model. Each check of the
 * vision verdict (src/qa.ts) judges synthetic sprite strips drawn in code, some of them faulty, and
 * every case is judged several times; a check's agreement is the share of cases on which every
 * repeat gave the same verdict. Each strip is labelled, per check, with whether the check should
 * pass it (known from how the strip was drawn): a case counts as a false pass or a false fail when
 * any repeat gave the wrong answer. A check no strip is faulty for (identity, perspective) has no
 * should-fail cases, so its entry is written but never qualifies.
 *
 * Set AI_GATEWAY_API_KEY (the test skips without it) and optionally:
 * - QA_STABILITY_CASES: distinct strips (default 60: 15 faulty for each of the two faults, the
 *   minimum of each class for a check to filter);
 * - QA_STABILITY_REPEATS: times each strip is judged (default 3, the minimum);
 * - QA_STABILITY_STATE: the file the cases judged so far are kept in between runs (default
 *   `qa-stability.json` in the real-check ledger directory);
 * - QA_STABILITY_OUT: a file the measured entries are written to as a JSON array.
 * Calls run through the product's spend controls (test/real/budget.ts). Before any call the check
 * forecasts its whole spend, cases x repeats x the vision route's estimate, and sizes this run's
 * batch of cases so its forecast fits what is left of the 1.50 USD run cap and of the budget; it
 * refuses when not one case fits. 60 cases x 3 repeats do not fit one run cap, so the cases judged
 * in full are kept in the state file and the next run continues from them; the entries are made
 * once every case is judged, and the state file is then removed. Run with `pnpm test:real`.
 *
 * The entries are printed, never applied: a person lands them in src/qa/stability.json by a PR.
 * This test never edits src.
 */
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetExceededError } from "../../src/budget.ts";
import { createRaster, encodePng, setPixel, type Raster } from "../../src/image/raster.ts";
import { buildVisionPrompt, parseVisionVerdict, VISION_CHECKS } from "../../src/qa.ts";
import {
  IMAGE_QA_CHECKS,
  MIN_CLASS_CASES,
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

/** Which check each kind of case is faulty for; every other check should pass it. */
const FAULTS = { opaque: "transparency", empty: "frame-count" } as const;

/** Of every four cases, two are clean, one has an opaque background and one an empty frame. */
function faultOf(i: number): keyof typeof FAULTS | undefined {
  return i % 4 === 1 ? "opaque" : i % 4 === 3 ? "empty" : undefined;
}

/** Whether `check` should pass case `i`, known from how the case is drawn. */
function shouldPass(i: number, check: string): boolean {
  const fault = faultOf(i);
  return fault === undefined || FAULTS[fault] !== check;
}

function drawCase(i: number): Case {
  const frameCount = 2 + (i % 3);
  const strip = createRaster(FRAME * frameCount, FRAME);
  const fault = faultOf(i);
  for (let f = 0; f < frameCount; f++) {
    if (fault === "empty" && f === 1) continue;
    drawShape(strip, f * FRAME, i, f % 2);
  }
  if (fault === "opaque") {
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
    const cases = count("QA_STABILITY_CASES", 4 * MIN_CLASS_CASES);
    const repeats = count("QA_STABILITY_REPEATS", MIN_REPEATS);
    const model = defaultRoutes.vision.model;

    const rb = realBudget();
    const gateway = rb.provider("vercel-ai-gateway");
    const perCase = repeats * defaultRoutes.vision.estimatedCostUsd;

    const checks = IMAGE_QA_CHECKS.filter((c) => c.modelBacked && c.source === "vision");
    assert.deepEqual(
      checks.map((c) => c.id),
      [...VISION_CHECKS],
    );
    /** Per check, per completed case: whether every repeat gave the same `passed`. */
    let agreed: Record<string, boolean[]> = Object.fromEntries(checks.map((c) => [c.id, []]));
    /** Per check, per completed case: whether any repeat contradicted the case's label. */
    let wrong: Record<string, boolean[]> = Object.fromEntries(checks.map((c) => [c.id, []]));
    const statePath = process.env["QA_STABILITY_STATE"] ?? join(rb.ledgerDir, "qa-stability.json");
    const key = {
      labelled: 1,
      model,
      repeats,
      versions: checks.map((c) => `${c.id}@${c.version}`),
    };
    try {
      const saved = JSON.parse(await readFile(statePath, "utf8")) as {
        key?: unknown;
        agreed?: Record<string, boolean[]>;
        wrong?: Record<string, boolean[]>;
      };
      if (JSON.stringify(saved.key) === JSON.stringify(key) && saved.agreed && saved.wrong) {
        agreed = saved.agreed;
        wrong = saved.wrong;
      }
    } catch {
      /* No state yet: start from the first case. */
    }
    const done = agreed[checks[0]!.id]!.length;

    // The whole measurement's forecast, and this run's batch sized so its forecast fits.
    const left = Math.max(0, cases - done);
    console.log(
      `forecast: ${left} case(s) left x $${perCase.toFixed(4)} = $${(left * perCase).toFixed(4)}`,
    );
    const fits = Math.floor((Math.min(rb.runLeftUsd(), rb.budgetLeftUsd()) + 1e-9) / perCase);
    const batch = Math.min(left, fits);
    // Refuses before any call when not one case fits (a forecast above the run cap or budget left).
    const { caller } = rb.caller(gateway, Math.max(batch, 1) * perCase, "qa stability");

    try {
      for (let i = done; i < done + batch; i++) {
        const c = drawCase(i);
        const prompt = buildVisionPrompt({
          subject: SUBJECT,
          frameCount: c.frameCount,
          frame: { width: FRAME, height: FRAME },
          referenceRoles: [c.reference.role],
        });
        const verdicts: Map<string, boolean>[] = [];
        for (let r = 0; r < repeats; r++) {
          const text = await rb.cleared("qa stability", () =>
            caller.vision("vision", prompt, [c.candidate, c.reference]),
          );
          verdicts.push(new Map(parseVisionVerdict(text).map((x) => [x.check, x.passed])));
        }
        for (const check of checks) {
          const first = verdicts[0]?.get(check.id);
          agreed[check.id]!.push(verdicts.every((v) => v.get(check.id) === first));
          const should = shouldPass(i, check.id);
          wrong[check.id]!.push(verdicts.some((v) => v.get(check.id) !== should));
        }
      }
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      console.log(`stopped at the budget: ${error.message}`);
    }
    console.log(`budget left: $${rb.budgetLeftUsd().toFixed(4)}`);

    const completed = agreed[checks[0]!.id]!.length;
    if (completed < cases) {
      await writeFile(statePath, `${JSON.stringify({ key, agreed, wrong })}\n`);
      console.log(
        `judged ${completed} of ${cases} cases; the next run continues from ${statePath}`,
      );
      return;
    }
    await rm(statePath, { force: true });
    const measuredAt = new Date().toISOString();
    const entries: StabilityEntry[] = checks.map((check) => {
      const should = Array.from({ length: completed }, (_, i) => shouldPass(i, check.id));
      const miss = (label: boolean) =>
        should.filter((s, i) => s === label && wrong[check.id]![i]).length;
      return {
        checkId: check.id,
        version: check.version,
        model,
        cases: completed,
        passCases: should.filter(Boolean).length,
        failCases: should.filter((s) => !s).length,
        falsePasses: miss(false),
        falseFails: miss(true),
        repeats,
        // Rounded down, so rounding never lifts a check over the bar.
        agreement: Math.floor((agreed[check.id]!.filter(Boolean).length / completed) * 1000) / 1000,
        measuredAt,
      };
    });
    for (const e of entries) {
      console.log(`${JSON.stringify(e)} qualifies: ${qualifies(e)}`);
      assert.ok(e.checkId && e.version && e.model);
      assert.equal(e.cases, e.passCases + e.failCases);
      assert.ok(e.agreement >= 0 && e.agreement <= 1);
      assert.ok(!Number.isNaN(Date.parse(e.measuredAt)));
    }
    const out = process.env["QA_STABILITY_OUT"];
    if (out) await writeFile(out, `${JSON.stringify(entries, null, 2)}\n`);
  },
);
