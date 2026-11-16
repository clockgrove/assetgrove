/**
 * The search package's entry for core's extension API (design sections 7.1, 7.2 and 7.8): fills
 * the `search` slot over a local index at `<stateDir>/search` and, when settings name one, a
 * shared remote store. LanceDB and Transformers.js load lazily, after the platform check.
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Extension,
  SearchContext,
  SearchFindResult,
  SearchForecast,
  SearchHit,
  SearchLibrary,
  SearchQuery,
  SearchSlot,
  SearchSource,
  SearchStoreSettings,
} from "./contract.ts";
import type { Embedder } from "./embedder.ts";
import { SearchError } from "./errors.ts";
import { bestViewPerAsset, rrf, SearchIndex } from "./find.ts";
import {
  embedderRecord,
  pendingWork,
  refreshTree,
  type PendingWork,
  type RefreshStats,
} from "./indexer.ts";
import { LanceStore } from "./lance-store.ts";
import { sha256Hex, type Library } from "./library.ts";
import { acquireWriteLock } from "./lock.ts";
import { RouteEmbedder } from "./route-embedder.ts";
import { MODEL_MANIFEST } from "./model-manifest.ts";
import { assertSupportedPlatform } from "./platform.ts";
import { ScriptedEmbedder } from "./scripted.ts";
import { loadSiglip2 } from "./siglip2.ts";
import { modelIsInstalled, setupModel } from "./setup.ts";
import type { BuiltFrom, EmbedderRecord, FilterTerm, Hit, Store } from "./store.ts";
import { parseWhere } from "./where.ts";

const embedders = new Map<string, Promise<Embedder>>();
const stores = new Map<string, Promise<LanceStore>>();

const modelsDir = (ctx: SearchContext): string => join(ctx.stateDir, "models");
const localDir = (ctx: SearchContext): string => join(ctx.stateDir, "search");

function embedderFor(ctx: SearchContext): Promise<Embedder> {
  if (ctx.settings.embedder === "route") {
    if (!ctx.embedder) {
      return Promise.reject(
        new SearchError(
          "settings_invalid",
          'search.embedder is "route" but no embeddings route resolved.',
          { hint: "Give the embeddings role a provider and model in the developer settings." },
        ),
      );
    }
    // Never cached: the port differs per call, a paid run's carrying `embed`.
    return Promise.resolve(new RouteEmbedder(ctx.embedder));
  }
  const key = `${ctx.settings.embedder}\0${modelsDir(ctx)}`;
  let p = embedders.get(key);
  if (!p) {
    p =
      ctx.settings.embedder === "scripted"
        ? Promise.resolve(new ScriptedEmbedder())
        : loadSiglip2(modelsDir(ctx));
    embedders.set(key, p);
    p.catch(() => embedders.delete(key));
  }
  return p;
}

function openCached(key: string, open: () => Promise<LanceStore>): Promise<LanceStore> {
  let p = stores.get(key);
  if (!p) {
    p = open();
    stores.set(key, p);
    p.catch(() => stores.delete(key));
  }
  return p;
}

async function closeCached(key: string): Promise<void> {
  const p = stores.get(key);
  stores.delete(key);
  if (p) (await p.catch(() => undefined))?.close();
}

const sameEmbedder = (a: EmbedderRecord, b: EmbedderRecord): boolean =>
  a.id === b.id && a.revision === b.revision && a.route === b.route && a.model === b.model;

const embedderLabel = (r: Pick<EmbedderRecord, "id" | "revision" | "route" | "model">): string =>
  r.route !== undefined ? `${r.id} ${r.route}/${r.model}` : `${r.id}@${r.revision}`;

/** One embedder per index: a store built by another embedder is rebuilt, never mixed. */
async function assertSameEmbedder(store: Store, embedder: Embedder, where: string): Promise<void> {
  const built = await store.embedder();
  const current = embedderRecord(embedder);
  if (!built || sameEmbedder(built, current)) return;
  throw new SearchError(
    "embedder_changed",
    `The index at ${where} was built by ${embedderLabel(built)} and this request uses ${embedderLabel(current)}. Run \`assetgrove search index --rebuild\` to rebuild it under the new embedder.`,
    {
      hint: "Run `assetgrove search index --rebuild` to rebuild it under the new embedder.",
      details: { built, current },
    },
  );
}

const remoteWhere = (ctx: SearchContext): string => (ctx.settings.store as SearchStoreSettings).uri;

/** Per URI scheme, each credential field and the object-store key Lance is handed it under. */
const CREDENTIAL_KEYS: Record<string, { field: CredentialField; key: string; optional?: true }[]> =
  {
    s3: [
      { field: "accessKeyId", key: "aws_access_key_id" },
      { field: "secretAccessKey", key: "aws_secret_access_key" },
      { field: "sessionToken", key: "aws_session_token", optional: true },
    ],
    gs: [{ field: "serviceAccountKey", key: "google_service_account_key" }],
    az: [
      { field: "accountName", key: "azure_storage_account_name" },
      { field: "accountKey", key: "azure_storage_account_key" },
    ],
  };
type CredentialField = keyof NonNullable<SearchStoreSettings["credentialsEnv"]>;

const settingsError = (message: string, details: Record<string, unknown>): SearchError =>
  new SearchError("settings_invalid", message, {
    details,
    hint: "Set the variables search.store.credentialsEnv names in the developer settings.",
  });

/**
 * The storage options Lance is given: the settings' endpoint and region, and the credentials the
 * settings name, under the keys the URI's scheme reads. A remote store is never opened without
 * them, so the object store never authenticates with credentials it finds on the machine.
 */
export function storageOptions(store: SearchStoreSettings, env: SearchContext["env"]) {
  const out: Record<string, string> = {};
  if (store.options.endpoint !== undefined) out.endpoint = store.options.endpoint;
  if (store.options.region !== undefined) out.region = store.options.region;
  const scheme = store.uri.slice(0, store.uri.indexOf(":"));
  const keys = CREDENTIAL_KEYS[scheme];
  const names = store.credentialsEnv ?? {};
  if (keys === undefined) {
    throw settingsError(`A ${scheme}:// store is not one search.store accepts.`, { scheme });
  }
  for (const { field, key, optional } of keys) {
    const name = names[field];
    if (name === undefined) {
      if (optional) continue;
      throw settingsError(
        `search.store.credentialsEnv names no ${field} variable; a ${scheme}:// store is never opened without explicit credentials.`,
        { field },
      );
    }
    const v = env[name];
    if (v === undefined || v === "") {
      throw settingsError(`The store credential variable ${name} is not set in the environment.`, {
        variable: name,
      });
    }
    out[key] = v;
  }
  return out;
}

const remoteKey = (uri: string, embedder: Embedder): string =>
  `remote\0${uri}\0${embedder.id}@${embedder.revision}`;

function openRemote(ctx: SearchContext, embedder: Embedder): Promise<LanceStore> {
  const store = ctx.settings.store as SearchStoreSettings;
  const isFile = store.uri.startsWith("file://");
  return openCached(remoteKey(store.uri, embedder), () =>
    LanceStore.open(isFile ? fileURLToPath(store.uri) : store.uri, {
      embedder,
      ...(!isFile && { storageOptions: storageOptions(store, ctx.env), remote: true }),
    }),
  );
}

/**
 * A shared index's tree key: the game id and the repository's root commits, so clones of one
 * repository share rows on every machine while two repositories with the same game id never do.
 */
async function sharedTree(ctx: SearchContext): Promise<string> {
  const origin = await ctx.library.origin();
  if (origin === "") {
    throw new SearchError(
      "invalid_input",
      "A shared index needs the repository's root commit, and this work tree has none (outside Git, before the first commit, or a shallow clone).",
      {
        hint: "Use a full clone with at least one commit, or drop search.store from the settings.",
      },
    );
  }
  return sha256Hex(`game:${ctx.game}\0origin:${origin}`);
}
const remoteLockDir = (ctx: SearchContext, uri: string): string =>
  join(localDir(ctx), "remote", sha256Hex(uri));

function adapt(
  lib: SearchLibrary,
  sources: readonly SearchSource[] | undefined,
  candidates = true,
) {
  const adapted: Library = {
    async list() {
      const items = await lib.list(sources);
      return candidates ? items : items.filter((i) => i.source !== "candidate");
    },
    load: (item) => lib.load(item as Parameters<SearchLibrary["load"]>[0]),
    head: () => lib.head(),
  };
  return adapted;
}

const REMOTE_SOURCES = ["pick", "reference"] as const;
const LOCAL_WITH_REMOTE = ["candidate", "folder"] as const;

const localLibrary = (ctx: SearchContext): Library =>
  adapt(ctx.library, ctx.settings.store ? LOCAL_WITH_REMOTE : undefined, ctx.settings.candidates);

async function localIndex(ctx: SearchContext, embedder: Embedder): Promise<SearchIndex> {
  const dir = localDir(ctx);
  const store = await openCached(`local\0${dir}\0${embedder.id}@${embedder.revision}`, () =>
    LanceStore.open(dir, { embedder }),
  );
  return SearchIndex.open({
    dir,
    embedder,
    store,
    worktree: ctx.worktree,
    library: localLibrary(ctx),
  });
}

const toHit = ({ row, score }: Hit, i: number): SearchHit => {
  const defined = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  return {
    address: row.address,
    rank: i + 1,
    score,
    source: row.source,
    path: row.path,
    view: row.view ?? "",
    fields: defined({
      game: row.game,
      kind: row.kind,
      subject: row.subject,
      tags: row.tags,
      state: row.state,
      bible: row.bible,
      license: row.license,
    }),
    sharedText: defined({ title: row.title, description: row.description, text: row.text }),
  };
};

async function likeVector(
  like: NonNullable<SearchQuery["like"]>,
  embedder: Embedder,
  searched: Store[],
): Promise<Float32Array> {
  if ("image" in like) return (await embedder.embedImages([like.image]))[0] as Float32Array;
  for (const store of searched) {
    const found = await store.query({
      filter: [{ field: "address", op: "=", value: like.address }],
      limit: 50,
    });
    const vec = found.find((h) => h.row.imageVec)?.row.imageVec;
    if (vec) return vec;
  }
  throw new SearchError("invalid_input", `No indexed image for ${like.address}.`, {
    details: { address: like.address },
  });
}

/** One store's answer to a query: fused when several rankings apply, filter-only otherwise. */
async function rank(
  store: Store,
  q: SearchQuery,
  filter: FilterTerm[],
  vectors: { words?: Float32Array; like?: Float32Array },
): Promise<Hit[]> {
  const pool = Math.max(4 * q.limit, 100);
  const lists: Promise<Hit[]>[] = [];
  const words = q.words?.trim() ?? "";
  if (vectors.words) {
    const value = vectors.words;
    lists.push(
      store.query({ vector: { column: "imageVec", value }, filter, limit: pool }),
      store.query({ vector: { column: "textVec", value }, filter, limit: pool }),
      store.query({ text: words, filter, limit: pool }),
    );
  }
  if (vectors.like) {
    lists.push(
      store.query({ vector: { column: "imageVec", value: vectors.like }, filter, limit: pool }),
    );
  }
  if (lists.length === 0) return store.query({ filter, limit: Number.MAX_SAFE_INTEGER });
  const results = await Promise.all(lists);
  return results.length === 1 ? bestViewPerAsset(results[0] as Hit[]) : rrf(results);
}

async function find(q: SearchQuery, ctx: SearchContext): Promise<SearchFindResult> {
  const filter: FilterTerm[] = parseWhere(q.where ?? []);
  const sources = q.sources ?? [];
  if (sources.length === 1) {
    filter.push({ field: "source", op: "=", value: sources[0] as SearchSource });
  }
  const embedder = await embedderFor(ctx);
  const local = await localIndex(ctx, embedder);
  const remote = ctx.settings.store ? await openRemote(ctx, embedder) : undefined;
  await assertSameEmbedder(local.store, embedder, localDir(ctx));
  if (remote) await assertSameEmbedder(remote, embedder, remoteWhere(ctx));
  // A hosted embedder spends, so without its paid-run port a read answers from stored vectors.
  const spends = ctx.settings.embedder === "route" && !ctx.embedder?.embed;
  const refreshed = spends ? false : (await local.refresh()).fresh;

  const words = q.words?.trim() ?? "";
  const vectors: { words?: Float32Array; like?: Float32Array } = {};
  if (words !== "") vectors.words = (await embedder.embedTexts([words]))[0] as Float32Array;
  if (q.like) {
    vectors.like = await likeVector(
      q.like,
      embedder,
      remote ? [local.store, remote] : [local.store],
    );
  }

  const within = (tree: string): FilterTerm[] =>
    q.allGames ? filter : [...filter, { field: "tree", op: "=", value: tree }];
  const answers = [await rank(local.store, q, within(local.tree), vectors)];
  if (remote) answers.push(await rank(remote, q, within(await sharedTree(ctx)), vectors));
  const ranking = vectors.words || vectors.like;
  // One image ranking is comparable across stores by similarity; fused rankings fuse again.
  const similarityOnly = !vectors.words && vectors.like;
  let ranked =
    answers.length === 1
      ? (answers[0] as Hit[])
      : similarityOnly
        ? answers.flat().sort((a, b) => b.score - a.score)
        : ranking
          ? rrf(answers)
          : answers.flat();
  if (sources.length > 1) ranked = ranked.filter((h) => sources.includes(h.row.source));

  const hits = bestViewPerAsset(ranked).slice(0, q.limit).map(toHit);
  if (!remote) {
    return { hits, fresh: refreshed, builtFrom: (await local.store.builtFrom(local.tree)) ?? null };
  }
  const built = await remote.builtFrom(await sharedTree(ctx));
  const fresh = refreshed && built !== undefined && built.head === (await ctx.library.head());
  return { hits, fresh, builtFrom: built ?? null };
}

async function index(
  options: { rebuild?: boolean },
  ctx: SearchContext,
): Promise<Record<string, unknown>> {
  const embedder = await embedderFor(ctx);
  const remoteSettings = ctx.settings.store;
  if (remoteSettings?.writer && !(await ctx.library.clean())) {
    throw new SearchError(
      "invalid_input",
      "The shared index is built from a clean HEAD, but there are uncommitted changes under the library root.",
      { hint: "Commit or stash the changes, then run `assetgrove search index` again." },
    );
  }
  if (options.rebuild) {
    await closeCached(`local\0${localDir(ctx)}\0${embedder.id}@${embedder.revision}`);
    const dir = localDir(ctx);
    const names = await readdir(dir).catch(() => [] as string[]);
    // `vectors.lance` is the content cache: a rebuild pays nothing twice for content it holds.
    for (const n of names.filter((n) => n.endsWith(".lance") && n !== "vectors.lance")) {
      await rm(join(dir, n), { recursive: true, force: true });
    }
  }
  const local = await localIndex(ctx, embedder);
  if (options.rebuild) await local.store.recordEmbedder(embedderRecord(embedder));
  else await assertSameEmbedder(local.store, embedder, localDir(ctx));
  const result: Record<string, unknown> = { local: await local.index() };
  if (!remoteSettings) return result;
  if (!remoteSettings.writer) {
    return { ...result, remote: { written: false, reason: "writer false" } };
  }
  const remote = await openRemote(ctx, embedder);
  const tree = await sharedTree(ctx);
  if (options.rebuild) await remote.recordEmbedder(embedderRecord(embedder));
  else await assertSameEmbedder(remote, embedder, remoteSettings.uri);
  const lock = await acquireWriteLock(remoteLockDir(ctx, remoteSettings.uri));
  try {
    const stats: RefreshStats = await refreshTree({
      store: remote,
      embedder,
      library: adapt(ctx.library, REMOTE_SOURCES),
      tree,
    });
    const built: BuiltFrom = { head: await ctx.library.head(), at: new Date().toISOString() };
    await remote.recordBuiltFrom(tree, built);
    await remote.optimize();
    result.remote = { written: true, uri: remoteSettings.uri, stats, builtFrom: built };
  } finally {
    await lock.release();
  }
  return result;
}

async function status(ctx: SearchContext): Promise<Record<string, unknown>> {
  const embedder = await embedderStatus(ctx);
  const out: Record<string, unknown> = {
    store: localDir(ctx),
    embedder,
    model: {
      installed: ctx.settings.embedder === "local" ? await modelIsInstalled(modelsDir(ctx)) : true,
    },
  };
  if (ctx.settings.embedder === "local" && !(out.model as { installed: boolean }).installed) {
    return out;
  }
  const real = await embedderFor(ctx);
  const local = await localIndex(ctx, real);
  out.recordedEmbedder = (await local.store.embedder()) ?? null;
  out.files = (await local.store.sources(local.tree)).length;
  out.builtFrom = (await local.store.builtFrom(local.tree)) ?? null;
  const remoteSettings = ctx.settings.store;
  if (remoteSettings) {
    const remote = await openRemote(ctx, real);
    const built = (await remote.builtFrom(await sharedTree(ctx))) ?? null;
    out.remote = {
      uri: remoteSettings.uri,
      writer: remoteSettings.writer,
      recordedEmbedder: (await remote.embedder()) ?? null,
      builtFrom: built,
      fresh: built !== null && built.head === (await ctx.library.head()),
    };
  }
  return out;
}

/** The embedder's identity without loading a model. */
async function embedderStatus(
  ctx: SearchContext,
): Promise<Pick<EmbedderRecord, "id" | "revision" | "route" | "model">> {
  if (ctx.settings.embedder === "scripted") {
    const { id, revision } = new ScriptedEmbedder();
    return { id, revision };
  }
  if (ctx.settings.embedder === "route") {
    const { id, revision, route, model } = await embedderFor(ctx);
    return { id, revision, route, model };
  }
  return { id: MODEL_MANIFEST.id, revision: MODEL_MANIFEST.revision };
}

async function setup(ctx: SearchContext): Promise<Record<string, unknown>> {
  if (ctx.settings.embedder === "scripted") return { model: "scripted", installed: true };
  if (ctx.settings.embedder === "route") return { model: "route", installed: true };
  const { dir } = await setupModel({ modelsDir: modelsDir(ctx), onProgress: ctx.log });
  return { dir, model: MODEL_MANIFEST.id, installed: true };
}

const sumPending = (a: PendingWork, b: PendingWork): PendingWork => ({
  images: a.images + b.images,
  texts: a.texts + b.texts,
  fingerprint: `${a.fingerprint}${b.fingerprint}`,
});

/** What a request would embed, counted without embedding, writing or calling the port. */
async function forecast(
  request: { index: { rebuild?: boolean } } | { find: SearchQuery },
  ctx: SearchContext,
): Promise<SearchForecast> {
  const embedder = await embedderFor(ctx);
  const rebuild = "index" in request ? request.index.rebuild === true : false;
  const local = await localIndex(ctx, embedder);
  if (!rebuild) await assertSameEmbedder(local.store, embedder, localDir(ctx));
  let pending = await pendingWork({
    store: local.store,
    embedder,
    library: localLibrary(ctx),
    tree: local.tree,
    rebuild,
  });
  let queries = 0;
  let query = "";
  if ("index" in request) {
    const remoteSettings = ctx.settings.store;
    if (remoteSettings?.writer) {
      const remote = await openRemote(ctx, embedder);
      if (!rebuild) await assertSameEmbedder(remote, embedder, remoteSettings.uri);
      pending = sumPending(
        pending,
        await pendingWork({
          store: remote,
          embedder,
          library: adapt(ctx.library, REMOTE_SOURCES),
          tree: await sharedTree(ctx),
        }),
      );
    }
  } else {
    const q = request.find;
    if (ctx.settings.store) {
      await assertSameEmbedder(await openRemote(ctx, embedder), embedder, remoteWhere(ctx));
    }
    const words = q.words?.trim() ?? "";
    if (words !== "") queries++;
    if (q.like && "image" in q.like) queries++;
    query = JSON.stringify({
      words,
      like: q.like && ("image" in q.like ? sha256Hex(q.like.image) : q.like.address),
    });
  }
  const state = sha256Hex(JSON.stringify({ pending: pending.fingerprint, query }));
  return { images: pending.images, texts: pending.texts, queries, state };
}

export const searchSlot: SearchSlot = { find, index, status, setup, forecast };

/** Core's entry: refuses on darwin-x64 before LanceDB or Transformers.js is imported. */
export default function searchExtension(_context: { api: 1 }): Extension {
  assertSupportedPlatform();
  return { api: 1, name: "search", search: searchSlot };
}
