import { nearMatchesFor, subjectReferencePaths } from "../search/near-match.ts";
import { resolve } from "node:path";
import type { GenerationBrief } from "../planning.ts";
import { readJson, lockFor, loadProfile, loadStyleBible } from "../inputs.ts";
import { runCap } from "../budget.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import { IDENTITY_CAST_OPERATION, IDENTITY_CHECK_OPERATION } from "../routes.ts";
import type { Route } from "../routes.ts";
import { generateSheet, motionLines, planSheet, sheetBrief } from "../sheet/generate.ts";
import { templatesFor } from "../animation/templates.ts";
import { InputError } from "../errors.ts";
import { knownTemplate } from "../animation/template-choice.ts";
import { SliceError } from "../sheet/slice.ts";
import type { AssetSpec } from "../types.ts";
import { sharedTexts, subjectOf, withSharedText } from "../request.ts";
import { formatImport } from "./import.ts";
import { dryRunOutcome, refusal, usd } from "./result.ts";
import { defineCommand } from "./types.ts";
import type { RunContext } from "./types.ts";
import {
  DRY_RUN_PROPERTY,
  NOTE_PROPERTY,
  ROUND_PROPERTY,
  RUNS_PROPERTY,
  bibleReads,
  buildWorkPlan,
  specReads,
  styleBibleReads,
  jobsOf,
  paidBy,
} from "../runs/plan.ts";

interface GenerateSheetArgs {
  spec: string;
  bible: string;
  profile: string;
  brief?: string;
  cap?: number;
  imports?: string;
  lockBible?: string;
  identityMode?: string;
  maxHalo?: number;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
  round?: number;
  runs?: string;
  note?: string;
}

/** Generate-sheet's plan step: its inputs, providers, planned calls and WorkPlan, with no call. */
async function prepare(args: GenerateSheetArgs, ctx: RunContext) {
  const capUsd = runCap(args.cap, ctx.settings);
  // Checked before the sheet is paid for; the import checks it again.
  if (args.maxHalo !== undefined && !(args.maxHalo >= 0 && args.maxHalo <= 1))
    throw new InputError(
      `the matte limit --max-halo must be a fraction from 0 to 1, not ${args.maxHalo}`,
    );
  const spec = await readJson<AssetSpec>(args.spec);
  const bible = await loadStyleBible(args.bible, { log: ctx.log });
  // A BIBLE.md holds the identity locks too: it is the lock bible unless --lock-bible names another.
  const lockBible = args.lockBible ?? (bible.markdown ? args.bible : undefined);
  const profile = await loadProfile(args.profile);
  const brief =
    args.brief === undefined
      ? undefined
      : sheetBrief((await readJson<unknown>(args.brief)).value, ctx.settings.promptPolicy.allow);
  const providers = await providerSet(args.providerScript, ctx);
  const routes = providers.routes;
  const lock = await lockFor(
    lockBible,
    args.identityMode,
    spec.value.subject ?? spec.value.assetId,
    profile.value,
    routes,
  );
  const perCall = [
    ...planSheet(spec.value, profile.value, routes),
    ...(lock
      ? [
          lock.settings.question === "cast" ? IDENTITY_CAST_OPERATION : "identity",
          ...(lock.settings.mode === "enforce" ? [IDENTITY_CHECK_OPERATION] : []),
        ].map((operation) => ({
          operation,
          model: (routes[operation] as Route).model,
          estimatedCostUsd: (routes[operation] as Route).estimatedCostUsd,
        }))
      : []),
  ];
  const jobs = jobsOf(perCall, routes);
  // The sheet prompt states the family's motion template, which the profile can declare. A family
  // nothing declares or names is decided at run time, so every template's lines are checked.
  const family = spec.value.animationFamily;
  const templates = templatesFor(profile.value);
  const known =
    typeof family === "string"
      ? knownTemplate(family, templates, spec.value.template)
      : { source: "undecided" as const };
  const motionTemplates = known ? [known.template] : templates;
  const bibleFiles = styleBibleReads("bible", bible);
  const near = await nearMatchesFor(
    spec.value,
    await subjectReferencePaths(spec, lockBible, bible),
    ctx,
    args.brief === undefined ? undefined : (await readJson<GenerationBrief>(args.brief)).value,
  );
  const work = await buildWorkPlan(generateSheetCommand, args, {
    near,
    promptAllow: ctx.settings.promptPolicy.allow,
    inputs: ["spec", "bible", "profile", "brief", "lockBible"],
    reads: {
      ...bibleFiles,
      ...specReads("spec", spec),
      ...(lock && lockBible !== undefined
        ? await bibleReads("lockBible", lockBible, lock.cast ? undefined : [lock.record.subject])
        : {}),
      // The recorded threshold decides which candidates enforce mode drops.
      ...(lock?.recordPath !== undefined && { "lockBible/identity-thresholds": lock.recordPath }),
    },
    // The sheet prompt names the subject (the asset id when the spec has no subject), so the plan
    // step checks it, free, before the spend is confirmed.
    promptText: [
      subjectOf(spec.value),
      ...motionTemplates.flatMap((t) => motionLines(t, undefined)),
      ...(args.note !== undefined ? [args.note] : []),
    ],
    jobs,
    capUsd,
    paid: paidBy(providers, jobs),
    providers,
    candidates: 1,
  });
  return { spec, bible, profile, brief, providers, routes, capUsd, lock, perCall, work };
}

export const generateSheetCommand = defineCommand<GenerateSheetArgs>({
  name: "generate-sheet",
  tool: "generate_sheet",
  summary: "have the model draw a whole cycle as one sheet within a cost cap, then import it",
  details: `Asks the model for a whole animation cycle as one sheet within the cost cap in USD, then
imports it as the import command does, with a proposed grouping for a human to confirm.
A sheet that does not slice into exactly the spec's frames.count figures fails QA (exit 5),
naming the cells or figures behind the difference; the sheet and its generation record are
kept in the import directory.
--dry-run prints the planned calls, the cost forecast and the spend left under the daily and
work-item limits, writes nothing and needs no key.
--lock-bible (by default --bible, when it is a BIBLE.md) and --identity-mode score the generated
sheet against the subject's identity lock as the import command does; the scoring call is part of the forecast and the cap.
The prompt states the family's motion template (its beats, a held pose, the loop). --brief adds
the author's brief (purpose, setting, what happens), checked as plan checks it.
--note adds the author's note to the sheet prompt (policy-checked, part of the request's digest); with
--round it asks for another round.`,
  input: {
    type: "object",
    properties: {
      spec: { type: "string", description: "the asset spec", placeholder: "<spec.json>" },
      bible: {
        type: "string",
        description: "the style bible (BIBLE.md)",
        placeholder: "<BIBLE.md>",
      },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      brief: {
        type: "string",
        description: "the author's brief: purpose, setting, what happens",
        placeholder: "<brief.json>",
      },
      cap: {
        type: "number",
        description:
          "the run's cost cap in USD; at most, and by default, the settings' caps.runUsd",
        placeholder: "<usd>",
      },
      imports: {
        type: "string",
        description: "where imports are staged",
        default: ".assetgrove/imports",
      },
      lockBible: {
        type: "string",
        description:
          "score the sheet against the subject's identity lock in this art bible (default: --bible when it is a BIBLE.md)",
        placeholder: "<BIBLE.md>",
      },
      identityMode: {
        type: "string",
        description: "override the profile's identity mode",
        placeholder: "<off|shadow|enforce>",
      },
      maxHalo: {
        type: "number",
        minimum: 0,
        description:
          "the matte checks' limit, 0 to 1: the share of a frame's edge pixels that may keep the background colour (default 0.005)",
        placeholder: "<fraction>",
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
      runs: RUNS_PROPERTY,
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
    const { spec, bible, profile, brief, providers, routes, capUsd, lock, perCall, work } =
      await prepare(args, ctx);
    if (args.dryRun) {
      const estimateUsd = perCall.reduce((sum, c) => sum + c.estimatedCostUsd, 0);
      const plan = {
        kind: "sheet",
        calls: perCall.length,
        perCall,
        estimateUsd,
        capUsd,
        withinCap: estimateUsd <= capUsd + 1e-9,
      };
      const human = [
        `dry run: one generated sheet, ${perCall.length} planned call(s), nothing spent`,
        ...perCall.map((c) => `  ${c.operation}  ${c.model}  ~${usd(c.estimatedCostUsd)}`),
        `forecast ${usd(estimateUsd)} against a $${capUsd.toFixed(2)} cap` +
          (plan.withinCap ? "" : " (over the cap)"),
      ].join("\n");
      return dryRunOutcome(work, human, ledger.forProfile(profile.value), plan);
    }
    let generated: Awaited<ReturnType<typeof generateSheet>>;
    try {
      generated = await generateSheet({
        spec: spec.value,
        ...(brief !== undefined && { brief }),
        specDir: spec.dir,
        bible: bible.value,
        bibleDir: bible.dir,
        profile: profile.value,
        routes,
        provider: providers,
        importsDir: resolve(args.imports ?? ".assetgrove/imports"),
        ...(ctx.run && { runDir: ctx.run.dir }),
        ...(args.maxHalo !== undefined && { matte: { maxHaloFraction: args.maxHalo } }),
        capUsd,
        ledger,
        ...(args.note !== undefined && { note: args.note }),
        ...(lock && {
          identity: {
            record: lock.record,
            references: lock.references,
            settings: lock.settings,
            ...(lock.cast && { cast: lock.cast }),
          },
        }),
      });
    } catch (error) {
      // The model drew another number of figures than the spec asks for: the sheet failed QA.
      if (!(error instanceof SliceError)) throw error;
      const fields = {
        spentUsd: error.spentUsd,
        found: error.found,
        expected: error.expected,
        problems: error.problems,
        ...(error.kept !== undefined && { kept: error.kept }),
      };
      return refusal("qa_found_nothing", error.message, fields, "");
    }
    const { record, importDir, grouping, spentUsd, contactSheet } = generated;
    return {
      exitCode: 0,
      fields: withSharedText(
        {
          importDir,
          spentUsd,
          ...(ctx.run && { runDir: ctx.run.dir }),
          ...(contactSheet && { contactSheet }),
          ...record,
          grouping,
        },
        sharedTexts(bible.value),
      ),
      human: `$${spentUsd.toFixed(4)} spent\n${formatImport(record, importDir, grouping)}`,
    };
  },
});
