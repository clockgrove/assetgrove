/**
 * The search index of one work tree (design sections 7.3 to 7.5): fresh before every query
 * unless another process holds the write lock, in which case the query answers at once from the
 * current table with `fresh: false` and writes nothing.
 */
import type { Embedder } from "./embedder.ts";
import { refreshTree, type RefreshStats } from "./indexer.ts";
import { LanceStore, type LanceStoreOptions } from "./lance-store.ts";
import { treeKey, type Library } from "./library.ts";
import { acquireWriteLock, tryAcquireWriteLock, type WriteLock } from "./lock.ts";
import type { BuiltFrom, FilterTerm, Hit, Row, Store, StoreQuery } from "./store.ts";
import { parseWhere, resolveOrdered } from "./where.ts";

/** Reciprocal Rank Fusion's constant (design section 7.5). */
export const RRF_K = 60;

export interface FindOptions {
  /** A words query: fused image-vector, card-text-vector and full-text rankings. */
  words?: string;
  /** `field=value`, `!=`, `<`, `>` and `tag=value` terms, all of which must match. */
  where?: string | string[];
  /** Search every tree in the store, not only this one (`--game all`). */
  allTrees?: boolean;
  limit?: number;
}

export interface FindHit {
  address: string;
  rank: number;
  score: number;
  source: Row["source"];
  path: string;
  view: string;
  fields: Pick<
    Row,
    | "game"
    | "kind"
    | "subject"
    | "tags"
    | "state"
    | "bible"
    | "license"
    | "origin"
    | "declaredOrigin"
    | "originEvidence"
    | "originSource"
    | "originLicense"
    | "digitalSourceType"
    | "width"
    | "height"
    | "mediaType"
    | "mediaSha256"
    | "mediaStatus"
    | "mediaReason"
  >;
  /** Card text: core passes it on only under `sharedText`. */
  sharedText: Pick<Row, "title" | "description" | "text">;
}

export interface FindResult {
  hits: FindHit[];
  fresh: boolean;
  builtFrom: BuiltFrom | undefined;
}

const assetOf = (h: Hit): string => `${h.row.tree}\0${h.row.id}`;

/** Keeps each asset's first row, in the order given: its best view in that ranking. */
export function bestViewPerAsset(hits: Hit[]): Hit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const asset = assetOf(h);
    if (seen.has(asset)) return false;
    seen.add(asset);
    return true;
  });
}

/**
 * Reciprocal Rank Fusion over assets: each list is first cut to one row per asset, its best
 * view there, and an asset scores Σ 1 / (k + rank), rank from 1. An asset keeps the view of its
 * best rank, earlier lists winning ties, so with the image-vector list first a turntable answers
 * at the view that looks most like the words.
 */
export function rrf(lists: Hit[][], k = RRF_K): Hit[] {
  const fused = new Map<string, { row: Row; score: number; best: number }>();
  for (const list of lists) {
    bestViewPerAsset(list).forEach((h, i) => {
      const asset = assetOf(h);
      const had = fused.get(asset);
      const add = 1 / (k + i + 1);
      if (!had) fused.set(asset, { row: h.row, score: add, best: i });
      else {
        had.score += add;
        if (i < had.best) Object.assign(had, { row: h.row, best: i });
      }
    });
  }
  return [...fused.values()]
    .map(({ row, score }) => ({ row, score }))
    .sort(
      (a, b) => b.score - a.score || (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0),
    );
}

export interface QueryVectors {
  words?: Float32Array;
  like?: Float32Array;
}

/** One store searched, with the filter its rows must match (its tree, the query's where terms). */
export interface Searched {
  store: Store;
  filter: FilterTerm[];
}

/** Each ranking's pool: four times the limit, at least 100. */
export const poolFor = (limit: number): number => Math.max(4 * limit, 100);

/**
 * The store queries a query ranks by, in fusion order: for words the image vector, the card-text
 * vector and the full text; for an image, its image vector. No filter set.
 */
export function rankingQueries(words: string, vectors: QueryVectors, limit: number): StoreQuery[] {
  const queries: StoreQuery[] = [];
  if (vectors.words) {
    const value = vectors.words;
    queries.push(
      { vector: { column: "imageVec", value }, limit },
      { vector: { column: "textVec", value }, limit },
      { text: words, limit },
    );
  }
  if (vectors.like) {
    queries.push({ vector: { column: "imageVec", value: vectors.like }, limit });
  }
  return queries;
}

/**
 * One ranking's answers from several stores, merged by the ranking's own score, best first; ties
 * keep the earlier store first. A single list is returned unchanged.
 */
export function mergeByScore(lists: Hit[][]): Hit[] {
  if (lists.length === 1) return lists[0] as Hit[];
  return lists.flat().sort((a, b) => b.score - a.score);
}

/**
 * A store's filter with each `bible<` and `bible>` term resolved to the `bible` values its rows
 * (under the other terms) hold on the asked side, in version order ("2" before "10").
 */
async function ordered(s: Searched): Promise<FilterTerm[]> {
  return resolveOrdered(s.filter, async (field, others) => {
    const rows = await s.store.query({ filter: others, limit: Number.MAX_SAFE_INTEGER });
    const values = rows.map(({ row }) => (row as unknown as Record<string, unknown>)[field]);
    return values.filter((v): v is string | number | boolean =>
      ["string", "number", "boolean"].includes(typeof v),
    );
  });
}

/**
 * The shipped ranking: each ranking asked of every store, merged across stores by its own score,
 * then fused once. With no ranking, every store's filtered rows, local first.
 */
export async function rankAcross(
  asked: Searched[],
  q: { words?: string; limit: number },
  vectors: QueryVectors,
): Promise<Hit[]> {
  const searched = await Promise.all(asked.map(async (s) => ({ ...s, filter: await ordered(s) })));
  const rankings = rankingQueries(q.words?.trim() ?? "", vectors, poolFor(q.limit));
  if (rankings.length === 0) {
    const rows = await Promise.all(
      searched.map((s) => s.store.query({ filter: s.filter, limit: Number.MAX_SAFE_INTEGER })),
    );
    return rows.flat();
  }
  const merged = await Promise.all(
    rankings.map(async (r) =>
      mergeByScore(
        await Promise.all(searched.map((s) => s.store.query({ ...r, filter: s.filter }))),
      ),
    ),
  );
  return merged.length === 1 ? bestViewPerAsset(merged[0] as Hit[]) : rrf(merged);
}

export interface SearchIndexOptions {
  /** The store folder, `<stateDir>/search`; it holds `write.lock`. */
  dir: string;
  embedder: Embedder;
  library: Library;
  /** The work tree whose rows this index keeps; its real path's sha256 is the `tree` key. */
  worktree: string;
  /** An already open store; otherwise LanceDB is opened at `dir`. */
  store?: Store;
  platform?: LanceStoreOptions["platform"];
  importLance?: LanceStoreOptions["importLance"];
  /** How long `index()` waits for another writer; queries never wait. */
  lockTimeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
}

export class SearchIndex {
  readonly dir: string;
  readonly tree: string;
  readonly store: Store;
  private readonly o: SearchIndexOptions;

  private constructor(o: SearchIndexOptions, store: Store) {
    this.o = o;
    this.dir = o.dir;
    this.tree = treeKey(o.worktree);
    this.store = store;
  }

  /** Opens without writing. Refuses on darwin-x64 before LanceDB is imported. */
  static async open(o: SearchIndexOptions): Promise<SearchIndex> {
    const store =
      o.store ??
      (await LanceStore.open(o.dir, {
        embedder: o.embedder,
        platform: o.platform,
        importLance: o.importLance,
      }));
    return new SearchIndex(o, store);
  }

  private async refreshUnder(
    lock: WriteLock,
    before?: (store: Store) => Promise<void>,
  ): Promise<RefreshStats> {
    try {
      if (before) await before(this.store);
      const stats = await refreshTree({
        store: this.store,
        embedder: this.o.embedder,
        library: this.o.library,
        tree: this.tree,
        onProgress: this.o.onProgress,
      });
      // One optimize per batch, under the lock.
      if (stats.written + stats.removed > 0) await this.store.optimize();
      return stats;
    } finally {
      await lock.release();
    }
  }

  /** Brings the tree up to date unless another process holds the lock; never waits. */
  async refresh(): Promise<{ fresh: boolean; stats?: RefreshStats }> {
    const lock = await tryAcquireWriteLock(this.dir);
    if (!lock) return { fresh: false };
    return { fresh: true, stats: await this.refreshUnder(lock) };
  }

  /**
   * The writer's path (`search index`): waits its turn for the lock, then refreshes. `before`
   * runs under the same lock first (a rebuild records its embedder there, so no concurrent
   * refresh sees the record missing).
   */
  async index(options: { before?: (store: Store) => Promise<void> } = {}): Promise<RefreshStats> {
    const lock = await acquireWriteLock(this.dir, { timeoutMs: this.o.lockTimeoutMs });
    return this.refreshUnder(lock, options.before);
  }

  async find(q: FindOptions): Promise<FindResult> {
    const filter: FilterTerm[] = q.where === undefined ? [] : parseWhere(q.where);
    const limit = q.limit ?? 20;
    const { fresh } = await this.refresh();
    if (!q.allTrees) filter.push({ field: "tree", op: "=", value: this.tree });

    const words = q.words?.trim() ?? "";
    const vec = words !== "" ? (await this.o.embedder.embedTexts([words]))[0] : undefined;
    const ranked = await rankAcross(
      [{ store: this.store, filter }],
      { words, limit },
      vec ? { words: vec } : {},
    );
    const hits = bestViewPerAsset(ranked) // one row per asset already after fusion
      .slice(0, limit)
      .map(({ row, score }, i): FindHit => ({
        address: row.address,
        rank: i + 1,
        score,
        source: row.source,
        path: row.path,
        view: row.view ?? "",
        fields: {
          game: row.game,
          kind: row.kind,
          subject: row.subject,
          tags: row.tags,
          state: row.state,
          bible: row.bible,
          license: row.license,
          origin: row.origin,
          declaredOrigin: row.declaredOrigin,
          originEvidence: row.originEvidence,
          originSource: row.originSource,
          originLicense: row.originLicense,
          digitalSourceType: row.digitalSourceType,
          width: row.width,
          height: row.height,
          mediaType: row.mediaType,
          mediaSha256: row.mediaSha256,
          mediaStatus: row.mediaStatus,
          mediaReason: row.mediaReason,
        },
        sharedText: { title: row.title, description: row.description, text: row.text },
      }));
    return { hits, fresh, builtFrom: await this.store.builtFrom(this.tree) };
  }

  close(): void {
    (this.store as { close?: () => void }).close?.();
  }
}
