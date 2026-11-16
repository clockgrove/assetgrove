/**
 * Reconcile (design section 3): the spend ledger is an estimate, so where a provider reports its
 * own usage to an ordinary key, a run's ledger spend is compared with it when the run ends. The
 * gateway and Tripo report each call's cost (`per-call-cost`, looked up by the request ID the
 * journal holds: the generation ID, the Tripo task ID), so another run on the same key or a credit
 * top-up changes nothing. Other providers record `unavailable`. A gap above max(`reconcile.marginUsd`, `reconcile.marginPct`% of the ledger
 * spend) appends a hold (src/spend.ts), and every paid run is refused until a person acknowledges
 * it. A per-call lookup the provider cannot answer yet is recorded as pending in
 * `<stateDir>/reconcile.jsonl` and retried at the next paid run's start and by `spend reconcile`;
 * one still unanswered a day after the run resolves as `failed`.
 *
 * The run directory keeps `reconcile-state.json`: the ledger reservations already reconciled. An
 * attempt that stops before its end leaves its reservations unreconciled, so its resume compares
 * that attempt's spend too.
 *
 * Reconciling reads the provider's usage and spends nothing.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Billing } from "./gateway/provider.ts";
import type { ConfiguredProvider } from "./providers/adapter.ts";
import { CALLS_DIR } from "./runs/journal.ts";
import { RUN_RECORD_FILE } from "./runs/dir.ts";
import type { Settings } from "./settings.ts";
import {
  SpendLedger,
  appendHold,
  appendJsonLine,
  assertNoOpenHold,
  readJsonLines,
} from "./spend.ts";

const EPSILON = 1e-9;

export const RECONCILE_FILE = "reconcile.jsonl";
/** In the run directory: what the run's attempts have reconciled, and the open attempt's start. */
export const RUN_RECONCILE_STATE_FILE = "reconcile-state.json";
/** A pending lookup still unanswered this long after its run resolves as `failed`. */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type ReconcileStatus = "unavailable" | "reconciled" | "pending" | "held" | "failed";

/** One provider's reconcile in a run record (`run.json` `reconcile`) or a `spend reconcile` result. */
export interface ReconcileEntry {
  provider: string;
  status: ReconcileStatus;
  /** How the provider reports usage; absent when it reports none. */
  method?: "per-call-cost";
  runId?: string;
  ledgerUsd?: number;
  providerUsd?: number;
  gapUsd?: number;
  marginUsd?: number;
  /** The hold appended, when the gap is above the margin. */
  holdId?: string;
  /** The pending lookup's id, while the provider has not reported every call. */
  pendingId?: string;
  /** Paid calls that cannot be looked up (no journaled request ID from the provider). */
  unmatched?: number;
  note?: string;
}

/** What reconciling reads: the settings and the providers they make. */
export interface ReconcileContext {
  settings: Pick<Settings, "stateDir" | "caps" | "reconcile" | "spend">;
  providers: readonly ConfiguredProvider[];
  now?: () => Date;
}

/** One call of a pending lookup: its request ID and what the ledger counts for it. */
interface PendingCall {
  requestId: string;
  ledgerUsd: number;
}

interface PendingRecord {
  op: "pending";
  id: string;
  at: string;
  provider: string;
  runId: string;
  calls: PendingCall[];
  unmatched: number;
}

interface ResolvedRecord {
  op: "resolved";
  id: string;
  at: string;
  status: ReconcileStatus;
  holdId?: string;
}

/** What a run took at its start for reconciling at its end. */
export interface RunReconcile {
  runId: string;
  runDir: string;
  /** The paid providers the plan names, by settings id. */
  providers: string[];
}

interface RunReconcileState {
  /** Ledger reservation ids an earlier attempt's end already reconciled. */
  reconciled: string[];
}

function readRunState(runDir: string): RunReconcileState {
  try {
    const raw = JSON.parse(readFileSync(join(runDir, RUN_RECONCILE_STATE_FILE), "utf8")) as {
      reconciled?: unknown;
    };
    const reconciled = Array.isArray(raw.reconciled)
      ? raw.reconciled.filter((v): v is string => typeof v === "string")
      : [];
    return { reconciled };
  } catch {
    return { reconciled: [] };
  }
}

function writeRunState(runDir: string, state: RunReconcileState): void {
  writeFileSync(join(runDir, RUN_RECONCILE_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

function reconcilePath(stateDir: string): string {
  return join(stateDir, RECONCILE_FILE);
}

function nowOf(ctx: ReconcileContext): Date {
  return ctx.now?.() ?? new Date();
}

function billingOfId(ctx: ReconcileContext, id: string): Billing | undefined {
  return ctx.providers.find((c) => c.id === id)?.provider.billing;
}

/** The margin a gap must pass: max(marginUsd, marginPct% of the ledger spend); both default to 0. */
export function marginFor(settings: Pick<Settings, "reconcile">, ledgerUsd: number): number {
  const usd = settings.reconcile.marginUsd ?? 0;
  const pct = settings.reconcile.marginPct ?? 0;
  return Math.max(usd, (pct / 100) * Math.abs(ledgerUsd));
}

/** Compares the two sides and appends a hold when the gap passes the margin. */
function compare(
  ctx: ReconcileContext,
  base: Pick<ReconcileEntry, "provider" | "method" | "unmatched" | "note"> & { runId: string },
  ledgerUsd: number,
  providerUsd: number,
): ReconcileEntry {
  const gapUsd = Math.abs(providerUsd - ledgerUsd);
  const marginUsd = marginFor(ctx.settings, ledgerUsd);
  const entry: ReconcileEntry = {
    ...base,
    status: "reconciled",
    ledgerUsd,
    providerUsd,
    gapUsd,
    marginUsd,
  };
  if (gapUsd <= marginUsd + EPSILON) return entry;
  const hold = appendHold(
    ctx.settings.stateDir,
    { provider: base.provider, runId: base.runId, ledgerUsd, providerUsd, gapUsd },
    nowOf(ctx),
  );
  return { ...entry, status: "held", holdId: hold.id };
}

/**
 * The start of a paid run: retries every pending lookup, refuses the run while a hold is not
 * acknowledged (`SpendHoldError`, exit 3 `spend_hold`).
 */
export async function startRunReconcile(
  ctx: ReconcileContext,
  run: { runId: string; runDir: string; providers: readonly string[] },
): Promise<RunReconcile> {
  await retryPending(ctx);
  assertNoOpenHold(ctx.settings);
  const providers = [...new Set(run.providers)].filter(
    (id) => id !== "" && billingOfId(ctx, id)?.paid === true,
  );
  return { runId: run.runId, runDir: run.runDir, providers };
}

/** The request ID the journal holds for a call, when the provider gave it. */
function journaledRequestId(runDir: string, callKey: string | undefined): string | undefined {
  if (callKey === undefined) return undefined;
  const path = join(runDir, CALLS_DIR, `${callKey}.json`);
  if (!existsSync(path)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as {
      record?: { requestId?: unknown; requestIdSource?: unknown };
    };
    const id = entry.record?.requestId;
    if (typeof id !== "string" || entry.record?.requestIdSource === "local") return undefined;
    return id;
  } catch {
    return undefined;
  }
}

/** The end of a paid run: one entry per paid provider the plan names. */
export async function finishRunReconcile(
  ctx: ReconcileContext,
  run: RunReconcile,
): Promise<ReconcileEntry[]> {
  const ledger = SpendLedger.fromSettings(ctx.settings, { env: {} });
  const state = readRunState(run.runDir);
  const done = new Set(state.reconciled);
  // Every reservation of the run no earlier attempt's end reconciled: an interrupted attempt's too.
  const calls = ledger.runCalls(run.runId).filter((c) => !done.has(c.id));
  const entries: ReconcileEntry[] = [];
  for (const provider of run.providers) {
    const billing = billingOfId(ctx, provider);
    const mine = calls.filter((c) => c.provider === provider);
    const ledgerUsd = mine.reduce((sum, c) => sum + c.costUsd, 0);
    try {
      if (billing === undefined || billing.reconcile === "unavailable") {
        entries.push({ provider, status: "unavailable", runId: run.runId, ledgerUsd });
      } else if (billing.callCost === undefined) {
        entries.push({
          provider,
          status: "unavailable",
          runId: run.runId,
          ledgerUsd,
          note: "the provider gives no per-call cost reading",
        });
      } else {
        const lookups: PendingCall[] = [];
        const seen = new Set<string>();
        let unmatched = 0;
        // The journal holds one request ID per call key: a reservation an interrupted attempt made
        // for a call a later attempt paid again has no request ID of its own.
        for (const call of mine.toReversed()) {
          const requestId = journaledRequestId(run.runDir, call.callKey);
          if (requestId === undefined || seen.has(call.callKey!)) unmatched++;
          else {
            seen.add(call.callKey!);
            lookups.unshift({ requestId, ledgerUsd: call.costUsd });
          }
        }
        entries.push(await perCall(ctx, provider, run.runId, billing, lookups, unmatched));
      }
    } catch (error) {
      entries.push({
        provider,
        status: "failed",
        runId: run.runId,
        ledgerUsd,
        note: (error as Error).message,
      });
    }
  }
  writeRunState(run.runDir, {
    reconciled: [...state.reconciled, ...calls.map((c) => c.id)],
  });
  return entries;
}

/**
 * Looks up each call's cost; with every one reported, compares, else records the lookup as
 * pending. A call the provider can never look up (null) joins the unmatched ones. A run none of
 * whose paid calls could be looked up records `failed`: nothing was compared. A retry stops at the
 * first call still unreported, so a pending lookup costs one provider call per retry while it waits.
 */
async function perCall(
  ctx: ReconcileContext,
  provider: string,
  runId: string,
  billing: Billing,
  lookups: PendingCall[],
  unmatchedBefore: number,
  pendingId?: string,
): Promise<ReconcileEntry> {
  const retry = pendingId !== undefined;
  let unmatched = unmatchedBefore;
  let ledgerUsd = 0;
  let providerUsd = 0;
  const waiting: PendingCall[] = [];
  const looked: PendingCall[] = [];
  for (const call of lookups) {
    const cost = await billing.callCost!(call.requestId);
    if (cost === null) {
      unmatched++;
      continue;
    }
    looked.push(call);
    if (cost === undefined) {
      waiting.push(call);
      if (retry) break;
      continue;
    }
    ledgerUsd += call.ledgerUsd;
    providerUsd += cost;
  }
  const base = {
    provider,
    method: "per-call-cost" as const,
    runId,
    ...(unmatched > 0 && { unmatched }),
  };
  if (waiting.length > 0) {
    const id = pendingId ?? randomBytes(8).toString("hex");
    if (pendingId === undefined) {
      const record: PendingRecord = {
        op: "pending",
        id,
        at: nowOf(ctx).toISOString(),
        provider,
        runId,
        calls: looked,
        unmatched,
      };
      appendJsonLine(reconcilePath(ctx.settings.stateDir), record, "reconcile record");
    }
    return {
      ...base,
      status: "pending",
      ledgerUsd: looked.reduce((sum, c) => sum + c.ledgerUsd, 0),
      pendingId: id,
      note: retry
        ? "a call cost is not reported yet"
        : `${waiting.length} of ${looked.length} call cost(s) not reported yet`,
    };
  }
  if (looked.length === 0 && unmatched > 0)
    return {
      ...base,
      status: "failed",
      note: `none of the ${unmatched} paid call(s) could be looked up with the provider; nothing was compared`,
    };
  return compare(
    ctx,
    {
      ...base,
      ...(unmatched > 0 && {
        note: `${unmatched} paid call(s) could not be looked up and are left out of both sides`,
      }),
    },
    ledgerUsd,
    providerUsd,
  );
}

/** The pending lookups not yet resolved, oldest first. */
export function pendingLookups(stateDir: string): PendingRecord[] {
  const values = readJsonLines(reconcilePath(stateDir), "reconcile record") as Array<
    PendingRecord | ResolvedRecord
  >;
  const resolved = new Set(values.filter((v) => v.op === "resolved").map((v) => v.id));
  return values.filter(
    (v): v is PendingRecord =>
      v.op === "pending" &&
      typeof v.id === "string" &&
      typeof v.provider === "string" &&
      typeof v.runId === "string" &&
      Array.isArray(v.calls) &&
      !resolved.has(v.id),
  );
}

/**
 * Retries every pending lookup: one whose calls are all reported now is compared (and may append a
 * hold) and marked resolved; one whose provider is no longer configured or still has a call to
 * report stays pending, until a day after its run, when it resolves as `failed`.
 */
export async function retryPending(ctx: ReconcileContext): Promise<ReconcileEntry[]> {
  const results: ReconcileEntry[] = [];
  for (const pending of pendingLookups(ctx.settings.stateDir)) {
    const billing = billingOfId(ctx, pending.provider);
    if (billing?.callCost === undefined) {
      results.push({
        provider: pending.provider,
        status: "pending",
        method: "per-call-cost",
        runId: pending.runId,
        pendingId: pending.id,
        note: `provider "${pending.provider}" is not configured with a per-call cost reading`,
      });
      continue;
    }
    let entry: ReconcileEntry;
    try {
      entry = await perCall(
        ctx,
        pending.provider,
        pending.runId,
        billing,
        pending.calls,
        typeof pending.unmatched === "number" ? pending.unmatched : 0,
        pending.id,
      );
    } catch (error) {
      entry = {
        provider: pending.provider,
        status: "pending",
        method: "per-call-cost",
        runId: pending.runId,
        pendingId: pending.id,
        note: (error as Error).message,
      };
    }
    const age = nowOf(ctx).getTime() - Date.parse(pending.at);
    if (entry.status === "pending" && age > PENDING_MAX_AGE_MS)
      entry = {
        ...entry,
        status: "failed",
        note: `the provider has not reported every call cost within a day: ${entry.note ?? ""}`.trim(),
      };
    if (entry.status !== "pending") {
      const resolved: ResolvedRecord = {
        op: "resolved",
        id: pending.id,
        at: nowOf(ctx).toISOString(),
        status: entry.status,
        ...(entry.holdId !== undefined && { holdId: entry.holdId }),
      };
      appendJsonLine(reconcilePath(ctx.settings.stateDir), resolved, "reconcile record");
      entry = { ...entry, pendingId: pending.id };
    }
    results.push(entry);
  }
  return results;
}

/** Adds the run's reconcile entries to its `run.json`, whoever wrote it. */
export async function recordReconcile(runDir: string, entries: ReconcileEntry[]): Promise<void> {
  const path = join(runDir, RUN_RECORD_FILE);
  let record: Record<string, unknown> = {};
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // No record, or an unreadable one: the reconcile entries alone are written.
  }
  await writeFile(path, `${JSON.stringify({ ...record, reconcile: entries }, null, 2)}\n`);
}
