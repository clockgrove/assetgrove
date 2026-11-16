/** The search bench: runs the confirmed bars through the package's Store and Embedder interfaces. */
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { availableParallelism, arch, cpus, platform, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { normalize, type Embedder } from "../../packages/assetgrove-search/src/embedder.ts";
import { MemoryStore } from "../../packages/assetgrove-search/src/memory-store.ts";
import type { Row, Store } from "../../packages/assetgrove-search/src/store.ts";
import { passes, type Bar } from "./bars.ts";
import type { ImageSource } from "./fetch.ts";
import type { LookLibrary } from "./library.ts";
import type { Label, Manifest } from "./manifest.ts";
import { allPairs, mean, percentile, precisionAt5, rrf, similarityThreshold } from "./metrics.ts";

export interface BenchEntry {
  bar: string;
  measured: number;
  /** The bar as the decisions record states it, e.g. ">= 0.85". */
  target: string;
  pass: boolean;
  unit: "" | "ms";
  n: number;
  /** Speed bars count only on the reference box. */
  reference?: boolean;
}

export interface Machine {
  platform: string;
  arch: string;
  cpu: string;
  threads: number;
  memoryGb: number;
  node: string;
  /** True on a box with the reference 24 threads. */
  referenceBox: boolean;
}

export interface BenchReport {
  entries: BenchEntry[];
  /** The computed image-similarity threshold, or null when no threshold reaches 0.9. */
  threshold: number | null;
  machine: Machine;
  /** The embedder that made the vectors; a scripted one never measures real look or words. */
  embedder: { id: string; revision: string; scripted: boolean };
  images: number;
  paddedTo: number;
}

export interface BenchOptions {
  manifest: Manifest;
  source: ImageSource;
  embedder: Embedder;
  bars: Map<string, Bar>;
  /**
   * The library the by-look measures search: the full library their bars were set on. The
   * manifest's look queries must be in it. Defaults to the manifest's own images and labels.
   */
  lookLibrary?: LookLibrary;
  /** A fresh store per call; the bench rebuilds one to check rebuild equality. */
  newStore?: () => Store | Promise<Store>;
  padTo?: number;
  /** Count of timed queries per speed measure. */
  timedQueries?: number;
  freshnessFiles?: number;
}

export function machine(): Machine {
  const threads = availableParallelism();
  return {
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? "unknown",
    threads,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    node: process.version,
    referenceBox: threads >= 24,
  };
}

const TOP = 20;
/** The package indexer's write batch (`packages/assetgrove-search/src/indexer.ts`). */
const INDEX_BATCH = 64;

/** Words query in shipped mode: image vector, card-text vector and full text, fused by RRF. */
async function shipped(
  store: Store,
  emb: Embedder,
  text: string,
  limit: number,
): Promise<string[]> {
  const [q] = await emb.embedTexts([text]);
  const vec = q as Float32Array;
  const lists = await Promise.all([
    store.query({ vector: { column: "imageVec", value: vec }, limit: TOP }),
    store.query({ vector: { column: "textVec", value: vec }, limit: TOP }),
    store.query({ text, limit: TOP }),
  ]);
  return rrf(lists.map((l) => l.map((h) => h.row.key))).slice(0, limit);
}

async function imageOnly(store: Store, emb: Embedder, text: string, limit: number) {
  const [q] = await emb.embedTexts([text]);
  const hits = await store.query({
    vector: { column: "imageVec", value: q as Float32Array },
    limit,
  });
  return hits.map((h) => h.row.key);
}

/** Small deterministic generator for padding rows. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const VOCAB = ["stone", "wood", "gold", "red", "blue", "sprite", "tile", "icon", "forest", "ruin"];

function paddingRows(count: number, dimension: number, fromIndex: number): Row[] {
  const rand = prng(42);
  const rows: Row[] = [];
  for (let n = 0; n < count; n++) {
    const unit = (): Float32Array =>
      normalize(Float32Array.from({ length: dimension }, () => rand() - 0.5));
    const i = fromIndex + n;
    rows.push({
      key: `pad-${i}`,
      tree: "bench",
      id: `pad-${i}`,
      address: `asset://bench/pad-${i}`,
      source: "pick",
      kind: "pad",
      subject: "pad",
      tags: [],
      text: `${VOCAB[i % 10]} ${VOCAB[(i * 7) % 10]} padding ${i}`,
      path: `pad/${i}.png`,
      sha256: `pad-${i}`,
      imageVec: unit(),
      textVec: unit(),
    });
  }
  return rows;
}

/** Stat every file and compare with what the index knows; no change means nothing to hash. */
export async function freshnessScan(
  files: string[],
  known: Map<string, { size: number; mtimeMs: number }>,
): Promise<number> {
  const changed = await Promise.all(
    files.map(async (f) => {
      const s = await stat(f);
      const k = known.get(f);
      return !k || k.size !== s.size || k.mtimeMs !== s.mtimeMs;
    }),
  );
  return changed.filter(Boolean).length;
}

export async function runBench(o: BenchOptions): Promise<BenchReport> {
  const { manifest, embedder } = o;
  const newStore = o.newStore ?? (() => new MemoryStore());
  const padTo = o.padTo ?? 10_000;
  const timed = o.timedQueries ?? 50;
  const label = new Map<string, Label>(manifest.labels.map((l) => [l.image, l]));
  const entries: BenchEntry[] = [];
  const mach = machine();
  const entry = (id: string, measured: number, n: number, speed = false) => {
    const bar = o.bars.get(id);
    if (!bar) throw new Error(`bar ${id} is not in the decisions record`);
    const e: BenchEntry = {
      bar: id,
      measured: Math.round(measured * 1000) / 1000,
      target: `${bar.op} ${bar.value}${bar.unit === "ms" ? " ms" : ""}`,
      pass: passes(bar, measured),
      unit: bar.unit,
      n,
    };
    if (speed) e.reference = mach.referenceBox;
    entries.push(e);
  };

  // Index the library: image vector from the pixels, text vector from the card text.
  const store = await newStore();
  const rows: Row[] = [];
  const indexMs: number[] = [];
  // Rows are written in batches, as the package's indexer writes them; each image's indexing time
  // is its embedding plus its share of its batch's write.
  let pending: { row: Row; ms: number }[] = [];
  const flush = async () => {
    const t0 = performance.now();
    await store.upsert(pending.map((p) => p.row));
    const share = (performance.now() - t0) / Math.max(1, pending.length);
    for (const p of pending) indexMs.push(p.ms + share);
    pending = [];
  };
  for (const image of manifest.images) {
    const l = label.get(image.id) as Label;
    const text = image.card?.text ?? "";
    const t0 = performance.now();
    const [imageVec] = await embedder.embedImages([await o.source.bytes(image)]);
    const [textVec] = await embedder.embedTexts([text]);
    const row: Row = {
      key: image.id,
      tree: "bench",
      id: image.id,
      address: `asset://bench/${image.id}`,
      source: "pick",
      kind: l.category,
      subject: l.pack,
      tags: [l.category, l.pack],
      text,
      path: image.file,
      sha256: image.sha256,
      imageVec,
      textVec,
    };
    pending.push({ row, ms: performance.now() - t0 });
    rows.push(row);
    if (pending.length === INDEX_BATCH) await flush();
  }
  await flush();
  // A writer optimizes after a batch: on LanceStore this builds the full-text index shipped mode uses.
  await store.optimize();

  // By look, in the look library: the full library the by-look bars were set on (docs/decisions.md).
  const look = o.lookLibrary ?? { images: manifest.images, labels: manifest.labels };
  const lookLabel = new Map<string, Label>(look.labels.map((l) => [l.image, l]));
  const known = new Map(rows.map((r) => [r.key, r]));
  const lookStore = await newStore();
  const lookRows: Row[] = [];
  for (const image of look.images) {
    const l = lookLabel.get(image.id);
    if (!l) throw new Error(`look library image ${image.id} has no label`);
    const imageVec =
      known.get(image.id)?.imageVec ??
      (await embedder.embedImages([await o.source.bytes(image)]))[0];
    lookRows.push({
      key: image.id,
      tree: "bench-look",
      id: image.id,
      address: `asset://bench-look/${image.id}`,
      source: "pick",
      kind: l.category,
      subject: l.pack,
      path: image.file,
      sha256: image.sha256,
      imageVec,
    });
  }
  for (let i = 0; i < lookRows.length; i += 500) await lookStore.upsert(lookRows.slice(i, i + 500));
  await lookStore.optimize();
  const lookVec = new Map(lookRows.map((r) => [r.key, r.imageVec as Float32Array]));
  // The query image is left out of its own results.
  const neighbours = async (id: string, k: number): Promise<string[]> => {
    const hits = await lookStore.query({
      vector: { column: "imageVec", value: lookVec.get(id) as Float32Array },
      limit: k + 1,
    });
    return hits
      .map((h) => h.row.key)
      .filter((k2) => k2 !== id)
      .slice(0, k);
  };
  const shareCategory: number[] = [];
  const pixelRecall: number[] = [];
  const recall: number[] = [];
  for (const id of manifest.lookQueries) {
    const l = lookLabel.get(id);
    if (!l) throw new Error(`look query ${id} is not in the look library`);
    const top5 = await neighbours(id, 5);
    const ok = top5.filter((n) => lookLabel.get(n)?.category === l.category).length >= 3 ? 1 : 0;
    shareCategory.push(ok);
    // Relevant: the other images of the same pack and category, as the spike measured it.
    const relevant = look.labels.filter(
      (x) => x.image !== id && x.category === l.category && x.pack === l.pack,
    );
    if (relevant.length > 0) {
      const top10 = new Set(await neighbours(id, 10));
      const found = relevant.filter((r) => top10.has(r.image)).length;
      const r = found / Math.min(10, relevant.length);
      recall.push(r);
      if (l.pixel === 16) pixelRecall.push(r);
    }
  }
  entry("look-category", mean(shareCategory), shareCategory.length);
  entry("look-recall10", mean(recall), recall.length);
  entry("look-pixel16", mean(pixelRecall), pixelRecall.length);

  // By words.
  const p5 = async (run: (text: string) => Promise<string[]>): Promise<number[]> => {
    const out: number[] = [];
    for (const q of manifest.writtenQueries) {
      // A query nothing in this subset answers (empty `relevant`) cannot score; skip it.
      if (q.relevant.length === 0) continue;
      const top = await run(q.text);
      out.push(precisionAt5(top, q.relevant));
    }
    return out;
  };
  const imgP = await p5((t) => imageOnly(store, embedder, t, 5));
  const shipP = await p5((t) => shipped(store, embedder, t, 5));
  entry("words-image-p5", mean(imgP), imgP.length);
  entry("words-shipped-p5", mean(shipP), shipP.length);

  // Filters return only matching rows; a rebuilt store answers identically.
  const rebuilt = await newStore();
  await rebuilt.upsert(rows);
  await rebuilt.optimize();
  const kinds = [...new Set(manifest.labels.map((l) => l.category))];
  const probe = rows[0]?.imageVec as Float32Array;
  let checks = 0;
  let good = 0;
  for (const kind of kinds) {
    for (const [op, value] of [
      ["=", kind],
      ["!=", kind],
    ] as const) {
      checks++;
      const q = { vector: { column: "imageVec" as const, value: probe }, limit: 1000 };
      const hits = await store.query({ ...q, filter: [{ field: "kind", op, value }] });
      const again = await rebuilt.query({ ...q, filter: [{ field: "kind", op, value }] });
      const expected = rows.filter((r) => (op === "=" ? r.kind === kind : r.kind !== kind)).length;
      const onlyMatching = hits.every((h) =>
        op === "=" ? h.row.kind === kind : h.row.kind !== kind,
      );
      const same =
        JSON.stringify(hits.map((h) => h.row.key)) === JSON.stringify(again.map((h) => h.row.key));
      if (onlyMatching && same && hits.length === expected) good++;
    }
  }
  entry("filters-rebuild", checks === 0 ? 0 : good / checks, checks);

  // The image-similarity threshold.
  const ids = manifest.images.map((i) => i.id);
  const vecs = new Map(rows.map((r) => [r.key, r.imageVec as Float32Array]));
  const threshold = similarityThreshold(allPairs(ids, vecs, manifest.pairs));

  // Freshness fixture (also timed inside search-10k).
  const dir = await mkdtemp(join(tmpdir(), "bench-fresh-"));
  try {
    const count = o.freshnessFiles ?? 2000;
    const files: string[] = [];
    const known = new Map<string, { size: number; mtimeMs: number }>();
    const when = new Date(1_700_000_000_000);
    for (let i = 0; i < count; i++) {
      const f = join(dir, `f${i}.png`);
      await writeFile(f, `file ${i}`);
      await utimes(f, when, when);
      const s = await stat(f);
      files.push(f);
      known.set(f, { size: s.size, mtimeMs: s.mtimeMs });
    }

    // Speed: pad to padTo rows.
    await store.upsert(paddingRows(Math.max(0, padTo - rows.length), embedder.dimension, 0));
    await store.optimize();
    const queries = manifest.writtenQueries.map((q) => q.text);
    const textMs: number[] = [];
    // "Fresh": a query preceded by the no-change freshness scan, as the real find does (design 7.4).
    const freshMs: number[] = [];
    for (let i = 0; i < timed; i++) {
      const t0 = performance.now();
      await shipped(store, embedder, queries[i % queries.length] ?? "tile", 10);
      textMs.push(performance.now() - t0);
      const t1 = performance.now();
      if ((await freshnessScan(files, known)) !== 0) throw new Error("freshness scan saw changes");
      await shipped(store, embedder, queries[i % queries.length] ?? "tile", 10);
      freshMs.push(performance.now() - t1);
    }
    const imageMs: number[] = [];
    const first = manifest.images[0];
    if (first) {
      const bytes = await o.source.bytes(first);
      for (let i = 0; i < timed; i++) {
        const t0 = performance.now();
        const [v] = await embedder.embedImages([bytes]);
        await store.query({ vector: { column: "imageVec", value: v as Float32Array }, limit: 10 });
        imageMs.push(performance.now() - t0);
      }
    }
    entry("text-query-p95", percentile(textMs, 0.95), textMs.length, true);
    entry("image-query-p95", percentile(imageMs, 0.95), imageMs.length, true);
    entry("search-10k", Math.max(...freshMs), freshMs.length, true);
    entry("indexing", mean(indexMs), indexMs.length, true);

    // Freshness: no changes, many files.
    const t0 = performance.now();
    const changed = await freshnessScan(files, known);
    const ms = performance.now() - t0;
    if (changed !== 0) throw new Error("freshness scan saw changes in an unchanged folder");
    entry("freshness-2000", ms, count, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const embedderInfo = {
    id: embedder.id,
    revision: embedder.revision,
    scripted: embedder.id.startsWith("scripted"),
  };
  return {
    entries,
    threshold,
    machine: mach,
    embedder: embedderInfo,
    images: rows.length,
    paddedTo: padTo,
  };
}

/** One JSON line per bar, then the threshold, then the machine. */
export function formatReport(r: BenchReport): string[] {
  return [
    ...r.entries.map((e) => JSON.stringify(e)),
    JSON.stringify({ threshold: r.threshold }),
    JSON.stringify({
      embedder: r.embedder,
      machine: r.machine,
      images: r.images,
      paddedTo: r.paddedTo,
    }),
  ];
}
