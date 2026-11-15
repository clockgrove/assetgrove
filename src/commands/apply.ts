import { InputError } from "../errors.ts";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { loadBible } from "../bible.ts";
import { applyJobs, applyPlan } from "../planning.ts";
import type { SavedPlan } from "../planning.ts";
import { readConfirmation } from "../confirm/records.ts";
import { sharedTexts, withSharedText } from "../request.ts";
import type { ConfirmationRecord } from "../types.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import { DRY_RUN_PROPERTY, ROUND_PROPERTY, buildWorkPlan, paidBy } from "../runs/plan.ts";
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
}

/** The plan step: the saved plan checked as apply checks it, and the calls apply would make. */
async function prepare(plan: string, args: ApplyArgs, ctx: RunContext) {
  const providers = await providerSet(args.providerScript, ctx);
  const forecast = await applyJobs(plan, {
    provider: providers,
    runCapUsd: ctx.settings.caps.runUsd,
    promptAllow: ctx.settings.promptPolicy.allow,
  });
  const work: WorkPlan = await buildWorkPlan(applyCommand, args, {
    inputs: ["plan"],
    jobs: forecast.jobs,
    capUsd: forecast.capUsd,
    paid: paidBy(providers, forecast.jobs),
    candidates: forecast.candidates,
    runsArg: "out",
    promptAllow: ctx.settings.promptPolicy.allow,
  });
  return { providers, work };
}

/**
 * The plan's confirmation, when it covers this apply (design section 7): the record of the saved
 * plan's request digest, every input hash it holds equal to the saved plan's, and apply's forecast
 * at or under the confirmed one. Otherwise apply asks under its own digest.
 */
export async function planConfirmation(
  planPath: string,
  work: WorkPlan,
  configDir: string,
): Promise<ConfirmationRecord | undefined> {
  let saved: SavedPlan;
  try {
    saved = JSON.parse(await readFile(planPath, "utf8")) as SavedPlan;
  } catch {
    return undefined;
  }
  if (typeof saved.requestDigest !== "string" || !/^[0-9a-f]{64}$/.test(saved.requestDigest))
    return undefined;
  const record = await readConfirmation(configDir, "spend", saved.requestDigest);
  if (record === undefined) return undefined;
  const inputs = saved.inputs ?? {};
  for (const [name, sha256] of Object.entries(record.inputs)) {
    // The plan request hashes its arguments' files and the files they name (`bible/<path>`);
    // the saved plan records the arguments' files. Each one both name must agree.
    if (name.includes("/")) continue;
    if (inputs[name] === undefined || inputs[name].sha256 !== sha256) return undefined;
  }
  if (work.forecastUsd > record.forecastUsd + 1e-9) return undefined;
  return record;
}

export const applyCommand = defineCommand<ApplyArgs>({
  name: "apply",
  tool: "apply",
  summary: "generate exactly a saved plan after explicit spend approval",
  details: `Refuses stale inputs before generation, and exits 2 plan_changed when the routes, estimates,
output grants or run cap resolved from the developer settings differ from planning time.
The plan's prompts pass the prompt policy (exit 9 prompt_refused) before any spend.
The plan's spend confirmation covers apply while every input hash it confirmed still matches and
apply's forecast is at or under the confirmed one; otherwise apply asks under its own digest (headless
settings, a record, the TTY, or exit 8 confirmation_required and \`assetgrove confirm <id>\`). The
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
    args.plan === undefined
      ? Promise.resolve(undefined)
      : planConfirmation(args.plan, work, ctx.settings.configDir),
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
