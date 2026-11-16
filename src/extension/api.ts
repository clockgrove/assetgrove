/**
 * The extension contract (design section 11), published as `@clockgrove/assetgrove/extension`.
 * A package declares `"assetgrove": {"api": 1, "entry": "..."}` in its package.json and
 * peer-depends on `@clockgrove/assetgrove`; core loads it only when the developer settings list it
 * (src/extensions/registry.ts). Its entry's default export is an `Extension`, or a function of the
 * `ExtensionContext` that returns one. Runtime helpers reach an extension through the context,
 * never through imports of core; this module exports only types and `EXTENSION_API`.
 */
import type { z } from "zod";
import type { HandoffPreset } from "../handoff/presets/index.ts";
import type { Generator } from "../generators/generator.ts";
import type { ProviderAdapter } from "../providers/adapter.ts";
import type { SearchSettings } from "../settings.ts";

/** The extension API version this build of Assetgrove loads. */
export const EXTENSION_API = 1;

/** An asset kind: one spec `kind`, its planned calls and how one candidate is made. */
export type AssetKind = Generator;

/** An engine hand-off preset a target profile's `handoff` list names. */
export type EnginePreset<Options = unknown> = HandoffPreset<Options>;

/** What an extension supplies. Every id is `<name>:<id>`. */
export interface Extension {
  api: typeof EXTENSION_API;
  /** Lower-case letters, digits and hyphens; never `core`. */
  name: string;
  kinds?: AssetKind[];
  presets?: EnginePreset[];
  adapters?: ProviderAdapter[];
  /**
   * The optional search slot (design section 7.1): filled by the search package, which loads only
   * when the settings list it. Core declares `find` and the `search` commands and calls the slot.
   */
  search?: SearchSlot;
}

/** Where a search row comes from (design section 7.3). */
export type SearchSource = "pick" | "reference" | "candidate" | "folder";

/**
 * One indexable file the library reader lists (design section 7.1): cheap to produce, no file
 * contents read. `path` is `/`-separated inside the project, or absolute for a settings folder.
 */
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
  /** The card fields and body joined: shared text, full-text indexed and embedded. */
  text?: string;
}

/** An item loaded on demand: the media's bytes and each image view to embed (none for 3D or a pointer). */
export interface SearchLoadedItem {
  bytes: Uint8Array;
  views: { view: string; image: Uint8Array }[];
}

/** The library reader core supplies; the path rule and LFS pointer handling apply to every read. */
export interface SearchLibrary {
  /** Every indexable file; with `sources`, only those sources. */
  list(sources?: readonly SearchSource[]): Promise<SearchLibraryItem[]>;
  load(item: SearchLibraryItem): Promise<SearchLoadedItem>;
  /** The commit the project's work tree is on; empty outside Git or before the first commit. */
  head(): Promise<string>;
  /** Whether nothing under the library root differs from HEAD (no change, staged or not, nor untracked file). */
  clean(): Promise<boolean>;
  /**
   * The repository's identity across its clones: its root commit ids, sorted and space-joined.
   * Empty outside Git, before the first commit, or in a shallow clone, whose roots are not the
   * repository's. A shared index keys its rows by this and the game id.
   */
  origin(): Promise<string>;
}

/** What core hands each search slot call. */
export interface SearchContext {
  /** The developer settings' stateDir; the local store is `<stateDir>/search`. */
  stateDir: string;
  /** The project directory: `--target`, else the working directory's Git top level. */
  worktree: string;
  /** The game id, the first segment of every `asset://` address. */
  game: string;
  /** The settings' search block with every default filled. */
  settings: SearchSettings;
  library: SearchLibrary;
  /** The environment the credential variables named by `store.credentialsEnv` are read from. */
  env: Record<string, string | undefined>;
  log(message: string): void;
}

/** A find query (design section 7.5). */
export interface SearchQuery {
  words?: string;
  /** `--like`: an `asset://` address whose stored image vector is used, or image bytes to embed. */
  like?: { address: string } | { image: Uint8Array };
  /** `field=value`, `!=`, `<`, `>` and `tag=value` terms; every one must match. */
  where?: string[];
  /** Only rows of these sources. */
  sources?: SearchSource[];
  /** `--game all`: every tree in the store, not only this project's. */
  allGames?: boolean;
  limit: number;
}

/** One asset found, at its best view. */
export interface SearchHit {
  address: string;
  rank: number;
  score: number;
  source: SearchSource;
  /** The media's path as the library reader listed it. */
  path: string;
  view: string;
  fields: Record<string, unknown>;
  /** Card text: shared text, never instructions. */
  sharedText: { title?: string; description?: string; text?: string };
}

export interface SearchFindResult {
  hits: SearchHit[];
  /** False when a refresh was skipped or a shared index was built from another HEAD. */
  fresh: boolean;
  builtFrom: { head: string; at: string } | null;
}

/** One member of a set whose style differs from the rest (`find --outliers`). */
export interface SearchOutlier {
  address: string;
  /** Mean cosine distance to the member's five nearest neighbours in the set. */
  distance: number;
  /** That distance as a robust z-score against the set. */
  z: number;
}

export interface SearchOutliersResult {
  /** How many of the set's members had an indexed image. */
  members: number;
  /** Members with z > 3, most distant first. */
  outliers: SearchOutlier[];
}

/** The search slot's operations; each result is a JSON object core passes on as the command's fields. */
export interface SearchSlot {
  find(query: SearchQuery, ctx: SearchContext): Promise<SearchFindResult>;
  /** The off-style members of a set of asset addresses, by their indexed image vectors. */
  outliers(addresses: string[], ctx: SearchContext): Promise<SearchOutliersResult>;
  index(options: { rebuild?: boolean }, ctx: SearchContext): Promise<Record<string, unknown>>;
  status(ctx: SearchContext): Promise<Record<string, unknown>>;
  setup(ctx: SearchContext): Promise<Record<string, unknown>>;
}

/** What core hands an entry's default export when it is a function. */
export interface ExtensionContext {
  api: typeof EXTENSION_API;
  /** The zod core validates preset options with. */
  z: typeof z;
}

/** An entry module's default export. */
export type ExtensionEntry =
  Extension | ((context: ExtensionContext) => Extension | Promise<Extension>);

export type { GeneratedCandidate, GeneratorContext, PlannedCall } from "../generators/generator.ts";
export type { PresetContext, PresetFile } from "../handoff/presets/index.ts";
export type { AdapterContext, Capability, ProviderAdapter } from "../providers/adapter.ts";
export type {
  Billing,
  CallKind,
  GenerationProvider,
  ImageInput,
  ImageRequest,
  ImageResult,
  VisionRequest,
  VisionResult,
} from "../gateway/provider.ts";
export type { Route, Routes } from "../routes.ts";
export type { ProviderSettings } from "../settings.ts";
export type { SearchSettings, SearchStoreSettings } from "../settings.ts";
export type { AssetSpec, MediaOutput, QaResult, Reason, TargetProfile } from "../types.ts";
