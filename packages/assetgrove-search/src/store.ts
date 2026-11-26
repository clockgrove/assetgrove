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
  origin?: string;
  declaredOrigin?: string;
  originEvidence?: string;
  originSource?: string;
  originLicense?: string;
  digitalSourceType?: string;
  /** The game id, kept for display. */
  game?: string;
  title?: string;
  description?: string;
  width?: number;
  height?: number;
  /** An audio file's length, in seconds. */
  durationS?: number;
  /** A music card's form: `track` or `cue`. */
  form?: string;
  /** A music card's requested tempo, in beats per minute. */
  tempo?: number;
  mediaType?: string;
  mediaSha256?: string;
  mediaStatus?: "available" | "unavailable";
  mediaReason?: string;
  /** Full-text searched. */
  text?: string;
  path: string;
  sha256: string;
  view?: string;
  imageVec?: Float32Array;
  textVec?: Float32Array;
}

export type FilterOp = "=" | "!=" | "<" | ">" | "<=" | ">=" | "has" | "in";
/**
 * A parsed filter term; a store never receives an unparsed string. All terms must match. `in`
 * keeps a row whose field is one of `value` (an empty list keeps none).
 */
export type FilterTerm =
  | { field: string; op: Exclude<FilterOp, "in">; value: Scalar }
  | { field: string; op: "in"; value: Scalar[] };

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

/** What a tree's row set was built from: one per indexable file (design section 7.3, `sources`). */
export interface SourceRow {
  tree: string;
  /** The file's path inside the work tree, `/`-separated. */
  path: string;
  size: number;
  mtimeMs: number;
  /** sha256 of the file's bytes. */
  sha256: string;
  /** sha256 of the item's card fields and text, so a card edit alone re-embeds only its text. */
  meta: string;
}

/** A cached vector, keyed by content: `view` is the image view, or `#text` for a text's vector. */
export interface CachedVector {
  sha256: string;
  view: string;
  vec: Float32Array;
}

/** What made an index's vectors; one per store. */
export interface EmbedderRecord {
  id: string;
  revision: string;
  route?: string;
  model?: string;
  dimension: number;
}

export interface Store {
  /** The embedder that made this store's vectors, or undefined before its first write. */
  embedder(): Promise<EmbedderRecord | undefined>;
  recordEmbedder(record: EmbedderRecord): Promise<void>;
  upsert(rows: Row[]): Promise<void>;
  remove(keys: string[]): Promise<void>;
  /** Removes every row of these paths in one tree. */
  removePaths(tree: string, paths: string[]): Promise<void>;
  /** With neither vector nor text, returns filtered rows in key order. */
  query(q: StoreQuery): Promise<Hit[]>;
  recordBuiltFrom(tree: string, built: BuiltFrom): Promise<void>;
  builtFrom(tree: string): Promise<BuiltFrom | undefined>;
  sources(tree: string): Promise<SourceRow[]>;
  putSources(rows: SourceRow[]): Promise<void>;
  removeSources(tree: string, paths: string[]): Promise<void>;
  /** Cached vectors of one embedder (`<id>@<revision>`), by `sha256` and `view`. */
  cachedVectors(
    embedder: string,
    keys: { sha256: string; view: string }[],
  ): Promise<CachedVector[]>;
  cacheVectors(embedder: string, vectors: CachedVector[]): Promise<void>;
  /** Compacts and indexes after a batch of writes; a writer calls it under the write lock. */
  optimize(): Promise<void>;
}
