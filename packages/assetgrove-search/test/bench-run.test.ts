import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";
import { readBars } from "../../../bench/search/bars.ts";
import { formatReport, missedBars, runBench } from "../../../bench/search/bench.ts";
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
import { droppedQueries, readManifest, relevantOf } from "../../../bench/search/manifest.ts";
import { precisionAt5 } from "../../../bench/search/metrics.ts";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Embedder } from "../src/embedder.ts";
import { SearchIndex } from "../src/find.ts";
import { LanceStore } from "../src/lance-store.ts";
import { ScriptedEmbedder } from "../src/scripted.ts";
import { cleanup, tempDir } from "./helpers/fixture.ts";

const fixtureUrl = new URL("../../../bench/search/fixture/manifest.json", import.meta.url);

describe("bench on the 20-image fixture", () => {
  it("runs offline, prints one entry per bar, the dropped queries and the machine, padded to 10,000", async () => {
    const manifest = await readManifest(fixtureUrl);
    const bars = await readBars();
    const report = await runBench({
      manifest,
      source: fixtureSource(),
      embedder: new ScriptedEmbedder(),
      bars,
      padTo: 10_000,
      timedQueries: 5,
      scriptedJudgements: true,
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
    // The fixture's fourth query is judged to have two relevant images: dropped and reported.
    assert.deepEqual(report.dropped, [
      { id: "wq-4", text: "armored knight with sword", relevant: 2 },
    ]);
    assert.equal(report.entries.find((e) => e.bar === "words-shipped-p5")?.n, 3);
    const lines = formatReport(report).map((l) => JSON.parse(l));
    assert.equal(lines.length, bars.size + 3);
    assert.deepEqual(lines[bars.size].dropped, report.dropped);
    assert.deepEqual(lines[bars.size + 1].indexing, report.indexing);
    assert.ok("machine" in lines[bars.size + 2]);

    // A missed quality bar counts everywhere; a missed speed bar only on the reference box.
    const entry = (bar: string, pass: boolean, reference?: boolean) => ({
      ...report.entries[0]!,
      bar,
      pass,
      ...(reference !== undefined && { reference }),
    });
    const with_ = (...entries: ReturnType<typeof entry>[]) => missedBars({ ...report, entries });
    assert.deepEqual(with_(entry("look-category", true), entry("indexing", true, false)), []);
    assert.deepEqual(
      with_(entry("look-category", false), entry("indexing", false, false)).map((e) => e.bar),
      ["look-category"],
    );
    assert.deepEqual(with_(entry("indexing", false, true)).map((e) => e.bar), ["indexing"]);
  });

  it("refuses to score by words while a query holds rule-made, unpooled or unjudged labels", async () => {
    const run = async (edit: (m: Awaited<ReturnType<typeof readManifest>>) => void) => {
      const manifest = await readManifest(fixtureUrl);
      edit(manifest);
      return runBench({
        manifest,
        source: fixtureSource(),
        embedder: new ScriptedEmbedder(),
        bars: await readBars(),
        padTo: 0,
        timedQueries: 1,
        freshnessFiles: 1,
        scriptedJudgements: true,
      });
    };
    await assert.rejects(
      run((m) => (m.writtenQueries[0]!.relevant = ["fx-05"])),
      /wq-1 holds rule-made relevance labels/,
    );
    await assert.rejects(
      run((m) => delete m.writtenQueries[1]!.candidates),
      /wq-2 is not pooled/,
    );
    await assert.rejects(
      run((m) => m.writtenQueries[2]!.judgements!.pop()),
      /wq-3 has 1 candidates not judged/,
    );
    // A pool ranked by another embedder or revision is not the top results the bench scores.
    await assert.rejects(
      run((m) => (m.writtenQueries[0]!.pooledBy!.embedder = "siglip2")),
      /wq-1 was pooled by siglip2@1, not the bench's scripted@1/,
    );
    await assert.rejects(
      run((m) => (m.writtenQueries[1]!.pooledBy!.revision = "0")),
      /wq-2 was pooled by scripted@0/,
    );
    await assert.rejects(
      run((m) => delete m.writtenQueries[2]!.pooledBy),
      /wq-3 was pooled by an unrecorded embedder/,
    );
  });

  it("refuses scripted judgements outside the offline fixture run", async () => {
    await assert.rejects(
      runBench({
        manifest: await readManifest(fixtureUrl),
        source: fixtureSource(),
        embedder: new ScriptedEmbedder(),
        bars: await readBars(),
        padTo: 0,
        timedQueries: 1,
        freshnessFiles: 1,
      }),
      /wq-1 holds judgements by scripted-judge, a word match/,
    );
  });
});

describe("card texts", () => {
  it("are written offline with model, prompt and date", async () => {
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

  it("sends the vision model no file name, one call per image", async () => {
    const manifest = buildFixtureManifest();
    manifest.images = manifest.images.slice(0, 2);
    manifest.images[0]!.file = "Bear.png";
    manifest.images[1]!.file = "red-barrel.png";
    const captions = new Map([
      [manifest.images[0]!.id, "a bear"],
      [manifest.images[1]!.id, "a red barrel"],
    ]);
    const source: ImageSource = {
      bytes: async (image) => Buffer.from(captions.get(image.id)!),
    };
    const sent: { image: Uint8Array; prompt: string }[] = [];
    const recording: VisionProvider = {
      describe: async (image, prompt) => {
        sent.push({ image, prompt });
        return { text: `A picture showing ${Buffer.from(image).toString("utf8")}.`, model: "m" };
      },
    };
    assert.equal(await writeCardTexts({ manifest, source, provider: recording }), 2);
    assert.equal(sent.length, 2);
    assert.equal(manifest.images[0]!.card?.text, "A picture showing a bear.");
    assert.equal(manifest.images[1]!.card?.text, "A picture showing a red barrel.");
    // The caption "a bear" says its subject truthfully, so only the prompt is held to the bare stem.
    for (const { image, prompt } of sent) {
      const bytes = Buffer.from(image).toString("latin1").toLowerCase();
      for (const file of ["bear.png", "red-barrel.png"]) {
        assert.equal(prompt.toLowerCase().includes(file), false, file);
        assert.equal(bytes.includes(file), false, file);
      }
      for (const stem of ["bear", "red-barrel"]) {
        assert.equal(prompt.toLowerCase().includes(stem), false, stem);
      }
      assert.equal(bytes.includes("red-barrel"), false);
    }
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

  it("can reach the shipped bar on the judged fixture queries: the best possible mean is 1", async () => {
    const m = await readManifest(fixtureUrl);
    const dropped = new Set(droppedQueries(m).map((q) => q.id));
    const scored = m.writtenQueries.filter((q) => !dropped.has(q.id));
    assert.equal(scored.length, 3);
    const best = scored.map((q) => precisionAt5(relevantOf(q), relevantOf(q)));
    assert.equal(best.reduce((a, b) => a + b, 0) / best.length, 1);
  });
});

describe("manifest building", () => {
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
    const opts = {
      manifest,
      embedder: new ScriptedEmbedder(),
      bars,
      padTo: 0,
      timedQueries: 1,
      scriptedJudgements: true,
    };
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
    // By words still runs on the labelled images alone.
    assert.equal(get(inFull, "words-shipped-p5").measured, get(alone, "words-shipped-p5").measured);
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
        scriptedJudgements: true,
      }),
      /not in the look library/,
    );
  });
});

describe("bench on the search that ships", () => {
  it("indexes through the package's indexer in its batches, finds through its find, on LanceStore", async () => {
    const scripted = new ScriptedEmbedder();
    const imageBatches: number[] = [];
    const embedder: Embedder = {
      id: scripted.id,
      revision: scripted.revision,
      dimension: scripted.dimension,
      embedImages: async (images) => {
        imageBatches.push(images.length);
        return scripted.embedImages(images);
      },
      embedTexts: (texts) => scripted.embedTexts(texts),
    };
    const fullText: number[] = [];
    const refreshes: boolean[] = [];
    const query = LanceStore.prototype.query;
    const refresh = SearchIndex.prototype.refresh;
    LanceStore.prototype.query = async function (this: LanceStore, q) {
      const hits = await query.call(this, q);
      if (q.text !== undefined) fullText.push(hits.length);
      return hits;
    };
    SearchIndex.prototype.refresh = async function (this: SearchIndex) {
      const r = await refresh.call(this);
      refreshes.push(r.fresh);
      return r;
    };
    try {
      const manifest = await readManifest(fixtureUrl);
      const bars = await readBars();
      const report = await runBench({
        manifest,
        source: fixtureSource(),
        embedder,
        bars,
        padTo: 200,
        timedQueries: 2,
        freshnessFiles: 10,
        scriptedJudgements: true,
      });
      assert.deepEqual(report.entries.map((e) => e.bar).sort(), [...bars.keys()].sort());
      assert.equal(report.entries.find((e) => e.bar === "filters-rebuild")?.pass, true);
      // The shipped indexer embeds the 20 images in one batch, not one image a call.
      assert.equal(imageBatches[0], 20);
      // The full-text ranking is LanceDB's, its index built by the indexer's optimize.
      assert.ok(fullText.some((n) => n > 0));
      // Every find checks freshness first, as the shipped find does.
      assert.ok(refreshes.length > manifest.lookQueries.length);
      assert.ok(refreshes.every(Boolean));

      // The indexing bar is the shipped indexer's time per image, and the report splits it.
      const split = report.indexing;
      assert.equal(split.images, 20);
      assert.equal(split.embeddedImages, 20);
      assert.ok(split.embeddedTexts > 0 && split.embeddedTexts <= 20);
      assert.equal(report.entries.find((e) => e.bar === "indexing")?.measured, split.perImageMs);
      assert.ok(Math.abs(split.perImageMs * 20 - split.totalMs) < 0.05);
      const parts = split.embedImagesMs + split.embedTextsMs + split.writeMs + split.otherMs;
      assert.ok(Math.abs(parts - split.totalMs) < 0.01);
      for (const ms of [split.embedImagesMs, split.embedTextsMs, split.writeMs]) {
        assert.ok(ms > 0 && ms <= split.totalMs);
      }
    } finally {
      LanceStore.prototype.query = query;
      SearchIndex.prototype.refresh = refresh;
    }
  });
});
