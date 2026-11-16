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
}

export interface SearchStoreSettings {
  uri: string;
  options: { endpoint?: string; region?: string };
  credentialsEnv?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  writer: boolean;
}

export interface SearchSettings {
  store?: SearchStoreSettings;
  embedder: "local" | "scripted";
  model: "siglip2-base";
  candidates: boolean;
  nearMatch: boolean;
  folders: string[];
}

export interface SearchContext {
  stateDir: string;
  worktree: string;
  game: string;
  settings: SearchSettings;
  library: SearchLibrary;
  env: Record<string, string | undefined>;
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

export interface SearchSlot {
  find(query: SearchQuery, ctx: SearchContext): Promise<SearchFindResult>;
  index(options: { rebuild?: boolean }, ctx: SearchContext): Promise<Record<string, unknown>>;
  status(ctx: SearchContext): Promise<Record<string, unknown>>;
  setup(ctx: SearchContext): Promise<Record<string, unknown>>;
}

export interface Extension {
  api: 1;
  name: string;
  search?: SearchSlot;
}
