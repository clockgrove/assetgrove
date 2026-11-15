/** The store interface: one place for the vector database vendor. */

export type Scalar = string | number | boolean;

/** One row per image view. Vector columns are `imageVec` and `textVec`. */
export interface Row {
  /** Unique key within a table. */
  key: string;
  tree: string;
  id: string;
  address: string;
  source: "pick" | "reference" | "candidate" | "folder";
  kind?: string;
  subject?: string;
  tags?: string[];
  state?: string;
  bible?: string;
  license?: string;
  /** The game id, kept for display. */
  game?: string;
  title?: string;
  description?: string;
  /** Full-text searched. */
  text?: string;
  path: string;
  sha256: string;
  view?: string;
  imageVec?: Float32Array;
  textVec?: Float32Array;
}

export type FilterOp = "=" | "!=" | "<" | ">" | "has";
/** A parsed filter term; a store never receives an unparsed string. All terms must match. */
export interface FilterTerm {
  field: string;
  op: FilterOp;
  value: Scalar;
}

export interface StoreQuery {
  /** Rank by cosine similarity of this vector against `column`. */
  vector?: { column: "imageVec" | "textVec"; value: Float32Array };
  /** Rank by full-text match against `text`. */
  text?: string;
  filter?: FilterTerm[];
  limit: number;
}

export interface Hit {
  row: Row;
  score: number;
}

export interface BuiltFrom {
  head: string;
  at: string;
}

export interface Store {
  upsert(rows: Row[]): Promise<void>;
  remove(keys: string[]): Promise<void>;
  /** With neither vector nor text, returns filtered rows in key order. */
  query(q: StoreQuery): Promise<Hit[]>;
  recordBuiltFrom(tree: string, built: BuiltFrom): Promise<void>;
  builtFrom(tree: string): Promise<BuiltFrom | undefined>;
}
