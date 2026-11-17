/**
 * The extension contract's search slot, mirrored structurally from core's
 * `src/extension/api.ts` and `src/settings.ts` (the package never imports core). Keep identical.
 */
export type SearchSource = "pick" | "reference" | "candidate" | "folder";

export interface SearchLibraryItem {
  path: string;
  size: number;
  mtimeMs: number;
  source: SearchSource;
  id: string;
  address: string;
  game?: string;
  kind?: string;
  subject?: string;
  tags?: string[];
  state?: string;
  bible?: string;
  license?: string;
  title?: string;
  description?: string;
  text?: string;
}

export interface SearchLoadedItem {
  bytes: Uint8Array;
  views: { view: string; image: Uint8Array }[];
}

export interface SearchLibrary {
  list(sources?: readonly SearchSource[]): Promise<SearchLibraryItem[]>;
  load(item: SearchLibraryItem): Promise<SearchLoadedItem>;
  head(): Promise<string>;
  clean(): Promise<boolean>;
  /**
   * The repository's identity across its clones: its root commit ids, sorted and space-joined.
   * Empty outside Git, before the first commit, or in a shallow clone, whose roots are not the
   * repository's. A shared index keys its rows by this and the game id.
   */
  origin(): Promise<string>;
  /**
   * Whether anything the shared index covers (the library root, the style bible and its reference
   * files) differs between `commit` and HEAD; true when Git cannot tell. Optional: without it a
   * shared index is fresh only at the commit it was built from.
   */
  changedSince?(commit: string): Promise<boolean>;
}

export interface SearchStoreSettings {
  uri: string;
  options: { endpoint?: string; region?: string };
  /** Per scheme: s3 accessKeyId, secretAccessKey, sessionToken?; gs serviceAccountKey; az accountName, accountKey. */
  credentialsEnv?: {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    serviceAccountKey?: string;
    accountName?: string;
    accountKey?: string;
  };
  writer: boolean;
}

export interface SearchSettings {
  store?: SearchStoreSettings;
  embedder: "local" | "scripted" | "route";
  model: "siglip2-base";
  candidates: boolean;
  nearMatch: boolean;
  folders: string[];
}

/** The hosted embedder core resolved from the `embeddings` role; set only when settings.search.embedder is "route". */
export interface SearchRouteEmbedder {
  /** The settings id of the provider the route names. */
  route: string;
  /** The route's model. */
  model: string;
  /** Vector width; core requests 768. */
  dimension: number;
  /**
   * Embeds one image (encoded bytes) or one text through core's Caller: reserved, journalled, ledgered.
   * Present only inside a confirmed paid run; absent, nothing may call the provider.
   */
  embed?(input: { image: Uint8Array } | { text: string }): Promise<number[]>;
}

export interface SearchContext {
  stateDir: string;
  worktree: string;
  game: string;
  settings: SearchSettings;
  library: SearchLibrary;
  env: Record<string, string | undefined>;
  embedder?: SearchRouteEmbedder;
  log(message: string): void;
}

export interface SearchQuery {
  words?: string;
  like?: { address: string } | { image: Uint8Array };
  where?: string[];
  sources?: SearchSource[];
  allGames?: boolean;
  limit: number;
}

export interface SearchHit {
  address: string;
  rank: number;
  score: number;
  source: SearchSource;
  path: string;
  view: string;
  fields: Record<string, unknown>;
  sharedText: { title?: string; description?: string; text?: string };
}

export interface SearchFindResult {
  hits: SearchHit[];
  fresh: boolean;
  builtFrom: { head: string; at: string } | null;
}

/** The picked assets closest to a request, ranked, with no similarity cut (design section 7.6). */
export interface NearMatchQuery {
  kind: string;
  subject: string;
  /** The request's brief as one text. */
  brief?: string;
  /** The images the request sends; picks are also ranked by image similarity to these. */
  references: Uint8Array[];
  limit: number;
}

export interface SearchRankedMember {
  address: string;
  distance: number;
}

export interface SearchOutliersResult {
  members: number;
  ranking: SearchRankedMember[];
}

/** What a request would embed, counted without embedding anything. */
export interface SearchForecast {
  /** Image views neither in the vector cache nor already indexed unchanged. */
  images: number;
  /** Card texts likewise. */
  texts: number;
  /** Query embeddings: 1 for words, 1 for a `like` image; 0 otherwise. */
  queries: number;
  /** sha256 hex over the pending work (stale/new item paths+size+mtime+meta, removed paths, the embedder key, the query), so the same pending work gives the same value. */
  state: string;
}

export interface SearchSlot {
  nearMatch?(query: NearMatchQuery, ctx: SearchContext): Promise<SearchFindResult>;
  outliers(addresses: string[], ctx: SearchContext): Promise<SearchOutliersResult>;
  find(query: SearchQuery, ctx: SearchContext): Promise<SearchFindResult>;
  index(options: { rebuild?: boolean }, ctx: SearchContext): Promise<Record<string, unknown>>;
  status(ctx: SearchContext): Promise<Record<string, unknown>>;
  setup(ctx: SearchContext): Promise<Record<string, unknown>>;
  forecast?(
    request: { index: { rebuild?: boolean } } | { find: SearchQuery },
    ctx: SearchContext,
  ): Promise<SearchForecast>;
}

export interface Extension {
  api: 1;
  name: string;
  search?: SearchSlot;
}
