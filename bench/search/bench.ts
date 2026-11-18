/**
 * The search bench: runs the confirmed bars on the search that ships. The labelled library is
 * indexed by the package's own indexer (`SearchIndex.index()`, batched as it batches) into a
 * `LanceStore` in a temporary folder, every words and look query is answered by the package's own
 * find (`findWith`, what `assetgrove find` runs), and the speed and freshness bars time those calls.
 */
import { realpathSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { availableParallelism, arch, cpus, platform, totalmem, tmpdir } from "node:os";
import { extname, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { SearchQuery } from "../../src/extension/api.ts";
import { normalize, type Embedder } from "../../packages/assetgrove-search/src/embedder.ts";
import { findWith } from "../../packages/assetgrove-search/src/extension.ts";
import { rankingQueries, SearchIndex } from "../../packages/assetgrove-search/src/find.ts";
import { LanceStore } from "../../packages/assetgrove-search/src/lance-store.ts";
import type { Library, LibraryItem } from "../../packages/assetgrove-search/src/library.ts";
import type { Row, Store } from "../../packages/assetgrove-search/src/store.ts";
import { passes, type Bar } from "./bars.ts";
import type { ImageSource } from "./fetch.ts";
import type { LookLibrary } from "./library.ts";
import {
  droppedQueries,
  relevantOf,
  wordsLabelProblems,
  type Label,
  type Manifest,
  type ManifestImage,
} from "./manifest.ts";
import { mean, percentile, precisionAt5 } from "./metrics.ts";

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

/**
 * Where the shipped indexer's time went, over one `SearchIndex.index()` of the labelled library:
 * embedding images, embedding card texts, writing to the store (rows, sources, the vector cache,
 * the optimize), and the rest (lock, listing, reading and hashing files).
 */
export interface IndexingSplit {
  images: number;
  totalMs: number;
  perImageMs: number;
  embedImagesMs: number;
  embedTextsMs: number;
  writeMs: number;
  otherMs: number;
  /** What the embedder was asked for: images and distinct card texts. */
  embeddedImages: number;
  embeddedTexts: number;
}

export interface BenchReport {
  entries: BenchEntry[];
  machine: Machine;
  /** The embedder that made the vectors; a scripted one never measures real look or words. */
  embedder: { id: string; revision: string; scripted: boolean };
  images: number;
  paddedTo: number;
  /** Written queries left out of the by-words score: fewer than `MIN_RELEVANT` judged relevant. */
  dropped: { id: string; text: string; relevant: number }[];
  indexing: IndexingSplit;
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
  padTo?: number;
  /** Count of timed queries per speed measure. */
  timedQueries?: number;
  freshnessFiles?: number;
  /**
   * Accept relevance judged by the offline scripted judge: the fixture run and tests only. The
   * real manifest's judgements must come from a model shown the image.
   */
  scriptedJudgements?: boolean;
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

/** Time spent in each part of the shipped calls, added up as they run. */
export interface Timings {
  embedImagesMs: number;
  embedTextsMs: number;
  writeMs: number;
  embeddedImages: number;
  embeddedTexts: number;
}

const newTimings = (): Timings => ({
  embedImagesMs: 0,
  embedTextsMs: 0,
  writeMs: 0,
  embeddedImages: 0,
  embeddedTexts: 0,
});

/** The embedder as given, its two calls timed. */
function timedEmbedder(e: Embedder, t: Timings): Embedder {
  return {
    id: e.id,
    revision: e.revision,
    dimension: e.dimension,
    ...(e.route !== undefined && { route: e.route }),
    ...(e.model !== undefined && { model: e.model }),
    ...(e.paid !== undefined && { paid: e.paid }),
    async embedImages(images) {
      const t0 = performance.now();
      try {
        return await e.embedImages(images);
      } finally {
        t.embedImagesMs += performance.now() - t0;
        t.embeddedImages += images.length;
      }
    },
    async embedTexts(texts) {
      const t0 = performance.now();
      try {
        return await e.embedTexts(texts);
      } finally {
        t.embedTextsMs += performance.now() - t0;
        t.embeddedTexts += texts.length;
      }
    },
  };
}

const WRITES = new Set<string | symbol>([
  "recordEmbedder",
  "upsert",
  "remove",
  "removePaths",
  "recordBuiltFrom",
  "putSources",
  "removeSources",
  "cacheVectors",
  "optimize",
]);

/** The store as given, every write timed. */
function timedStore(store: Store, t: Timings): Store {
  return new Proxy(store, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function") return v;
      if (!WRITES.has(prop)) return v.bind(target);
      return async (...args: unknown[]) => {
        const t0 = performance.now();
        try {
          return await v.apply(target, args);
        } finally {
          t.writeMs += performance.now() - t0;
        }
      };
    },
  });
}

/** The bench's folder: one `LanceStore` (`search/`) and the work trees it indexes. */
export interface Bench {
  root: string;
  /** The store folder, as `<stateDir>/search` is: it holds the tables and `write.lock`. */
  dir: string;
  store: Store;
  embedder: Embedder;
  timings: Timings;
  close(): Promise<void>;
}

/** A temporary folder with an empty `LanceStore`, the embedder and store timed. */
export async function openBench(embedder: Embedder): Promise<Bench> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "bench-search-")));
  const dir = join(root, "search");
  const timings = newTimings();
  const lance = await LanceStore.open(dir, { embedder });
  return {
    root,
    dir,
    store: timedStore(lance, timings),
    embedder: timedEmbedder(embedder, timings),
    timings,
    async close() {
      lance.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** One work tree of the bench: its folder, the library over it, and the shipped index of it. */
export interface BenchTree {
  worktree: string;
  index: SearchIndex;
  store: Store;
  embedder: Embedder;
  address(imageId: string): string;
  /** The image id an address names, or undefined for a row that is not one of the images. */
  imageOf(address: string): string | undefined;
}

/**
 * A folder library, listed as core's reader lists files (a stat each) and loaded from disk: the
 * images with their labels as card fields, and every file under `folder` as a file with no image
 * view, which the freshness check stats but which adds no row.
 */
function folderLibrary(
  worktree: string,
  images: Map<string, Omit<LibraryItem, "size" | "mtimeMs">>,
  folder?: string,
): Library {
  return {
    async list() {
      const items: LibraryItem[] = [];
      for (const [path, item] of images) {
        const s = statSync(join(worktree, path));
        items.push({ ...item, size: s.size, mtimeMs: s.mtimeMs });
      }
      if (folder !== undefined) {
        const abs = join(worktree, folder);
        let names: string[];
        try {
          names = readdirSync(abs).sort();
        } catch {
          names = [];
        }
        for (const name of names) {
          const path = folder === "" ? name : `${folder}/${name}`;
          const s = statSync(join(abs, name));
          if (!s.isFile()) continue;
          items.push({
            path,
            size: s.size,
            mtimeMs: s.mtimeMs,
            source: "folder",
            id: path,
            address: `asset://bench-files/${path}`,
            text: "freshness file",
          });
        }
      }
      return items;
    },
    async load(item) {
      const bytes = new Uint8Array(await readFile(join(worktree, item.path)));
      return { bytes, views: images.has(item.path) ? [{ view: "", image: bytes }] : [] };
    },
    head: async () => "bench",
  };
}

/**
 * Writes `images` into a new work tree `<root>/<name>` and opens the shipped index of it in the
 * bench's store. Each image is a pick with its label's category as kind and pack as subject and
 * tags; with `cardText` its written card text is its text, as the labelled library's is.
 */
export async function benchTree(
  bench: Bench,
  o: {
    name: string;
    images: ManifestImage[];
    labels: Label[];
    source: ImageSource;
    cardText: boolean;
    /** A folder inside the work tree whose files the library lists too (freshness files). */
    folder?: string;
    /** False when the work tree already holds the images (an index rebuilt from it). */
    write?: boolean;
  },
): Promise<BenchTree> {
  const worktree = join(bench.root, o.name);
  await mkdir(worktree, { recursive: true });
  const label = new Map(o.labels.map((l) => [l.image, l]));
  const prefix = `asset://${o.name}/`;
  const items = new Map<string, Omit<LibraryItem, "size" | "mtimeMs">>();
  for (const image of o.images) {
    const l = label.get(image.id);
    if (!l) throw new Error(`image ${image.id} has no label`);
    const path = `${image.id}${extname(image.file)}`;
    if (o.write !== false) await writeFile(join(worktree, path), await o.source.bytes(image));
    items.set(path, {
      path,
      source: "pick",
      id: image.id,
      address: `${prefix}${image.id}`,
      kind: l.category,
      subject: l.pack,
      tags: [l.category, l.pack],
      ...(o.cardText && { text: image.card?.text ?? "" }),
    });
  }
  const index = await SearchIndex.open({
    dir: bench.dir,
    embedder: bench.embedder,
    store: bench.store,
    worktree,
    library: folderLibrary(worktree, items, o.folder),
  });
  return {
    worktree,
    index,
    store: bench.store,
    embedder: bench.embedder,
    address: (id) => `${prefix}${id}`,
    imageOf: (address) => (address.startsWith(prefix) ? address.slice(prefix.length) : undefined),
  };
}

/** The shipped find over one bench tree; the image ids it returns, best first. */
export async function find(tree: BenchTree, q: SearchQuery): Promise<string[]> {
  const r = await findWith(q, { embedder: tree.embedder, local: tree.index });
  return r.hits.map((h) => tree.imageOf(h.address)).filter((id): id is string => id !== undefined);
}

/** Indexes the labelled library through the shipped indexer, as `bench` in the bench's store. */
export async function indexLabelled(
  bench: Bench,
  manifest: Manifest,
  source: ImageSource,
  folder?: string,
): Promise<BenchTree> {
  const tree = await benchTree(bench, {
    name: "bench",
    images: manifest.images,
    labels: manifest.labels,
    source,
    cardText: true,
    folder,
  });
  await tree.index.index();
  return tree;
}

/** The rankings the bench scores by words, each a list of image ids, best first. */
export const RANKINGS = ["image-vector", "card-text-vector", "full-text", "fused"] as const;
export type Ranking = (typeof RANKINGS)[number];

/**
 * The top `depth` of every ranking the bench scores, for one written query: the shipped find's
 * three rankings (image vector, card-text vector, full text), each asked of the store as the find
 * asks it, and the find itself, which fuses them. The relevance pool is taken from these, so it
 * favours none of them.
 */
export async function rankingsFor(
  tree: BenchTree,
  text: string,
  depth: number,
): Promise<Record<Ranking, string[]>> {
  const [vec] = await tree.embedder.embedTexts([text]);
  const filter = [{ field: "tree", op: "=" as const, value: tree.index.tree }];
  const lists = await Promise.all(
    rankingQueries(text.trim(), { words: vec as Float32Array }, depth).map((q) =>
      tree.store.query({ ...q, filter }),
    ),
  );
  const ids = (i: number) =>
    (lists[i] ?? [])
      .map((h) => tree.imageOf(h.row.address))
      .filter((id): id is string => id !== undefined)
      .filter((id, n, all) => all.indexOf(id) === n)
      .slice(0, depth);
  return {
    "image-vector": ids(0),
    "card-text-vector": ids(1),
    "full-text": ids(2),
    fused: await find(tree, { words: text, limit: depth }),
  };
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

/** Rows standing in for the rest of 10,000 assets: in the tree searched, not under test. */
function paddingRows(count: number, dimension: number, tree: string): Row[] {
  const rand = prng(42);
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const unit = (): Float32Array =>
      normalize(Float32Array.from({ length: dimension }, () => rand() - 0.5));
    rows.push({
      key: `${tree}:pad/${i}.png#`,
      tree,
      id: `pad-${i}`,
      address: `asset://bench-pad/pad-${i}`,
      source: "pick",
      kind: "pad",
      subject: "pad",
      tags: [],
      text: `${VOCAB[i % 10]} ${VOCAB[(i * 7) % 10]} padding ${i}`,
      path: `pad/${i}.png`,
      sha256: `pad-${i}`,
      view: "",
      imageVec: unit(),
      textVec: unit(),
    });
  }
  return rows;
}

const round = (ms: number): number => Math.round(ms * 1000) / 1000;

export async function runBench(o: BenchOptions): Promise<BenchReport> {
  const { manifest, embedder } = o;
  const padTo = o.padTo ?? 10_000;
  const timed = o.timedQueries ?? 50;
  // By words reads only judged relevance: refuse a manifest whose labels are rule-made, unjudged,
  // scripted outside the fixture, or pooled by another embedder than the one scored here.
  const labelProblems = wordsLabelProblems(manifest, {
    embedder,
    scriptedJudgements: o.scriptedJudgements === true,
  });
  if (labelProblems.length > 0)
    throw new Error(
      `the written queries cannot be scored by words:\n${labelProblems.slice(0, 10).join("\n")}`,
    );
  const look = o.lookLibrary ?? { images: manifest.images, labels: manifest.labels };
  const lookLabel = new Map<string, Label>(look.labels.map((l) => [l.image, l]));
  for (const id of manifest.lookQueries) {
    if (!lookLabel.has(id)) throw new Error(`look query ${id} is not in the look library`);
  }
  const dropped = droppedQueries(manifest);
  const droppedIds = new Set(dropped.map((q) => q.id));
  const entries: BenchEntry[] = [];
  const mach = machine();
  const entry = (id: string, measured: number, n: number, speed = false) => {
    const bar = o.bars.get(id);
    if (!bar) throw new Error(`bar ${id} is not in the decisions record`);
    const e: BenchEntry = {
      bar: id,
      measured: round(measured),
      target: `${bar.op} ${bar.value}${bar.unit === "ms" ? " ms" : ""}`,
      pass: passes(bar, measured),
      unit: bar.unit,
      n,
    };
    if (speed) e.reference = mach.referenceBox;
    entries.push(e);
  };

  const bench = await openBench(embedder);
  let rebuilt: Bench | undefined;
  let lookBench: Bench | undefined;
  try {
    // Index the labelled library through the shipped indexer, timed as it runs.
    const t = bench.timings;
    const before = { ...t };
    const words = await benchTree(bench, {
      name: "bench",
      images: manifest.images,
      labels: manifest.labels,
      source: o.source,
      cardText: true,
      folder: "fresh",
    });
    const t0 = performance.now();
    await words.index.index();
    const totalMs = performance.now() - t0;
    const images = manifest.images.length;
    const embedImagesMs = t.embedImagesMs - before.embedImagesMs;
    const embedTextsMs = t.embedTextsMs - before.embedTextsMs;
    const writeMs = t.writeMs - before.writeMs;
    const indexing: IndexingSplit = {
      images,
      totalMs: round(totalMs),
      perImageMs: round(totalMs / Math.max(1, images)),
      embedImagesMs: round(embedImagesMs),
      embedTextsMs: round(embedTextsMs),
      writeMs: round(writeMs),
      otherMs: round(totalMs - embedImagesMs - embedTextsMs - writeMs),
      embeddedImages: t.embeddedImages - before.embeddedImages,
      embeddedTexts: t.embeddedTexts - before.embeddedTexts,
    };

    // By look, in the look library: the full library the by-look bars were set on
    // (docs/decisions.md), indexed in a store of its own so that the speed bars below time a store
    // of exactly padTo rows. Each query is `find --like <address>`; the query image is left out of
    // its own results.
    lookBench = await openBench(embedder);
    const lookTree = await benchTree(lookBench, {
      name: "bench-look",
      images: look.images,
      labels: look.labels,
      source: o.source,
      cardText: false,
    });
    await lookTree.index.index();
    const shareCategory: number[] = [];
    const pixelRecall: number[] = [];
    const recall: number[] = [];
    for (const id of manifest.lookQueries) {
      const l = lookLabel.get(id) as Label;
      const ranked = (
        await find(lookTree, { like: { address: lookTree.address(id) }, limit: 11 })
      ).filter((n) => n !== id);
      const top5 = ranked.slice(0, 5);
      const ok = top5.filter((n) => lookLabel.get(n)?.category === l.category).length >= 3 ? 1 : 0;
      shareCategory.push(ok);
      // Relevant: the other images of the same pack and category, as the spike measured it.
      const relevant = look.labels.filter(
        (x) => x.image !== id && x.category === l.category && x.pack === l.pack,
      );
      if (relevant.length > 0) {
        const top10 = new Set(ranked.slice(0, 10));
        const found = relevant.filter((r) => top10.has(r.image)).length;
        const r = found / Math.min(10, relevant.length);
        recall.push(r);
        if (l.pixel === 16) pixelRecall.push(r);
      }
    }
    entry("look-category", mean(shareCategory), shareCategory.length);
    entry("look-recall10", mean(recall), recall.length);
    entry("look-pixel16", mean(pixelRecall), pixelRecall.length);
    await lookBench.close();
    lookBench = undefined;

    // By words: the image-vector ranking alone, and the shipped find.
    const p5 = async (run: (text: string) => Promise<string[]>): Promise<number[]> => {
      const out: number[] = [];
      for (const q of manifest.writtenQueries) {
        // A query judged to have fewer than MIN_RELEVANT relevant images is dropped and reported.
        if (droppedIds.has(q.id)) continue;
        const top = await run(q.text);
        // An image ranked here that was never judged counts as not relevant (the pooling rule).
        out.push(precisionAt5(top, relevantOf(q)));
      }
      return out;
    };
    const imgP = await p5(async (text) => (await rankingsFor(words, text, 5))["image-vector"]);
    const shipP = await p5((text) => find(words, { words: text, limit: 5 }));
    entry("words-image-p5", mean(imgP), imgP.length);
    entry("words-shipped-p5", mean(shipP), shipP.length);

    // Filters return only matching rows; an index rebuilt from the same library answers
    // identically. Both through the shipped find, ranked by the first image's look.
    rebuilt = await openBench(embedder);
    const again = await benchTree(
      { ...rebuilt, root: bench.root },
      {
        name: "bench",
        images: manifest.images,
        labels: manifest.labels,
        source: o.source,
        cardText: true,
        folder: "fresh",
        write: false,
      },
    );
    await again.index.index();
    const kinds = [...new Set(manifest.labels.map((l) => l.category))];
    const kindOf = new Map(manifest.labels.map((l) => [l.image, l.category]));
    const first = manifest.images[0];
    let checks = 0;
    let good = 0;
    for (const kind of first ? kinds : []) {
      for (const op of ["=", "!="] as const) {
        checks++;
        const q: SearchQuery = {
          like: { address: words.address((first as ManifestImage).id) },
          where: [`kind${op}${kind}`],
          limit: 1000,
        };
        const hits = await find(words, q);
        const same = await find(again, q);
        const matches = (id: string) =>
          op === "=" ? kindOf.get(id) === kind : kindOf.get(id) !== kind;
        const expected = manifest.images.filter((i) => matches(i.id)).length;
        if (
          hits.every(matches) &&
          JSON.stringify(hits) === JSON.stringify(same) &&
          hits.length === expected
        )
          good++;
      }
    }
    entry("filters-rebuild", checks === 0 ? 0 : good / checks, checks);
    await rebuilt.close();
    rebuilt = undefined;

    // Speed: pad the labelled tree to padTo rows, then time the shipped find, which checks
    // freshness before it answers.
    await bench.store.upsert(
      paddingRows(Math.max(0, padTo - images), embedder.dimension, words.index.tree),
    );
    await bench.store.optimize();
    // The speed bars are set on a store of padTo rows: the timed finds search that and no more.
    const stored = (await bench.store.query({ limit: Number.MAX_SAFE_INTEGER })).length;
    if (stored !== Math.max(padTo, images))
      throw new Error(`the timed store holds ${stored} rows, not ${Math.max(padTo, images)}`);
    const queries = manifest.writtenQueries.map((q) => q.text);
    const textMs: number[] = [];
    for (let i = 0; i < timed; i++) {
      const t1 = performance.now();
      await find(words, { words: queries[i % queries.length] ?? "tile", limit: 10 });
      textMs.push(performance.now() - t1);
    }
    const imageMs: number[] = [];
    if (first) {
      const bytes = await o.source.bytes(first);
      for (let i = 0; i < timed; i++) {
        const t1 = performance.now();
        await find(words, { like: { image: bytes }, limit: 10 });
        imageMs.push(performance.now() - t1);
      }
    }

    // Freshness files: unchanged files the library lists beside the images. The fresh search
    // over 10,000 assets stats them with the images; the freshness bar checks them alone, a
    // work tree of their own.
    const count = o.freshnessFiles ?? 2000;
    const freshDir = join(words.worktree, "fresh");
    await mkdir(freshDir, { recursive: true });
    const when = new Date(1_700_000_000_000);
    for (let i = 0; i < count; i++) {
      const f = join(freshDir, `f${i}.png`);
      await writeFile(f, `file ${i}`);
      await utimes(f, when, when);
    }
    await words.index.refresh();
    const freshMs: number[] = [];
    for (let i = 0; i < timed; i++) {
      const t1 = performance.now();
      await find(words, { words: queries[i % queries.length] ?? "tile", limit: 10 });
      freshMs.push(performance.now() - t1);
    }
    entry("text-query-p95", percentile(textMs, 0.95), textMs.length, true);
    entry("image-query-p95", percentile(imageMs, 0.95), imageMs.length, true);
    entry("search-10k", Math.max(...freshMs), freshMs.length, true);
    entry("indexing", indexing.perImageMs, images, true);

    // Freshness: no changes, many files, the package's own check.
    const files = await benchTree(bench, {
      name: join("bench", "fresh"),
      images: [],
      labels: [],
      source: o.source,
      cardText: false,
      folder: "",
    });
    await files.index.index();
    const t2 = performance.now();
    const fresh = await files.index.refresh();
    const ms = performance.now() - t2;
    const changed = (fresh.stats?.written ?? 0) + (fresh.stats?.removed ?? 0);
    if (!fresh.fresh || changed !== 0)
      throw new Error("the freshness check saw changes in an unchanged folder");
    entry("freshness-2000", ms, count, true);

    const embedderInfo = {
      id: embedder.id,
      revision: embedder.revision,
      scripted: embedder.id.startsWith("scripted"),
    };
    return {
      entries,
      machine: mach,
      embedder: embedderInfo,
      images,
      paddedTo: padTo,
      dropped: dropped.map((q) => ({ id: q.id, text: q.text, relevant: relevantOf(q).length })),
      indexing,
    };
  } finally {
    if (rebuilt) await rebuilt.close();
    if (lookBench) await lookBench.close();
    await bench.close();
  }
}

/** One JSON line per bar, then the dropped written queries, the indexing split and the machine. */
/**
 * The bars a run missed that count on this machine: every quality bar, and a speed bar only on the
 * reference box (a speed entry off it carries `reference: false`).
 */
export function missedBars(r: BenchReport): BenchEntry[] {
  return r.entries.filter((e) => !e.pass && e.reference !== false);
}

export function formatReport(r: BenchReport): string[] {
  return [
    ...r.entries.map((e) => JSON.stringify(e)),
    JSON.stringify({ dropped: r.dropped }),
    JSON.stringify({ indexing: r.indexing }),
    JSON.stringify({
      embedder: r.embedder,
      machine: r.machine,
      images: r.images,
      paddedTo: r.paddedTo,
    }),
  ];
}
