/**
 * `find`, `search index`, `search status` and `search setup` (design section 7): core declares
 * them with `requires: "search"` and calls the search slot of the extension that fills it, handing
 * it the library reader (src/search/reader.ts). While no loaded extension fills the slot, help and
 * the tool list leave them out and a call exits 2 `extension_unavailable` (src/commands/runner.ts).
 * Core never imports the search package.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { keyValue } from "../env.ts";
import type { Env } from "../env.ts";
import { InputError, ProviderError } from "../errors.ts";
import { registerKeyEnv } from "../redact.ts";
import { EXIT } from "../errors.ts";
import type { SearchContext, SearchQuery, SearchSlot, SearchSource } from "../extension/api.ts";
import { CORE_REGISTRY } from "../extensions/registry.ts";
import { createLibraryReader } from "../search/reader.ts";
import type { LibraryReader } from "../search/reader.ts";
import { writeFindSheet } from "../search/sheet.ts";
import type { SearchSettings, Settings } from "../settings.ts";
import { formatAddress, parseAddress } from "../tree/address.ts";
import { openProject, projectDir } from "../tree/project.ts";
import { readTree } from "../tree/read.ts";
import { defineCommand } from "./types.ts";
import type { RunContext } from "./types.ts";

const TARGET = {
  type: "string",
  description:
    "the project whose library to search; the working directory's Git top level by default",
  placeholder: "<dir>",
} as const;

export const SEARCH_SOURCES: readonly SearchSource[] = ["pick", "reference", "candidate", "folder"];

/** The settings' search block with every default filled; the defaults when the file has none. */
export function searchSettings(settings: Settings): SearchSettings {
  return (
    settings.search ?? {
      embedder: "local",
      model: "siglip2-base",
      candidates: true,
      nearMatch: true,
      folders: [],
    }
  );
}

/** The slot and the context one call hands it. */
export async function searchCall(
  command: string,
  target: string | undefined,
  ctx: RunContext,
  needsProject = true,
): Promise<{ slot: SearchSlot; context: SearchContext; reader: LibraryReader }> {
  const slot = (ctx.extensions ?? CORE_REGISTRY).requireSearch(command);
  const settings = searchSettings(ctx.settings);
  const dir = projectDir(target);
  const reader = await createLibraryReader({
    dir,
    stateDir: ctx.settings.stateDir,
    settings,
  }).catch((error: unknown) => {
    // Setup downloads the model, which needs no project.
    if (needsProject) throw error;
    return noProject(error);
  });
  const context: SearchContext = {
    stateDir: ctx.settings.stateDir,
    worktree: dir,
    game: reader.game,
    settings,
    library: reader,
    env: credentialEnv(settings, ctx.env),
    log: ctx.log,
  };
  return { slot, context, reader };
}

/**
 * The store's credential variables, named by `search.store.credentialsEnv`, and nothing else of
 * the environment; their values are redacted from every log from here on.
 */
function credentialEnv(settings: SearchSettings, env?: Env): Record<string, string | undefined> {
  const names = Object.values(settings.store?.credentialsEnv ?? {});
  registerKeyEnv(names);
  return Object.fromEntries(names.map((name) => [name, keyValue(name, env)]));
}

/** The reader of a call that needs no project: every read refuses with why there is none. */
function noProject(cause: unknown): LibraryReader {
  const refuse = async (): Promise<never> => {
    throw cause;
  };
  return {
    game: "",
    list: refuse,
    load: refuse,
    head: async () => "",
    clean: async () => false,
    origin: async () => "",
    loadImageByPath: async () => undefined,
  };
}

/**
 * A slot error as core's exit table has it: a code of the table keeps its exit; a failed model
 * download is a provider error (exit 4); any other code is `invalid_input` naming that code.
 */
export function slotError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (!(error instanceof Error) || typeof code !== "string" || Object.hasOwn(EXIT, code))
    return error;
  if (code === "setup_failed" || code === "hash_mismatch")
    return new ProviderError(`${code}: ${error.message}`, { cause: error });
  return new InputError(`${code}: ${error.message}`, { cause: error });
}

export async function calling<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw slotError(error);
  }
}

interface FindArgs {
  words?: string;
  like?: string;
  where?: string[];
  source?: string[];
  game?: string;
  limit?: number;
  outliers?: string;
  target?: string;
}

/**
 * The asset addresses of a tree folder, every page of it, as the search index names them (an asset
 * has no trailing slash).
 */
async function folderMembers(dir: string, stateDir: string, set: string): Promise<string[]> {
  const project = await openProject(dir, stateDir);
  const members: string[] = [];
  let address: string | undefined = set;
  while (address !== undefined) {
    const read = await readTree(project, address);
    const document = read.document as
      { kind?: string; children?: { address: string; kind: string }[]; next?: string } | undefined;
    if (!read.folder || document?.kind !== "folder") {
      throw new InputError(`--outliers ${set} is not a folder address of the asset tree`);
    }
    for (const child of document.children ?? []) {
      if (child.kind !== "asset" && child.kind !== "candidate") continue;
      const at = parseAddress(child.address);
      members.push(formatAddress(at.game, at.segments));
    }
    address = document.next;
  }
  return members;
}

/**
 * One find, as the `find` command and the tree's search paths both run it (design sections 2 and
 * 7.5): the same slot call over the same query, so both return the same hits. `sheet` is false for
 * a resource read, which writes nothing.
 */
export async function runFind(
  args: FindArgs,
  ctx: RunContext,
  options: { sheet: boolean },
): Promise<{ fields: Record<string, unknown>; human: string }> {
  for (const source of args.source ?? [])
    if (!(SEARCH_SOURCES as readonly string[]).includes(source))
      throw new InputError(`unknown --source "${source}"; use ${SEARCH_SOURCES.join(", ")}`);
  const { slot, context, reader } = await searchCall("find", args.target, ctx);
  if (args.game !== undefined && args.game !== "all" && args.game !== context.game)
    throw new InputError(`--game takes all or this project's game "${context.game}"`);
  if (args.outliers !== undefined) {
    const members = await folderMembers(context.worktree, ctx.settings.stateDir, args.outliers);
    const result = await calling(() => slot.outliers(members, context));
    const human = [
      ...result.outliers.map((o) => `${o.address} (z ${o.z.toFixed(2)})`),
      `${result.outliers.length} outlier${result.outliers.length === 1 ? "" : "s"} among ${result.members} members of ${args.outliers}`,
    ].join("\n");
    return { fields: { set: args.outliers, ...result }, human };
  }
  let like: SearchQuery["like"];
  if (args.like !== undefined) {
    if (args.like.startsWith("asset://")) like = { address: args.like };
    else {
      try {
        like = { image: new Uint8Array(await readFile(args.like)) };
      } catch (error) {
        throw new InputError(`--like ${args.like} cannot be read`, { cause: error });
      }
    }
  }
  const query: SearchQuery = {
    ...(args.words !== undefined && args.words.trim() !== "" && { words: args.words }),
    ...(like && { like }),
    ...(args.where !== undefined && args.where.length > 0 && { where: args.where }),
    ...(args.source !== undefined &&
      args.source.length > 0 && { sources: args.source as SearchSource[] }),
    ...(args.game === "all" && { allGames: true }),
    limit: args.limit ?? 20,
  };
  const result = await calling(() => slot.find(query, context));
  const fields: Record<string, unknown> = {
    hits: result.hits,
    fresh: result.fresh,
    builtFrom: result.builtFrom,
  };
  let sheet: string | undefined;
  if (options.sheet) {
    const images = await Promise.all(result.hits.map((hit) => reader.loadImageByPath(hit.path)));
    sheet = await writeFindSheet(
      result.hits,
      images,
      join(ctx.settings.stateDir, "search", "sheets"),
    );
    fields["sheet"] = sheet;
  }
  const human = [
    ...result.hits.map((h) => `${h.rank}. ${h.address} (${h.source}, ${h.score.toFixed(4)})`),
    `${result.hits.length} hit${result.hits.length === 1 ? "" : "s"}${result.fresh ? "" : " (index not fresh)"}${sheet ? `; sheet ${sheet}` : ""}`,
  ].join("\n");
  return { fields, human };
}

export const findCommand = defineCommand<FindArgs>({
  name: "find",
  tool: "find",
  requires: "search",
  summary: "search the library by words, by look or by fields",
  details: `Needs the search package (@clockgrove/assetgrove-search) listed under extensions in the
developer settings. Words rank by fusing the image vector, the card-text vector and full text;
--like ranks by look against an asset:// address's image or an image file; --where keeps rows whose
fields match (field=value, !=, <, >, tag=value; fields kind, subject, state, bible, license,
source, game, id, address, path, view, title). Returns hits [{address, rank, score, source, path,
view, fields, sharedText}] (card text only under sharedText), fresh, builtFrom, and sheet: a PNG of
the hits numbered by rank, which the tool also returns as image content. The index is brought up
to date first unless another process is writing it (fresh false then). --outliers <folder> instead
lists the members of an asset:// folder whose indexed image is off the rest (mean cosine distance
to its five nearest neighbours, as a robust z above 3): {set, members, outliers: [{address,
distance, z}]}. Spends nothing; writes only
the index and the sheet under the state directory.`,
  input: {
    type: "object",
    properties: {
      words: { type: "string", description: "the words to search for", placeholder: "[words]" },
      like: {
        type: "string",
        description: "an asset:// address or an image file to rank by look",
        placeholder: "<address|path>",
      },
      where: {
        type: "array",
        items: { type: "string" },
        description: "a field filter (field=value, !=, <, >, tag=value); repeat for more",
        placeholder: "<filter>",
      },
      source: {
        type: "array",
        items: { type: "string" },
        description: `only rows of this source (${SEARCH_SOURCES.join(", ")}); repeat for more`,
        placeholder: "<source>",
      },
      game: {
        type: "string",
        description: "all to search every game in the store; this project's game by default",
        placeholder: "all",
      },
      limit: { type: "integer", description: "the most hits", default: 20, minimum: 1 },
      outliers: {
        type: "string",
        description:
          "an asset:// folder address (a kind, subject, tag or the root): list its members whose look is off the set's (robust z above 3) instead of searching",
        placeholder: "<set>",
      },
      target: TARGET,
    },
    additionalProperties: false,
  },
  positionals: [{ name: "words" }],
  effect: { readOnly: true, spends: "never", writes: "state" },
  async run(args, ctx) {
    const { fields, human } = await runFind(args, ctx, { sheet: true });
    return { exitCode: 0, fields, human };
  },
});

interface IndexArgs {
  rebuild?: boolean;
  target?: string;
}

export const searchIndexCommand = defineCommand<IndexArgs>({
  name: "search index",
  tool: "search_index",
  requires: "search",
  summary: "bring the search index up to date",
  details: `Needs the search package. Waits for the index's write lock, then indexes what changed:
picks, bible references, run candidates and the settings' folders. With a shared store
(search.store) and writer true it also builds the shared index from pick and reference rows,
refused (exit 2 invalid_input) while files under the library root differ from HEAD. --rebuild
starts the local index afresh. Spends nothing; writes the index under the state directory.`,
  input: {
    type: "object",
    properties: {
      rebuild: { type: "boolean", description: "delete the local index and build it afresh" },
      target: TARGET,
    },
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "never", writes: "state" },
  async run(args, ctx) {
    const { slot, context } = await searchCall("search index", args.target, ctx);
    const fields = await calling(() =>
      slot.index(args.rebuild === true ? { rebuild: true } : {}, context),
    );
    return { exitCode: 0, fields, human: JSON.stringify(fields, null, 2) };
  },
});

export const searchStatusCommand = defineCommand<{ target?: string }>({
  name: "search status",
  tool: "search_status",
  requires: "search",
  summary: "show the search index, its model and its shared store",
  details: `Needs the search package. Reports the local store, the embedder and whether its model is
installed, what the index was built from, and the shared store with whether it is fresh for this
work tree's HEAD. Reads only.`,
  input: { type: "object", properties: { target: TARGET }, additionalProperties: false },
  effect: { readOnly: true, spends: "never", writes: "none" },
  async run(args, ctx) {
    const { slot, context } = await searchCall("search status", args.target, ctx);
    const fields = await calling(() => slot.status(context));
    return { exitCode: 0, fields, human: JSON.stringify(fields, null, 2) };
  },
});

export const searchSetupCommand = defineCommand<{ target?: string }>({
  name: "search setup",
  tool: "search_setup",
  requires: "search",
  summary: "download the search model and check it against its pinned hashes",
  details: `Needs the search package. Downloads the pinned model to <stateDir>/models from its
fixed host, else its fixed mirror, and checks every file against the sha256 values the package
ships; a failed download or a mismatch exits 4. Free; writes only under the state directory.`,
  input: { type: "object", properties: { target: TARGET }, additionalProperties: false },
  effect: { readOnly: false, spends: "never", writes: "state" },
  async run(args, ctx) {
    const { slot, context } = await searchCall("search setup", args.target, ctx, false);
    const fields = await calling(() => slot.setup(context));
    return { exitCode: 0, fields, human: JSON.stringify(fields, null, 2) };
  },
});
