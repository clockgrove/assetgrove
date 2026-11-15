import { InputError } from "../errors.ts";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { loadBible } from "../bible.ts";
import { applyJobs, applyPlan } from "../planning.ts";
import type { SavedPlan } from "../planning.ts";
import { sharedTexts, withSharedText } from "../request.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import { DRY_RUN_PROPERTY, ROUND_PROPERTY, buildWorkPlan, paidBy } from "../runs/plan.ts";
import { dryRunOutcome, formatRun, formatWork, refusal } from "./result.ts";
import { defineCommand } from "./types.ts";
import type { RunContext, WorkPlan } from "./types.ts";

interface ApplyArgs {
  plan?: string;
  autoApprove?: boolean;
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

export const applyCommand = defineCommand<ApplyArgs>({
  name: "apply",
  tool: "apply",
  summary: "generate exactly a saved plan after explicit spend approval",
  details: `Refuses stale inputs before generation, and exits 2 plan_changed when the routes, estimates,
output grants or run cap resolved from the developer settings differ from planning time.
The plan's prompts pass the prompt policy (exit 9 prompt_refused) before any spend.
Set the plan's approved field to true after review, or use --auto-approve for unattended runs.
Approval authorizes this generation spend; resulting assets remain pending review. Never prompts.`,
  input: {
    type: "object",
    properties: {
      plan: { type: "string", description: "the saved plan", placeholder: "<plan.json>" },
      autoApprove: { type: "boolean", description: "approve the plan's spend without review" },
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
      autoApprove: args.autoApprove === true,
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
