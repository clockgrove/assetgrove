import { runCap } from "../budget.ts";
import { resolve } from "node:path";
import {
  DEFAULT_FIX_CAP_USD,
  parseAnchor,
  planFrameFix,
  runFixFrame,
  stripTarget,
} from "../animation/commands.ts";
import { formatReport } from "../animation/run.ts";
import { InputError } from "../errors.ts";
import { specForQa, loadProfile, loadStyleBible } from "../inputs.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import { dryRunOutcome, usd } from "./result.ts";
import { defineCommand } from "./types.ts";
import type { RunContext } from "./types.ts";
import {
  DRY_RUN_PROPERTY,
  ROUND_PROPERTY,
  RUNS_PROPERTY,
  buildWorkPlan,
  jobsOf,
  paidBy,
} from "../runs/plan.ts";

interface FixFrameArgs {
  strip: string;
  family: string;
  profile: string;
  frame: number;
  from?: number;
  keyPose?: string;
  out: string;
  subject?: string;
  spec?: string;
  note?: string;
  provenance?: string;
  bible?: string;
  anchor?: string;
  cap?: number;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
  round?: number;
  runs?: string;
}

/** The plan step: the strip's inputs, the one edit call and the WorkPlan, with no call made. */
async function prepare(args: FixFrameArgs, ctx: RunContext) {
  if ((args.from === undefined) === (args.keyPose === undefined)) {
    throw new InputError("give exactly one of --from <frame> or --key-pose <image>");
  }
  const capUsd = runCap(args.cap, ctx.settings, DEFAULT_FIX_CAP_USD);
  const providers = await providerSet(args.providerScript, ctx);
  const routes = providers.routes;
  const profile = await loadProfile(args.profile);
  const anchor = parseAnchor(args.anchor);
  const spec = await specForQa(args.spec);
  const subject = args.subject ?? spec.subject;
  const target = stripTarget({
    path: args.strip,
    family: args.family,
    profile: profile.value,
    ...(subject !== undefined && { subject }),
    ...(anchor !== undefined && { anchor }),
    ...(spec.gait !== undefined && { gait: spec.gait }),
    // The spec's template is its own family's.
    ...(spec.template !== undefined &&
      (spec.family === undefined || spec.family === args.family) && {
        template: spec.template,
      }),
  });
  const plan = planFrameFix(routes, capUsd, target);
  const jobs = jobsOf(plan.perCall, routes);
  const work = await buildWorkPlan(fixFrameCommand, args, {
    promptAllow: ctx.settings.promptPolicy.allow,
    inputs: ["strip", "profile", "spec", "keyPose", "provenance", "bible"],
    // Without --provenance the fix reads the strip's sidecar when it exists.
    reads: { provenance: `${args.strip}.provenance.json` },
    // The edit prompt names the family and the subject and carries the note.
    promptText: [args.family, args.subject, args.note].filter((t) => t !== undefined),
    jobs,
    capUsd,
    paid: paidBy(providers, jobs),
    providers,
    candidates: 1,
  });
  return { capUsd, providers, routes, profile, target, plan, work };
}

export const fixFrameCommand = defineCommand<FixFrameArgs>({
  name: "fix-frame",
  tool: "fix_frame",
  summary: "regenerate one bad frame of a strip by a reference-guided edit within a cost cap",
  details: `Edits frame <n> (1-based) with one reference-guided edit call, from an approved neighbour
frame (--from) or the approved key pose (--key-pose), within the cost cap in USD. When the edited
figure's candidate scales (area, height, head box) register to different pixels and the strip has
another frame to draw beside it, one fix-scale decision call then picks the scale at which the
character matches the surrounding frames; the edit and that decision are reserved against the cap
together before the first call. Only that frame changes. Writes the fixed strip, its provenance
(the strip's own, with the calls and a fixes entry added) and its QA report and previews into
--out. --provenance (default <strip>.provenance.json when it exists) is the strip's own provenance
or the record recipe or op wrote for it; any other file is refused (exit 2) before the call. Never
writes into a target and never sets a review value. --spec reads the asset spec's gait, template
(and subject) for that QA. A family whose spec declares no template and that no template is named
for first costs one motion-template decision, which picks the registration pin and the QA's
template.
Give exactly one of --from and --key-pose.
--dry-run prints the planned calls (the edit, the fix-scale decision and any motion-template
decision), the forecast and the spend left under the daily and work-item
limits, and needs no key.`,
  input: {
    type: "object",
    properties: {
      strip: {
        type: "string",
        description: "the sprite strip holding the bad frame",
        placeholder: "<strip.png>",
      },
      family: {
        type: "string",
        description: "the animation family of the strip",
        placeholder: "<name>",
      },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      frame: {
        type: "integer",
        minimum: 1,
        description: "the frame to regenerate, counted from 1",
        placeholder: "<n>",
      },
      from: {
        type: "integer",
        minimum: 1,
        description: "the approved neighbour frame to edit from",
        placeholder: "<n>",
      },
      keyPose: {
        type: "string",
        description: "the approved key pose to edit from",
        placeholder: "<image>",
      },
      out: {
        type: "string",
        description: "where the fixed strip and reports are written",
        placeholder: "<directory>",
      },
      subject: {
        type: "string",
        description: "the subject the strip shows",
        placeholder: "<name>",
      },
      spec: {
        type: "string",
        description: "the asset spec; supplies the gait, template and subject",
        placeholder: "<spec.json>",
      },
      note: { type: "string", description: "a note for the edit call", placeholder: "<text>" },
      provenance: {
        type: "string",
        description: "the strip's own provenance record",
        placeholder: "<strip>.provenance.json",
      },
      bible: {
        type: "string",
        description: "the style bible (BIBLE.md)",
        placeholder: "<BIBLE.md>",
      },
      anchor: { type: "string", description: "the anchor point of the frames", placeholder: "x,y" },
      cap: {
        type: "number",
        description: "the run's cost cap in USD",
        default: DEFAULT_FIX_CAP_USD,
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
    required: ["strip", "family", "profile", "frame", "out"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "conditional", writes: "out" },
  confirm: "spend",
  plan: async (args, ctx) => (await prepare(args, ctx)).work,
  async run(args, ctx) {
    const index = args.frame;
    const neighbour = args.from;
    const keyPose = args.keyPose;
    const { capUsd, providers, routes, profile, target, plan, work } = await prepare(args, ctx);
    if (args.dryRun) {
      const human = [
        `dry run: fix frame ${index}, ${plan.calls} planned call(s), nothing spent`,
        ...plan.perCall.map((c) => `  ${c.operation}  ${c.model}  ~${usd(c.estimatedCostUsd)}`),
        `forecast ${usd(plan.estimateUsd)} against a $${capUsd.toFixed(2)} cap` +
          (plan.withinCap ? "" : " (over the cap)"),
      ].join("\n");
      return dryRunOutcome(
        work,
        human,
        spendLedger(ctx, args.workItem).forProfile(profile.value),
        plan,
      );
    }
    const bible =
      args.bible !== undefined
        ? (await loadStyleBible(args.bible, { log: ctx.log })).value
        : undefined;
    const result = await runFixFrame({
      target,
      index,
      from: keyPose !== undefined ? { keyPose } : { neighbour: neighbour as number },
      ...(args.note !== undefined && { note: args.note }),
      ...(args.provenance !== undefined && { provenancePath: args.provenance }),
      ...(bible !== undefined && { bible: { version: bible.version, palette: bible.palette } }),
      outDir: resolve(args.out),
      routes,
      capUsd,
      ledger: spendLedger(ctx, args.workItem),
      provider: { provider: providers, name: providers.billing.providerId },
    });
    const human = [
      `fixed frame ${index} of ${target.family} with ${result.fix.model} (request ${result.fix.requestId}), $${result.spentUsd.toFixed(4)} spent`,
      `wrote ${result.stripPath}`,
      `wrote ${result.provenancePath}`,
      ...formatReport(result.qa.report),
      `  onion skin ${result.qa.files.onion}`,
      `  preview ${result.qa.files.preview}`,
    ].join("\n");
    return {
      exitCode: 0,
      fields: {
        stripPath: result.stripPath,
        provenancePath: result.provenancePath,
        fix: result.fix,
        spentUsd: result.spentUsd,
        qa: { ...result.qa.report, files: result.qa.files },
      },
      human,
    };
  },
});
