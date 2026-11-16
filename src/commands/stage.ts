import { nearMatchesFor } from "../search/near-match.ts";
import { basename, dirname } from "node:path";
import { InputError } from "../errors.ts";
import { readJson, loadProfile, loadStyleBible } from "../inputs.ts";
import { runCap } from "../budget.ts";
import { DEFAULT_CANDIDATES, planStage, stage } from "../loop.ts";
import { CORE_REGISTRY } from "../extensions/registry.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import { rigReads } from "../model3d/rig/template.ts";
import type { AssetSpec } from "../types.ts";
import { sharedTexts, withSharedText } from "../request.ts";
import { dryRunOutcome, formatPlan, formatRun, refusal } from "./result.ts";
import { defineCommand } from "./types.ts";
import type { RunContext, WorkPlan } from "./types.ts";
import {
  DRY_RUN_PROPERTY,
  NOTE_PROPERTY,
  ROUND_PROPERTY,
  buildWorkPlan,
  jobsOf,
  paidBy,
  specReads,
  styleBibleReads,
} from "../runs/plan.ts";

interface StageArgs {
  spec: string;
  bible: string;
  profile: string;
  candidates?: number;
  cap?: number;
  runs?: string;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
  round?: number;
  note?: string;
}

/** Everything stage's plan step reads: the inputs, providers, the stage plan and the WorkPlan. */
async function prepare(args: StageArgs, ctx: RunContext) {
  const candidates = args.candidates ?? DEFAULT_CANDIDATES;
  const capUsd = runCap(args.cap, ctx.settings);
  const spec = await readJson<AssetSpec>(args.spec);
  const bible = await loadStyleBible(args.bible);
  const profile = await loadProfile(args.profile);
  // Every asset kind of the registry: core's (still, sprite-strip, character-3d) and the loaded
  // extensions'.
  const registry = ctx.extensions ?? CORE_REGISTRY;
  registry.requireKind(spec.value.kind);
  if (args.note !== undefined && spec.value.kind === "character-3d")
    throw new InputError("--note applies to image kinds; a character-3d spec takes no note");
  const stageGenerators = [...registry.kinds];
  const providers = await providerSet(args.providerScript, ctx);
  const routes = providers.routes;
  const plan = planStage({
    spec: spec.value,
    profile: profile.value,
    routes,
    generators: stageGenerators,
    candidates,
    capUsd,
  });
  const jobs = jobsOf(plan.perCandidate, routes, candidates);
  const bibleFiles = styleBibleReads("bible", bible);
  const near = await nearMatchesFor(spec.value, Object.values(bibleFiles), ctx);
  const work: WorkPlan = await buildWorkPlan(stageCommand, args, {
    near,
    promptAllow: ctx.settings.promptPolicy.allow,
    inputs: ["spec", "bible", "profile"],
    promptText: args.note !== undefined ? [args.note] : [],
    reads: {
      ...bibleFiles,
      ...specReads("spec", spec),
      ...rigReads("profile", profile),
    },
    jobs,
    capUsd,
    paid: paidBy(providers, jobs),
    providers,
    candidates,
  });
  return {
    candidates,
    stageGenerators,
    capUsd,
    spec,
    bible,
    profile,
    providers,
    routes,
    plan,
    work,
  };
}

export const stageCommand = defineCommand<StageArgs>({
  name: "stage",
  tool: "stage",
  summary: "generate candidates within a cost cap and stage those that pass QA",
  details: `Generates candidates through the Vercel AI Gateway (AI_GATEWAY_API_KEY from the environment)
within the cost cap in USD, and stages only the ones that pass QA.
--note adds the author's note to each candidate's prompt (policy-checked, part of the request's digest);
with --round it asks for another round. 3D kinds do not take it.
--dry-run prints the planned calls, the cost forecast and the spend left under the daily and
work-item limits, writes nothing and needs no key.
--provider-script answers every model call from a module whose default export is
{ image, vision } instead of calling the gateway.
A character-3d spec makes rigged, animated .glb candidates from the subject's approved
turnaround: its 3D calls go to Tripo (TRIPO_API_KEY from the environment) and its identity call to
the gateway; turntable renders are written beside each candidate (docs/characters-3d.md).
A sprite-strip spec needs an approved keyPose: stage a still of the pose first, choose one
of its staged candidates, and name that file as keyPose in the strip spec.`,
  input: {
    type: "object",
    properties: {
      spec: { type: "string", description: "the asset spec", placeholder: "<spec.json>" },
      bible: { type: "string", description: "the style bible", placeholder: "<bible.json>" },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      candidates: {
        type: "number",
        description: "how many candidates to generate",
        default: DEFAULT_CANDIDATES,
      },
      cap: {
        type: "number",
        description:
          "the run's cost cap in USD; at most, and by default, the settings' caps.runUsd",
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
      note: NOTE_PROPERTY,
      round: ROUND_PROPERTY,
      dryRun: DRY_RUN_PROPERTY,
    },
    required: ["spec", "bible", "profile"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "conditional", writes: "runs" },
  confirm: "spend",
  plan: async (args, ctx) => (await prepare(args, ctx)).work,
  async run(args, ctx) {
    const ledger = spendLedger(ctx, args.workItem);
    const {
      candidates,
      stageGenerators,
      capUsd,
      spec,
      bible,
      profile,
      providers,
      routes,
      plan,
      work,
    } = await prepare(args, ctx);

    if (args.dryRun) {
      return dryRunOutcome(
        work,
        formatPlan(plan),
        ledger.forProfile(profile.value),
        plan as unknown as Record<string, unknown>,
      );
    }

    // The runner opened the request's run directory `<runs>/r-<16 hex>/`; stage runs in it.
    const dir = ctx.run?.dir ?? work.runDir;
    const { run, runDir } = await stage({
      spec: spec.value,
      specDir: spec.dir,
      bible: bible.value,
      bibleDir: bible.dir,
      profile: profile.value,
      profileDir: profile.dir,
      routes,
      provider: providers,
      generators: stageGenerators,
      runsDir: dirname(dir),
      runId: basename(dir),
      candidates,
      capUsd,
      ledger,
      ...(args.note !== undefined && { note: args.note }),
      log: ctx.log,
      ...(work.promptPolicy && { promptPolicy: work.promptPolicy }),
    });
    const fields = withSharedText({ runDir, ...run }, sharedTexts(bible.value));
    const human = formatRun(run, runDir);
    if (run.candidates.length > 0) return { exitCode: 0, fields, human };
    if (run.stopped) return refusal("cap_refused", run.stopped, fields, human);
    if (run.errors.length > 0 && run.errors.length === run.filtered) {
      return refusal(
        "provider_error",
        `every candidate failed to generate: ${run.errors[0]}`,
        fields,
        human,
      );
    }
    return refusal("qa_found_nothing", "no candidate passed QA", fields, human);
  },
});
