import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";
import { readBars } from "../../../bench/search/bars.ts";
import { formatReport, runBench } from "../../../bench/search/bench.ts";
import {
  CARD_PROMPT,
  forVision,
  markSpotChecked,
  MIN_VISION_SIDE,
  ScriptedVision,
  spotCheckSample,
  type VisionProvider,
  writeCardTexts,
} from "../../../bench/search/card-text.ts";
import { buildFixtureManifest, fixtureSource } from "../../../bench/search/fixture.ts";
import { fetchImages, type ImageSource } from "../../../bench/search/fetch.ts";
import { readLookLibrary, type LookLibrary } from "../../../bench/search/library.ts";
import { readManifest } from "../../../bench/search/manifest.ts";
import { allPairs, precisionAt5, similarityThreshold } from "../../../bench/search/metrics.ts";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LanceStore } from "../src/lance-store.ts";
import { ScriptedEmbedder } from "../src/scripted.ts";
import type { Store } from "../src/store.ts";
import { cleanup, tempDir } from "./helpers/fixture.ts";

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

describe("the image a vision model is shown", () => {
  it("scales a small PNG up by a whole factor with hard pixels, and leaves other bytes alone", () => {
    const small = new PNG({ width: 2, height: 1 });
    small.data.set([255, 0, 0, 255, 0, 0, 255, 0]);
    const shown = PNG.sync.read(Buffer.from(forVision(new Uint8Array(PNG.sync.write(small)))));
    assert.equal(shown.width, MIN_VISION_SIDE);
    assert.equal(shown.height, MIN_VISION_SIDE / 2);
    const at = (x: number, y: number) => [
      ...shown.data.subarray((y * shown.width + x) * 4).subarray(0, 4),
    ];
    assert.deepEqual(at(0, 0), [255, 0, 0, 255]);
    assert.deepEqual(at(MIN_VISION_SIDE / 2 - 1, MIN_VISION_SIDE / 2 - 1), [255, 0, 0, 255]);
    assert.deepEqual(at(MIN_VISION_SIDE / 2, 0), [0, 0, 255, 0]);

    const big = new PNG({ width: MIN_VISION_SIDE, height: 4 });
    const bigBytes = new Uint8Array(PNG.sync.write(big));
    assert.equal(forVision(bigBytes), bigBytes);
    const text = new TextEncoder().encode("a caption, not an image");
    assert.equal(forVision(text), text);
  });
});

describe("the by-look library", () => {
  it("is the full inventory: 1,728 images, the labelled 300 inside it unchanged", async () => {
    const lib = await readLookLibrary();
    const m = await readManifest(new URL("../../../bench/search/manifest.json", import.meta.url));
    assert.equal(lib.images.length, 1728);
    assert.equal(new Set(lib.images.map((i) => i.id)).size, 1728);
    assert.equal(new Set(lib.images.map((i) => i.sha256)).size, 1728);
    for (const i of lib.images) {
      assert.match(i.url, /^https:\/\/[^#]+\.zip#.+/);
      assert.match(i.sha256, /^[0-9a-f]{64}$/);
    }
    const image = new Map(lib.images.map((i) => [i.id, i]));
    const label = new Map(lib.labels.map((l) => [l.image, l]));
    for (const i of m.images) {
      assert.equal(image.get(i.id)?.sha256, i.sha256);
      assert.equal(image.get(i.id)?.url, i.url);
    }
    for (const l of m.labels) assert.deepEqual(label.get(l.image), l);
    for (const q of m.lookQueries) assert.ok(image.has(q));
    assert.ok(lib.labels.filter((l) => l.pixel === 16).length > 0);
  });

  it("is fetched once per image, each file checked against its sha256", async () => {
    const dir = await tempDir("fetch");
    const realFetch = globalThis.fetch;
    const served: string[] = [];
    const body = new TextEncoder().encode("served image");
    globalThis.fetch = (async (url: string | URL | Request) => {
      served.push(String(url));
      return new Response(body);
    }) as typeof fetch;
    try {
      const sha256 = createHash("sha256").update(body).digest("hex");
      const img = {
        id: "kn-0000000000",
        file: "a.png",
        url: "https://fixtures.invalid/a.png",
        sha256,
        width: 1,
        height: 1,
      };
      // A cached file whose bytes do not match is not trusted: the image is fetched again.
      await writeFile(join(dir, `${img.id}.bin`), new TextEncoder().encode("stale bytes"));
      const source = await fetchImages({ images: [img, img] }, dir);
      assert.deepEqual(served, [img.url]);
      assert.deepEqual(await source.bytes(img), body);

      // A cached file that matches is read, not fetched.
      await fetchImages({ images: [img] }, dir);
      assert.equal(served.length, 1);

      // A served file whose bytes do not match the listed sha256 is refused and not cached.
      const bad = { ...img, id: "kn-0000000001", sha256: "0".repeat(64) };
      await assert.rejects(fetchImages({ images: [bad] }, dir), /sha256 does not match/);
      await assert.rejects(readFile(join(dir, `${bad.id}.bin`)), { code: "ENOENT" });
    } finally {
      globalThis.fetch = realFetch;
      await cleanup(dir);
    }
  });

  const pixelDecoys = (): { look: LookLibrary; captions: Map<string, string> } => {
    const manifest = buildFixtureManifest();
    const captions = new Map<string, string>();
    const look: LookLibrary = { images: [...manifest.images], labels: [...manifest.labels] };
    // Ten exact look-alikes of each pixel image, in another pack: same category, not relevant.
    for (const l of manifest.labels.filter((x) => x.pixel === 16)) {
      for (let n = 0; n < 10; n++) {
        const id = `zz-${l.image}-${n}`;
        captions.set(id, l.image);
        look.images.push({ id, file: `${id}.png`, url: "", sha256: id, width: 16, height: 16 });
        look.labels.push({ image: id, category: l.category, pack: "pack-z", pixel: 16 });
      }
    }
    return { look, captions };
  };

  it("searches the whole look library, and look-pixel16 is recall@10, not category share", async () => {
    const manifest = await readManifest(fixtureUrl);
    const bars = await readBars();
    const base = fixtureSource();
    const { look, captions } = pixelDecoys();
    // A look-alike's bytes are its original's caption.
    const source: ImageSource = {
      bytes: async (image) => base.bytes({ ...image, id: captions.get(image.id) ?? image.id }),
    };
    const opts = { manifest, embedder: new ScriptedEmbedder(), bars, padTo: 0, timedQueries: 1 };
    const alone = await runBench({ ...opts, source: base, freshnessFiles: 1 });
    const inFull = await runBench({ ...opts, source, lookLibrary: look, freshnessFiles: 1 });
    const get = (r: typeof alone, id: string) => r.entries.find((e) => e.bar === id)!;
    assert.equal(get(alone, "look-pixel16").n, 4);
    assert.equal(get(alone, "look-pixel16").measured, 1);
    // Every top 10 of a pixel query is now its look-alikes from pack-z: still the same category,
    // so a category share would stay 1, but none is relevant, so recall@10 is 0.
    assert.equal(get(inFull, "look-pixel16").measured, 0);
    assert.equal(get(inFull, "look-pixel16").n, 4);
    assert.ok(get(inFull, "look-recall10").measured < get(alone, "look-recall10").measured);
    // By words and the threshold still run on the labelled images alone.
    assert.equal(get(inFull, "words-shipped-p5").measured, get(alone, "words-shipped-p5").measured);
    assert.equal(inFull.threshold, alone.threshold);
    assert.equal(inFull.images, manifest.images.length);
  });

  it("refuses a look query that is not in the look library", async () => {
    const manifest = await readManifest(fixtureUrl);
    await assert.rejects(
      runBench({
        manifest,
        source: fixtureSource(),
        embedder: new ScriptedEmbedder(),
        bars: await readBars(),
        lookLibrary: { images: [], labels: [] },
        padTo: 0,
        timedQueries: 1,
        freshnessFiles: 1,
      }),
      /not in the look library/,
    );
  });
});

describe("bench on LanceStore", () => {
  it("runs every bar on the shipped store, its full text indexed", async () => {
    const dir = await tempDir("bench-lance");
    const stores: LanceStore[] = [];
    const embedder = new ScriptedEmbedder();
    const newStore = async (): Promise<Store> => {
      const s = await LanceStore.open(join(dir, `s${stores.length}`), { embedder });
      stores.push(s);
      return s;
    };
    try {
      const manifest = await readManifest(fixtureUrl);
      const bars = await readBars();
      const report = await runBench({
        manifest,
        source: fixtureSource(),
        embedder,
        bars,
        newStore,
        padTo: 200,
        timedQueries: 2,
        freshnessFiles: 10,
      });
      assert.deepEqual(report.entries.map((e) => e.bar).sort(), [...bars.keys()].sort());
      assert.equal(report.entries.find((e) => e.bar === "filters-rebuild")?.pass, true);
      assert.ok(stores.length >= 3);
      // The full-text list answers: the store built its text index.
      const hits = await stores[0]!.query({ text: "knight", limit: 5 });
      assert.ok(hits.length > 0);
    } finally {
      for (const s of stores) s.close();
      await cleanup(dir);
    }
  });
});
