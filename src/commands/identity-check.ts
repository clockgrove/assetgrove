import { Budget, runCap } from "../budget.ts";
import { loadBible } from "../bible.ts";
import { Caller } from "../calls.ts";
import { InputError } from "../errors.ts";
import { checkIdentityRecord, loadIdentity } from "../identity.ts";
import type { IdentityRecordCheck } from "../identity.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import { IDENTITY_CHECK_OPERATION } from "../routes.ts";
import type { Route } from "../routes.ts";
import { ledgerFor } from "../spend.ts";
import {
  DRY_RUN_PROPERTY,
  ROUND_PROPERTY,
  RUNS_PROPERTY,
  bibleReads,
  buildWorkPlan,
  jobOf,
  paidBy,
} from "../runs/plan.ts";
import { dryRunOutcome, formatWork } from "./result.ts";
import { defineCommand } from "./types.ts";
import type { RunContext } from "./types.ts";

interface IdentityCheckArgs {
  bible: string;
  subject?: string[];
  cap?: number;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
  round?: number;
  runs?: string;
}

/** The plan step: the identities to check, loaded as the run loads them, and its WorkPlan. */
async function prepare(args: IdentityCheckArgs, ctx: RunContext) {
  const doc = await loadBible(args.bible);
  const named = args.subject ?? [];
  const subjects = named.length > 0 ? named : Object.keys(doc.data.identities).sort();
  const loaded = await Promise.all(
    subjects.map(async (subject) => {
      const identity = await loadIdentity(doc, subject);
      if (!identity) throw new InputError(`"${subject}" has no identity lock in ${doc.path}`);
      return identity;
    }),
  );
  if (loaded.length === 0) throw new InputError(`${doc.path} has no identity locks`);
  const provider = await providerSet(args.providerScript, ctx);
  const jobs = [
    jobOf(
      IDENTITY_CHECK_OPERATION,
      provider.routes[IDENTITY_CHECK_OPERATION] as Route,
      loaded.length,
    ),
  ];
  const work = await buildWorkPlan(identityCheckCommand, args, {
    inputs: ["bible"],
    reads: await bibleReads("bible", args.bible, subjects),
    jobs,
    capUsd: runCap(args.cap, ctx.settings),
    paid: paidBy(provider, jobs),
    candidates: 0,
  });
  return { loaded, provider, work };
}

export const identityCheckCommand = defineCommand<IdentityCheckArgs>({
  name: "identity-check",
  tool: "identity_check",
  summary: "check that identity records agree with their own approved references",
  details: `Asks the identity-check route whether each identity record's written signature features,
proportions and palette agree with the record's approved reference images (the source of truth).
Checks every identity in the bible, or the named subjects. Exits 1 when any record disagrees or
could not be checked: identity enforce mode does not filter with such a record until a person
fixes its text or its references. See docs/generation-knobs.md.`,
  input: {
    type: "object",
    properties: {
      bible: {
        type: "string",
        description: "the BIBLE.md holding the identity records",
        placeholder: "<BIBLE.md>",
      },
      subject: {
        type: "array",
        items: { type: "string" },
        description: "a subject to check; repeat for several (default: every identity)",
        placeholder: "<name>",
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
    required: ["bible"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "always", writes: "runs" },
  confirm: "spend",
  plan: async (args, ctx) => (await prepare(args, ctx)).work,
  async run(args, ctx) {
    const { loaded, provider, work } = await prepare(args, ctx);
    if (args.dryRun)
      return dryRunOutcome(
        work,
        formatWork("identity-check", work),
        spendLedger(ctx, args.workItem),
      );
    const routes = provider.routes;
    const budget = new Budget(
      work.capUsd,
      ledgerFor(spendLedger(ctx, args.workItem), provider, {}),
    );
    budget.check(
      loaded.length * (routes[IDENTITY_CHECK_OPERATION] as Route).estimatedCostUsd,
      `${loaded.length} identity record checks`,
    );
    const caller = new Caller({
      provider,
      budget,
      routes,
      log: ctx.log,
    });
    const checks: IdentityRecordCheck[] = [];
    for (const identity of loaded) checks.push(await checkIdentityRecord({ caller, ...identity }));
    const ok = checks.every((c) => c.checked && c.consistent);
    const fields = { checks, spentUsd: budget.spentUsd };
    const human = checks.map((c) => c.reason).join("\n");
    return { exitCode: ok ? 0 : 1, fields, human };
  },
});
