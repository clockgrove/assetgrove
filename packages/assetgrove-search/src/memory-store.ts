import { cosine } from "./embedder.ts";
import { NUMERIC_FILTER_FIELDS } from "./where.ts";
import type {
  BuiltFrom,
  CachedVector,
  EmbedderRecord,
  FilterTerm,
  Hit,
  Row,
  Scalar,
  SourceRow,
  Store,
  StoreQuery,
} from "./store.ts";

function matches(row: Row, t: FilterTerm): boolean {
  if (t.op === "has") return (row.tags ?? []).includes(String(t.value));
  const v = (row as unknown as Record<string, unknown>)[t.field];
  if (t.op === "in") return v !== undefined && t.value.includes(v as Scalar);
  if (NUMERIC_FILTER_FIELDS.some((n) => n === t.field) && v === undefined) return false;
  switch (t.op) {
    case "=":
      return v === t.value;
    case "!=":
      return v !== t.value;
    case "<":
      return v !== undefined && (v as string | number) < t.value;
    case "<=":
      return v !== undefined && (v as string | number) <= t.value;
    case ">=":
      return v !== undefined && (v as string | number) >= t.value;
    case ">":
      return v !== undefined && (v as string | number) > t.value;
  }
}

const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** An exact in-memory store: flat cosine search, term-count full text. For tests and tiny libraries. */
export class MemoryStore implements Store {
  private rows = new Map<string, Row>();
  private built = new Map<string, BuiltFrom>();
  private sourceRows = new Map<string, SourceRow>();
  private vectors = new Map<string, Float32Array>();
  private record: EmbedderRecord | undefined;

  async embedder(): Promise<EmbedderRecord | undefined> {
    return this.record && { ...this.record };
  }

  async recordEmbedder(record: EmbedderRecord): Promise<void> {
    this.record = { ...record };
  }

  async upsert(rows: Row[]): Promise<void> {
    for (const r of rows) this.rows.set(r.key, structuredClone(r));
  }

  async remove(keys: string[]): Promise<void> {
    for (const k of keys) this.rows.delete(k);
  }

  async removePaths(tree: string, paths: string[]): Promise<void> {
    const gone = new Set(paths);
    for (const [k, r] of this.rows) if (r.tree === tree && gone.has(r.path)) this.rows.delete(k);
  }

  async query(q: StoreQuery): Promise<Hit[]> {
    const rows = [...this.rows.values()]
      .filter((r) => (q.filter ?? []).every((t) => matches(r, t)))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let hits: Hit[];
    if (q.vector) {
      const { column, value } = q.vector;
      hits = rows.flatMap((row) => {
        const v = row[column];
        return v ? [{ row, score: cosine(v, value) }] : [];
      });
    } else if (q.text !== undefined) {
      const terms = words(q.text);
      hits = rows
        .map((row) => {
          const have = words(row.text ?? "");
          return { row, score: terms.filter((t) => have.includes(t)).length / (terms.length || 1) };
        })
        .filter((h) => h.score > 0);
    } else {
      hits = rows.map((row) => ({ row, score: 0 }));
    }
    // Array.prototype.sort is stable, so ties keep key order.
    if (q.vector || q.text !== undefined) hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, q.limit);
  }

  async recordBuiltFrom(tree: string, built: BuiltFrom): Promise<void> {
    this.built.set(tree, built);
  }

  async builtFrom(tree: string): Promise<BuiltFrom | undefined> {
    return this.built.get(tree);
  }

  async sources(tree: string): Promise<SourceRow[]> {
    return [...this.sourceRows.values()].filter((s) => s.tree === tree).map((s) => ({ ...s }));
  }

  async putSources(rows: SourceRow[]): Promise<void> {
    for (const r of rows) this.sourceRows.set(`${r.tree}\0${r.path}`, { ...r });
  }

  async removeSources(tree: string, paths: string[]): Promise<void> {
    for (const p of paths) this.sourceRows.delete(`${tree}\0${p}`);
  }

  async cachedVectors(
    embedder: string,
    keys: { sha256: string; view: string }[],
  ): Promise<CachedVector[]> {
    return keys.flatMap(({ sha256, view }) => {
      const vec = this.vectors.get(`${embedder}\0${sha256}\0${view}`);
      return vec ? [{ sha256, view, vec }] : [];
    });
  }

  async cacheVectors(embedder: string, vectors: CachedVector[]): Promise<void> {
    for (const v of vectors) this.vectors.set(`${embedder}\0${v.sha256}\0${v.view}`, v.vec);
  }

  async optimize(): Promise<void> {}
}
