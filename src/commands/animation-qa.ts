import { join, resolve } from "node:path";
import {
  importTargets,
  parseAnchor,
  planAnimationQa,
  runAnimationQa,
  stripTarget,
} from "../animation/commands.ts";
import { formatReport } from "../animation/run.ts";
import { InputError } from "../errors.ts";
import { specForQa, loadProfile } from "../inputs.ts";
import { runCap } from "../budget.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import { dryRunOutcome, refusal, usd } from "./result.ts";
import { defineCommand } from "./types.ts";
import { MOTION_TEMPLATE_OPERATION } from "../routes.ts";
import type { Route } from "../routes.ts";
import type { RunContext } from "./types.ts";
import {
  DRY_RUN_PROPERTY,
  ROUND_PROPERTY,
  RUNS_PROPERTY,
  buildWorkPlan,
  jobOf,
  paidBy,
} from "../runs/plan.ts";
import type { PlanJob } from "../runs/plan.ts";

interface AnimationQaArgs {
  strip?: string;
  family?: string;
  profile?: string;
  import?: string;
  out?: string;
  subject?: string;
  spec?: string;
  anchor?: string;
  noVision?: boolean;
  cap?: number;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
  round?: number;
  runs?: string;
}

/** The plan step: the strips, their flicker and holes calls and the WorkPlan, with no call made. */
async function prepare(args: AnimationQaArgs, ctx: RunContext) {
  const capUsd = runCap(args.cap, ctx.settings);
  const providers = await providerSet(args.providerScript, ctx);
  const routes = providers.routes;
  const vision = !args.noVision;
  const spec = await specForQa(args.spec);
  let targets;
  if (typeof args.import === "string") {
    if (args.strip !== undefined) throw new InputError("give --strip or --import, not both");
    targets = await importTargets(args.import);
  } else {
    const missing = (["strip", "family", "profile"] as const).filter((n) => !args[n]);
    if (missing.length > 0) {
      throw new InputError(`missing required option ${missing.map((n) => `--${n}`).join(", ")}`);
    }
    const profile = await loadProfile(args.profile as string);
    const anchor = parseAnchor(args.anchor);
    targets = [
      stripTarget({
        path: args.strip as string,
        family: args.family as string,
        profile: profile.value,
        ...(args.subject !== undefined && { subject: args.subject }),
        ...(anchor !== undefined && { anchor }),
      }),
    ];
  }
  const subject = args.subject ?? spec.subject;
  for (const t of targets) {
    if (subject !== undefined) t.subject = subject;
    if (spec.gait !== undefined) t.gait = spec.gait;
    // The spec's template is its own family's: the one strip given, or the import's family of
    // the spec's name.
    if (
      spec.template !== undefined &&
      (spec.family === undefined ? targets.length === 1 : t.family === spec.family)
    )
      t.template = spec.template;
  }
  // The motion-template decisions are not vision checks: --no-vision still makes them.
  const plan = await planAnimationQa(targets, routes, capUsd, vision, true);
  const flickers = plan.perFamily.reduce((sum, f) => sum + f.flickerCalls, 0);
  const holes = plan.perFamily.reduce((sum, f) => sum + f.holeCalls, 0);
  const decisions = plan.perFamily.reduce((sum, f) => sum + f.templateCalls, 0);
  const jobs: PlanJob[] = [];
  if (decisions > 0)
    jobs.push(
      jobOf(MOTION_TEMPLATE_OPERATION, routes[MOTION_TEMPLATE_OPERATION] as Route, decisions),
    );
  if (flickers > 0) jobs.push(jobOf("flicker", routes.flicker, flickers));
  if (holes > 0) jobs.push(jobOf("holes", routes.holes, holes));
  const work = await buildWorkPlan(animationQaCommand, args, {
    promptAllow: ctx.settings.promptPolicy.allow,
    inputs: ["spec", "strip", "profile", "import"],
    // The motion-template, flicker and holes prompts name the family and the subject.
    promptText: jobs.length > 0 ? [args.family, args.subject].filter((t) => t !== undefined) : [],
    jobs,
    capUsd,
    paid: paidBy(providers, jobs),
    providers,
    candidates: 0,
  });
  return { capUsd, providers, routes, vision, targets, plan, work };
}

export const animationQaCommand = defineCommand<AnimationQaArgs>({
  name: "animation-qa",
  tool: "animation_qa",
  summary: "check strips against motion templates and for loop and continuity; write previews",
  details: `Checks each strip against its family's motion template (beats, timing, contact frames,
silhouette variation) and runs loop and continuity QA on pixels (loop seam, ground line,
footprint drift, a colour halo at the edge). Two checks need vision, within the
cost cap in USD: identity flicker, one call per pair of consecutive frames, each label and
confidence appended to flicker.jsonl; and holes, one call per frame with a see-through area
inside the figure's outline, which the model judges a hole or a natural opening between
parts. --no-vision skips both. Writes <family>.qa.json, the onion-skin
sheet <family>.onion.png and the looping preview <family>.webp into --out.
--import checks every family write-families wrote from that import.
--spec reads the asset spec's gait, template (and its subject, unless --subject is given); the
gait picks the motion template's footprint rule for it, over the profile's animation.gait.
A family no spec or grouping declares a template for, and that no template is named for, costs
one motion-template decision per run (--no-vision too); with none chosen, ground contact,
footprint drift and the loop seam are not applicable.
--dry-run prints the planned calls, the cost forecast and the spend left under the daily and
work-item limits, writes nothing and needs no key.
Give --strip, --family and --profile for one strip, or --import for every family of an import.
Exits 5 when any check fails; every failed check names its frame.`,
  input: {
    type: "object",
    properties: {
      strip: {
        type: "string",
        description: "the sprite strip to check",
        placeholder: "<strip.png>",
      },
      family: {
        type: "string",
        description: "the animation family of the strip",
        placeholder: "<name>",
      },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      import: {
        type: "string",
        description: "check every family write-families wrote from this import",
        placeholder: "<import directory>",
      },
      out: {
        type: "string",
        description: "where reports and previews are written",
        default: ".assetgrove/animation",
      },
      subject: {
        type: "string",
        description: "the subject the strips show",
        placeholder: "<name>",
      },
      spec: {
        type: "string",
        description: "the asset spec; supplies the gait, template and subject",
        placeholder: "<spec.json>",
      },
      anchor: { type: "string", description: "the anchor point of the frames", placeholder: "x,y" },
      noVision: {
        type: "boolean",
        description: "skip the flicker and holes checks that need vision",
      },
      cap: {
        type: "number",
        description:
          "the run's cost cap in USD; at most, and by default, the settings' caps.runUsd",
        placeholder: "<usd>",
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
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "conditional", writes: "out" },
  confirm: "spend",
  plan: async (args, ctx) => (await prepare(args, ctx)).work,
  async run(args, ctx) {
    const { capUsd, providers, routes, vision, targets, plan, work } = await prepare(args, ctx);
    if (args.dryRun) {
      const human = [
        `dry run: ${targets.length} strip(s), ${plan.calls} planned call(s), nothing spent`,
        ...plan.perFamily.map(
          (f) =>
            `  ${f.family}: ${f.flickerCalls} flicker call(s)  ${plan.model}; ${f.holeCalls} holes call(s)  ${plan.holesModel}` +
            (f.templateCalls > 0
              ? `; ${f.templateCalls} motion-template call  ${plan.templateModel}`
              : ""),
        ),
        `forecast ${usd(plan.estimateUsd)} against a $${capUsd.toFixed(2)} cap` +
          (plan.withinCap ? "" : " (over the cap)"),
      ].join("\n");
      const ledger = targets.reduce(
        (l, t) => l.forProfile(t.profile),
        spendLedger(ctx, args.workItem),
      );
      return dryRunOutcome(work, human, ledger, plan as unknown as Record<string, unknown>);
    }
    const outDir = resolve(args.out ?? ".assetgrove/animation");
    const { results, spentUsd } = await runAnimationQa({
      targets,
      outDir,
      routes,
      capUsd,
      ledger: spendLedger(ctx, args.workItem),
      provider: { provider: providers, name: providers.billing.providerId },
      vision,
    });
    const lines: string[] = [];
    for (const r of results) {
      lines.push(...formatReport(r.report));
      lines.push(`  onion skin ${r.files.onion}`, `  preview ${r.files.preview}`);
    }
    if (vision || spentUsd > 0)
      lines.push(`$${spentUsd.toFixed(4)} spent; decisions in ${join(outDir, "flicker.jsonl")}`);
    const fields = {
      outDir,
      spentUsd,
      families: results.map((r) => ({
        ...r.report,
        decisions: r.decisions,
        holeDecisions: r.holeDecisions,
        files: r.files,
      })),
    };
    const human = lines.join("\n");
    const failed = results.filter((r) => !r.report.passed).map((r) => r.report.family);
    if (failed.length > 0) {
      return refusal(
        "qa_found_nothing",
        `animation QA failed for ${failed.join(", ")}`,
        fields,
        human,
      );
    }
    return { exitCode: 0, fields, human };
  },
});
