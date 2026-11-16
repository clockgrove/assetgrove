/**
 * The free plan step of a paid command (design section 6): the jobs a request would run, their
 * forecast against the cap, the hashes of its input files, its options, and the request digest
 * that names its run directory. Building one makes no provider call and no ledger entry.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { bibleReferences, loadBible } from "../bible.ts";
import { InputError } from "../errors.ts";
import type { JsonSchemaObject } from "../commands/types.ts";
import { collectPromptText, enforcePromptPolicy } from "../policy/text.ts";
import type { PromptPolicyRecord } from "../policy/text.ts";
import { PROMPT_POLICY_OPERATION } from "../routes.ts";
import type { Route } from "../routes.ts";
import type { NearMatch, NearMatchOutcome } from "../search/near-match.ts";
import { runDirOf } from "./dir.ts";

/** One kind of call a request makes: `count` calls on a route, each estimated at `estimatedCostUsd`. */
export interface PlanJob {
  operation: string;
  /** The settings id of the provider that serves the route; empty when the route names none. */
  provider: string;
  model: string;
  count: number;
  /** The route's estimate of one call, in USD. */
  estimatedCostUsd: number;
}

/** What a paid command would do and cost, computed before anything is spent. */
export interface WorkPlan {
  jobs: PlanJob[];
  /** How many candidates the request makes (0 for a command that makes none). */
  candidates: number;
  /** The sum of every job's `count × estimatedCostUsd`. */
  forecastUsd: number;
  capUsd: number;
  /** Whether a job's provider is billed. */
  paid: boolean;
  /** Each input file's argument name and the sha256 of its bytes. */
  inputs: Record<string, string>;
  /** Every other argument, with the input schema's defaults applied. */
  options: Record<string, unknown>;
  /** sha256 hex of the normalised prompt text the request's inputs carry. */
  policyTextSha256: string;
  /** The prompt policy's check of that text. */
  promptPolicy?: PromptPolicyRecord;
  /**
   * Up to three picked assets of exactly the spec's kind and subject (design section 7.6), when
   * search is loaded and near matches are on. Never part of the digest: a changing index must not
   * void a confirmation.
   */
  nearMatches?: NearMatch[];
  /** The numbered sheet of `nearMatches`. */
  nearMatchSheet?: string;
  /** Why the near-match search failed; the plan went on without it. */
  searchError?: string;
  /** sha256 hex of the canonical JSON of the request (`requestDigest`). */
  digest: string;
  /** `<runs>/r-<first 16 hex of the digest>/`, absolute. */
  runDir: string;
}

/** The round a request is in when it names none. */
export const DEFAULT_ROUND = 1;

/** The default directory runs are staged under. */
export const DEFAULT_RUNS = ".assetgrove/runs";

/** Arguments that never enter a request's options: how it is answered, counted and where it runs. */
const NOT_OPTIONS: ReadonlySet<string> = new Set(["providerScript", "dryRun", "workItem", "round"]);

/**
 * JSON with every object's keys sorted and undefined values left out, so equal values always give
 * the same text. Hand-written (docs/decisions.md): the digest must be byte-for-byte deterministic.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function sha256Hex(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

/** What the request digest covers (design section 6). */
export interface DigestInput {
  command: string;
  round: number;
  inputs: Record<string, string>;
  options: Record<string, unknown>;
  jobs: PlanJob[];
  forecastUsd: number;
  capUsd: number;
  policyTextSha256?: string;
}

/** sha256 hex of the canonical JSON of `{command, round, inputs, options, jobs, forecastUsd, capUsd, policyTextSha256}`. */
export function requestDigest(input: DigestInput): string {
  const { command, round, inputs, options, jobs, forecastUsd, capUsd, policyTextSha256 } = input;
  return sha256Hex(
    canonicalJson({ command, round, inputs, options, jobs, forecastUsd, capUsd, policyTextSha256 }),
  );
}

async function hashDirectory(dir: string): Promise<string> {
  const files: Record<string, string> = {};
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        files[relative(dir, path).split(sep).join("/")] = sha256Hex(await readFile(path));
    }
  };
  await walk(dir);
  return sha256Hex(canonicalJson(files));
}

/**
 * The sha256 of each named input file; a directory hashes to the sha256 of the canonical JSON of
 * its files' relative paths and hashes. Absent arguments are left out.
 */
export async function hashInputs(
  paths: Record<string, string | undefined>,
): Promise<Record<string, string>> {
  const inputs: Record<string, string> = {};
  for (const [name, path] of Object.entries(paths)) {
    if (path === undefined) continue;
    let isDirectory: boolean;
    try {
      isDirectory = (await stat(path)).isDirectory();
    } catch (error) {
      throw new InputError(`cannot read ${name} ${path}`, { cause: error });
    }
    inputs[name] = isDirectory ? await hashDirectory(path) : sha256Hex(await readFile(path));
  }
  return inputs;
}

/** A call as a route plans it: the operation and its route's model and estimate. */
export interface PlannedCallLike {
  operation: string;
  model: string;
  estimatedCostUsd: number;
}

/** A job of `count` calls of an operation on its route. */
export function jobOf(operation: string, route: Route, count = 1): PlanJob {
  return {
    operation,
    provider: route.provider ?? "",
    model: route.model,
    count,
    estimatedCostUsd: route.estimatedCostUsd,
  };
}

/**
 * Jobs from planned calls, each `count` times; the provider comes from the operation's route.
 * Calls of the same operation, provider, model and estimate merge into one job.
 */
export function jobsOf(
  calls: readonly PlannedCallLike[],
  routes: Record<string, Route>,
  count = 1,
): PlanJob[] {
  return mergeJobs(
    calls.map((c) => ({
      operation: c.operation,
      provider: providerOf(routes, c.operation),
      model: c.model,
      count,
      estimatedCostUsd: c.estimatedCostUsd,
    })),
  );
}

function providerOf(routes: Record<string, Route>, operation: string): string {
  try {
    return (Object.hasOwn(routes, operation) && routes[operation]?.provider) || "";
  } catch {
    return "";
  }
}

/** Merges jobs of the same operation, provider, model and estimate, adding their counts; drops empty ones. */
export function mergeJobs(jobs: readonly PlanJob[]): PlanJob[] {
  const merged: PlanJob[] = [];
  for (const job of jobs) {
    if (job.count <= 0) continue;
    const same = merged.find(
      (m) =>
        m.operation === job.operation &&
        m.provider === job.provider &&
        m.model === job.model &&
        m.estimatedCostUsd === job.estimatedCostUsd,
    );
    if (same) same.count += job.count;
    else merged.push({ ...job });
  }
  return merged;
}

/** The forecast of a list of jobs. */
export function forecastOf(jobs: readonly PlanJob[]): number {
  return jobs.reduce((sum, j) => sum + j.count * j.estimatedCostUsd, 0);
}

/** What a command gives `buildWorkPlan` beside its name, schema and arguments. */
export interface WorkPlanParts {
  /** The argument names that are input files; their values are hashed, not listed as options. */
  inputs: readonly string[];
  jobs: readonly PlanJob[];
  capUsd: number;
  /** Whether the provider of a job bills (`billing.paid`); see `paidOf`. */
  paid: boolean;
  /**
   * The command's providers and routes. When the request carries prompt text, the plan adds one
   * `prompt-policy` job on their route (the run's first call, src/runs/execute.ts); reading a
   * route no provider serves throws `RouteUnavailableError` (exit 2 `route_unavailable`).
   */
  providers: PolicyProviders;
  candidates: number;
  /** The argument that names the runs directory; `runs` when absent. */
  runsArg?: string;
  /** Settings `promptPolicy.allow` terms that clear a blocklist hit in the prompt text. */
  promptAllow?: readonly string[];
  /**
   * Files the request reads through its arguments (a bible's reference images, a spec's key pose,
   * a default template), name to path: hashed into `inputs` beside the arguments' own files, so a
   * changed reference changes the digest. One that cannot be read is left out: the command
   * reports it when it loads it.
   */
  reads?: Record<string, string>;
  /**
   * Prompt text the request carries outside its input files (a free-text option such as a note or
   * subject, text a shared profile puts in a prompt): checked with the files' text by the
   * blocklist and the model check.
   */
  promptText?: readonly string[];
  /** The plan step's near matches (src/search/near-match.ts); kept out of the digest. */
  near?: NearMatchOutcome;
}

/** What the plan step reads from a command's provider set: its routes and its providers' billing. */
export type PolicyProviders = Parameters<typeof paidBy>[0] & {
  routes: Readonly<Record<string, Route>>;
};

/** The prompt text each plan checked, kept beside the plan (never printed or digested as text). */
const policyTexts = new WeakMap<WorkPlan, string>();

/** The prompt text a plan's prompt-policy job decides on; undefined when it has none. */
export function policyTextOf(plan: WorkPlan): string | undefined {
  return policyTexts.get(plan);
}

/** The sha256 of a file, or undefined when it cannot be read. */
async function hashIfReadable(path: string): Promise<string | undefined> {
  try {
    return sha256Hex(await readFile(path));
  } catch {
    return undefined;
  }
}

/** The files a JSON style bible names (references and perspective sample), as `<arg>/<path>`. */
export function styleBibleReads(
  arg: string,
  bible: { value: { references?: { path: string }[]; perspective?: unknown }; dir: string },
): Record<string, string> {
  const paths = [
    ...(Array.isArray(bible.value.references) ? bible.value.references.map((r) => r.path) : []),
    ...(typeof bible.value.perspective === "string" ? [bible.value.perspective] : []),
  ];
  return Object.fromEntries(paths.map((path) => [`${arg}/${path}`, resolve(bible.dir, path)]));
}

/** The key pose an asset spec names, as `<arg>/keyPose`; none when it names none. */
export function specReads(
  arg: string,
  spec: { value: { keyPose?: unknown }; dir: string },
): Record<string, string> {
  return typeof spec.value.keyPose === "string"
    ? { [`${arg}/keyPose`]: resolve(spec.dir, spec.value.keyPose) }
    : {};
}

/**
 * The files a Markdown bible names, as `<arg>/<path>`: the identity turnaround and references of
 * `subjects`, or every reference (anchors and all identities) when no subjects are given.
 */
export async function bibleReads(
  arg: string,
  path: string,
  subjects?: readonly string[],
): Promise<Record<string, string>> {
  const doc = await loadBible(path);
  const paths =
    subjects === undefined
      ? bibleReferences(doc.data).map((reference) => reference.path)
      : subjects.flatMap((subject) => {
          const lock = doc.data.identities[subject];
          return lock ? [lock.turnaround, ...(lock.references ?? [])] : [];
        });
  return Object.fromEntries(paths.map((p) => [`${arg}/${p}`, resolve(doc.dir, p)]));
}

/**
 * A command's WorkPlan from its arguments: input hashes, options with the schema's defaults, the
 * merged jobs and their forecast, the digest and the run directory.
 */
export async function buildWorkPlan(
  spec: { name: string; input: JsonSchemaObject },
  given: object,
  parts: WorkPlanParts,
): Promise<WorkPlan> {
  const args = given as Record<string, unknown>;
  const runsArg = parts.runsArg ?? "runs";
  const inputNames = new Set(parts.inputs);
  const paths: Record<string, string | undefined> = {};
  for (const name of parts.inputs) {
    const value = args[name];
    paths[name] = typeof value === "string" ? value : undefined;
  }
  const inputs = await hashInputs(paths);
  for (const [name, path] of Object.entries(parts.reads ?? {})) {
    if (name in inputs) continue;
    const hash = await hashIfReadable(path);
    if (hash !== undefined) inputs[name] = hash;
  }
  const promptFiles: Record<string, string> = {};
  for (const [name, path] of Object.entries(paths))
    if (path !== undefined) promptFiles[name] = path;
  for (const [name, path] of Object.entries(parts.reads ?? {})) promptFiles[name] ??= path;
  const promptTexts = [
    ...(await collectPromptText(promptFiles)),
    ...(parts.promptText ?? []).filter((text) => text.trim().length > 0),
  ];
  const promptPolicy = enforcePromptPolicy(promptTexts, parts.promptAllow ?? []);
  const policyText = promptTexts.join("\n");
  // The model check (design section 16): one decide call when there is text to check.
  const policyJobs = policyText.trim()
    ? [jobOf(PROMPT_POLICY_OPERATION, parts.providers.routes[PROMPT_POLICY_OPERATION]!)]
    : [];
  const policyTextSha256 = promptPolicy.textSha256;
  const options: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(spec.input.properties)) {
    if (inputNames.has(name) || NOT_OPTIONS.has(name) || name === runsArg) continue;
    const value = args[name] ?? property.default;
    if (value !== undefined) options[name] = value;
  }
  const round = typeof args["round"] === "number" ? args["round"] : DEFAULT_ROUND;
  const jobs = mergeJobs([...policyJobs, ...parts.jobs]);
  const forecastUsd = forecastOf(jobs);
  const digest = requestDigest({
    command: spec.name,
    round,
    inputs,
    options,
    jobs,
    forecastUsd,
    capUsd: parts.capUsd,
    policyTextSha256,
  });
  const runs = typeof args[runsArg] === "string" ? (args[runsArg] as string) : DEFAULT_RUNS;
  const plan: WorkPlan = {
    jobs,
    candidates: parts.candidates,
    forecastUsd,
    capUsd: parts.capUsd,
    paid: parts.paid || paidBy(parts.providers, policyJobs),
    inputs,
    options,
    policyTextSha256,
    promptPolicy,
    digest,
    runDir: runDirOf(resolve(runs), digest),
  };
  if (policyJobs.length > 0) policyTexts.set(plan, policyText);
  if (parts.near?.nearMatches !== undefined) plan.nearMatches = parts.near.nearMatches;
  if (parts.near?.nearMatchSheet !== undefined) plan.nearMatchSheet = parts.near.nearMatchSheet;
  if (parts.near?.searchError !== undefined) plan.searchError = parts.near.searchError;
  return plan;
}

/** Whether a provider of the jobs bills: `paid(id)` reads a provider's billing by settings id. */
export function paidOf(
  jobs: readonly PlanJob[],
  paid: (providerId: string) => boolean | undefined,
): boolean {
  return jobs.some((j) => j.count > 0 && paid(j.provider) === true);
}

/** Whether a provider of the jobs bills, read from a provider set's configured providers. */
export function paidBy(
  providers: { get(id: string): { provider: { billing: { paid: boolean } } } | undefined },
  jobs: readonly PlanJob[],
): boolean {
  return paidOf(jobs, (id) => providers.get(id)?.provider.billing.paid);
}

/** The `round` input property every paid command takes. */
export const ROUND_PROPERTY = {
  type: "integer",
  description: "the round of this request, part of its digest",
  default: DEFAULT_ROUND,
  minimum: 1,
} as const;

/** The `note` input property of a command that takes an author's note with a new round. */
export const NOTE_PROPERTY = {
  type: "string",
  description:
    "the author's note for this round, added to the prompts; part of the request's digest",
  placeholder: "<text>",
} as const;

/** The `runs` input property of a paid command that stages nothing else under it. */
export const RUNS_PROPERTY = {
  type: "string",
  description: "where the run directory (request.json, run.json) is written",
  default: DEFAULT_RUNS,
} as const;

/** The `dryRun` input property of every paid command. */
export const DRY_RUN_PROPERTY = {
  type: "boolean",
  description: "print the plan and forecast; spend nothing",
} as const;
