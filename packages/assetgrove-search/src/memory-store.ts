import { cosine } from "./embedder.ts";
import type { BuiltFrom, FilterTerm, Hit, Row, Store, StoreQuery } from "./store.ts";

function matches(row: Row, t: FilterTerm): boolean {
  if (t.op === "has") return (row.tags ?? []).includes(String(t.value));
  const v = (row as unknown as Record<string, unknown>)[t.field];
  switch (t.op) {
    case "=":
      return v === t.value;
    case "!=":
      return v !== t.value;
    case "<":
      return v !== undefined && (v as string | number) < t.value;
    case ">":
      return v !== undefined && (v as string | number) > t.value;
  }
}

const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** An exact in-memory store: flat cosine search, term-count full text. For tests and tiny libraries. */
export class MemoryStore implements Store {
  private rows = new Map<string, Row>();
  private built = new Map<string, BuiltFrom>();

  async upsert(rows: Row[]): Promise<void> {
    for (const r of rows) this.rows.set(r.key, structuredClone(r));
  }

  async remove(keys: string[]): Promise<void> {
    for (const k of keys) this.rows.delete(k);
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
}
