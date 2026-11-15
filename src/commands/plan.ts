import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProfile, readJson } from "../inputs.ts";
import { generationTool } from "../mcp.ts";
import { planJobs } from "../planning.ts";
import { planningContext, providerSet, spendLedger } from "../providers/index.ts";
import {
  DRY_RUN_PROPERTY,
  ROUND_PROPERTY,
  RUNS_PROPERTY,
  bibleReads,
  specReads,
  buildWorkPlan,
  jobOf,
  paidBy,
} from "../runs/plan.ts";
import { PROMPT_POLICY_OPERATION } from "../routes.ts";
import type { AssetSpec } from "../types.ts";
import { dryRunOutcome, formatWork } from "./result.ts";
import { defineCommand } from "./types.ts";
import type { RunContext, WorkPlan } from "./types.ts";

/** The plan command's compiler record in its run directory. */
export const COMPILER_FILE = "compiler.json";

interface PlanArgs {
  spec: string;
  bible: string;
  profile: string;
  out: string;
  brief?: string;
  runOptions?: string;
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
    specPath: args.spec,
    profilePath: args.profile,
    ...(args.brief && { briefPath: args.brief }),
    ...(args.runOptions && { runOptionsPath: args.runOptions }),
    ...(args.template && { templatePath: args.template }),
    ...(args.identityMode && { identityMode: args.identityMode }),
    provider: providers,
    runCapUsd: ctx.settings.caps.runUsd,
    promptAllow: ctx.settings.promptPolicy.allow,
  });
  // The apply after this plan runs its own prompt-policy check first: forecast it too.
  const jobs = [
    jobOf(PROMPT_POLICY_OPERATION, providers.routes[PROMPT_POLICY_OPERATION]!),
    ...forecast.jobs,
  ];
  const work: WorkPlan = await buildWorkPlan(planCommand, args, {
    inputs: ["spec", "bible", "profile", "brief", "runOptions", "template"],
    reads: {
      ...(await bibleReads("bible", args.bible)),
      ...specReads("spec", spec),
      ...forecast.reads,
    },
    jobs,
    capUsd: forecast.capUsd,
    paid: paidBy(providers, jobs),
    providers,
    candidates: forecast.candidates,
    promptAllow: ctx.settings.promptPolicy.allow,
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
The saved plan (assetgrove-plan/1) holds operation names, compiled prompts, input hashes, the
request digest and a hash of the routes, estimates, grants and cap resolved from the developer
settings; --run-options holds candidates, seed, strictness and exploration only.
Review the saved plan before apply; this command never generates images.`,
  input: {
    type: "object",
    properties: {
      spec: { type: "string", description: "the asset spec", placeholder: "<spec.json>" },
      bible: { type: "string", description: "the art bible", placeholder: "<BIBLE.md>" },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      out: { type: "string", description: "where the plan is saved", placeholder: "<plan.json>" },
      brief: { type: "string", description: "the generation brief", placeholder: "<brief.json>" },
      runOptions: {
        type: "string",
        description: "the run options: candidates, seed, strictness and exploration only",
        placeholder: "<run-options.json>",
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
        runOptions: args.runOptions,
        template: args.template,
        identityMode: args.identityMode,
      },
      {
        ...(await planningContext(args.providerScript, args.workItem, ctx)),
        ...(ctx.run && { requestDigest: ctx.run.plan.digest }),
      },
    );
    // The compiler call's record (model, route, request ID, cost) stays in the plan command's run
    // directory, which the saved plan's requestDigest names; the plan itself holds none of it.
    if (ctx.run && result["compiler"] !== undefined)
      await writeFile(
        join(ctx.run.dir, COMPILER_FILE),
        `${JSON.stringify(result["compiler"], null, 2)}\n`,
      );
    return { exitCode: 0, fields: { ...result }, human: JSON.stringify(result, null, 2) };
  },
});
