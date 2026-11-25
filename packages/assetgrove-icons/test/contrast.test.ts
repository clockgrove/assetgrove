import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundaryContrast,
  compositeOver,
  contrastRatio,
  formatRatio,
  relativeLuminance,
} from "../src/contrast.ts";
import { contrastReasons, fill, iconOutput, profileOf } from "./helpers/icons.ts";

test("relative luminance and the ratio follow WCAG 2.2", () => {
  assert.equal(relativeLuminance([0, 0, 0]), 0);
  assert.equal(relativeLuminance([255, 255, 255]), 1);
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]), 21);
  assert.equal(contrastRatio([255, 255, 255], [0, 0, 0]), 21);
  assert.equal(contrastRatio([40, 90, 200], [40, 90, 200]), 1);
  // 4.54:1 is the known ratio of #767676 on white.
  assert.equal(formatRatio(contrastRatio([0x76, 0x76, 0x76], [255, 255, 255])), "4.542");
});

test("compositing is straight-alpha over, unrounded", () => {
  assert.deepEqual(compositeOver([0, 0, 0], 255, [10, 20, 30]), [0, 0, 0]);
  assert.deepEqual(compositeOver([0, 0, 0], 0, [10, 20, 30]), [10, 20, 30]);
  const [r] = compositeOver([255, 255, 255], 51, [0, 0, 0]);
  assert.ok(Math.abs((r as number) - 51) < 1e-9);
});

test("a neighbour beyond the image is the bare background", () => {
  const filled = { width: 2, height: 2, data: new Uint8Array(16).fill(255) };
  filled.data.fill(0);
  for (let i = 3; i < 16; i += 4) filled.data[i] = 255;
  assert.equal(boundaryContrast(filled, 1, [255, 255, 255]).minimum, 21);
  assert.equal(boundaryContrast(filled, 1, [0, 0, 0]).minimum, 1);
  assert.equal(boundaryContrast(filled, 1, [0, 0, 0]).pairs, 8);
});

test("an icon with good contrast to a light and a dark background passes on both", async () => {
  const icon = iconOutput(8, (r) => fill(r, 2, 6, [0x5c, 0x8a, 0x4d, 255]));
  const reasons = await contrastReasons(icon, profileOf(["#ffffff", "#1d2b35"]));
  assert.equal(reasons.length, 2);
  for (const r of reasons) {
    assert.equal(r.check, "icons:boundary-contrast");
    assert.equal(r.source, "deterministic");
    assert.equal(r.passed, true, r.reason);
    assert.match(r.reason, /at least 3:1$/);
  }
  assert.match(reasons[0]!.reason, /#ffffff is \d+\.\d{3}:1/);
  assert.match(reasons[1]!.reason, /#1d2b35 is \d+\.\d{3}:1/);
});

test("an icon failing on one background names it and its ratio", async () => {
  const icon = iconOutput(8, (r) => fill(r, 2, 6, [0x2b, 0x2b, 0x2b, 255]));
  const reasons = await contrastReasons(icon, profileOf(["#ffffff", "#1d2b35"]));
  assert.equal(reasons[0]?.passed, true, reasons[0]?.reason);
  const failed = reasons[1]!;
  assert.equal(failed.passed, false);
  const ratio = contrastRatio([0x2b, 0x2b, 0x2b], [0x1d, 0x2b, 0x35]);
  assert.equal(failed.reason, `boundary contrast on #1d2b35 is ${formatRatio(ratio)}:1, below 3:1`);
});

test("a ratio of 2.999 fails", async () => {
  const fg = [119, 159, 117] as const;
  const ratio = contrastRatio(fg, [255, 255, 255]);
  assert.ok(ratio >= 2.999 && ratio < 3, String(ratio));
  const icon = iconOutput(8, (r) => fill(r, 2, 6, [...fg, 255]));
  const [reason] = await contrastReasons(icon, profileOf(["#ffffff"]));
  assert.equal(reason?.passed, false);
  assert.equal(reason?.reason, "boundary contrast on #ffffff is 2.999:1, below 3:1");
});

test("a soft alpha edge is judged at the profile's threshold", async () => {
  // A black core ringed by near-invisible white at alpha 100.
  const icon = iconOutput(8, (r) => {
    fill(r, 1, 7, [255, 255, 255, 100]);
    fill(r, 2, 6, [0, 0, 0, 255]);
  });
  const at = (threshold: number) =>
    contrastReasons(icon, profileOf(["#ffffff"], { alpha: { mode: "soft", threshold } })).then(
      (rs) => rs[0]!,
    );
  const high = await at(128);
  assert.equal(high.passed, true, high.reason);
  assert.equal(high.reason, "boundary contrast on #ffffff is 21.000:1, at least 3:1");
  const low = await at(1);
  assert.equal(low.passed, false);
  assert.equal(low.reason, "boundary contrast on #ffffff is 1.000:1, below 3:1");
});

test("an icon with nothing at the threshold fails every background", async () => {
  const icon = iconOutput(8, (r) => fill(r, 2, 6, [0, 0, 0, 100]));
  const reasons = await contrastReasons(
    icon,
    profileOf(["#ffffff", "#000000"], { alpha: { mode: "soft", threshold: 128 } }),
  );
  assert.deepEqual(
    reasons.map((r) => [r.passed, r.reason]),
    [
      [false, "boundary contrast on #ffffff: nothing visible at the threshold 128"],
      [false, "boundary contrast on #000000: nothing visible at the threshold 128"],
    ],
  );
});
