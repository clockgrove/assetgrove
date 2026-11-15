/**
 * The LanceDB store (design section 7.3): one rows table per embedder and revision, with its own
 * `sources` table for freshness and `built` table recording what each tree's rows were built
 * from, and one `vectors` table caching vectors by content and embedder. LanceDB is pinned
 * exactly and imported only after the platform check.
 *
 * The store takes no lock itself: a writer holds the package's write lock (`lock.ts`) around
 * every write and `optimize()`. Reads never create, repair or write anything.
 */
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type * as Arrow from "apache-arrow";
import type * as Lance from "@lancedb/lancedb";
import { assertSupportedPlatform } from "./platform.ts";
import { compileFilter } from "./where.ts";
import type { BuiltFrom, CachedVector, Hit, Row, SourceRow, Store, StoreQuery } from "./store.ts";

export interface LanceModules {
  lancedb: typeof Lance;
  arrow: typeof Arrow;
}

export interface LanceStoreOptions {
  /** The embedder whose vectors the rows table holds. */
  embedder: { id: string; revision: string; dimension: number };
  /** For tests: the platform to check instead of this process's. */
  platform?: { platform: string; arch: string };
  /** For tests: how LanceDB is imported. */
  importLance?: () => Promise<LanceModules>;
}

const importLanceDefault = async (): Promise<LanceModules> => ({
  lancedb: await import("@lancedb/lancedb"),
  arrow: await import("apache-arrow"),
});

const ROW_STRINGS = [
  "key",
  "tree",
  "game",
  "id",
  "address",
  "source",
  "kind",
  "subject",
  "state",
  "bible",
  "license",
  "title",
  "description",
  "text",
  "path",
  "sha256",
  "view",
] as const;
const REQUIRED = new Set(["key", "tree", "id", "address", "source", "path", "sha256"]);
/** Scalar indexes of design section 7.3; `tree` has many values, the others few. */
const SCALAR_INDEXES = [
  ["tree", "btree"],
  ["source", "bitmap"],
  ["kind", "bitmap"],
  ["state", "bitmap"],
] as const;

const sqlString = (s: string): string => `'${s.replaceAll("'", "''")}'`;
const sqlList = (xs: string[]): string => xs.map(sqlString).join(", ");
const byKey = (a: { key: string }, b: { key: string }): number =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

const tableSuffix = (embedder: { id: string; revision: string }): string => {
  const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `${safe(embedder.id)}_${safe(embedder.revision)}`;
};

/** `rows_<id>_<revision>` made safe for a table name. */
export function rowsTableName(embedder: { id: string; revision: string }): string {
  return `rows_${tableSuffix(embedder)}`;
}

/**
 * `sources_<id>_<revision>` and `built_<id>_<revision>`: freshness and built-from belong to one
 * rows table, so one embedder's index is never judged by what another indexed.
 */
export function sourcesTableName(embedder: { id: string; revision: string }): string {
  return `sources_${tableSuffix(embedder)}`;
}

export function builtTableName(embedder: { id: string; revision: string }): string {
  return `built_${tableSuffix(embedder)}`;
}

type Mode = "read" | "write";

export class LanceStore implements Store {
  readonly dir: string;
  private readonly m: LanceModules;
  private readonly dimension: number;
  private readonly rowsName: string;
  private readonly sourcesName: string;
  private readonly builtName: string;
  private db: Lance.Connection | undefined;
  private readonly tables = new Map<string, Lance.Table>();

  private constructor(dir: string, m: LanceModules, options: LanceStoreOptions) {
    this.dir = dir;
    this.m = m;
    this.dimension = options.embedder.dimension;
    this.rowsName = rowsTableName(options.embedder);
    this.sourcesName = sourcesTableName(options.embedder);
    this.builtName = builtTableName(options.embedder);
  }

  /**
   * Opens the store at `dir` without writing. On darwin-x64 it refuses with
   * `extension_unavailable` (reason `platform`) before LanceDB is imported.
   */
  static async open(dir: string, options: LanceStoreOptions): Promise<LanceStore> {
    assertSupportedPlatform(options.platform);
    const m = await (options.importLance ?? importLanceDefault)();
    return new LanceStore(dir, m, options);
  }

  private schemas(name: string): Arrow.Schema {
    const { Schema, Field, Utf8, Float32, Float64, FixedSizeList, List } = this.m.arrow;
    const str = (n: string, nullable = true) => new Field(n, new Utf8(), nullable);
    const num = (n: string) => new Field(n, new Float64(), false);
    const vec = (n: string) =>
      new Field(n, new FixedSizeList(this.dimension, new Field("item", new Float32(), true)), true);
    if (name === this.rowsName) {
      return new Schema([
        ...ROW_STRINGS.map((n) => str(n, !REQUIRED.has(n))),
        new Field("tags", new List(new Field("item", new Utf8(), true)), true),
        vec("imageVec"),
        vec("textVec"),
      ]);
    }
    if (name === this.sourcesName) {
      return new Schema([
        str("tree", false),
        str("path", false),
        num("size"),
        num("mtimeMs"),
        str("sha256", false),
        str("meta", false),
      ]);
    }
    if (name === "vectors") {
      return new Schema([
        str("sha256", false),
        str("view", false),
        str("embedder", false),
        new Field("vec", new List(new Field("item", new Float32(), true)), false),
      ]);
    }
    return new Schema([str("tree", false), str("head", false), str("at", false)]);
  }

  private async connection(): Promise<Lance.Connection> {
    // Strong consistency: every read sees what another process committed.
    this.db ??= await this.m.lancedb.connect(this.dir, { readConsistencyInterval: 0 });
    return this.db;
  }

  /**
   * The table, or undefined when it is missing in read mode. A table folder without
   * `_versions` (found by stat), or a store folder deleted under an open handle, means rebuild:
   * a writer recreates the table, and recreating the rows table also forgets `sources`, so the
   * next freshness pass re-adds every file.
   */
  private async table(name: string, mode: Mode): Promise<Lance.Table | undefined> {
    const folder = join(this.dir, `${name}.lance`);
    const present = await stat(join(folder, "_versions")).then(
      () => true,
      () => false,
    );
    if (present) {
      const open = this.tables.get(name);
      if (open) return open;
      const t = await (await this.connection()).openTable(name);
      this.tables.set(name, t);
      return t;
    }
    this.tables.delete(name);
    if (mode === "read") return undefined;
    await rm(folder, { recursive: true, force: true });
    if (name === this.rowsName) {
      this.tables.delete(this.sourcesName);
      await rm(join(this.dir, `${this.sourcesName}.lance`), { recursive: true, force: true });
    }
    // A deleted store folder leaves the connection pointing at nothing; connect afresh.
    this.db = undefined;
    const t = await (
      await this.connection()
    ).createEmptyTable(name, this.schemas(name), { mode: "overwrite" });
    this.tables.set(name, t);
    return t;
  }

  private async mergeInto(
    name: string,
    on: string | string[],
    records: Record<string, unknown>[],
  ): Promise<void> {
    if (records.length === 0) return;
    const t = (await this.table(name, "write")) as Lance.Table;
    const data = this.m.lancedb.makeArrowTable(records, { schema: this.schemas(name) });
    await t.mergeInsert(on).whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(data);
  }

  private async deleteFrom(name: string, where: string): Promise<void> {
    const t = await this.table(name, "read");
    if (t) await t.delete(where);
  }

  private async select(name: string, where: string): Promise<Record<string, unknown>[]> {
    const t = await this.table(name, "read");
    if (!t) return [];
    return (await t.query().where(where).toArray()) as Record<string, unknown>[];
  }

  async upsert(rows: Row[]): Promise<void> {
    const records = rows.map((r) => {
      const o: Record<string, unknown> = {};
      for (const n of ROW_STRINGS) o[n] = r[n] ?? null;
      o.tags = r.tags ?? null;
      o.imageVec = r.imageVec ? Array.from(r.imageVec) : null;
      o.textVec = r.textVec ? Array.from(r.textVec) : null;
      return o;
    });
    await this.mergeInto(this.rowsName, "key", records);
  }

  async remove(keys: string[]): Promise<void> {
    if (keys.length > 0) await this.deleteFrom(this.rowsName, `key IN (${sqlList(keys)})`);
  }

  async removePaths(tree: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.deleteFrom(
      this.rowsName,
      `tree = ${sqlString(tree)} AND path IN (${sqlList(paths)})`,
    );
  }

  private toRow(o: Record<string, unknown>): Row {
    const r: Record<string, unknown> = {};
    for (const n of ROW_STRINGS) if (o[n] !== null && o[n] !== undefined) r[n] = o[n];
    const list = (v: unknown) => (v as { toArray(): ArrayLike<unknown> }).toArray();
    if (o.tags !== null && o.tags !== undefined) r.tags = Array.from(list(o.tags)) as string[];
    for (const n of ["imageVec", "textVec"]) {
      if (o[n] !== null && o[n] !== undefined) r[n] = Float32Array.from(list(o[n]) as number[]);
    }
    return r as unknown as Row;
  }

  async query(q: StoreQuery): Promise<Hit[]> {
    const t = await this.table(this.rowsName, "read");
    if (!t) return [];
    const where = compileFilter(q.filter ?? []);
    let hits: Hit[];
    if (q.vector) {
      // Exact, flat search: no vector index is ever built (design section 7.3).
      let vq = t
        .vectorSearch(Array.from(q.vector.value))
        .column(q.vector.column)
        .distanceType("cosine")
        .bypassVectorIndex()
        .limit(q.limit);
      if (where) vq = vq.where(where);
      const found = (await vq.toArray()) as Record<string, unknown>[];
      hits = found.map((o) => ({ row: this.toRow(o), score: 1 - (o._distance as number) }));
    } else if (q.text !== undefined) {
      if (q.text.trim() === "" || !(await this.hasIndex(t, "text"))) return [];
      let fq = t
        .query()
        .fullTextSearch(q.text, { columns: ["text"] })
        .limit(q.limit);
      if (where) fq = fq.where(where);
      const found = (await fq.toArray()) as Record<string, unknown>[];
      hits = found.map((o) => ({ row: this.toRow(o), score: o._score as number }));
    } else {
      const query = where ? t.query().where(where) : t.query();
      const found = (await query.toArray()) as Record<string, unknown>[];
      return found
        .map((o) => ({ row: this.toRow(o), score: 0 }))
        .sort((a, b) => byKey(a.row, b.row))
        .slice(0, q.limit);
    }
    // Ties break by key, so equal stores answer in equal order.
    return hits.sort((a, b) => b.score - a.score || byKey(a.row, b.row));
  }

  private async hasIndex(t: Lance.Table, column: string): Promise<boolean> {
    return (await t.listIndices()).some((i) => i.columns.includes(column));
  }

  async recordBuiltFrom(tree: string, built: BuiltFrom): Promise<void> {
    await this.mergeInto(this.builtName, "tree", [{ tree, head: built.head, at: built.at }]);
  }

  async builtFrom(tree: string): Promise<BuiltFrom | undefined> {
    const [o] = await this.select(this.builtName, `tree = ${sqlString(tree)}`);
    return o ? { head: o.head as string, at: o.at as string } : undefined;
  }

  async sources(tree: string): Promise<SourceRow[]> {
    // Without a rows table its sources describe nothing that exists.
    if (!(await this.table(this.rowsName, "read"))) return [];
    return (await this.select(this.sourcesName, `tree = ${sqlString(tree)}`)).map((o) => ({
      tree: o.tree as string,
      path: o.path as string,
      size: o.size as number,
      mtimeMs: o.mtimeMs as number,
      sha256: o.sha256 as string,
      meta: o.meta as string,
    }));
  }

  async putSources(rows: SourceRow[]): Promise<void> {
    await this.mergeInto(
      this.sourcesName,
      ["tree", "path"],
      rows as unknown as Record<string, unknown>[],
    );
  }

  async removeSources(tree: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.deleteFrom(
      this.sourcesName,
      `tree = ${sqlString(tree)} AND path IN (${sqlList(paths)})`,
    );
  }

  async cachedVectors(
    embedder: string,
    keys: { sha256: string; view: string }[],
  ): Promise<CachedVector[]> {
    if (keys.length === 0) return [];
    const wanted = new Set(keys.map((k) => `${k.sha256}\0${k.view}`));
    const shas = [...new Set(keys.map((k) => k.sha256))];
    const found = await this.select(
      "vectors",
      `embedder = ${sqlString(embedder)} AND sha256 IN (${sqlList(shas)})`,
    );
    return found
      .filter((o) => wanted.has(`${o.sha256 as string}\0${o.view as string}`))
      .map((o) => ({
        sha256: o.sha256 as string,
        view: o.view as string,
        vec: Float32Array.from(
          (o.vec as { toArray(): ArrayLike<number> }).toArray() as ArrayLike<number>,
        ),
      }));
  }

  async cacheVectors(embedder: string, vectors: CachedVector[]): Promise<void> {
    await this.mergeInto(
      "vectors",
      ["sha256", "view", "embedder"],
      vectors.map((v) => ({ sha256: v.sha256, view: v.view, embedder, vec: Array.from(v.vec) })),
    );
  }

  /**
   * Builds the missing scalar and full-text indexes, then compacts every table and brings its
   * indexes up to date. Run by a writer under the write lock after a batch, never per upsert.
   */
  async optimize(): Promise<void> {
    const rows = await this.table(this.rowsName, "read");
    if (rows && (await rows.countRows()) > 0) {
      const have = new Set((await rows.listIndices()).flatMap((i) => i.columns));
      const { Index } = this.m.lancedb;
      for (const [column, kind] of SCALAR_INDEXES) {
        if (!have.has(column)) {
          await rows.createIndex(column, {
            config: kind === "btree" ? Index.btree() : Index.bitmap(),
          });
        }
      }
      if (!have.has("text")) await rows.createIndex("text", { config: Index.fts() });
    }
    for (const name of [this.rowsName, this.sourcesName, "vectors", this.builtName]) {
      const t = await this.table(name, "read");
      if (t) await t.optimize();
    }
  }

  /** Closes the open tables and the connection. */
  close(): void {
    for (const t of this.tables.values()) t.close();
    this.tables.clear();
    this.db?.close();
    this.db = undefined;
  }
}
