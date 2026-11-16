import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { InputError } from "../errors.ts";
import { loadBible } from "../bible.ts";
import { recordIdentityThreshold } from "../identity.ts";
import { sha256 } from "../request.ts";
import { evaluateIdentity, planEvaluation } from "../identity-eval.ts";
import type { Breakdown, MediumReport } from "../identity-eval.ts";
import { loadProfile } from "../inputs.ts";
import { runCap } from "../budget.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import { IDENTITY_CHECK_OPERATION } from "../routes.ts";
import type { Route } from "../routes.ts";
import {
  DRY_RUN_PROPERTY,
  ROUND_PROPERTY,
  RUNS_PROPERTY,
  buildWorkPlan,
  jobOf,
  paidBy,
} from "../runs/plan.ts";
import { dryRunOutcome, formatWork } from "./result.ts";
import { defineCommand } from "./types.ts";
import type { RunContext } from "./types.ts";

function formatMedium(medium: string, m: MediumReport, threshold: number): string[] {
  const pct = (n: number) => `${Number((n * 100).toFixed(1))}%`;
  const line = (label: string, g: Breakdown["byKind"][string]) =>
    `  ${label}: ${g.cases} cases${g.auc !== undefined ? `, AUC ${g.auc.toFixed(3)}` : ""}, false accepts ${pct(g.falseAcceptRate)}, false rejects ${pct(g.falseRejectRate)}`;
  const b = m.configured;
  return [
    `${medium.toUpperCase()}${m.provisional ? " (provisional, no threshold rests on it)" : ""} at threshold ${threshold}:`,
    line("overall", b),
    ...Object.entries(b.byKind).map(([k, g]) => line(`kind ${k}`, g)),
    ...Object.entries(b.byCast).map(([c, g]) => line(`cast ${c}`, g)),
    m.provisional
      ? "  enforce bar: not judged on provisional 3D"
      : b.bar.met
        ? "  enforce bar (provisional): met"
        : `  enforce bar (provisional): not met: ${b.bar.failures.join("; ")}`,
  ];
}

async function record(
  args: IdentityEvalArgs,
  report: Awaited<ReturnType<typeof evaluateIdentity>>,
): Promise<string> {
  if (!report.recommended)
    throw new InputError("nothing to record: none meets the bar, so no threshold is recommended");
  const at = report.media["2d"]?.recommended;
  // Enforce drops paid candidates at the recorded cut, so a cut whose eval failed the bar (a set
  // the model cannot separate recommends the reject-everything cut) is never recorded.
  if (!at?.bar.met)
    throw new InputError(
      `nothing recorded: at the recommended threshold ${report.recommended.threshold} the enforce bar is not met${at ? ` (${at.bar.failures.join("; ")})` : ""}`,
    );
  const doc = await loadBible(args.bible as string);
  return recordIdentityThreshold(doc.dir, {
    question: report.question,
    model: report.model,
    threshold: report.recommended.threshold,
    recordedAt: new Date().toISOString(),
    eval: {
      casesFile: relative(doc.dir, resolve(args.cases)) || args.cases,
      casesSha256: sha256(new Uint8Array(await readFile(args.cases))),
      cases: report.cases,
      scored: report.scored,
      falseAcceptRate: at?.falseAcceptRate ?? 0,
      falseRejectRate: at?.falseRejectRate ?? 0,
      barMet: at?.bar.met ?? false,
    },
  });
}

interface IdentityEvalArgs {
  bible?: string;
  cases: string;
  profile?: string;
  log?: string;
  record?: boolean;
  cap?: number;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
  round?: number;
  runs?: string;
}

/** The plan step: the same inputs and routes the run uses, and its WorkPlan, with no call. */
async function prepare(args: IdentityEvalArgs, ctx: RunContext) {
  const profile = args.profile ? (await loadProfile(args.profile)).value : {};
  const provider = await providerSet(args.providerScript, ctx);
  const set = await planEvaluation({
    ...(args.bible !== undefined && { biblePath: args.bible }),
    casesPath: args.cases,
    profile,
  });
  // Checked before any call: a record is the bible's own, so every case must be judged against it.
  if (args.record) {
    if (args.bible === undefined) throw new InputError("--record needs --bible <BIBLE.md>");
    const own = (await loadBible(args.bible)).path;
    const others = set.bibles.filter((path) => path !== own);
    if (others.length > 0)
      throw new InputError(
        `--record records a threshold for ${args.bible} alone, but cases name other bibles: ${others.join(", ")}`,
      );
  }
  const jobs = [
    jobOf(set.operation, provider.routes[set.operation] as Route, set.cases),
    jobOf(
      IDENTITY_CHECK_OPERATION,
      provider.routes[IDENTITY_CHECK_OPERATION] as Route,
      set.identities,
    ),
  ];
  const work = await buildWorkPlan(identityEvalCommand, args, {
    promptAllow: ctx.settings.promptPolicy.allow,
    inputs: ["cases", "bible", "profile"],
    reads: set.reads,
    jobs,
    capUsd: runCap(args.cap, ctx.settings),
    paid: paidBy(provider, jobs),
    providers: provider,
    candidates: 0,
  });
  return { profile, provider, work };
}

export const identityEvalCommand = defineCommand<IdentityEvalArgs>({
  name: "identity-eval",
  tool: "identity_eval",
  summary: "score a local labelled image set against identity locks and recommend a threshold",
  details: `Scores every case of a labelled set against its subject's identity lock through the identity
route. cases.json is a list (or {"cases": [...]}) of {"image", "subject", "same": true|false,
"qa": true|false (optional), "kind": same|drift|generic|lookalike, "cast", "medium": 2d|3d,
"bible": path relative to the file}, image paths relative to the file. --bible is optional when
every case names its bible. With identity.question "cast" each candidate is judged against the whole
cast of its bible; every subject's record is first checked against its own references. Each call's label, confidence,
latency and cost are logged on stderr, and one JSON line per case goes to --log. Reports accuracy
for every threshold, the recommended threshold, accuracy at the profile's threshold and agreement
with the cases' QA verdicts. The recommended threshold is the one with the fewest false rejects among those whose false-accept rate is within the enforce bar overall, per kind and per cast (the lowest on a tie); when none meets the bar, none is recommended. --record writes it to identity-thresholds.json beside --bible, keyed by question and model, which enforce mode requires. Never filters or approves. Keep the set and the log local; they may
hold a game's private art. See docs/generation-knobs.md.`,
  input: {
    type: "object",
    properties: {
      bible: {
        type: "string",
        description: "the BIBLE.md holding the identity locks",
        placeholder: "<BIBLE.md>",
      },
      cases: { type: "string", description: "the labelled cases", placeholder: "<cases.json>" },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      record: {
        type: "boolean",
        description:
          "record the recommended threshold for this bible and model in identity-thresholds.json beside the bible; refused when none meets the bar",
      },
      log: {
        type: "string",
        description: "where one JSON line per case is written",
        placeholder: "<identity-eval.jsonl>",
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
      runs: RUNS_PROPERTY,
      round: ROUND_PROPERTY,
      dryRun: DRY_RUN_PROPERTY,
    },
    required: ["cases"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "always", writes: "out" },
  confirm: "spend",
  plan: async (args, ctx) => (await prepare(args, ctx)).work,
  async run(args, ctx) {
    const { profile, provider, work } = await prepare(args, ctx);
    if (args.dryRun)
      return dryRunOutcome(
        work,
        formatWork("identity-eval", work),
        spendLedger(ctx, args.workItem).forProfile(profile),
      );
    const report = await evaluateIdentity({
      ...(args.bible !== undefined && { biblePath: args.bible }),
      casesPath: args.cases,
      profile,
      routes: provider.routes,
      provider,
      capUsd: work.capUsd,
      ledger: spendLedger(ctx, args.workItem),
      ...(args.log !== undefined && { logPath: args.log }),
      log: ctx.log,
    });
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    const recorded = args.record ? await record(args, report) : undefined;
    const lines = [
      `${report.scored} of ${report.cases} cases scored by ${report.model} (${report.question}), ${report.failed} failed, $${report.spentUsd.toFixed(6)} spent`,
      ...report.sweep.map(
        (r) =>
          `  threshold ${r.threshold.toFixed(3)}: ${r.correct} correct (${pct(r.accuracy)}), ${r.falseRejects} false rejects, ${r.falseAccepts} false accepts`,
      ),
      report.recommended
        ? `recommended threshold ${report.recommended.threshold.toFixed(3)} (${pct(report.recommended.accuracy)})`
        : report.sweep.length > 0
          ? "no threshold recommended: none meets the bar (false-accept rate within the enforce bar)"
          : "no threshold recommended: no 2D case of a trusted record was scored",
      ...(recorded
        ? [`recorded threshold ${report.recommended?.threshold.toFixed(3)} in ${recorded}`]
        : []),
      `configured threshold ${report.configured.threshold}: ${pct(report.configured.accuracy)}`,
      ...(report.qaAgreement
        ? [
            `agreement with QA: ${report.qaAgreement.agree}/${report.qaAgreement.scored} (${pct(report.qaAgreement.rate)}), identity-only failures ${report.qaAgreement.identityOnlyFailed}, QA-only failures ${report.qaAgreement.qaOnlyFailed}`,
          ]
        : []),
      ...(["2d", "3d"] as const).flatMap((medium) => {
        const m = report.media[medium];
        return m ? formatMedium(medium, m, report.configured.threshold) : [];
      }),
      ...(report.untrusted
        ? [
            `untrusted records (kept out of the threshold and the bar): ${report.untrusted.cases} cases at threshold ${report.configured.threshold}, false accepts ${pct(report.untrusted.falseAcceptRate)}, false rejects ${pct(report.untrusted.falseRejectRate)}`,
          ]
        : []),
      ...report.recordChecks.map((c) => `record check: ${c.reason}`),
    ];
    return { exitCode: 0, fields: { ...report }, human: lines.join("\n") };
  },
});
