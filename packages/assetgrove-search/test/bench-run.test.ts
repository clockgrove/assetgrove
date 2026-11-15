import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readBars } from "../../../bench/search/bars.ts";
import { formatReport, runBench } from "../../../bench/search/bench.ts";
import {
  CARD_PROMPT,
  markSpotChecked,
  ScriptedVision,
  spotCheckSample,
  writeCardTexts,
  type VisionProvider,
} from "../../../bench/search/card-text.ts";
import { buildFixtureManifest, fixtureSource } from "../../../bench/search/fixture.ts";
import { readManifest } from "../../../bench/search/manifest.ts";
import { allPairs, precisionAt5, similarityThreshold } from "../../../bench/search/metrics.ts";
import { ScriptedEmbedder } from "../src/scripted.ts";

const fixtureUrl = new URL("../../../bench/search/fixture/manifest.json", import.meta.url);

describe("bench on the 20-image fixture", () => {
  it("runs offline, prints one entry per bar, the threshold and the machine, padded to 10,000", async () => {
    const manifest = await readManifest(fixtureUrl);
    const bars = await readBars();
    const report = await runBench({
      manifest,
      source: fixtureSource(),
      embedder: new ScriptedEmbedder(),
      bars,
      padTo: 10_000,
      timedQueries: 5,
    });
    assert.deepEqual(report.entries.map((e) => e.bar).sort(), [...bars.keys()].sort());
    for (const e of report.entries) {
      assert.equal(typeof e.measured, "number");
      assert.equal(typeof e.pass, "boolean");
      assert.match(e.target, /^(>=|<=|<|=) [\d.]+/);
    }
    assert.equal(report.entries.find((e) => e.bar === "filters-rebuild")?.pass, true);
    assert.equal(report.paddedTo, 10_000);
    assert.ok(report.machine.threads >= 1 && report.machine.cpu.length > 0);
    assert.equal(typeof report.threshold, "number");
    const lines = formatReport(report).map((l) => JSON.parse(l));
    assert.equal(lines.length, bars.size + 2);
    assert.ok("threshold" in lines[bars.size]);
    assert.ok("machine" in lines[bars.size + 1]);
  });
});

describe("similarity threshold", () => {
  it("is the lowest similarity at which same-asset precision reaches 0.9", () => {
    const pairs = [
      ...[0.99, 0.97, 0.95, 0.93, 0.91, 0.9, 0.88, 0.86, 0.84].map((sim) => ({ sim, same: true })),
      { sim: 0.8, same: false },
      { sim: 0.5, same: false },
    ];
    // At 0.84: 9 of 9 same. At 0.8: 9 of 10 = 0.9, still counts. At 0.5: 9 of 11 < 0.9.
    assert.equal(similarityThreshold(pairs), 0.8);
    assert.equal(similarityThreshold([{ sim: 0.9, same: false }]), null);
    assert.equal(
      allPairs(
        ["a", "b"],
        new Map([
          ["a", Float32Array.of(1, 0)],
          ["b", Float32Array.of(1, 0)],
        ]),
        [["b", "a"]],
      )[0]?.same,
      true,
    );
  });
});

describe("card texts", () => {
  it("are written offline with model, prompt and date, and none holds its file stem", async () => {
    const manifest = buildFixtureManifest();
    const n = await writeCardTexts({
      manifest,
      source: fixtureSource(),
      provider: new ScriptedVision(),
      now: () => new Date("2026-01-02T03:04:05Z"),
    });
    assert.equal(n, 20);
    for (const i of manifest.images) {
      assert.equal(i.card?.model, "scripted-vision");
      assert.equal(i.card?.date, "2026-01-02T03:04:05.000Z");
      assert.equal(manifest.prompts[i.card?.prompt as string], CARD_PROMPT);
    }
    assert.equal(
      await writeCardTexts({ manifest, source: fixtureSource(), provider: new ScriptedVision() }),
      0,
    );
  });

  it("refuses a model that writes the file stem, after one retry", async () => {
    const manifest = buildFixtureManifest();
    let calls = 0;
    const leaky: VisionProvider = {
      describe: async () => {
        calls++;
        return { text: "this is characters_1", model: "m" };
      },
    };
    await assert.rejects(
      writeCardTexts({ manifest, source: fixtureSource(), provider: leaky }),
      /file stem/,
    );
    assert.equal(calls, 2);
  });

  it("record the spot-check sample", () => {
    const manifest = buildFixtureManifest();
    const sample = spotCheckSample(manifest, 3, "s");
    assert.deepEqual(sample, spotCheckSample(manifest, 3, "s"));
    assert.throws(() => markSpotChecked(manifest, sample, "kirk", "2026-01-01"), /no card text/);
  });
});

describe("by-words precision", () => {
  it("scores 1 for a perfect ranking even when fewer than five images are relevant", () => {
    assert.equal(precisionAt5(["a", "x", "y", "z", "w"], ["a"]), 1);
    assert.equal(precisionAt5(["a", "b", "c", "d", "e"], ["a", "b", "c", "d", "e", "f"]), 1);
    assert.equal(precisionAt5(["x"], ["a"]), 0);
  });

  it("can reach the shipped bar on the committed queries: the best possible mean is 1", async () => {
    const m = await readManifest(new URL("../../../bench/search/manifest.json", import.meta.url));
    const scored = m.writtenQueries.filter((q) => q.relevant.length > 0);
    assert.ok(scored.length >= 25);
    const best = scored.map((q) => precisionAt5(q.relevant, q.relevant));
    assert.equal(best.reduce((a, b) => a + b, 0) / best.length, 1);
  });
});

describe("manifest building", () => {
  it("matches the owner's id rule for the female adventurer and finds recolour pairs", async () => {
    const m = await readManifest(new URL("../../../bench/search/manifest.json", import.meta.url));
    assert.ok(m.writtenQueries.find((q) => q.id === "q14")?.relevant.length);
    assert.ok(m.pairs.length >= 20);
  });

  it("calls the vision model only up to the cap, and saves each text as it is written", async () => {
    const manifest = buildFixtureManifest();
    let saved = 0;
    await assert.rejects(
      writeCardTexts({
        manifest,
        source: fixtureSource(),
        provider: new ScriptedVision(),
        maxCalls: 3,
        onWritten: () => void saved++,
      }),
      /cap/,
    );
    assert.equal(saved, 3);
  });
});
