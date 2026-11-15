import { loadProfile, readJson } from "../inputs.ts";
import { generationTool } from "../mcp.ts";
import { planJobs } from "../planning.ts";
import type { GenerationBrief, RunSettings } from "../planning.ts";
import { planningContext, providerSet, spendLedger } from "../providers/index.ts";
import {
  DRY_RUN_PROPERTY,
  ROUND_PROPERTY,
  RUNS_PROPERTY,
  buildWorkPlan,
  paidBy,
} from "../runs/plan.ts";
import type { AssetSpec } from "../types.ts";
import { dryRunOutcome, formatWork } from "./result.ts";
import { defineCommand } from "./types.ts";
import type { RunContext, WorkPlan } from "./types.ts";

interface PlanArgs {
  spec: string;
  bible: string;
  profile: string;
  out: string;
  brief?: string;
  settings?: string;
  template?: string;
  identityMode?: string;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
  round?: number;
  runs?: string;
}

/** The plan step: every call plan and the apply after it can make, forecast from the routes alone. */
async function prepare(args: PlanArgs, ctx: RunContext) {
  const spec = await readJson<AssetSpec>(args.spec);
  const profile = await loadProfile(args.profile);
  const providers = await providerSet(args.providerScript, ctx);
  const forecast = await planJobs({
    biblePath: args.bible,
    spec: spec.value,
    specDir: spec.dir,
    profile: profile.value,
    ...(args.brief && { brief: (await readJson<GenerationBrief>(args.brief)).value }),
    ...(args.settings && {
      settings: (await readJson<Partial<RunSettings>>(args.settings)).value,
    }),
    ...(args.template && { templatePath: args.template }),
    ...(args.identityMode && { identityMode: args.identityMode }),
    provider: providers,
    runCapUsd: ctx.settings.caps.runUsd,
  });
  const work: WorkPlan = await buildWorkPlan(planCommand, args, {
    inputs: ["spec", "bible", "profile", "brief", "settings", "template"],
    jobs: forecast.jobs,
    capUsd: forecast.capUsd,
    paid: paidBy(providers, forecast.jobs),
    candidates: forecast.candidates,
  });
  return { profile, work };
}

export const planCommand = defineCommand<PlanArgs>({
  name: "plan",
  tool: "plan",
  summary: "compile a reviewable generation plan; never generate images",
  details: `--identity-mode overrides the profile's identity.mode for a character with an identity lock:
shadow (the default) scores candidates beside QA without filtering, enforce filters those below
the threshold, off skips scoring. The forecast includes the scoring calls.
The configured compiler LLM writes prompt and negatives from repository templates.
Without an available LLM, a marked deterministic template fallback is recorded.
Review the saved plan before apply; this command never generates images.`,
  input: {
    type: "object",
    properties: {
      spec: { type: "string", description: "the asset spec", placeholder: "<spec.json>" },
      bible: { type: "string", description: "the art bible", placeholder: "<BIBLE.md>" },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      out: { type: "string", description: "where the plan is saved", placeholder: "<plan.json>" },
      brief: { type: "string", description: "the generation brief", placeholder: "<brief.json>" },
      settings: {
        type: "string",
        description: "the run settings",
        placeholder: "<settings.json>",
      },
      template: {
        type: "string",
        description: "the prompt template",
        placeholder: "<template.md>",
      },
      identityMode: {
        type: "string",
        description: "override the profile's identity mode",
        placeholder: "<off|shadow|enforce>",
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
      runs: RUNS_PROPERTY,
      dryRun: DRY_RUN_PROPERTY,
    },
    required: ["spec", "bible", "profile", "out"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "conditional", writes: "out" },
  confirm: "spend",
  plan: async (args, ctx) => (await prepare(args, ctx)).work,
  async run(args, ctx) {
    if (args.dryRun) {
      const { profile, work } = await prepare(args, ctx);
      return dryRunOutcome(
        work,
        formatWork("plan", work),
        spendLedger(ctx, args.workItem).forProfile(profile.value),
      );
    }
    const result = await generationTool(
      "plan",
      {
        spec: args.spec,
        bible: args.bible,
        profile: args.profile,
        out: args.out,
        brief: args.brief,
        settings: args.settings,
        template: args.template,
        identityMode: args.identityMode,
      },
      await planningContext(args.providerScript, args.workItem, ctx),
    );
    return { exitCode: 0, fields: { ...result }, human: JSON.stringify(result, null, 2) };
  },
});
