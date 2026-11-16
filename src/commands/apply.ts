import { InputError } from "../errors.ts";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { loadBible } from "../bible.ts";
import { readJson } from "../inputs.ts";
import { nearMatchesFor } from "../search/near-match.ts";
import type { AssetSpec } from "../types.ts";
import { applyJobs, applyPlan, planDigest } from "../planning.ts";
import type { GenerationBrief, SavedPlan } from "../planning.ts";
import { bindingAllows, readConfirmation, writeConfirmation } from "../confirm/records.ts";
import { sharedTexts, withSharedText } from "../request.ts";
import type { ConfirmationRecord } from "../types.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import {
  DEFAULT_ROUND,
  DRY_RUN_PROPERTY,
  NOTE_PROPERTY,
  ROUND_PROPERTY,
  buildWorkPlan,
  paidBy,
} from "../runs/plan.ts";
import { dryRunOutcome, formatRun, formatWork, refusal } from "./result.ts";
import { defineCommand } from "./types.ts";
import type { RunContext, WorkPlan } from "./types.ts";

interface ApplyArgs {
  plan?: string;
  out?: string;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
  round?: number;
  note?: string;
}

/** The near matches of the spec and reference images a saved plan names. */
async function savedPlanNearMatches(planPath: string, ctx: RunContext) {
  try {
    const saved = JSON.parse(await readFile(planPath, "utf8")) as SavedPlan;
    const specPath = saved.inputs["spec"]?.path;
    if (specPath === undefined) return {};
    const spec = await readJson<AssetSpec>(specPath);
    const references = Object.entries(saved.inputs)
      .filter(([name]) => name.startsWith("reference/"))
      .map(([, input]) => input.path);
    const briefPath = saved.inputs["brief"]?.path;
    const brief =
      briefPath === undefined ? undefined : (await readJson<GenerationBrief>(briefPath)).value;
    return await nearMatchesFor(spec.value, references, ctx, brief);
  } catch {
    return {};
  }
}

/** The plan step: the saved plan checked as apply checks it, and the calls apply would make. */
async function prepare(plan: string, args: ApplyArgs, ctx: RunContext) {
  const providers = await providerSet(args.providerScript, ctx);
  const forecast = await applyJobs(plan, {
    provider: providers,
    runCapUsd: ctx.settings.caps.runUsd,
    promptAllow: ctx.settings.promptPolicy.allow,
  });
  const near = await savedPlanNearMatches(plan, ctx);
  const work: WorkPlan = await buildWorkPlan(applyCommand, args, {
    near,
    inputs: ["plan"],
    jobs: forecast.jobs,
    capUsd: forecast.capUsd,
    paid: paidBy(providers, forecast.jobs),
    providers,
    candidates: forecast.candidates,
    runsArg: "out",
    promptAllow: ctx.settings.promptPolicy.allow,
    promptText: args.note !== undefined ? [args.note] : [],
  });
  return { providers, work };
}

/**
 * The plan's confirmation, when it covers this apply (design section 7): one plan request covers
 * one apply run, the default round's, of the plan file that request's run saved (the record holds
 * its digest), while every input hash its record holds equals the saved plan's and apply's forecast
 * is at or under the confirmed one. The first apply run it covers binds it to its run directory;
 * once that run finishes it covers no other. Another round is another paid request, and it, like
 * any apply the record does not cover, asks under its own digest.
 */
export async function planConfirmation(
  planPath: string,
  work: WorkPlan,
  configDir: string,
  round: number = DEFAULT_ROUND,
): Promise<ConfirmationRecord | undefined> {
  if (round !== DEFAULT_ROUND) return undefined;
  let saved: SavedPlan;
  try {
    saved = JSON.parse(await readFile(planPath, "utf8")) as SavedPlan;
  } catch {
    return undefined;
  }
  if (typeof saved.requestDigest !== "string" || !/^[0-9a-f]{64}$/.test(saved.requestDigest))
    return undefined;
  const record = await readConfirmation(configDir, "spend", saved.requestDigest);
  if (record === undefined || record.command !== "plan") return undefined;
  if (record.savedPlan !== saved.digest || planDigest(saved) !== saved.digest) return undefined;
  if (!bindingAllows(record.coveredRun, work.runDir)) return undefined;
  const inputs = saved.inputs ?? {};
  for (const [name, sha256] of Object.entries(record.inputs)) {
    // The plan request hashes its arguments' files and the files they name (`bible/<path>`);
    // the saved plan records the arguments' files. Each one both name must agree.
    if (name.includes("/")) continue;
    if (inputs[name] === undefined || inputs[name].sha256 !== sha256) return undefined;
  }
  if (work.forecastUsd > record.forecastUsd + 1e-9) return undefined;
  if (record.coveredRun !== undefined) return record;
  const bound = { ...record, coveredRun: { runDir: work.runDir } };
  await writeConfirmation(configDir, bound);
  return bound;
}

export const applyCommand = defineCommand<ApplyArgs>({
  name: "apply",
  tool: "apply",
  summary: "generate exactly a saved plan after explicit spend approval",
  details: `Refuses stale inputs before generation, and exits 2 plan_changed when the routes, estimates,
output grants or run cap resolved from the developer settings differ from planning time.
--note adds the author's note to each image prompt (policy-checked before spend, part of the request's digest);
with --round it asks for another round, and a plan's confirmation never covers a note.
The plan's prompts pass the prompt policy (exit 9 prompt_refused) before any spend.
The plan's spend confirmation covers one apply run of the plan it saved, the default round, while every
input hash it confirmed still matches and apply's forecast is at or under the confirmed one; --round n > 1,
another --out once that run started, or any other apply, asks under its own digest (headless
settings, a record, an MCP client's form, the TTY, or exit 8 confirmation_required and \`assetgrove confirm <id>\`). The
confirmation authorizes this generation spend; resulting assets remain pending review.`,
  input: {
    type: "object",
    properties: {
      plan: { type: "string", description: "the saved plan", placeholder: "<plan.json>" },
      out: {
        type: "string",
        description: "where runs are staged",
        placeholder: "<runs directory>",
      },
      workItem: {
        type: "string",
        description: "the work item the spend ledger counts against",
        placeholder: "<label>",
      },
      providerScript: {
        type: "string",
        description: "answer every model call from this module instead of a provider",
        placeholder: "<module>",
      },
      note: NOTE_PROPERTY,
      round: ROUND_PROPERTY,
      dryRun: DRY_RUN_PROPERTY,
    },
    additionalProperties: false,
  },
  positionals: [{ name: "plan" }],
  effect: { readOnly: false, spends: "always", writes: "runs" },
  confirm: "spend",
  plan: async (args, ctx) => {
    if (args.plan === undefined) throw new InputError("apply requires exactly one plan file");
    return (await prepare(args.plan, args, ctx)).work;
  },
  priorConfirmation: (args, ctx, work) =>
    args.plan === undefined || args.note !== undefined
      ? Promise.resolve(undefined)
      : planConfirmation(args.plan, work, ctx.settings.configDir, args.round),
  async run(args, ctx) {
    if (args.plan === undefined) throw new InputError("apply requires exactly one plan file");
    const { providers, work } = await prepare(args.plan, args, ctx);
    const ledger = spendLedger(ctx, args.workItem);
    if (args.dryRun) return dryRunOutcome(work, formatWork("apply", work), ledger);
    const dir = ctx.run?.dir ?? work.runDir;
    const result = await applyPlan(args.plan, {
      provider: providers,
      ledger,
      log: ctx.log,
      runCapUsd: ctx.settings.caps.runUsd,
      promptAllow: ctx.settings.promptPolicy.allow,
      outDir: dirname(dir),
      ...(args.note !== undefined && { note: args.note }),
      runId: basename(dir),
    });
    const bible = await loadBible(
      (JSON.parse(await readFile(args.plan, "utf8")) as SavedPlan).inputs["bible"]!.path,
    );
    const fields = withSharedText(
      {
        ...result,
        ...(result.run.contactSheet && { contactSheet: result.run.contactSheet }),
      },
      sharedTexts(bible.data),
    );
    const human = formatRun(result.run, result.runDir);
    if (result.run.candidates.length === 0)
      return refusal("qa_found_nothing", "no candidate passed QA", fields, human);
    return { exitCode: 0, fields, human };
  },
});
