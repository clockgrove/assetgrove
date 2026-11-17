/**
 * `find`, `search index`, `search status` and `search setup` (design section 7): core declares
 * them with `requires: "search"` and calls the search slot of the extension that fills it, handing
 * it the library reader (src/search/reader.ts). While no loaded extension fills the slot, help and
 * the tool list leave them out and a call exits 2 `extension_unavailable` (src/commands/runner.ts).
 * Core never imports the search package.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Budget, runCap } from "../budget.ts";
import { Caller } from "../calls.ts";
import { keyValue } from "../env.ts";
import type { Env } from "../env.ts";
import { InputError, ProviderError } from "../errors.ts";
import { registerKeyEnv } from "../redact.ts";
import { EXIT } from "../errors.ts";
import type {
  SearchContext,
  SearchForecast,
  SearchOutliersResult,
  SearchQuery,
  SearchRouteEmbedder,
  SearchSlot,
  SearchSource,
} from "../extension/api.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import type { ProviderSet } from "../providers/set.ts";
import { sniffMediaType } from "../request.ts";
import { EMBED_OPERATION, STYLE_OUTLIER_OPERATION } from "../routes.ts";
import type { Route } from "../routes.ts";
import {
  DRY_RUN_PROPERTY,
  ROUND_PROPERTY,
  RUNS_PROPERTY,
  buildWorkPlan,
  canonicalJson,
  jobOf,
  paidBy,
} from "../runs/plan.ts";
import type { WorkPlan } from "../runs/plan.ts";
import { ledgerFor } from "../spend.ts";
import { dryRunOutcome, formatWork } from "./result.ts";
import { CORE_REGISTRY } from "../extensions/registry.ts";
import { createLibraryReader } from "../search/reader.ts";
import type { LibraryReader } from "../search/reader.ts";
import { writeFindSheet } from "../search/sheet.ts";
import type { SearchSettings, Settings } from "../settings.ts";
import { folderChildren, resolveMembers } from "../audit/members.ts";
import { BIBLE_PATH } from "../init.ts";
import { sha256Hex } from "../library/canonical.ts";
import {
  bibleStyleText,
  judgeStyleOutlier,
  selectMembers,
  styleOutlierWork,
} from "../search/style-outliers.ts";
import type { StyleAnswer } from "../search/style-outliers.ts";
import { openProject, projectDir } from "../tree/project.ts";
import { defineCommand } from "./types.ts";
import type { CommandSpec, JsonSchemaProperty, Outcome, RunContext } from "./types.ts";

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
  embedder?: SearchRouteEmbedder,
): Promise<{ slot: SearchSlot; context: SearchContext; reader: LibraryReader }> {
  const slot = (ctx.extensions ?? CORE_REGISTRY).requireSearch(command);
  const settings = searchSettings(ctx.settings);
  // A hosted embedder with no port given: the route's identity, so the slot embeds nothing.
  if (embedder === undefined && needsProject && settings.embedder === "route")
    embedder = (await embedRoute(undefined, ctx)).embedder;
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
    ...(embedder && { embedder }),
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
    changedSince: async () => true,
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

/** The width hosted vectors are asked for: the index schema's (design section 7.3). */
export const EMBED_DIMENSION = 768;

/** Whether the settings embed through the `embeddings` role (design section 7.7). */
function hosted(ctx: RunContext): boolean {
  return searchSettings(ctx.settings).embedder === "route";
}

/** What a hosted request's arguments carry beside the command's own. */
interface PaidArgs {
  cap?: number;
  workItem?: string;
  providerScript?: string;
  runs?: string;
  round?: number;
  dryRun?: boolean;
}

/**
 * A dry run of a call that spends nothing (find or search index with the local model) is invalid
 * input, so it never runs the real index or query in its place.
 */
function refuseDryRun(name: string, args: PaidArgs): void {
  if (args.dryRun !== true) return;
  throw new InputError(
    `${name} spends nothing with the local model, so it has no dry run or estimate; dry runs and estimates need search.embedder "route" (or find --outliers)`,
  );
}

/** The inputs a hosted embedder's paid request takes, as every paid command does. */
const PAID_PROPERTIES: Record<string, JsonSchemaProperty> = {
  cap: {
    type: "number",
    description:
      "with a hosted embedder, the run's cost cap in USD; at most, and by default, the settings' caps.runUsd",
    placeholder: "<usd>",
  },
  workItem: {
    type: "string",
    description: "with a hosted embedder, the work item the spend ledger counts against",
    placeholder: "<label>",
  },
  providerScript: {
    type: "string",
    description: "answer every model call from this module instead of a provider",
    placeholder: "<module>",
  },
  runs: { ...RUNS_PROPERTY, description: `with a hosted embedder, ${RUNS_PROPERTY.description}` },
  round: ROUND_PROPERTY,
  dryRun: {
    ...DRY_RUN_PROPERTY,
    description: "with a hosted embedder, print the plan and forecast; spend nothing",
  },
};

/**
 * The hosted embedder's route and the providers that serve it. A route no configured provider
 * serves, or one whose adapter has no `embed` capability, exits 2 `route_unavailable` here, before
 * any reservation.
 */
async function embedRoute(
  providerScript: string | undefined,
  ctx: RunContext,
): Promise<{ providers: ProviderSet; route: Route; embedder: SearchRouteEmbedder }> {
  const providers = await providerSet(providerScript, ctx);
  const route = providers.routes[EMBED_OPERATION] as Route;
  return {
    providers,
    route,
    embedder: { route: route.provider ?? "", model: route.model, dimension: EMBED_DIMENSION },
  };
}

/** The slot's forecast of a request; nothing to embed when the slot cannot forecast. */
async function forecastOf(
  slot: SearchSlot,
  request: Parameters<NonNullable<SearchSlot["forecast"]>>[0],
  context: SearchContext,
): Promise<SearchForecast> {
  if (slot.forecast === undefined) return { images: 0, texts: 0, queries: 0, state: "" };
  return calling(() => slot.forecast!(request, context));
}

/**
 * The free plan step of a hosted embedder's request: one `embed` job of every image, card text
 * and query the slot would embed, its forecast against the cap, and a digest covering the pending
 * work, so the same work is the same request and a repeat pays nothing twice.
 */
async function hostedPlan(
  spec: { name: string; input: CommandSpec["input"] },
  args: PaidArgs & { target?: string },
  ctx: RunContext,
  request: Parameters<NonNullable<SearchSlot["forecast"]>>[0],
  extra: Record<string, string> = {},
): Promise<{ work: WorkPlan; forecast: SearchForecast; providers: ProviderSet }> {
  const { providers, route, embedder } = await embedRoute(args.providerScript, ctx);
  const { slot, context } = await searchCall(spec.name, args.target, ctx, true, embedder);
  const forecast = await forecastOf(slot, request, context);
  const count = forecast.images + forecast.texts + forecast.queries;
  const jobs = count > 0 ? [jobOf(EMBED_OPERATION, route, count)] : [];
  const work = await buildWorkPlan(spec, args, {
    inputs: [],
    jobs,
    capUsd: runCap(args.cap, ctx.settings),
    paid: paidBy(providers, jobs),
    providers,
    candidates: 0,
    hashes: { "search/pending": forecast.state, ...extra },
  });
  return { work, forecast, providers };
}

/**
 * Inside a confirmed run, the hosted embedder with its `embed` port: each image or text is one
 * `embed` call through the `Caller`, reserved against the run's cap and the spend ledger and
 * journalled, so a resumed run pays for none twice.
 */
async function paidEmbedder(
  args: PaidArgs,
  ctx: RunContext,
  work: WorkPlan,
): Promise<{ embedder: SearchRouteEmbedder; budget: Budget }> {
  const { providers, embedder } = await embedRoute(args.providerScript, ctx);
  const budget = new Budget(work.capUsd, ledgerFor(spendLedger(ctx, args.workItem), providers));
  budget.check(work.forecastUsd, `the ${work.jobs[0]?.count ?? 0} embedding calls`);
  const caller = new Caller({
    provider: providers,
    budget,
    routes: providers.routes,
    log: ctx.log,
  });
  return {
    budget,
    embedder: {
      ...embedder,
      embed: (input) => {
        if ("text" in input)
          return caller.embed(EMBED_OPERATION, { text: input.text }, EMBED_DIMENSION);
        const sha256 = createHash("sha256").update(input.image).digest("hex");
        return caller.embed(
          EMBED_OPERATION,
          {
            image: {
              role: "search",
              path: `sha256:${sha256}`,
              mediaType: sniffMediaType(input.image),
              bytes: input.image,
              sha256,
            },
          },
          EMBED_DIMENSION,
        );
      },
    },
  };
}

/**
 * Whether a find takes its plan step: --outliers always (it asks style-outlier decisions, #366),
 * any other find only with a hosted embedder. A hosted find without words or an image file still
 * brings the index up to date first (design 7.4), so it forecasts and confirms the images that
 * adds; with nothing to embed or judge it pays nothing and asks nothing.
 */
function findPlanned(args: FindArgs, ctx: RunContext): boolean {
  return args.outliers !== undefined || hosted(ctx);
}

interface FindArgs extends PaidArgs {
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
 * The free ranking of a set's members by their indexed images (design section 8), when a loaded
 * extension fills the search slot; undefined without one. Free: the slot reads its index, no
 * model is called, and nothing is judged.
 */
export async function setOutliers(
  addresses: string[],
  target: string | undefined,
  ctx: RunContext,
): Promise<SearchOutliersResult | undefined> {
  if ((ctx.extensions ?? CORE_REGISTRY).search === undefined) return undefined;
  const { slot, context } = await searchCall("audit", target, ctx);
  return calling(() => slot.outliers(addresses, context));
}

/** The query of a find call; an image file for --like is read here. */
async function findQuery(args: FindArgs, game: string): Promise<SearchQuery> {
  for (const source of args.source ?? [])
    if (!(SEARCH_SOURCES as readonly string[]).includes(source))
      throw new InputError(`unknown --source "${source}"; use ${SEARCH_SOURCES.join(", ")}`);
  if (args.game !== undefined && args.game !== "all" && args.game !== game)
    throw new InputError(`--game takes all or this project's game "${game}"`);
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
  return {
    ...(args.words !== undefined && args.words.trim() !== "" && { words: args.words }),
    ...(like && { like }),
    ...(args.where !== undefined && args.where.length > 0 && { where: args.where }),
    ...(args.source !== undefined &&
      args.source.length > 0 && { sources: args.source as SearchSource[] }),
    ...(args.game === "all" && { allGames: true }),
    limit: args.limit ?? 20,
  };
}

/**
 * One find, as the `find` command and the tree's search paths both run it (design sections 2 and
 * 7.5): the same slot call over the same query, so both return the same hits. `sheet` is false for
 * a resource read, which writes nothing. With a hosted embedder, `embedder` is the paid run's port;
 * without it the slot answers from the vectors already in the index and embeds nothing.
 */
export async function runFind(
  args: FindArgs,
  ctx: RunContext,
  options: { sheet: boolean; embedder?: SearchRouteEmbedder },
): Promise<{ fields: Record<string, unknown>; human: string }> {
  // Without the paid run's port a hosted embedder is the route's identity only: stored vectors.
  const embedder =
    options.embedder ??
    (hosted(ctx) ? (await embedRoute(args.providerScript, ctx)).embedder : undefined);
  const { slot, context, reader } = await searchCall("find", args.target, ctx, true, embedder);
  const query = await findQuery(args, context.game);
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

/**
 * The plan step of find --outliers (#366): the slot's free ranking of the set, the members asked
 * about (the most distant, at most five) with their images, the contact sheet of the typical
 * members, the bible's style text, and one style-outlier decision per member asked about.
 */
async function prepareOutliers(args: FindArgs & { outliers: string }, ctx: RunContext) {
  // The ranking reads stored vectors: a hosted embedder is the route's identity only, no refresh.
  const embedder = hosted(ctx) ? (await embedRoute(args.providerScript, ctx)).embedder : undefined;
  const { slot, context } = await searchCall("find", args.target, ctx, true, embedder);
  for (const source of args.source ?? [])
    if (!(SEARCH_SOURCES as readonly string[]).includes(source))
      throw new InputError(`unknown --source "${source}"; use ${SEARCH_SOURCES.join(", ")}`);
  if (args.game !== undefined && args.game !== "all" && args.game !== context.game)
    throw new InputError(`--game takes all or this project's game "${context.game}"`);
  const project = await openProject(context.worktree, ctx.settings.stateDir);
  const addresses = await folderChildren(project, args.outliers, "--outliers");
  const result = await calling(() =>
    slot.outliers(
      addresses.map((m) => m.address),
      context,
    ),
  );
  const { judged, typical } = selectMembers(result.ranking);
  const wanted = new Set([...judged, ...typical].map((m) => m.address));
  // A member whose media cannot be resolved (a path that leaves the library root) has no image.
  const resolved = (
    await Promise.all(
      addresses
        .filter((m) => wanted.has(m.address))
        .map((m) => resolveMembers(project, [m]).catch(() => [])),
    )
  ).flat();
  const byAddress = new Map(resolved.map((m) => [m.address, m.image]));
  const { pending, sheet, notJudged } = styleOutlierWork(result.ranking, (address) =>
    byAddress.get(address),
  );
  const style = bibleStyleText(join(context.worktree, BIBLE_PATH));
  const providers = await providerSet(args.providerScript, ctx);
  const jobs =
    pending.length > 0
      ? [
          jobOf(
            STYLE_OUTLIER_OPERATION,
            providers.routes[STYLE_OUTLIER_OPERATION] as Route,
            pending.length,
          ),
        ]
      : [];
  const work = await buildWorkPlan(findCommand, args, {
    inputs: [],
    jobs,
    capUsd: runCap(args.cap, ctx.settings),
    paid: paidBy(providers, jobs),
    providers,
    candidates: 0,
    hashes: {
      "search/outliers": sha256Hex(
        canonicalJson([
          result.ranking.map((m) => m.address),
          pending.map((p) => [p.member.address, p.image.sha256]),
          sheet?.sheet.sha256 ?? null,
          style,
        ]),
      ),
    },
  });
  return {
    work,
    result,
    typical: typical.map((m) => m.address),
    sheet,
    style,
    pending,
    notJudged,
    providers,
  };
}

/** find --outliers inside its confirmed run: one style-outlier decision per member asked about. */
async function runOutliers(
  args: FindArgs & { outliers: string },
  ctx: RunContext,
): Promise<Outcome> {
  const { work, result, typical, sheet, style, pending, notJudged, providers } =
    await prepareOutliers(args, ctx);
  if (args.dryRun || ctx.run === undefined)
    return dryRunOutcome(work, formatWork("find", work), spendLedger(ctx, args.workItem));
  const budget = new Budget(work.capUsd, ledgerFor(spendLedger(ctx, args.workItem), providers));
  budget.check(work.forecastUsd, `the ${pending.length} style-outlier decisions`);
  const caller = new Caller({
    provider: providers,
    budget,
    routes: providers.routes,
    log: ctx.log,
  });
  const answers = new Map<string, StyleAnswer>();
  for (const { member, image } of pending)
    answers.set(
      member.address,
      await judgeStyleOutlier(caller, member, image, sheet!.sheet, sheet!.count, style),
    );
  const ranking = result.ranking.map((m) => {
    const answer = answers.get(m.address);
    return {
      ...m,
      ...(answer && { differentStyle: answer.differentStyle, probability: answer.probability }),
    };
  });
  const outliers = [...answers.values()]
    .filter((a) => a.differentStyle)
    .map((a) => ({ address: a.address, distance: a.distance, probability: a.probability }));
  const fields = {
    set: args.outliers,
    members: result.members,
    outliers,
    ranking,
    typical,
    notJudged,
    spentUsd: budget.spentUsd,
  };
  const human = [
    ...ranking.map(
      (m, i) =>
        `${i + 1}. ${m.address} (distance ${m.distance.toFixed(4)})${
          m.differentStyle === undefined
            ? ""
            : m.differentStyle
              ? `: drawn in another style (${m.probability})`
              : `: same style (${m.probability})`
        }`,
    ),
    ...(notJudged.length > 0
      ? [`not judged, no image on this machine: ${notJudged.join(", ")}`]
      : []),
    `${outliers.length} drawn in another style among ${result.members} members of ${args.outliers} (${answers.size} judged)`,
    ...outliers.map((o) => `  ${o.address}`),
  ].join("\n");
  return { exitCode: 0, fields, human };
}

/** A hosted find's plan step: the refresh and the query it would embed. */
async function findPlan(args: FindArgs, ctx: RunContext) {
  const game = (
    await createLibraryReader({
      dir: projectDir(args.target),
      stateDir: ctx.settings.stateDir,
      settings: searchSettings(ctx.settings),
    })
  ).game;
  const query = await findQuery(args, game);
  const like: Record<string, string> =
    query.like !== undefined && "image" in query.like
      ? { "search/like": createHash("sha256").update(query.like.image).digest("hex") }
      : {};
  return hostedPlan(findCommand, args, ctx, { find: query }, like);
}

export const findCommand: CommandSpec = defineCommand<FindArgs>({
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
asks which members of an asset:// folder are drawn in a different style: the search index ranks
every member by its image's mean cosine distance to the rest (free, uncut), and for the five most
distant (at most half the set) one style-outlier decision each ($0.001 estimate on the default
route) is shown the member's image, a contact sheet of up to eight typical (least distant) members
and the style bible's text. It returns {set, members, outliers: [{address, distance,
probability}] (the yes answers), ranking: [{address, distance, differentStyle?, probability?}]
(every member, most distant first), typical, notJudged, spentUsd} and prints the whole ranking.
--outliers is a paid request under every embedder: plan step, forecast, one spend confirmation,
caps and spend ledger; it embeds nothing. With the local model any other find spends nothing and
writes only the index and the sheet under the state directory.
With a hosted embedder (search.embedder "route", the embeddings role) find is a paid request: its
plan step forecasts the images and card texts that bringing the index up to date embeds, and the
words or image file to embed, one spend confirmation covers it, and each embedding is reserved
against the caps and journalled in its run directory. With nothing to embed it pays nothing and
asks nothing.`,
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
          "an asset:// folder address (a kind, subject, tag or the root): rank its members by embedding distance and list those a style-outlier decision judges drawn in another style, instead of searching (paid)",
        placeholder: "<set>",
      },
      target: TARGET,
      ...PAID_PROPERTIES,
    },
    additionalProperties: false,
  },
  positionals: [{ name: "words" }],
  effect: { readOnly: true, spends: "conditional", writes: "state" },
  plan: async (args, ctx) =>
    args.outliers !== undefined
      ? (await prepareOutliers({ ...args, outliers: args.outliers }, ctx)).work
      : (await findPlan(args, ctx)).work,
  planned: findPlanned,
  // --outliers asks style-outlier decisions under every embedder, so find can always spend; only
  // with a hosted embedder can every find spend, so only then is its tool marked as asking.
  spendsWith: () => true,
  marksSpendWith: hosted,
  replayFinished: false,
  async run(args, ctx) {
    if (args.outliers !== undefined) return runOutliers({ ...args, outliers: args.outliers }, ctx);
    let embedder: SearchRouteEmbedder | undefined;
    let budget: Budget | undefined;
    if (!findPlanned(args, ctx)) refuseDryRun("find", args);
    else {
      const { work, forecast } = await findPlan(args, ctx);
      if (args.dryRun || ctx.run === undefined)
        return dryRunOutcome(work, formatWork("find", work), spendLedger(ctx, args.workItem), {
          embed: forecast,
        });
      ({ embedder, budget } = await paidEmbedder(args, ctx, ctx.run.plan));
    }
    const { fields, human } = await runFind(args, ctx, {
      sheet: true,
      ...(embedder && { embedder }),
    });
    if (budget) fields["spentUsd"] = budget.spentUsd;
    return { exitCode: 0, fields, human };
  },
});

interface IndexArgs extends PaidArgs {
  rebuild?: boolean;
  target?: string;
}

export const searchIndexCommand: CommandSpec = defineCommand<IndexArgs>({
  name: "search index",
  tool: "search_index",
  requires: "search",
  summary: "bring the search index up to date",
  details: `Needs the search package. Waits for the index's write lock, then indexes what changed:
picks, bible references, run candidates and the settings' folders. With a shared store
(search.store) and writer true it also builds the shared index from pick and reference rows,
refused (exit 2 invalid_input) while files under the library root differ from HEAD. --rebuild
starts the local index afresh; with a hosted embedder it keeps the vectors already paid for. An index built by another embedder exits 2 embedder_changed until
--rebuild rebuilds it under this one. With the local model it spends nothing and writes the index
under the state directory. With a hosted embedder (search.embedder "route", the embeddings role)
it is a paid request: its plan step forecasts one embedding per image view and card text not
embedded yet, one spend confirmation covers it, each call is reserved against the caps and
journalled, and content embedded before is never paid for again. With the local model there is
nothing to forecast, so --dry-run and estimate refuse it (exit 2 invalid_input). The same request run again is
run again, not returned as it ended, so a deleted or changed index is built afresh; its journal
answers every call it made before.`,
  input: {
    type: "object",
    properties: {
      rebuild: {
        type: "boolean",
        description:
          "delete the local index and build it afresh (a hosted embedder keeps its paid vector cache)",
      },
      target: TARGET,
      ...PAID_PROPERTIES,
    },
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "conditional", writes: "state" },
  plan: async (args, ctx) =>
    (
      await hostedPlan(searchIndexCommand, args, ctx, {
        index: args.rebuild === true ? { rebuild: true } : {},
      })
    ).work,
  planned: (_args, ctx) => hosted(ctx),
  spendsWith: hosted,
  replayFinished: false,
  async run(args, ctx) {
    let embedder: SearchRouteEmbedder | undefined;
    let budget: Budget | undefined;
    let embedded: SearchForecast | undefined;
    if (!hosted(ctx)) refuseDryRun("search index", args);
    else {
      const { work, forecast } = await hostedPlan(searchIndexCommand, args, ctx, {
        index: args.rebuild === true ? { rebuild: true } : {},
      });
      if (args.dryRun || ctx.run === undefined)
        return dryRunOutcome(
          work,
          formatWork("search index", work),
          spendLedger(ctx, args.workItem),
          { embed: forecast },
        );
      embedded = forecast;
      ({ embedder, budget } = await paidEmbedder(args, ctx, ctx.run.plan));
    }
    const { slot, context } = await searchCall("search index", args.target, ctx, true, embedder);
    const result = await calling(() =>
      slot.index(args.rebuild === true ? { rebuild: true } : {}, context),
    );
    const fields = {
      ...result,
      ...(embedded && { forecast: embedded }),
      ...(budget && { spentUsd: budget.spentUsd }),
    };
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
    const embedder = hosted(ctx) ? (await embedRoute(undefined, ctx)).embedder : undefined;
    const { slot, context } = await searchCall("search status", args.target, ctx, true, embedder);
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
