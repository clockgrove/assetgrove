/**
 * Freshness (design section 7.4): stat the tree's indexable files, compare them with `sources`,
 * hash only changed files, take vectors from the cache, embed only unseen content, and drop
 * rows for files that are gone. The caller holds the write lock.
 */
import type { Embedder } from "./embedder.ts";
import { itemMeta, itemText, sha256Hex, type Library, type LibraryItem } from "./library.ts";
import type { CachedVector, EmbedderRecord, Row, SourceRow, Store } from "./store.ts";

/** The `view` under which a text's vector is cached. */
export const TEXT_VIEW = "#text";
const BATCH = 64;

export interface RefreshStats {
  /** Files whose rows were written: added, changed, or with changed card fields. */
  written: number;
  removed: number;
  /** Content the embedder was asked for. */
  embeddedImages: number;
  embeddedTexts: number;
}

export interface RefreshOptions {
  store: Store;
  embedder: Embedder;
  library: Library;
  tree: string;
  onProgress?: (done: number, total: number) => void;
}

export const embedderRecord = (e: Embedder): EmbedderRecord => ({
  id: e.id,
  revision: e.revision,
  ...(e.route !== undefined && { route: e.route }),
  ...(e.model !== undefined && { model: e.model }),
  dimension: e.dimension,
});

export const embedderKey = (e: Embedder): string => `${e.id}@${e.revision}`;

const vecKey = (sha256: string, view: string) => `${sha256}\0${view}`;

/** Brings one tree's rows up to date. Returns what it did; writes nothing when nothing changed. */
export async function refreshTree(o: RefreshOptions): Promise<RefreshStats> {
  const { store, library, tree } = o;
  const stats: RefreshStats = { written: 0, removed: 0, embeddedImages: 0, embeddedTexts: 0 };
  const items = await library.list();
  const known = new Map((await store.sources(tree)).map((s) => [s.path, s]));
  const listed = new Set(items.map((i) => i.path));

  const gone = [...known.keys()].filter((p) => !listed.has(p));
  if (gone.length > 0) {
    await store.removePaths(tree, gone);
    await store.removeSources(tree, gone);
    stats.removed = gone.length;
  }

  const stale = items.filter((item) => {
    const s = known.get(item.path);
    return !s || s.size !== item.size || s.mtimeMs !== item.mtimeMs || s.meta !== itemMeta(item);
  });
  for (let i = 0; i < stale.length; i += BATCH) {
    await refreshBatch(o, stale.slice(i, i + BATCH), known, stats);
    o.onProgress?.(Math.min(i + BATCH, stale.length), stale.length);
  }

  if (stats.written + stats.removed > 0 || !(await store.builtFrom(tree))) {
    const head = (await library.head?.()) ?? "";
    await store.recordBuiltFrom(tree, { head, at: new Date().toISOString() });
  }
  if (!(await store.embedder())) await store.recordEmbedder(embedderRecord(o.embedder));
  return stats;
}

export interface PendingWork {
  images: number;
  texts: number;
  /** sha256 hex over the stale items, the removed paths and the embedder key. */
  fingerprint: string;
}

/**
 * What `refreshTree` would embed, decided the same way and without embedding or writing: stale
 * items are loaded and hashed, touched-but-identical ones skipped, and content already in the
 * vector cache or shared within the pending work counted once or not at all. With `rebuild`
 * the tree's rows are taken as gone, so every item is stale; the vector cache still answers.
 */
export async function pendingWork(o: {
  store: Store;
  embedder: Embedder;
  library: Library;
  tree: string;
  rebuild?: boolean;
}): Promise<PendingWork> {
  const { store, library, tree } = o;
  const ek = embedderKey(o.embedder);
  const items = await library.list();
  const known = new Map((o.rebuild ? [] : await store.sources(tree)).map((s) => [s.path, s]));
  const listed = new Set(items.map((i) => i.path));
  const gone = [...known.keys()].filter((p) => !listed.has(p)).sort();
  const stale = items.filter((item) => {
    const s = known.get(item.path);
    return !s || s.size !== item.size || s.mtimeMs !== item.mtimeMs || s.meta !== itemMeta(item);
  });

  const wanted = new Map<string, { sha256: string; view: string; image: boolean }>();
  const changed: string[][] = [];
  for (const item of stale) {
    const loaded = await library.load(item);
    const sha256 = sha256Hex(loaded.bytes);
    const meta = itemMeta(item);
    const was = known.get(item.path);
    changed.push([item.path, String(item.size), String(item.mtimeMs), meta]);
    if (was && was.sha256 === sha256 && was.meta === meta) continue;
    for (const v of loaded.views) {
      wanted.set(vecKey(sha256, v.view), { sha256, view: v.view, image: true });
    }
    const text = itemText(item);
    wanted.set(vecKey(sha256Hex(text), TEXT_VIEW), {
      sha256: sha256Hex(text),
      view: TEXT_VIEW,
      image: false,
    });
  }
  const cached = new Set(
    (await store.cachedVectors(ek, [...wanted.values()])).map((c) => vecKey(c.sha256, c.view)),
  );
  const missing = [...wanted.entries()].filter(([k]) => !cached.has(k)).map(([, v]) => v);
  const fingerprint = sha256Hex(
    JSON.stringify({ changed: changed.sort(), gone, embedder: ek, rebuild: o.rebuild ?? false }),
  );
  return {
    images: missing.filter((m) => m.image).length,
    texts: missing.filter((m) => !m.image).length,
    fingerprint,
  };
}

async function refreshBatch(
  o: RefreshOptions,
  batch: LibraryItem[],
  known: Map<string, SourceRow>,
  stats: RefreshStats,
): Promise<void> {
  const { store, embedder, library, tree } = o;
  const ek = embedderKey(embedder);
  const sources: SourceRow[] = [];
  const toWrite: {
    item: LibraryItem;
    sha256: string;
    text: string;
    textSha: string;
    views: { view: string; image: Uint8Array }[];
  }[] = [];

  for (const item of batch) {
    const loaded = await library.load(item);
    const sha256 = sha256Hex(loaded.bytes);
    const meta = itemMeta(item);
    const source = { tree, path: item.path, size: item.size, mtimeMs: item.mtimeMs, sha256, meta };
    sources.push(source);
    const was = known.get(item.path);
    // Touched but identical: only the stat changes.
    if (was && was.sha256 === sha256 && was.meta === meta) continue;
    const text = itemText(item);
    toWrite.push({ item, sha256, text, textSha: sha256Hex(text), views: loaded.views });
  }

  // Vectors by content: the cache first, the embedder only for what it has never seen.
  const wanted = new Map<
    string,
    { sha256: string; view: string; image?: Uint8Array; text?: string }
  >();
  for (const w of toWrite) {
    for (const v of w.views)
      wanted.set(vecKey(w.sha256, v.view), { sha256: w.sha256, view: v.view, image: v.image });
    wanted.set(vecKey(w.textSha, TEXT_VIEW), { sha256: w.textSha, view: TEXT_VIEW, text: w.text });
  }
  const vectors = new Map<string, Float32Array>();
  for (const c of await store.cachedVectors(ek, [...wanted.values()])) {
    vectors.set(vecKey(c.sha256, c.view), c.vec);
  }
  const missing = [...wanted.entries()].filter(([k]) => !vectors.has(k)).map(([, v]) => v);
  const images = missing.filter((m) => m.image !== undefined);
  const texts = missing.filter((m) => m.text !== undefined);
  const fresh: CachedVector[] = [];
  if (images.length > 0) {
    const vecs = await embedder.embedImages(images.map((m) => m.image as Uint8Array));
    images.forEach((m, i) =>
      fresh.push({ sha256: m.sha256, view: m.view, vec: vecs[i] as Float32Array }),
    );
    stats.embeddedImages += images.length;
  }
  if (texts.length > 0) {
    const vecs = await embedder.embedTexts(texts.map((m) => m.text as string));
    texts.forEach((m, i) =>
      fresh.push({ sha256: m.sha256, view: m.view, vec: vecs[i] as Float32Array }),
    );
    stats.embeddedTexts += texts.length;
  }
  if (fresh.length > 0) {
    await store.cacheVectors(ek, fresh);
    for (const f of fresh) vectors.set(vecKey(f.sha256, f.view), f.vec);
  }

  const rows: Row[] = toWrite.flatMap(({ item, sha256, text, textSha, views }) =>
    (views.length ? views : [{ view: "" }]).map((v) => {
      const row: Row = {
        key: `${tree}:${item.path}#${v.view}`,
        tree,
        id: item.id,
        address: item.address,
        source: item.source,
        path: item.path,
        sha256,
        view: v.view,
        text,
        imageVec: vectors.get(vecKey(sha256, v.view)),
        textVec: vectors.get(vecKey(textSha, TEXT_VIEW)),
      };
      for (const f of [
        "game",
        "kind",
        "subject",
        "tags",
        "state",
        "bible",
        "license",
        "origin",
        "declaredOrigin",
        "originEvidence",
        "originSource",
        "originLicense",
        "digitalSourceType",
        "title",
        "description",
        "width",
        "height",
        "durationS",
        "form",
        "tempo",
        "mediaType",
        "mediaSha256",
        "mediaStatus",
        "mediaReason",
      ] as const) {
        if (item[f] !== undefined) (row as unknown as Record<string, unknown>)[f] = item[f];
      }
      return row;
    }),
  );
  // Views can change with the content, so a rewritten file's old rows go first.
  await store.removePaths(
    tree,
    toWrite.map((w) => w.item.path),
  );
  await store.upsert(rows);
  await store.putSources(sources);
  stats.written += toWrite.length;
}
