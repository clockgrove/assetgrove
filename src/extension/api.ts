/**
 * The extension ("pack") contract (design section 11), published as
 * `@clockgrove/assetgrove/extension`. A package declares `"assetgrove": {"api": 2, "entry": "..."}`
 * in its package.json and a peer range on `@clockgrove/assetgrove`; core loads it only when the
 * developer settings list it, it speaks an api core speaks and the range admits core's version
 * (src/extensions/registry.ts, src/extensions/version.ts). Its entry's default export is an
 * `Extension`, or a function of the `ExtensionContext` that returns one. Runtime helpers reach a
 * pack through the context, never through imports of core by path; this module exports types,
 * `EXTENSION_API`, `EXTENSION_APIS` and zod's `z`.
 */
import { z } from "zod";
import type { ZodType } from "zod";
import type { HandoffPreset } from "../handoff/presets/index.ts";
import type { Generator } from "../generators/generator.ts";
import type { AdapterContext, ProviderAdapter } from "../providers/adapter.ts";
import type { SearchSettings } from "../settings.ts";
import type { prompt, qa, raster } from "./helpers.ts";
import type { SetupContext } from "./setup.ts";

/** The extension API version this build of Assetgrove speaks. */
export const EXTENSION_API = 2;

/** Every extension API version this build loads; a pack declaring another is refused. */
export const EXTENSION_APIS: readonly number[] = [EXTENSION_API];

/** The zod core validates preset options with, the same instance the context hands a pack. */
export { z };

export type { FrameLayout, FramesTrait } from "../frames.ts";

/** An asset kind: one spec `kind`, its planned calls and how one candidate is made. */
export type AssetKind = Generator;

/**
 * An engine hand-off preset a target profile's `handoff` list names: its async `write` gets `read`
 * for the target, and `scope: "families"` makes it write for every family of an asset so far.
 */
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
   * The zod schema of the pack's own settings, its block at `extensionSettings.<package>` in the
   * developer settings. Core parses the block (`{}` when the developer wrote none), so the schema's
   * defaults sit under the developer's values, and hands the result over as `context.settings`. An
   * invalid block is refused at load, naming the pack and each field; without a schema, any block
   * for the pack is refused.
   */
  settingsSchema?: ZodType;
  /**
   * The optional search slot (design section 7.1): filled by the search package, which loads only
   * when the settings list it. Core declares `find` and the `search` commands and calls the slot.
   */
  search?: SearchSlot;
  /**
   * The programs the pack may run, each `{ id: "<name>:<id>", setting }`: `setting` names the
   * top-level field of the pack's own settings that holds the executable's absolute path, so the
   * program comes from the developer settings, never from a profile. A preset runs one only through
   * its context's `run` (`ToolRunner`), under core's approval rules; an id it does not declare is
   * refused.
   */
  tools?: ToolDeclaration[];
  /**
   * Installs what the pack needs, when a person runs `assetgrove extensions setup <name>`: every
   * download goes through `ctx.download`, pinned to a version and a sha256 or sha512 the pack ships.
   */
  setup?(ctx: SetupContext): Promise<Record<string, unknown>>;
}

/** A program a pack declares (`Extension.tools`). */
export interface ToolDeclaration {
  /** `<name>:<id>`. */
  id: string;
  /** The top-level field of the pack's settings holding the executable's absolute path. */
  setting: string;
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
  origin?: string;
  declaredOrigin?: string;
  originEvidence?: string;
  originSource?: string;
  originLicense?: string;
  digitalSourceType?: string;

  title?: string;
  description?: string;
  width?: number;
  height?: number;
  mediaType?: string;
  mediaSha256?: string;
  mediaStatus?: "available" | "unavailable";
  mediaReason?: string;
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
  /**
   * Whether anything the shared index covers (the library root, the style bible and its reference
   * files) differs between `commit` and HEAD: `git diff --quiet <commit> HEAD -- <paths>`. True
   * when Git cannot tell (outside Git, or a commit this clone lacks). Optional in the contract: a
   * library without it leaves a shared index fresh only at the commit it was built from.
   */
  changedSince?(commit: string): Promise<boolean>;
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
  /**
   * The hosted embedder (design section 7.7), set only when `search.embedder` is `route`: the
   * provider and model the `embeddings` role resolves to.
   */
  embedder?: SearchRouteEmbedder;
  log(message: string): void;
}

/** The hosted embedder core resolved from the `embeddings` role. */
export interface SearchRouteEmbedder {
  /** The settings id of the provider the route names. */
  route: string;
  /** The route's model. */
  model: string;
  /** The vector width core asks the route for. */
  dimension: number;
  /**
   * Embeds one image (encoded bytes) or one text through core's `Caller`: reserved against the
   * caps, journalled and recorded in the spend ledger. Present only inside a confirmed paid run
   * (`find` with words or an image, `search index`); absent, nothing may call the provider, and
   * the slot answers from vectors already stored.
   */
  embed?(input: { image: Uint8Array } | { text: string }): Promise<number[]>;
}

/** What a request would embed, counted by the slot without embedding anything. */
export interface SearchForecast {
  /** Image views neither cached by content nor indexed unchanged. */
  images: number;
  /** Card texts likewise. */
  texts: number;
  /** Query embeddings: one for words, one for a `like` image. */
  queries: number;
  /** sha256 hex of the pending work, so the same work gives the same value. */
  state: string;
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

/**
 * The picks of `kind` ranked closest to the request's words (kind, subject, brief) fused with image
 * similarity to `references` (design section 7.6). No subject filter and no similarity threshold.
 */
export interface NearMatchQuery {
  kind: string;
  subject: string;
  /** The request's brief as one text: purpose, appearsIn, mood and context, joined by spaces. */
  brief?: string;
  /** The images the request sends, found by their bytes. */
  references: Uint8Array[];
  limit: number;
}

/** One member of a set as `find --outliers` ranks it (design section 7.5). */
export interface SearchRankedMember {
  address: string;
  /** Mean cosine distance of the member's indexed image to every other member's. */
  distance: number;
}

export interface SearchOutliersResult {
  /** How many of the set's members had an indexed image. */
  members: number;
  /**
   * Every one of those members, most distant first, uncut: a free ranking, never a verdict. Core
   * asks a `style-outlier` decision which of the most distant are drawn in another style.
   */
  ranking: SearchRankedMember[];
}

/** The search slot's operations; each result is a JSON object core passes on as the command's fields. */
export interface SearchSlot {
  /**
   * The picks of the query's kind ranked closest to its words (kind, subject, brief) fused with
   * image similarity to its references; no subject filter, no threshold. Optional: a slot without it gives no near matches.
   */
  nearMatch?(query: NearMatchQuery, ctx: SearchContext): Promise<SearchFindResult>;
  find(query: SearchQuery, ctx: SearchContext): Promise<SearchFindResult>;
  /** Every member of a set of asset addresses ranked by its indexed image's distance to the rest. */
  outliers(addresses: string[], ctx: SearchContext): Promise<SearchOutliersResult>;
  index(options: { rebuild?: boolean }, ctx: SearchContext): Promise<Record<string, unknown>>;
  status(ctx: SearchContext): Promise<Record<string, unknown>>;
  /**
   * The free plan step of a hosted embedder's paid request (design section 7.7): what `index` or
   * `find` would embed, counted from the index and the library without calling the embedder.
   */
  forecast?(
    request: { index: { rebuild?: boolean } } | { find: SearchQuery },
    ctx: SearchContext,
  ): Promise<SearchForecast>;
}

/** Core's raster functions: decode, encode, crop, scale, palette and grid (src/extension/helpers.ts). */
export type RasterHelpers = typeof raster;
/** Core's deterministic QA checks. */
export type QaHelpers = typeof qa;
/** The bible-to-prompt compiler. */
export type PromptHelpers = typeof prompt;

/** The run a call is made in, when a paid command's executor opened one. */
export interface RunInfo {
  /** Whether the run holds a verified confirmation to spend. */
  cleared: boolean;
  /** The run's id and directory, when it has a run directory. */
  id?: string;
  dir?: string;
}

/**
 * What core hands an entry's default export when it is a function: everything a pack needs from
 * core, so it imports none of core's modules by path.
 */
export interface ExtensionContext<Settings = Record<string, unknown>> {
  api: typeof EXTENSION_API;
  /**
   * The pack's settings: its `extensionSettings` block parsed by its `settingsSchema`, defaults
   * filled; `{}` when it declares none. Core fills it once the entry has returned the extension and
   * the block has passed, so reading it inside the entry's factory throws: read it when a kind,
   * preset or adapter runs. Optional in the type only so a hand-made context still compiles.
   */
  readonly settings?: Readonly<Settings>;
  /** The zod core validates preset options with. */
  z: typeof z;
  raster: RasterHelpers;
  qa: QaHelpers;
  prompt: PromptHelpers;
  /**
   * The guarded `fetch` for one provider instance: it refuses any host outside the adapter's
   * `fixedHosts` and the settings `baseURL` (when `endpointFromSettings`), re-checking every
   * redirect hop. Core hands the same as `AdapterContext.fetch`. It guards provider-steered URLs,
   * not pack code: a pack's SDK must take it as its `fetch`.
   */
  http(
    adapter: Pick<ProviderAdapter, "id" | "fixedHosts" | "endpointFromSettings">,
    c?: Pick<AdapterContext, "baseURL">,
  ): typeof fetch;
  run: {
    /** The current run, or undefined outside one. */
    current(): RunInfo | undefined;
  };
  /** One line to stderr, prefixed with the pack's package name. */
  log(message: string): void;
}

/** An entry module's default export. */
export type ExtensionEntry =
  Extension | ((context: ExtensionContext) => Extension | Promise<Extension>);

export type {
  GeneratedCandidate,
  GeneratorContext,
  KindCheck,
  KindCheckInput,
  PlannedCall,
} from "../generators/generator.ts";
export type { Caller } from "../calls.ts";
export type { ToolOutputFile, ToolResult, ToolRunOptions, ToolRunner, ToolStep } from "./tools.ts";
export type { PinnedDownload, SetupContext } from "./setup.ts";
export type { FilteringState, StabilityEntry } from "../qa/stability.ts";
export type {
  CallParameterName,
  CallParameters,
  KeyedCallParameters,
  PlannedCallParameters,
} from "../call-parameters.ts";
export type { Raster } from "../image/raster.ts";
export type {
  FamiliesContext,
  HandedOffFamily,
  PresetContext,
  PresetFile,
  TargetEntry,
  TargetRead,
  UsageCache,
  UsageContext,
  UsageReference,
  UsageReport,
} from "../handoff/presets/index.ts";
export type { AdapterContext, Capability, ProviderAdapter } from "../providers/adapter.ts";
export type {
  AnimateRequest,
  Billing,
  CallKind,
  CallTypes,
  DecisionAnswer,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  DecisionSource,
  DeclaredLimit,
  EmbedRequest,
  EmbedResult,
  GenerationProvider,
  ImageInput,
  ImageOutputParameters,
  ImageRequest,
  ImageResult,
  JobProvider,
  JobStatus,
  LimitReading,
  ModelRequest,
  ModelResult,
  ModelView,
  ProviderJobs,
  ProviderResult,
  RigRequest,
  VisionRequest,
  VisionResult,
} from "../gateway/provider.ts";
export type { Route, Routes } from "../routes.ts";
export type { ProviderSettings } from "../settings.ts";
export type { SearchSettings, SearchStoreSettings } from "../settings.ts";
export type {
  AssetSpec,
  Box,
  LoadedReference,
  MediaOutput,
  Point,
  QaResult,
  Reason,
  Rgb,
  Size,
  StyleBible,
  StyleProfile,
  TargetProfile,
} from "../types.ts";
export type { ResolvedStyle } from "../style.ts";
export type { SpecExpectation } from "../qa.ts";
export type { FrameGrid } from "../request.ts";
