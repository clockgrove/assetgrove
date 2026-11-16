/**
 * The executor of a paid command (design section 9). For a real run it makes the free plan step,
 * refuses a forecast over the cap, creates the run directory `<runs>/r-<16 hex>/` with
 * `request.json`, takes its `lock`, and then either returns the finished run (`reused: true`) or
 * runs the command inside the run's journal scope, so every provider call already answered is
 * answered from `calls/` and only missing calls are paid for. It writes `state.json` as the run
 * moves and `run.json` when it ends, and reports progress to a connected client.
 *
 * Checked where money is spent (design section 7): before the first reservation and on every
 * resume, a request that can spend is confirmed (`requireConfirmation`: headless settings, the
 * record of its digest, a prior confirmation the command names, the TTY, else exit 8), and the
 * run's scope carries the clearance `Caller` requires for every paid call. The record is copied
 * into `run.json`. A confirmation pays for one run: its first run binds it to the run directory,
 * and the run finishing consumes it, so the same request in another directory asks again. A
 * request whose forecast is 0 on free providers needs no confirmation.
 *
 * The run executes in the process that received the request: there is no detached process.
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONTACT_SHEET_FILE } from "../contact.ts";
import type { Outcome, RunContext } from "../commands/types.ts";
import { createProviders } from "../providers/adapter.ts";
import { loadScript } from "../providers/script.ts";
import {
  beginRunReconcile,
  finishRunReconcile,
  recordReconcile,
  startRunReconcile,
} from "../reconcile.ts";
import type { ReconcileContext, ReconcileEntry, RunReconcile } from "../reconcile.ts";
import { Budget } from "../budget.ts";
import { Caller } from "../calls.ts";
import { checkPromptModel } from "../policy/model.ts";
import type { PromptPolicyRecord } from "../policy/text.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import { SpendHoldError, ledgerFor } from "../spend.ts";
import { bindConfirmation, requireConfirmation } from "../confirm/index.ts";
import type { KindRequest } from "../confirm/index.ts";
import type { ConfirmationRecord } from "../types.ts";
import { DEFAULT_ROUND, policyTextOf } from "./plan.ts";
import type { WorkPlan } from "./plan.ts";
import { RUN_RECORD_FILE, openRunDir, runIdOfDir, writeRunRecord } from "./dir.ts";
import { Journal, withRunScope } from "./journal.ts";
import type { RunScope } from "./journal.ts";
import { RunInProgressError, acquireRunLock } from "./lock.ts";

export const STATE_FILE = "state.json";

export type RunStatus = "running" | "finished" | "failed";

/** A run's state (`state.json`): where it is, who runs it and, once it ends, how it ended. */
export interface RunState {
  runId: string;
  command: string;
  digest: string;
  status: RunStatus;
  pid: number;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  /** How many times the request has been executed in this directory, resumes included. */
  attempts: number;
  /** The outcome a finished run returns again when the request is repeated. */
  outcome?: { exitCode: number; fields: Record<string, unknown>; human: string; error?: unknown };
}

/** What a run tells a connected client: calls answered so far of the plan's total. */
export interface ProgressUpdate {
  progress: number;
  total: number;
  message: string;
}

/** The state of a run directory, or undefined when it has none or it cannot be read. */
export function readRunState(runDir: string): RunState | undefined {
  try {
    return JSON.parse(readFileSync(join(runDir, STATE_FILE), "utf8")) as RunState;
  } catch {
    return undefined;
  }
}

async function writeState(runDir: string, state: RunState): Promise<void> {
  await writeFile(join(runDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** The outcome of a refusal before the run starts. */
function refused(
  code: "cap_refused" | "run_in_progress" | "spend_hold",
  message: string,
  exitCode: number,
) {
  return { exitCode, fields: {}, human: "", error: { code, message } } satisfies Outcome;
}

/** The fields every executed run adds to its command's result. */
function runFields(plan: WorkPlan, reused: boolean): Record<string, unknown> {
  return { runId: runIdOfDir(plan.runDir), runDir: plan.runDir, digest: plan.digest, reused };
}

/** Whether a request needs a spend confirmation: all but a forecast of 0 on free providers. */
export function needsSpendConfirmation(plan: WorkPlan): boolean {
  return plan.paid || plan.forecastUsd > 0;
}

/**
 * What a person is shown for a spend request: its summary and flat fields, from the digest body's
 * own fields (so `assetgrove confirm` can rebuild them from a verified body) plus, when the
 * WorkPlan is at hand, its candidate count, which the digest does not cover.
 */
export function spendShown(
  id: string,
  body: {
    command: string;
    jobs: WorkPlan["jobs"];
    forecastUsd: number;
    capUsd: number;
    options?: Record<string, unknown>;
  },
  candidates?: number,
  nearMatches?: readonly { address: string }[],
): { summary: string; details: Record<string, unknown> } {
  const providers = [...new Set(body.jobs.map((j) => j.provider).filter(Boolean))];
  const region = body.options?.["region"];
  const regions =
    Array.isArray(region) && region.every((r) => typeof r === "string")
      ? (region as string[])
      : undefined;
  const summary = `${body.command} would spend up to $${body.forecastUsd.toFixed(4)} (cap $${body.capUsd.toFixed(2)})`;
  return {
    summary:
      (regions ? `${summary}; regions: ${regions.map((r, i) => `${i + 1}) ${r}`).join("; ")}` : summary) +
      (nearMatches !== undefined && nearMatches.length > 0
        ? `; existing near matches of this kind and subject: ${nearMatches.map((m) => m.address).join(", ")}`
        : ""),
    details: {
      command: body.command,
      jobs: body.jobs,
      ...(candidates !== undefined && { candidates }),
      ...(nearMatches !== undefined &&
        nearMatches.length > 0 && { nearMatches: nearMatches.map((m) => m.address) }),
      ...(regions && { regions }),
      forecastUsd: body.forecastUsd,
      capUsd: body.capUsd,
      providers,
      digest: id,
    },
  };
}

/** The spend request of a WorkPlan: its digest body, and what a person is shown. */
export function spendRequest(command: string, round: number, plan: WorkPlan): KindRequest {
  const body = {
    command,
    round,
    inputs: plan.inputs,
    options: plan.options,
    jobs: plan.jobs,
    forecastUsd: plan.forecastUsd,
    capUsd: plan.capUsd,
    policyTextSha256: plan.policyTextSha256,
  };
  return {
    kind: "spend",
    id: plan.digest,
    ...spendShown(plan.digest, body, plan.candidates, plan.nearMatches),
    body,
  };
}

/** Adds the confirmation to the run's `run.json`, whoever wrote it. */
async function recordConfirmation(runDir: string, record: ConfirmationRecord): Promise<void> {
  const path = join(runDir, RUN_RECORD_FILE);
  let run: Record<string, unknown>;
  try {
    run = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  await writeFile(path, `${JSON.stringify({ ...run, confirmation: record }, null, 2)}\n`);
}

/**
 * Executes a paid command's request: `plan` is its free plan step, `run` its real run. A thrown
 * error becomes an outcome through `toOutcome`. `prior` names an earlier confirmation that covers
 * this request (apply's plan); `round` is the request's round, part of its digest.
 */
export async function executeRun(options: {
  command: string;
  plan: WorkPlan;
  ctx: RunContext;
  run: (ctx: RunContext) => Promise<Outcome>;
  toOutcome: (error: unknown) => Outcome;
  /** The `--provider-script` module, which reconciling gives the scripted providers it makes. */
  providerScript?: string;
  round?: number;
  /** The work item the spend ledger counts the run's own prompt-policy call against. */
  workItem?: string;
  prior?: () => Promise<ConfirmationRecord | undefined>;
}): Promise<Outcome> {
  const { command, plan, ctx } = options;
  if (plan.forecastUsd > plan.capUsd + 1e-9)
    return refused(
      "cap_refused",
      `refused: the forecast $${plan.forecastUsd.toFixed(4)} exceeds the $${plan.capUsd.toFixed(2)} cap`,
      3,
    );
  // A paid run first retries pending reconcile lookups, then is refused while a spend hold is not
  // acknowledged, and takes the balance readings its end compares with (src/reconcile.ts).
  let reconcileCtx: ReconcileContext | undefined;
  let reconcile: RunReconcile | undefined;
  if (plan.paid) {
    reconcileCtx = await reconcileContext(ctx, options.providerScript);
    try {
      reconcile = await startRunReconcile(reconcileCtx, {
        runId: runIdOfDir(plan.runDir),
        runDir: plan.runDir,
        providers: plan.jobs.map((j) => j.provider),
      });
    } catch (error) {
      if (error instanceof SpendHoldError) return refused("spend_hold", error.message, 3);
      throw error;
    }
  }
  await openRunDir(plan);
  let lock;
  try {
    lock = acquireRunLock(plan.runDir);
  } catch (error) {
    if (error instanceof RunInProgressError) return refused("run_in_progress", error.message, 2);
    throw error;
  }
  try {
    const runId = runIdOfDir(plan.runDir);
    const previous = readRunState(plan.runDir);
    if (previous?.status === "finished" && previous.outcome !== undefined) {
      // A finished request is returned as it ended: no provider call, no ledger entry.
      const stored = previous.outcome;
      ctx.progress?.({ progress: 1, total: 1, message: `run ${runId} reused` });
      return {
        exitCode: stored.exitCode,
        fields: { ...stored.fields, ...runFields(plan, true) },
        human: stored.human,
      };
    }
    // Before the first reservation and on every resume: no confirmation, no run (exit 8).
    let confirmation: ConfirmationRecord | undefined;
    if (needsSpendConfirmation(plan)) {
      try {
        confirmation = await requireConfirmation(
          spendRequest(command, options.round ?? DEFAULT_ROUND, plan),
          { settings: ctx.settings, ...(ctx.prompt && { prompt: ctx.prompt }) },
          { ...(options.prior && { prior: options.prior }), runDir: plan.runDir },
        );
      } catch (error) {
        return options.toOutcome(error);
      }
    }
    const state: RunState = {
      runId,
      command,
      digest: plan.digest,
      status: "running",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      attempts: (previous?.attempts ?? 0) + 1,
    };
    await writeState(plan.runDir, state);
    // An interrupted earlier attempt's balance readings stay this run's start (src/reconcile.ts).
    if (reconcile !== undefined) beginRunReconcile(reconcile);
    // A record left by an earlier attempt of the same request is replaced by this one's.
    await rm(join(plan.runDir, RUN_RECORD_FILE), { force: true });
    await rm(join(plan.runDir, CONTACT_SHEET_FILE), { force: true });

    const progress = progressReporter(plan, ctx);
    const journal = new Journal(plan.runDir, runId);
    const scope: RunScope = {
      journal,
      onCall: progress.onCall,
      ...(confirmation && { clearance: { digest: plan.digest, record: confirmation } }),
    };
    let promptPolicy = plan.promptPolicy;
    let outcome: Outcome;
    try {
      outcome = await withRunScope(scope, async () => {
        // The run's first job (design section 16): the prompt policy's model check, before any
        // other call. A refusal exits 9; a check that cannot run exits 4 (fails closed).
        const text = policyTextOf(plan);
        if (text !== undefined && plan.promptPolicy !== undefined) {
          try {
            const checked = await promptPolicyCheck(ctx, options, plan, text, plan.promptPolicy);
            scope.promptPolicy = checked.record;
            scope.priorSpentUsd = checked.spentUsd;
          } catch (error) {
            const refusedRecord = (error as { policy?: PromptPolicyRecord }).policy;
            if (refusedRecord !== undefined) promptPolicy = refusedRecord;
            throw error;
          }
          promptPolicy = scope.promptPolicy;
        }
        return options.run({ ...ctx, run: { dir: plan.runDir, plan } });
      });
    } catch (error) {
      outcome = options.toOutcome(error);
    }
    progress.finish();
    outcome = { ...outcome, fields: { ...outcome.fields, ...runFields(plan, false) } };
    const finishedAt = new Date().toISOString();
    if (!existsSync(join(plan.runDir, RUN_RECORD_FILE))) {
      const spent = outcome.fields["spentUsd"];
      await writeRunRecord({
        runId,
        runDir: plan.runDir,
        command,
        digest: plan.digest,
        startedAt: state.startedAt,
        finishedAt,
        ok: outcome.exitCode === 0,
        exitCode: outcome.exitCode,
        ...(outcome.error && { error: outcome.error.code }),
        ...(typeof spent === "number" && { spentUsd: spent }),
        ...(promptPolicy && { promptPolicy }),
        ...(existsSync(join(plan.runDir, CONTACT_SHEET_FILE)) && {
          contactSheet: CONTACT_SHEET_FILE,
        }),
      });
    }
    if (reconcileCtx !== undefined && reconcile !== undefined) {
      const entries = await reconciled(reconcileCtx, reconcile);
      await recordReconcile(plan.runDir, entries);
      for (const e of entries)
        if (e.status === "held")
          ctx.log(
            `spend hold ${e.holdId}: provider "${e.provider}" reports $${e.providerUsd?.toFixed(4)} against $${e.ledgerUsd?.toFixed(4)} in the ledger; paid runs are refused until it is acknowledged`,
          );
    }
    if (confirmation) await recordConfirmation(plan.runDir, confirmation);
    const ok = outcome.exitCode === 0;
    // A finished run consumes its confirmation: it pays for no further run.
    if (ok && confirmation)
      await bindConfirmation(
        ctx.settings.configDir,
        confirmation.digest,
        confirmation.digest === plan.digest ? "run" : "coveredRun",
        plan.runDir,
        true,
      );
    await writeState(plan.runDir, {
      ...state,
      status: ok ? "finished" : "failed",
      finishedAt,
      exitCode: outcome.exitCode,
      ...(ok && {
        outcome: { exitCode: outcome.exitCode, fields: outcome.fields, human: outcome.human },
      }),
    });
    return outcome;
  } finally {
    lock.release();
  }
}

/**
 * The prompt policy's model check, on the providers and routes of the settings, under the run's
 * cap and the spend ledger of the run's work item; journaled in the run like any other call.
 */
async function promptPolicyCheck(
  ctx: RunContext,
  options: { providerScript?: string; workItem?: string },
  plan: WorkPlan,
  text: string,
  record: PromptPolicyRecord,
): Promise<{ record: PromptPolicyRecord; spentUsd: number }> {
  const providers = await providerSet(options.providerScript, ctx);
  const budget = new Budget(plan.capUsd, ledgerFor(spendLedger(ctx, options.workItem), providers));
  // The whole request's forecast must fit the ledger before its first call, this one.
  budget.check(plan.forecastUsd, `the ${plan.jobs.length > 1 ? "run" : "prompt-policy check"}`);
  const caller = new Caller({
    provider: providers,
    budget,
    routes: providers.routes,
    log: ctx.log,
  });
  const checked = await checkPromptModel(caller, text, record);
  // The command's budgets count this spend against the same cap (src/budget.ts), and each counts
  // the run's unanswered ledger spend itself.
  return { record: checked, spentUsd: budget.spentUsd - budget.unansweredUsd };
}

/** The settings and the providers they make, for reconciling; makes no call. */
async function reconcileContext(
  ctx: RunContext,
  providerScript: string | undefined,
): Promise<ReconcileContext> {
  const script = providerScript !== undefined ? await loadScript(providerScript, ctx) : undefined;
  const providers = createProviders(ctx.settings, {
    ...(ctx.env && { env: ctx.env }),
    ...(script && { script }),
    ...(ctx.extensions && { adapters: ctx.extensions.adapters }),
  });
  return { settings: ctx.settings, providers };
}

/** The run's reconcile; an error reconciling never changes how the run ended. */
async function reconciled(rctx: ReconcileContext, run: RunReconcile): Promise<ReconcileEntry[]> {
  try {
    return await finishRunReconcile(rctx, run);
  } catch (error) {
    return run.providers.map((provider) => ({
      provider,
      status: "failed" as const,
      runId: run.runId,
      note: (error as Error).message,
    }));
  }
}

/**
 * Progress for a connected client: one update when the run starts, one per call answered, and
 * one for each job that had none by the end, so every job is reported at least once.
 */
function progressReporter(plan: WorkPlan, ctx: RunContext) {
  const send = ctx.progress;
  const total = plan.jobs.reduce((sum, job) => sum + job.count, 0);
  const reported = new Set<string>();
  let answered = 0;
  send?.({ progress: 0, total, message: `run ${runIdOfDir(plan.runDir)}: ${total} call(s)` });
  return {
    onCall: send
      ? (call: { operation: string; reused: boolean }) => {
          answered++;
          reported.add(call.operation);
          send({
            progress: Math.min(answered, total),
            total,
            message: `${call.operation}${call.reused ? " (journal)" : ""}: ${answered} of ${total}`,
          });
        }
      : undefined,
    finish() {
      if (!send) return;
      for (const job of plan.jobs) {
        if (reported.has(job.operation)) continue;
        reported.add(job.operation);
        send({ progress: total, total, message: `${job.operation}: done` });
      }
    },
  };
}
