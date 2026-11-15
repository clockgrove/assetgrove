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
import type { BuiltFrom, FilterTerm, Hit, Row, Store } from "./store.ts";
import { parseWhere } from "./where.ts";

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
  fields: Pick<Row, "game" | "kind" | "subject" | "tags" | "state" | "bible" | "license">;
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

  private async refreshUnder(lock: WriteLock): Promise<RefreshStats> {
    try {
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

  /** The writer's path (`search index`): waits its turn for the lock, then refreshes. */
  async index(): Promise<RefreshStats> {
    const lock = await acquireWriteLock(this.dir, { timeoutMs: this.o.lockTimeoutMs });
    return this.refreshUnder(lock);
  }

  async find(q: FindOptions): Promise<FindResult> {
    const filter: FilterTerm[] = q.where === undefined ? [] : parseWhere(q.where);
    const limit = q.limit ?? 20;
    const { fresh } = await this.refresh();
    if (!q.allTrees) filter.push({ field: "tree", op: "=", value: this.tree });

    let ranked: Hit[];
    const words = q.words?.trim() ?? "";
    if (words !== "") {
      const pool = Math.max(4 * limit, 100);
      const [vec] = await this.o.embedder.embedTexts([words]);
      const value = vec as Float32Array;
      const lists = await Promise.all([
        this.store.query({ vector: { column: "imageVec", value }, filter, limit: pool }),
        this.store.query({ vector: { column: "textVec", value }, filter, limit: pool }),
        this.store.query({ text: words, filter, limit: pool }),
      ]);
      ranked = rrf(lists);
    } else {
      ranked = await this.store.query({ filter, limit: Number.MAX_SAFE_INTEGER });
    }
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
        },
        sharedText: { title: row.title, description: row.description, text: row.text },
      }));
    return { hits, fresh, builtFrom: await this.store.builtFrom(this.tree) };
  }

  close(): void {
    (this.store as { close?: () => void }).close?.();
  }
}
