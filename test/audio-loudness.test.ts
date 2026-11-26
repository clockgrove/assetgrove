/**
 * Loudness and true peak (src/audio/loudness.ts) against the EBU Tech 3341 (V4, 2023)
 * minimum-requirements test vectors, generated here as the standard's Table 1 defines them: the
 * EBU's files cannot be downloaded or committed, so each signal is synthesized.
 *
 * Run: cases 1-6 (integrated loudness, case 1 also at 44.1 kHz), 1, 2 and 12 (maximum momentary
 * loudness), 15-23 (true peak). Not run: 7 and 8 are authentic programme files that cannot be
 * generated; 9-11 and 13-14 measure the short-term or other meters, which Assetgrove does not
 * expose.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  integratedLoudness,
  maxMomentaryLoudness,
  measureLoudness,
  truePeak,
} from "../src/audio/loudness.ts";

/** A 1000 Hz sine in segments on one running phase; each segment is [seconds, peak dBFS]. */
function tones(segs: [seconds: number, dbfs: number][], sr = 48000, nch = 2): Float64Array[] {
  const n = segs.reduce((n, [s]) => n + Math.round(s * sr), 0);
  const x = new Float64Array(n);
  let i = 0;
  for (const [s, db] of segs)
    for (let e = i + Math.round(s * sr), a = 10 ** (db / 20); i < e; i++)
      x[i] = a * Math.sin((2 * Math.PI * 1000 * i) / sr);
  return Array.from({ length: nch }, () => x.slice());
}

/** A sine of period `div` samples with 10 ms raised-cosine fades, 1 s long, on two channels. */
function tpSine(div: number, a: number, deg: number, fs = 48000): Float64Array[] {
  const n = fs;
  const fade = 0.01 * fs;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = Math.min(1, i / fade, (n - 1 - i) / fade);
    const r = 0.5 - 0.5 * Math.cos(Math.PI * w);
    x[i] = r * a * Math.sin((2 * Math.PI * i) / div + (deg * Math.PI) / 180);
  }
  return [x, x.slice()];
}

/**
 * One fs/4 period at amplitude 1.00 inside an fs/6 sine at 0.50, continuous in phase, synthesized
 * at 4·fs, low-passed (Kaiser-windowed sinc) and decimated with `off` samples of offset.
 */
function tpBurst(off: number, fs = 48000): Float64Array[] {
  const up = 4;
  const n4 = 2 * fs;
  const x4 = new Float64Array(n4);
  const at = Math.round(n4 / 2 / 24) * 24;
  for (let i = 0; i < n4; i++)
    x4[i] =
      i >= at && i < at + 16
        ? Math.sin((2 * Math.PI * (i - at)) / 16)
        : 0.5 * Math.sin((2 * Math.PI * (i < at ? i : i - at - 16)) / 24);
  for (let i = 0, f = 0.005 * up * fs; i < f; i++) {
    const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / f);
    x4[i]! *= w;
    x4[n4 - 1 - i]! *= w;
  }
  const N = 1023;
  const M = 511;
  const i0 = (z: number) => {
    let s = 1;
    let t = 1;
    for (let k = 1; k < 50; k++) s += t *= (z / 2 / k) ** 2;
    return s;
  };
  const h = Float64Array.from(
    { length: N },
    (_, k) =>
      (k === M ? 0.25 : Math.sin((Math.PI * (k - M)) / up) / (Math.PI * (k - M))) *
      i0(12 * Math.sqrt(1 - ((k - M) / M) ** 2)),
  );
  const hs = h.reduce((a, b) => a + b);
  const y = new Float64Array(Math.floor((n4 - off) / up));
  for (let j = 0; j < y.length; j++) {
    const c = j * up + off;
    let v = 0;
    for (let k = 0; k < N; k++) {
      const i = c + M - k;
      if (i >= 0 && i < n4) v += h[k]! * x4[i]!;
    }
    y[j] = v / hs;
  }
  return [y, y.slice()];
}

function near(got: number | null, want: number, tolerance: number, label: string): void {
  assert.ok(
    got !== null && Math.abs(got - want) <= tolerance,
    `${label}: measured ${got}, want ${want} ±${tolerance}`,
  );
}

function withinTruePeak(got: number, want: number, label: string): void {
  assert.ok(
    got >= want - 0.4 && got <= want + 0.2,
    `${label}: measured ${got}, want ${want} +0.2/-0.4`,
  );
}

const rep = (n: number, segs: [number, number][]) => Array.from({ length: n }, () => segs).flat();

test("integrated loudness, EBU Tech 3341 cases 1-6", () => {
  const cases: [string, Float64Array[], number][] = [
    ["case 1", tones([[20, -23]]), -23],
    ["case 2", tones([[20, -33]]), -33],
    [
      "case 3",
      tones([
        [10, -36],
        [60, -23],
        [10, -36],
      ]),
      -23,
    ],
    [
      "case 4",
      tones([
        [10, -72],
        [10, -36],
        [60, -23],
        [10, -36],
        [10, -72],
      ]),
      -23,
    ],
    [
      "case 5",
      tones([
        [20, -26],
        [20.1, -20],
        [20, -26],
      ]),
      -23,
    ],
  ];
  for (const [label, channels, want] of cases)
    near(integratedLoudness(channels, 48000), want, 0.1, `${label} integrated`);

  const [l, r, c, ls, rs] = [
    tones([[20, -28]])[0]!,
    tones([[20, -28]])[0]!,
    tones([[20, -24]])[0]!,
    tones([[20, -30]])[0]!,
    tones([[20, -30]])[0]!,
  ];
  near(integratedLoudness([l, r, c, ls, rs], 48000), -23, 0.1, "case 6 integrated");
});

test("integrated loudness of case 1 at 44.1 kHz", () => {
  near(integratedLoudness(tones([[20, -23]], 44100), 44100), -23, 0.1, "case 1 at 44100 Hz");
});

test("maximum momentary loudness, EBU Tech 3341 cases 1, 2 and 12", () => {
  near(maxMomentaryLoudness(tones([[20, -23]]), 48000), -23, 0.1, "case 1 momentary");
  near(maxMomentaryLoudness(tones([[20, -33]]), 48000), -33, 0.1, "case 2 momentary");
  near(
    maxMomentaryLoudness(
      tones(
        rep(20, [
          [0.18, -20],
          [0.22, -30],
        ]),
      ),
      48000,
    ),
    -23,
    0.1,
    "case 12 momentary",
  );
});

test("momentary loudness is null under 400 ms and for silence", () => {
  assert.equal(maxMomentaryLoudness(tones([[0.3, -23]]), 48000), null);
  assert.equal(
    maxMomentaryLoudness(
      tones([[2, -200]]).map((c) => c.fill(0)),
      48000,
    ),
    null,
  );
});

test("true peak, EBU Tech 3341 cases 15-19", () => {
  const cases: [string, Float64Array[], number][] = [
    ["case 15", tpSine(4, 0.5, 0), -6],
    ["case 16", tpSine(4, 0.5, 45), -6],
    ["case 17", tpSine(6, 0.5, 60), -6],
    ["case 18", tpSine(8, 0.5, 67.5), -6],
    ["case 19", tpSine(4, 1.41, 45), 3],
  ];
  for (const [label, channels, want] of cases)
    withinTruePeak(truePeak(channels, 48000), want, `${label} true peak`);
});

test("true peak, EBU Tech 3341 cases 20-23", () => {
  for (let off = 0; off < 4; off++)
    withinTruePeak(truePeak(tpBurst(off), 48000), 0, `case ${20 + off} true peak`);
});

test("measureLoudness returns all three figures for case 1", () => {
  const m = measureLoudness(tones([[20, -23]]), 48000);
  near(m.integrated, -23, 0.1, "case 1 integrated");
  near(m.momentaryMax, -23, 0.1, "case 1 momentary");
  withinTruePeak(m.truePeak, -23, "case 1 true peak");
});
