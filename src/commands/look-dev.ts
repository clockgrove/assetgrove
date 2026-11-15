import { basename, dirname } from "node:path";
import { readJson, readModel, loadProfile, loadStyleBible } from "../inputs.ts";
import { lookDev, planLookdev } from "../model3d/lookdev/command.ts";
import { runCap } from "../budget.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import { rigReads } from "../model3d/rig/template.ts";
import { lookdevSettings } from "../model3d/lookdev/settings.ts";
import type { AssetSpec } from "../types.ts";
import { readProvenance } from "../model3d/rig/command.ts";
import { dryRunOutcome, formatRun, refusal, usd } from "./result.ts";
import { defineCommand } from "./types.ts";
import type { RunContext } from "./types.ts";
import {
  DRY_RUN_PROPERTY,
  ROUND_PROPERTY,
  buildWorkPlan,
  jobsOf,
  paidBy,
  specReads,
  styleBibleReads,
} from "../runs/plan.ts";

interface LookDevArgs {
  model: string;
  provenance: string;
  spec: string;
  bible: string;
  profile: string;
  cap?: number;
  runs?: string;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
  round?: number;
}

/** Look-dev's plan step: its inputs, providers, look-dev plan and WorkPlan, with no call. */
async function prepare(args: LookDevArgs, ctx: RunContext) {
  const spec = await readJson<AssetSpec>(args.spec);
  const bible = await loadStyleBible(args.bible);
  const profile = await loadProfile(args.profile);
  const providers = await providerSet(args.providerScript, ctx);
  const routes = providers.routes;
  const capUsd = runCap(args.cap, ctx.settings, planLookdev(profile.value, routes).capUsd);
  const plan = planLookdev(profile.value, routes, capUsd);
  const jobs = jobsOf(plan.calls, routes);
  // The groom prompts name each season the profile declares and carry its traits.
  const { seasons, traits } = lookdevSettings(profile.value);
  const work = await buildWorkPlan(lookDevCommand, args, {
    promptAllow: ctx.settings.promptPolicy.allow,
    inputs: ["model", "provenance", "spec", "bible", "profile"],
    reads: {
      ...styleBibleReads("bible", bible),
      ...specReads("spec", spec),
      ...rigReads("profile", profile),
    },
    promptText: (seasons ?? []).flatMap((season) => [season, traits[season] ?? ""]),
    jobs,
    capUsd,
    paid: paidBy(providers, jobs),
    providers,
    candidates: 1,
  });
  return { spec, bible, profile, providers, routes, capUsd, plan, work };
}

export const lookDevCommand = defineCommand<LookDevArgs>({
  name: "look-dev",
  tool: "look_dev",
  summary: "give a picked 3D character its look: base colour, fur groom maps and eyes",
  details: `Repaints a picked character's base colour on its own UVs in the look the bible's approved
references define (restyled renders projected back onto the model), writes fur groom maps
(length, direction, density) and tint textures per season the profile declares
(model3d.groom), gives the eyes their own glossy material and mask, and checks them: the
maps' zero-length masks, map-driven shell-fur renders, UV seams, the eyes' catch-light at the
closest zoom and the identity lock. Before-and-after renders beside the approved turnaround
are written for the person who approves; pick hands the result off. The cap defaults to
model3d.lookdev.capUsd or $3 and is reserved before any call (docs/look-dev.md).`,
  input: {
    type: "object",
    properties: {
      model: { type: "string", description: "the character model", placeholder: "<model.glb>" },
      provenance: {
        type: "string",
        description: "the model's provenance",
        placeholder: "<provenance.json>",
      },
      spec: { type: "string", description: "the asset spec", placeholder: "<spec.json>" },
      bible: { type: "string", description: "the style bible", placeholder: "<bible.json>" },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      cap: {
        type: "number",
        description:
          "the run's cost cap in USD; defaults to the profile's look-dev cap, at most the settings' caps.runUsd",
        placeholder: "<usd>",
      },
      runs: {
        type: "string",
        description: "where runs are staged",
        default: ".assetgrove/runs",
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
    required: ["model", "provenance", "spec", "bible", "profile"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "conditional", writes: "runs" },
  confirm: "spend",
  plan: async (args, ctx) => (await prepare(args, ctx)).work,
  async run(args, ctx) {
    const ledger = spendLedger(ctx, args.workItem);
    const { spec, bible, profile, providers, routes, capUsd, plan, work } = await prepare(
      args,
      ctx,
    );
    if (args.dryRun) {
      const human = [
        `look-dev: ${plan.calls.length} call(s), forecast ${usd(plan.estimateUsd)} against the $${plan.capUsd.toFixed(2)} cap`,
        ...plan.calls.map((c) => `  ${c.operation}  ${c.model}  ${usd(c.estimatedCostUsd)}`),
        `  seasons: ${plan.seasons.join(", ")}`,
      ].join("\n");
      return dryRunOutcome(
        work,
        human,
        ledger.forProfile(profile.value),
        plan as unknown as Record<string, unknown>,
      );
    }
    // The runner opened the request's run directory `<runs>/r-<16 hex>/`; look-dev runs in it.
    const dir = ctx.run?.dir ?? work.runDir;
    const model = await readModel(args.model);
    const { run, runDir, passed } = await lookDev({
      model,
      provenance: await readProvenance(args.provenance),
      spec: spec.value,
      specDir: spec.dir,
      bible: bible.value,
      bibleDir: bible.dir,
      profile: profile.value,
      profileDir: profile.dir,
      routes,
      provider: providers,
      ledger,
      runsDir: dirname(dir),
      runId: basename(dir),
      capUsd,
      log: ctx.log,
      ...(work.promptPolicy && { promptPolicy: work.promptPolicy }),
    });
    const fields = { runDir, ...run };
    const human = formatRun(run, runDir);
    if (passed) return { exitCode: 0, fields, human };
    return refusal(
      "qa_found_nothing",
      "the looked-dev model did not pass its checks",
      fields,
      human,
    );
  },
});
